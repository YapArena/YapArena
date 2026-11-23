import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import {
  withTransaction,
  type TransactionOptions,
} from "../../platform/transaction.ts";
import { COIN_WORKER_LIMITS } from "../account-wallet/debate-sandbox.ts";
import {
  assertSandboxRail,
  type SandboxRail,
} from "../account-wallet/sandbox-repository.ts";
import { createMicMoney, lockMoney, type HeldPledge } from "./money.ts";
import { openFund, type TurnKind } from "./rules.ts";

// Decision 0018, PR 3: keep the asker on (X), and the mic's money when a
// debate ends (D7, D9).
//
// The clock only opens funds and closes them: it holds the debate row, its
// debate_media row and then the mic rows, and never a book or the ledger.
// A fund whose closing turn ended unfunded is marked closing; its holds are
// refunded afterwards by settleClosing, in its own transaction (the fund row
// FOR UPDATE, the books, the ledger), which the worker's recovery pass
// retries. Pledging takes the same order after the pledger's account row
// (repository.ts keep), so a pledge and a close are decided by the fund row:
// a pledge that reached the price first has funded it; one after the close
// is refused.
//
// A debate that ended (at its maximum, by an operator, cancelled or sent to
// review) is settled by settleEnded once the end has committed: its
// debate_media row first, so no clock step or mic start of that debate runs
// beside it, then its open list, its open funds, the books and the ledger.
// Every open question's pledges and every open fund's pledges are refunded,
// the mics still live or queued are done (a queued mic has fired and stays
// paid), and the mic turn the end cut is recorded so its window is refunded
// after this commits (turns.ts).

