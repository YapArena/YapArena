import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { withTransaction } from "../../platform/transaction.ts";
import { assertActiveSession } from "../../platform/auth/sessions.ts";
import { CoinOperationError } from "../account-wallet/external-operations.ts";
import type { SandboxContext } from "../account-wallet/sandbox-repository.ts";
import {
  timing,
  type createMediaRepository,
  type MediaState,
} from "../media/repository.ts";
import { currentMicTurn, insertMicTurn, micOn } from "./engine.ts";
import { askerKind, micTurnSide } from "./turn-kinds.ts";
import { cutTurn, MicError, MIC_TERMS, type Side } from "./rules.ts";

// Decision 0018, PR 2b: starting a mic, refunding the turn it cut, and the
// asker's own controls.
//
// Firing (repository.ts) commits first and never touches debate_media: it
// locks the list row, the books and the ledger. Starting the live mic is a
// separate transaction that locks only the debate's debate_media row and then
// the mic rows it changes, so it never waits on the list or the ledger while
// holding the clock. If a turn is running it is cut: the speaker loses the
// rest of it (E5, E6) and the asker's question turn starts with its own turn
// number and a full turn. Only after that commits is the cut turn's window
// refunded (E10, voidTurnWindow, its own transaction and locks). The worker's
// recover() retries both until they are done; both are idempotent.

type VoidTurnWindow = (
  debateId: string,
  turnNumber: number,
  reason: "turn_cut",
) => Promise<{ roundId: string | null; created: boolean }>;

