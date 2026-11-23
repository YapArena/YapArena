import type { PoolClient } from "pg";
import { closeMicFund, extensionFunded, openMicFund } from "./funds.ts";
import { createList } from "./repository.ts";
import { MicError, nextTurn, otherSide, type Side } from "./rules.ts";
import { askerKind, micTurnSide, type MicTurnKind } from "./turn-kinds.ts";

// Decision 0018, PR 2b: the mic inside the media clock's turn advance.
//
// planMicAdvance runs in the media clock's own transaction, after it has
// locked the debate row and then its debate_media row, and only for a debate
// whose rules snapshot says the mic is on (micOn). It locks the mic rows it
// changes after those, the same order as starting a mic (turns.ts), which
// takes only the debate_media row and then the mic rows. Keeping the asker
// on adds only fund rows here (funds.ts): the clock opens and closes funds
// and never takes a book or the ledger.

/** The rules snapshot key a debate's start copies MIC_ENABLED into. */
export const MIC_SNAPSHOT_KEY = "mic_enabled";
export const micOn = (rules: unknown) =>
  typeof rules === "object" &&
  rules !== null &&
  MIC_SNAPSHOT_KEY in rules &&
  rules[MIC_SNAPSHOT_KEY] === true;

/** L2: the list opens when both debaters have completed three rounds. */
export const LIST_OPENS_AFTER_TURNS = 6;

export interface MicTurnRow {
  kind: MicTurnKind;
  micId: string;
  camp: Side;
  target: Side;
  holderId: string;
  allottedMs: number;
  ended: boolean;
}

/** What the clock does when the current turn ends. */
export type MicAdvance =
  | { end: true }
  | {
      end: false;
      side: Side; // debate_media.active_side for the next turn
      speaking: Side | null; // whose microphone opens; none for the asker's turns
      nextMs: number;
      reason: string;
      // Records the next turn once the clock has given it its number.
      record(client: PoolClient, turnNumber: number): Promise<void>;
    };

/** The mic turn now running in a debate, or null for a debater's own turn. */
export async function currentMicTurn(
  client: PoolClient,
  debateId: string,
  turnNumber: number,
  lock = false,
) {
  return (
    (
      await client.query<MicTurnRow>(
        `SELECT t.kind, t.mic_id AS "micId", m.camp, m.target,
          m.holder_id::text AS "holderId", t.allotted_ms AS "allottedMs",
          t.ended_at IS NOT NULL AS ended
        FROM mic_turns t JOIN mic_mics m ON m.id=t.mic_id
        WHERE t.debate_id=$1 AND t.turn_number=$2${lock ? " FOR UPDATE OF t" : ""}`,
        [debateId, turnNumber],
      )
    ).rows[0] ?? null
  );
}

// The turn after an exchange turn: never a debater's own turn or a new question.
function exchangeKind(kind: ReturnType<typeof nextTurn>): MicTurnKind {
  if (kind === "debate" || kind === "question")
    throw new MicError("not a turn after an exchange turn", 500);
  return kind;
}