/** Opens the fund of an asker's first turn of a segment (X1, X10). */
export async function openMicFund(
  client: PoolClient,
  input: {
    debateId: string;
    micId: string;
    turnNumber: number;
    kind: "question" | "extq";
  },
) {
  const price = (
    await client.query<{ price: string }>(
      "SELECT price::text FROM mic_mics WHERE id=$1",
      [input.micId],
    )
  ).rows[0]!.price;
  const fund = openFund(input.kind, BigInt(price));
  await client.query(
    `INSERT INTO mic_funds(id,mic_id,debate_id,opened_turn_number,closes_after,price)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      input.micId,
      input.debateId,
      input.turnNumber,
      fund.closesAfter,
      String(fund.price),
    ],
  );
}

/**
 * X7: the turn a fund waits for has ended. Unless a pledge has funded it,
 * it is closing; its holds are refunded after the clock commits.
 */
export async function closeMicFund(
  client: PoolClient,
  micId: string,
  ended: TurnKind,
) {
  if (ended !== "followup" && ended !== "extq") return false;
  return Boolean(
    (
      await client.query(
        `UPDATE mic_funds SET state='closing'
        WHERE mic_id=$1 AND state='open' AND closes_after=$2`,
        [micId, ended],
      )
    ).rowCount,
  );
}

/** X4, X11: whether the mic's latest fund was funded, for the next turn. */
export async function extensionFunded(client: PoolClient, micId: string) {
  return (
    (
      await client.query<{ state: string }>(
        `SELECT state FROM mic_funds WHERE mic_id=$1
        ORDER BY opened_turn_number DESC LIMIT 1`,
        [micId],
      )
    ).rows[0]?.state === "funded"
  );
}

interface FundPledgeRow extends HeldPledge {
  fund_id: string;
}
interface QuestionPledgeRow extends HeldPledge {
  question_id: string;
}
const pledgeColumns = "p.id,p.user_id::text,p.amount::text,p.funding";
// A hold to refund: its scope on the book event and how its row records it.
interface Refund {
  pledge: HeldPledge;
  scope: Record<string, string>;
  record: () => Promise<unknown>;
}

export function createMicFunds(options: {
  database: Pool;
  rail: SandboxRail;
  limits?: TransactionOptions;
  logger: Pick<Logger, "error">;
}) {
  const { database, rail, logger } = options;
  const money = createMicMoney(rail);
  const transaction = <T>(work: (client: PoolClient) => Promise<T>) =>
    withTransaction(
      database,
      async (client) => {
        await assertSandboxRail(client, rail);
        return work(client);
      },
      options.limits ?? COIN_WORKER_LIMITS,
    );

  // The held pledges of these funds, to refund for this reason.
  async function fundRefunds(
    client: PoolClient,
    funds: readonly string[],
    reason: "fund_closed" | "debate_ended",
  ): Promise<Refund[]> {
    const rows = (
      await client.query<FundPledgeRow>(
        `SELECT ${pledgeColumns},p.fund_id FROM mic_fund_pledges p
        WHERE p.fund_id=ANY($1::uuid[]) AND p.state='held' ORDER BY p.created_at,p.id`,
        [funds],
      )
    ).rows;
    return rows.map((pledge) => ({
      pledge,
      scope: { fundId: pledge.fund_id },
      record: () =>
        client.query(
          "UPDATE mic_fund_pledges SET state='refunded',refund_reason=$2 WHERE id=$1",
          [pledge.id, reason],
        ),
    }));
  }
  // Every refund exactly, after locking the books and the ledger once.
  async function refundAll(
    client: PoolClient,
    refunds: readonly Refund[],
    reason: "fund_closed" | "debate_ended",
  ) {
    if (!refunds.length) return 0;
    const locked = await lockMoney(
      client,
      refunds.map((refund) => refund.pledge.user_id),
    );
    for (const refund of refunds)
      await money.release(client, locked.books, locked.buckets, refund.pledge, {
        reason,
        scope: refund.scope,
        record: refund.record,
      });
    return refunds.length;
  }

  /** X7: refunds a closing fund's holds exactly. True when it was closing. */
  async function settleFund(fundId: string) {
    return transaction(async (client) => {
      const fund = (
        await client.query<{ id: string }>(
          "SELECT id FROM mic_funds WHERE id=$1 AND state='closing' FOR UPDATE",
          [fundId],
        )
      ).rows[0];
      if (!fund) return false;
      await refundAll(
        client,
        await fundRefunds(client, [fund.id], "fund_closed"),
        "fund_closed",
      );
      await client.query("UPDATE mic_funds SET state='failed' WHERE id=$1", [
        fund.id,
      ]);
      return true;
    });
  }

  /** D7, D9: settles the mic's money of one debate that has ended. */
  async function settleDebate(debateId: string) {
    return transaction(async (client) => {
      const debate = (
        await client.query<{ status: string }>(
          "SELECT status FROM debates WHERE id=$1",
          [debateId],
        )
      ).rows[0];
      if (!debate || debate.status === "live") return null;
      const media = (
        await client.query<{ turnNumber: number }>(
          `SELECT turn_number AS "turnNumber" FROM debate_media
          WHERE debate_id=$1 FOR UPDATE`,
          [debateId],
        )
      ).rows[0];
      if (
        (
          await client.query(
            "SELECT 1 FROM mic_debate_ends WHERE debate_id=$1",
            [debateId],
          )
        ).rowCount
      )
        return null;
      await client.query(
        `SELECT id FROM mic_lists WHERE debate_id=$1 AND state='open'
        ORDER BY id FOR UPDATE`,
        [debateId],
      );
      const funds = (
        await client.query<{ id: string }>(
          `SELECT id FROM mic_funds WHERE debate_id=$1 AND state='open'
          ORDER BY id FOR UPDATE`,
          [debateId],
        )
      ).rows.map((row) => row.id);
      // D7: every question that hasn't fired, its wager and pledges.
      const questions = (
        await client.query<QuestionPledgeRow>(
          `SELECT ${pledgeColumns},p.question_id FROM mic_pledges p
          JOIN mic_questions q ON q.id=p.question_id
          WHERE q.debate_id=$1 AND q.state='open' AND p.state='held'
          ORDER BY p.created_at,p.id`,
          [debateId],
        )
      ).rows;
      const refunded = await refundAll(
        client,
        [
          ...(await fundRefunds(client, funds, "debate_ended")),
          ...questions.map((pledge) => ({
            pledge,
            scope: { questionId: pledge.question_id },
            record: () =>
              client.query(
                "UPDATE mic_pledges SET state='refunded',refund_reason='debate_ended' WHERE id=$1",
                [pledge.id],
              ),
          })),
        ],
        "debate_ended",
      );
      await client.query(
        "UPDATE mic_questions SET state='refunded' WHERE debate_id=$1 AND state='open'",
        [debateId],
      );
      if (funds.length)
        await client.query(
          "UPDATE mic_funds SET state='refunded' WHERE id=ANY($1::uuid[])",
          [funds],
        );
      await client.query(
        "UPDATE mic_lists SET state='closed' WHERE debate_id=$1 AND state='open'",
        [debateId],
      );
      // The mic turn the end cut (an operator's end; the clock's maximum
      // never ends a debate inside a mic turn) stops now.
      const cut = media
        ? (
            await client.query<{ turnNumber: number }>(
              `UPDATE mic_turns SET ended_at=clock_timestamp(),
                used_ms=LEAST(allotted_ms,GREATEST(0,
                  floor(extract(epoch FROM clock_timestamp()-started_at)*1000)))::integer
              WHERE debate_id=$1 AND turn_number=$2 AND ended_at IS NULL
              RETURNING turn_number AS "turnNumber"`,
              [debateId, media.turnNumber],
            )
          ).rows[0]
        : undefined;
      const mics = (
        await client.query(
          `UPDATE mic_mics SET state='done'
          WHERE debate_id=$1 AND state IN ('live','queued')`,
          [debateId],
        )
      ).rowCount;
      await client.query(
        `INSERT INTO mic_debate_ends(debate_id,cut_turn_number,cut_void)
        VALUES($1,$2,$3)`,
        [debateId, cut?.turnNumber ?? null, cut ? "pending" : null],
      );
      return {
        refunded,
        mics: mics ?? 0,
        cutTurnNumber: cut?.turnNumber ?? null,
      };
    });
  }

  return Object.freeze({
    settleFund,
    settleDebate,
    /** Refunds every closing fund (of one debate, or all). Never throws. */
    async settleClosing(debateId: string | null = null, limit = 20) {
      let settled = 0;
      try {
        const due = (
          await database.query<{ id: string }>(
            `SELECT id FROM mic_funds WHERE state='closing'
            AND ($1::uuid IS NULL OR debate_id=$1) ORDER BY opened_at,id LIMIT $2`,
            [debateId, limit],
          )
        ).rows;
        for (const fund of due) {
          try {
            if (await settleFund(fund.id)) settled++;
          } catch (error) {
            logger.error(
              { error, fundId: fund.id },
              "keep-the-asker-on refund failed; retrying",
            );
          }
        }
      } catch (error) {
        logger.error({ error }, "keep-the-asker-on refunds failed; retrying");
      }
      return settled;
    },
    /** Settles every ended debate whose mic money is not settled. Never throws. */
    async settleEnded(limit = 20) {
      let settled = 0;
      try {
        const due = (
          await database.query<{ debateId: string }>(
            `SELECT l.debate_id AS "debateId" FROM mic_lists l
            JOIN debates d ON d.id=l.debate_id
            WHERE l.state='open' AND d.status<>'live'
              AND NOT EXISTS (SELECT 1 FROM mic_debate_ends e WHERE e.debate_id=l.debate_id)
            ORDER BY l.opened_at,l.debate_id LIMIT $1`,
            [limit],
          )
        ).rows;
        for (const { debateId } of due) {
          try {
            if (await settleDebate(debateId)) settled++;
          } catch (error) {
            logger.error(
              { error, debateId },
              "mic refunds at the debate's end failed; retrying",
            );
          }
        }
      } catch (error) {
        logger.error({ error }, "mic refunds at the end failed; retrying");
      }
      return settled;
    },
  });
}
export type MicFunds = ReturnType<typeof createMicFunds>;