export function createMicTurns(options: {
  database: Pool;
  media: Pick<ReturnType<typeof createMediaRepository>, "advanceWithClient">;
  voidTurnWindow: VoidTurnWindow;
  // Applies the debate's durable turn to the speakers' permissions.
  onTurn?: (debateId: string) => Promise<unknown>;
  logger: Pick<Logger, "warn" | "error">;
}) {
  const { database, media, logger } = options;

  async function applied(debateId: string) {
    try {
      await options.onTurn?.(debateId);
    } catch (error) {
      // The media worker repairs permissions from the durable turn.
      logger.warn({ error, debateId }, "mic turn permissions not yet applied");
    }
  }

  // (b) Starts the debate's live mic that has not started, cutting the
  // running turn. Null when there is nothing to start now: no such mic, the
  // debate is paused or not live, or the turn already reached its deadline
  // (the clock then starts the mic at the boundary, cutting nothing).
  async function startWithClient(client: PoolClient, debateId: string) {
    const event = (
      await client.query<{
        status: string;
        rulesSnapshot: Parameters<typeof timing>[0];
      }>(
        `SELECT status, rules_snapshot AS "rulesSnapshot" FROM debates WHERE id=$1`,
        [debateId],
      )
    ).rows[0];
    if (!event || event.status !== "live" || !micOn(event.rulesSnapshot))
      return null;
    const state = (
      await client.query<
        Pick<
          MediaState,
          | "state"
          | "activeSide"
          | "turnNumber"
          | "turnDeadlineAt"
          | "remainingMs"
          | "lastResumedAt"
        > & { databaseNow: Date }
      >(
        `SELECT state, active_side AS "activeSide", turn_number AS "turnNumber",
          turn_deadline_at AS "turnDeadlineAt", remaining_ms AS "remainingMs",
          last_resumed_at AS "lastResumedAt", clock_timestamp() AS "databaseNow"
        FROM debate_media WHERE debate_id=$1 FOR UPDATE`,
        [debateId],
      )
    ).rows[0];
    if (
      !state ||
      state.state !== "running" ||
      !state.activeSide ||
      !state.turnDeadlineAt ||
      !state.lastResumedAt
    )
      return null;
    const now = new Date(state.databaseNow).getTime(),
      deadline = new Date(state.turnDeadlineAt).getTime();
    if (deadline <= now) return null;
    const mic = (
      await client.query<{ id: string; camp: Side; target: Side }>(
        `SELECT m.id, m.camp, m.target FROM mic_mics m
        WHERE m.debate_id=$1 AND m.state='live'
          AND NOT EXISTS (SELECT 1 FROM mic_runs r WHERE r.mic_id=m.id)
        FOR UPDATE OF m`,
        [debateId],
      )
    ).rows[0];
    if (!mic) return null;
    // One mic is live at a time, so the running turn is a debater's own.
    if (await currentMicTurn(client, debateId, state.turnNumber)) return null;
    const { turnMs } = timing(event.rulesSnapshot);
    const { lostMs } = cutTurn(deadline - now);
    // The cut turn's time so far counts as debate time, as at its deadline.
    const elapsed = Math.min(
      state.remainingMs ?? turnMs,
      Math.max(0, now - new Date(state.lastResumedAt).getTime()),
    );
    const side = micTurnSide("question", mic.camp, mic.target);
    await client.query(
      `UPDATE debate_media SET active_side=$2, turn_number=turn_number+1,
        active_ms=active_ms+$3, remaining_ms=$4, last_resumed_at=CURRENT_TIMESTAMP,
        turn_deadline_at=CURRENT_TIMESTAMP+($4::integer*INTERVAL '1 millisecond'),
        revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE debate_id=$1`,
      [debateId, side, elapsed, turnMs],
    );
    await client.query(
      `INSERT INTO mic_runs(mic_id,debate_id,cut_turn_number,cut_side,lost_ms,cut_void)
      VALUES($1,$2,$3,$4,$5,'pending')`,
      [mic.id, debateId, state.turnNumber, state.activeSide, lostMs],
    );
    await insertMicTurn(client, {
      debateId,
      turnNumber: state.turnNumber + 1,
      micId: mic.id,
      kind: "question",
      side,
      allottedMs: turnMs,
    });
    await client.query(
      `INSERT INTO event_history (debate_id, action, from_status, to_status, reason)
      VALUES ($1, 'turn_advanced', 'live', 'live', $2)`,
      [
        debateId,
        `mic question turn, side ${side}; cut turn ${state.turnNumber}`,
      ],
    );
    return { micId: mic.id, cutTurnNumber: state.turnNumber, lostMs };
  }

  // (c) Refunds each cut turn's window not yet refunded. A window whose
  // settlement has already started is left to settle and recorded as refused.
  async function voidCuts(debateId: string | null, limit = 20) {
    const due = (
      await database.query<{
        micId: string;
        debateId: string;
        turnNumber: number;
      }>(
        `SELECT mic_id AS "micId", debate_id AS "debateId", cut_turn_number AS "turnNumber"
        FROM mic_runs WHERE cut_void='pending' AND ($1::uuid IS NULL OR debate_id=$1)
        ORDER BY started_at, mic_id LIMIT $2`,
        [debateId, limit],
      )
    ).rows;
    let voided = 0;
    for (const cut of due) {
      let outcome: "done" | "refused";
      try {
        await options.voidTurnWindow(cut.debateId, cut.turnNumber, "turn_cut");
        outcome = "done";
      } catch (error) {
        if (!(error instanceof CoinOperationError) || error.status !== 409) {
          logger.error(
            { error, debateId: cut.debateId, turnNumber: cut.turnNumber },
            "cut turn window refund failed; retrying",
          );
          continue;
        }
        logger.warn(
          { error, debateId: cut.debateId, turnNumber: cut.turnNumber },
          "cut turn window could not be refunded",
        );
        outcome = "refused";
      }
      await database.query(
        "UPDATE mic_runs SET cut_void=$2 WHERE mic_id=$1 AND cut_void='pending'",
        [cut.micId, outcome],
      );
      if (outcome === "done") voided++;
    }
    return voided;
  }

  // Session first, as every account write does, before any debate lock.
  async function signedIn(client: PoolClient, context: SandboxContext) {
    const session = await assertActiveSession(
      client,
      context.userId,
      context.sessionTokenHash,
    );
    if (
      context.expectedSessionId !== undefined &&
      session.id !== context.expectedSessionId
    )
      throw new CoinOperationError(
        "account context changed; refresh balances and review again",
        409,
        "session_changed",
      );
  }
  async function assertAskerTurn(
    client: PoolClient,
    debateId: string,
    state: Pick<MediaState, "state" | "turnNumber">,
    userId: string,
  ) {
    if (state.state !== "running")
      throw new MicError("the debate isn't running");
    const turn = await currentMicTurn(client, debateId, state.turnNumber, true);
    if (!turn || turn.ended || !askerKind(turn.kind))
      throw new MicError("it isn't an asker's turn");
    if (turn.holderId !== userId)
      throw new MicError("only the asker can do this in their turn", 403);
  }

  /** Starts a fired mic now, then refunds the turn it cut. Never throws. */
  async function start(debateId: string) {
    try {
      const started = await withTransaction(database, (client) =>
        startWithClient(client, debateId),
      );
      if (started) await applied(debateId);
      await voidCuts(debateId);
      return started;
    } catch (error) {
      logger.error({ error, debateId }, "mic start failed; retrying");
      return null;
    }
  }

  return Object.freeze({
    start,
    /**
     * The worker's recovery pass: starts every live mic whose start did not
     * happen and refunds every cut turn whose refund did not.
     */
    async recover(limit = 20) {
      const pending = (
        await database.query<{ debateId: string }>(
          `SELECT m.debate_id AS "debateId" FROM mic_mics m
          JOIN debate_media dm ON dm.debate_id=m.debate_id
          JOIN debates d ON d.id=m.debate_id
          WHERE m.state='live' AND dm.state='running' AND d.status='live'
            AND dm.turn_deadline_at>clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM mic_runs r WHERE r.mic_id=m.id)
          ORDER BY m.fired_at, m.id LIMIT $1`,
          [limit],
        )
      ).rows;
      let started = 0;
      for (const { debateId } of pending) if (await start(debateId)) started++;
      return { started, voided: await voidCuts(null, limit) };
    },
    /** E1: the asker ends their own turn; the exchange moves on at once. */
    async endAskerTurn(context: SandboxContext, debateId: string) {
      const result = await withTransaction(database, async (client) => {
        await signedIn(client, context);
        return media.advanceWithClient(client, debateId, (state) =>
          assertAskerTurn(client, debateId, state, context.userId),
        );
      });
      if (!result) throw new MicError("the debate isn't running");
      await applied(debateId);
      return result.ended
        ? { ended: true }
        : { ended: false, side: result.turn.side };
    },
    /** E2, E9: the asker's typed text, shown on screen as it is. */
    async setAskerText(
      context: SandboxContext,
      debateId: string,
      text: string,
    ) {
      const clean = text.trim();
      if (!clean) throw new MicError("write your question first", 400);
      if ([...clean].length > MIC_TERMS.questionMaxChars)
        throw new MicError(
          `the text is at most ${MIC_TERMS.questionMaxChars} characters`,
          400,
        );
      return withTransaction(database, async (client) => {
        await signedIn(client, context);
        const state = (
          await client.query<Pick<MediaState, "state" | "turnNumber">>(
            `SELECT state, turn_number AS "turnNumber" FROM debate_media
            WHERE debate_id=$1 FOR UPDATE`,
            [debateId],
          )
        ).rows[0];
        if (!state) throw new MicError("debate not found", 404);
        await assertAskerTurn(client, debateId, state, context.userId);
        await client.query(
          "UPDATE mic_turns SET text=$3 WHERE debate_id=$1 AND turn_number=$2",
          [debateId, state.turnNumber, clean],
        );
        // The media snapshot's revision tells the debate page to refresh.
        await client.query(
          `UPDATE debate_media SET revision=revision+1, updated_at=CURRENT_TIMESTAMP
          WHERE debate_id=$1`,
          [debateId],
        );
        return { turnNumber: state.turnNumber, text: clean };
      });
    },
  });
}
export type MicTurns = ReturnType<typeof createMicTurns>;