export async function insertMicTurn(
  client: PoolClient,
  input: {
    debateId: string;
    turnNumber: number;
    micId: string;
    kind: MicTurnKind;
    side: Side;
    allottedMs: number;
  },
) {
  await client.query(
    `INSERT INTO mic_turns(debate_id,turn_number,mic_id,kind,side,allotted_ms)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [
      input.debateId,
      input.turnNumber,
      input.micId,
      input.kind,
      input.side,
      input.allottedMs,
    ],
  );
  // X1, X10: keep-the-asker-on opens with the asker's first turn of a segment.
  if (input.kind === "question" || input.kind === "extq")
    await openMicFund(client, {
      debateId: input.debateId,
      micId: input.micId,
      turnNumber: input.turnNumber,
      kind: input.kind,
    });
}

function micTurn(
  debateId: string,
  mic: { micId: string; camp: Side; target: Side },
  kind: MicTurnKind,
  turnMs: number,
): MicAdvance {
  const side = micTurnSide(kind, mic.camp, mic.target);
  return {
    end: false,
    side,
    speaking: askerKind(kind) ? null : side,
    // E4, E8: every mic turn is a full turn, whatever the debate has left.
    nextMs: turnMs,
    reason: `mic ${kind} turn, side ${side}`,
    record: (client, turnNumber) =>
      insertMicTurn(client, {
        debateId,
        turnNumber,
        micId: mic.micId,
        kind,
        side,
        allottedMs: turnMs,
      }),
  };
}

/**
 * The turn after the one ending now, for a debate with the mic on.
 * activeMs includes the ending turn's time; remainingMs is what the ending
 * turn had left (zero at its deadline, more when the asker ends it early).
 */
export async function planMicAdvance(
  client: PoolClient,
  input: {
    debateId: string;
    turnNumber: number;
    activeSide: Side;
    activeMs: number;
    remainingMs: number;
    turnMs: number;
    maximumMs: number;
  },
): Promise<MicAdvance> {
  const { debateId, turnMs, maximumMs } = input;
  const current = await currentMicTurn(
    client,
    debateId,
    input.turnNumber,
    true,
  );
  if (current && !current.ended)
    await client.query(
      `UPDATE mic_turns SET ended_at=clock_timestamp(), used_ms=$3
      WHERE debate_id=$1 AND turn_number=$2`,
      [
        debateId,
        input.turnNumber,
        current.allottedMs -
          Math.min(current.allottedMs, Math.max(0, input.remainingMs)),
      ],
    );
  // E1, E4, E8: question, answer, follow-up, answer, then the resume turn.
  // X1, X4, X7, X10: the fund closes when the asker's last turn of a segment
  // ends; funded, the target's answer is followed by an extension question
  // and answer, again and again (X8), else by the resume turn.
  if (current && current.kind !== "resume") {
    await closeMicFund(client, current.micId, current.kind);
    const funded =
      (current.kind === "answer2" || current.kind === "exta") &&
      (await extensionFunded(client, current.micId));
    return micTurn(
      debateId,
      current,
      exchangeKind(nextTurn(current.kind, funded)),
      turnMs,
    );
  }
  // The mic is done once the debater it did not ask has had the floor back.
  if (current)
    await client.query(
      "UPDATE mic_mics SET state='done' WHERE id=$1 AND state='live'",
      [current.micId],
    );
  else if (
    !(
      await client.query("SELECT 1 FROM mic_lists WHERE debate_id=$1", [
        debateId,
      ])
    ).rowCount
  ) {
    // L2: a debater's own turn ended; the list opens once both have spoken
    // three times. Mic turns never come before it, so they are not counted.
    const micTurns = (
      await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM mic_turns WHERE debate_id=$1 AND turn_number<=$2",
        [debateId, input.turnNumber],
      )
    ).rows[0]!.n;
    if (input.turnNumber - micTurns >= LIST_OPENS_AFTER_TURNS)
      await createList(client, debateId, 4, false);
  }
  // F12, F14: a mic that fired but has not started (its start failed, or it
  // fired just as the turn ended) starts now without a cut; a queued mic
  // starts once the mic before it has resumed the debate.
  const waiting = (
    await client.query<{
      id: string;
      state: "live" | "queued";
      camp: Side;
      target: Side;
    }>(
      `SELECT m.id, m.state, m.camp, m.target FROM mic_mics m
      WHERE m.debate_id=$1 AND m.state IN ('live','queued')
        AND NOT EXISTS (SELECT 1 FROM mic_runs r WHERE r.mic_id=m.id)
      ORDER BY (m.state='live') DESC, m.fired_at, m.id LIMIT 1 FOR UPDATE OF m`,
      [debateId],
    )
  ).rows[0];
  if (
    waiting &&
    !(
      await client.query(
        "SELECT 1 FROM mic_mics WHERE debate_id=$1 AND state='live' AND id<>$2",
        [debateId, waiting.id],
      )
    ).rowCount
  ) {
    if (waiting.state === "queued")
      await client.query("UPDATE mic_mics SET state='live' WHERE id=$1", [
        waiting.id,
      ]);
    await client.query("INSERT INTO mic_runs(mic_id,debate_id) VALUES($1,$2)", [
      waiting.id,
      debateId,
    ]);
    return micTurn(
      debateId,
      { micId: waiting.id, camp: waiting.camp, target: waiting.target },
      "question",
      turnMs,
    );
  }
  // A debater's own turn, after the side that spoke last. Mic turns do not
  // count toward the maximum length, so a mic never ends the debate.
  const micMs = Number(
    (
      await client.query<{ ms: string }>(
        "SELECT COALESCE(sum(used_ms),0)::text AS ms FROM mic_turns WHERE debate_id=$1",
        [debateId],
      )
    ).rows[0]!.ms,
  );
  const debateMs = input.activeMs - micMs;
  if (debateMs >= maximumMs) return { end: true };
  const side = otherSide(input.activeSide);
  return {
    end: false,
    side,
    speaking: side,
    nextMs: Math.min(turnMs, maximumMs - debateMs),
    reason: `side ${side} turn`,
    record: async () => {},
  };
}
