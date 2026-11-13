// Decision 0015 (D8): stores the topic figure after each revealed round as an
// insert-only point. It runs beside the coin loop, in its own transactions,
// never inside settlement, and takes no round or ledger locks.
//
// A reveal event is one counted debate's settled windows that have no point
// yet and whose earlier turns are settled or void (a five-day debate's only
// once none of its windows is open). Its rounds are appended in turn order in
// one transaction, so a reader never sees half of a five-day reveal. One
// writer per topic runs at a time, across processes (advisory lock), and the
// point order is the insertion order, so history is never rewritten: a round
// that commits late is appended after points recorded before it.
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { COIN_WORKER_LIMITS } from "../account-wallet/debate-sandbox.ts";
import { ENDORSEMENT_METHOD, foldAnswers } from "./model.ts";
import {
  COUNTED_DEBATE_SQL,
  countedRoundSql,
  topicAnswers,
} from "./repository.ts";
import type { EndorsementAnswer } from "./types.ts";

/** Reveal events handled per tick, oldest first. */
export const ENDORSEMENT_EVENTS_PER_TICK = 20;

interface RevealEvent {
  topicId: string;
  debateId: string;
}

interface PendingRound {
  id: string;
}

// The counted rounds of a debate (or of every debate) that have no point yet.
const PENDING = `FROM debates d JOIN topics t ON t.id=d.topic_id
  JOIN coin_debate_rounds r ON r.debate_id=d.id AND r.turn_number IS NOT NULL
  WHERE ${COUNTED_DEBATE_SQL} AND ${countedRoundSql("$1")}
    AND NOT EXISTS (SELECT 1 FROM endorsement_points p WHERE p.round_id=r.id)`;

export function createEndorsementRecorder(
  database: Pick<Pool, "query" | "connect">,
  rail: string,
  { limits = COIN_WORKER_LIMITS } = {},
) {
  async function pendingRounds(client: PoolClient, debateId: string) {
    return (
      await client.query<PendingRound>(
        `SELECT r.id::text AS id ${PENDING} AND r.debate_id=$2 ORDER BY r.turn_number`,
        [rail, debateId],
      )
    ).rows;
  }

  async function recordEvent(event: RevealEvent) {
    return withTransaction(
      database,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('endorsement:'||$1::text,0))",
          [event.topicId],
        );
        // Under READ COMMITTED each statement after the lock sees what the
        // previous writer committed, so a round recorded meanwhile drops out.
        const rounds = await pendingRounds(client, event.debateId);
        if (!rounds.length) return 0;
        const answers = await topicAnswers(client, event.topicId, rail, {
          recordedOr: rounds.map((round) => round.id),
        });
        const pending = new Map(rounds.map((round) => [round.id, round]));
        const included: EndorsementAnswer[] = answers.filter(
          (answer) => !pending.has(answer.roundId),
        );
        for (const round of rounds) {
          for (const answer of answers)
            if (answer.roundId === round.id) included.push(answer);
          const topic = foldAnswers(included);
          const debate = foldAnswers(
            included.filter((answer) => answer.debateId === event.debateId),
          );
          await client.query(
            // The round's own reveal time, with its microseconds.
            `INSERT INTO endorsement_points(round_id,topic_id,debate_id,turn_number,revealed_at,
              topic_yes,topic_accounts,debate_yes,debate_accounts,switching,debate_switching,method)
            SELECT r.id,$2,r.debate_id,r.turn_number,r.revealed_at,$3,$4,$5,$6,$7,$8,$9
            FROM coin_debate_rounds r WHERE r.id=$1`,
            [
              round.id,
              event.topicId,
              topic.yes,
              topic.accounts,
              debate.yes,
              debate.accounts,
              JSON.stringify(topic.switching),
              JSON.stringify(debate.switching),
              ENDORSEMENT_METHOD,
            ],
          );
        }
        return rounds.length;
      },
      limits,
    );
  }

  return Object.freeze({
    /**
     * Records the oldest reveal events. topicIds limits the search (tests and
     * one-off runs); every event runs even when another fails.
     */
    async record(
      limit = ENDORSEMENT_EVENTS_PER_TICK,
      topicIds?: readonly string[],
    ) {
      const events = (
        await database.query<RevealEvent>(
          `SELECT d.topic_id::text AS "topicId", r.debate_id::text AS "debateId"
          ${PENDING} AND ($3::uuid[] IS NULL OR d.topic_id=ANY($3::uuid[]))
          GROUP BY d.topic_id, r.debate_id
          ORDER BY min(r.revealed_at), r.debate_id LIMIT $2`,
          [rail, limit, topicIds ? [...topicIds] : null],
        )
      ).rows;
      const failures: unknown[] = [];
      let points = 0;
      for (const event of events) {
        try {
          points += await recordEvent(event);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "endorsement events failed");
      return { events: events.length, points };
    },
  });
}
