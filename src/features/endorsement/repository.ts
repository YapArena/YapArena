// Decision 0015: the eligible answers, the debate figure computed on read and
// the stored topic points. Every exclusion lives in SQL, so the PostgreSQL
// suites test it; the counting itself is model.ts.
import type { Pool } from "pg";
import { latestDebateFigure } from "./model.ts";
import type {
  DebateEndorsement,
  EndorsementAnswer,
  EndorsementDebateResult,
  EndorsementHistoryPoint,
  Switching,
  TopicEndorsement,
  TopicEndorsementPage,
} from "./types.ts";

export interface Queryable {
  query: Pool["query"];
}

/** The most points one topic history returns. */
export const ENDORSEMENT_HISTORY_LIMIT = 2_000;

/** UTC with microseconds, so timestamps compare as strings. */
export function utcText(column: string) {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * A settled, revealed turn window on the rail, whose earlier turns (every
 * turn, for a five-day debate) are no longer open. Aliases: r is the round.
 */
export function countedRoundSql(railParameter: string) {
  return `r.rail=${railParameter} AND r.turn_number IS NOT NULL AND r.state='settled'
    AND r.revealed_at<=clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM coin_debate_rounds e
      WHERE e.debate_id=r.debate_id AND e.rail=r.rail AND e.turn_number IS NOT NULL
        AND e.state='open' AND (r.reveal_mode='five_day' OR e.turn_number<r.turn_number))`;
}

/**
 * A counted debate: it and its topic are published, it is not a demo, and
 * its question is the topic title. Aliases: d is the debate, t its topic.
 */
export const COUNTED_DEBATE_SQL = `t.publication_state='published'
  AND d.publication_state='published' AND NOT d.is_demo AND d.proposition=t.title`;

const ANSWER_COLUMNS = `o.user_id::text AS "userId", o.side,
  ${utcText("o.created_at")} AS "createdAt", ${utcText("r.revealed_at")} AS "revealedAt",
  r.debate_id::text AS "debateId", r.turn_number AS "turnNumber", r.id::text AS "roundId"`;

const ANSWER_SOURCE = `FROM debates d JOIN topics t ON t.id=d.topic_id
  JOIN coin_debate_rounds r ON r.debate_id=d.id AND r.turn_number IS NOT NULL
  JOIN coin_debate_orders o ON o.round_id=r.id`;

const ANSWER_ORDER = `ORDER BY o.created_at, r.revealed_at, r.turn_number, r.id`;

/**
 * A topic's counted answers. With recordedOr, only rounds that already have a
 * point plus the rounds listed (the recorder's view); without it, every
 * counted answer now.
 */
export async function topicAnswers(
  database: Queryable,
  topicId: string,
  rail: string,
  options: { recordedOr?: readonly string[] } = {},
) {
  const recorded = options.recordedOr
    ? `AND (EXISTS (SELECT 1 FROM endorsement_points p WHERE p.round_id=r.id)
        OR r.id=ANY($3::uuid[]))`
    : "";
  const parameters: unknown[] = [topicId, rail];
  if (options.recordedOr) parameters.push([...options.recordedOr]);
  return (
    await database.query<EndorsementAnswer>(
      `SELECT ${ANSWER_COLUMNS} ${ANSWER_SOURCE}
      WHERE d.topic_id=$1 AND ${COUNTED_DEBATE_SQL} AND ${countedRoundSql("$2")} ${recorded}
      ${ANSWER_ORDER}`,
      parameters,
    )
  ).rows;
}

/**
 * One debate's counted answers for its own bar. The page already refuses
 * unpublished debates, and a demo debate still shows its own bar; only the
 * question must be the topic title.
 */
export async function debateAnswers(
  database: Queryable,
  debateId: string,
  rail: string,
) {
  return (
    await database.query<EndorsementAnswer>(
      `SELECT ${ANSWER_COLUMNS} ${ANSWER_SOURCE}
      WHERE d.id=$1 AND d.proposition=t.title AND ${countedRoundSql("$2")}
      ${ANSWER_ORDER}`,
      [debateId, rail],
    )
  ).rows;
}

/**
 * The debate figure through its highest counted turn, or null before the
 * first one. Run it in the same snapshot as the turn windows it sits beside.
 */
export async function debateEndorsement(
  database: Queryable,
  debateId: string,
  rail: string,
): Promise<DebateEndorsement | null> {
  return latestDebateFigure(await debateAnswers(database, debateId, rail));
}

const LINK_COLUMNS = `CASE WHEN d.publication_state='published' AND NOT d.is_demo
    THEN d.slug END AS slug, d.proposition AS title`;

interface LinkRow {
  slug: string | null;
  title: string;
}

function link(row: LinkRow) {
  return row.slug === null ? null : { slug: row.slug, title: row.title };
}

export async function topicFigure(
  database: Queryable,
  topicId: string,
): Promise<TopicEndorsement | null> {
  const row = (
    await database.query<
      LinkRow & {
        yes: number;
        accounts: number;
        switching: Switching;
        revealedAt: string;
        liveEndedAt: string | null;
        debatesCounted: number;
      }
    >(
      `SELECT p.topic_yes AS yes, p.topic_accounts AS accounts, p.switching,
        ${utcText("p.revealed_at")} AS "revealedAt", ${LINK_COLUMNS},
        ${utcText("d.live_ended_at")} AS "liveEndedAt",
        (SELECT count(DISTINCT q.debate_id)::int FROM endorsement_points q
          JOIN debates qd ON qd.id=q.debate_id
          WHERE q.topic_id=p.topic_id AND qd.publication_state='published'
            AND NOT qd.is_demo) AS "debatesCounted"
      FROM endorsement_points p JOIN debates d ON d.id=p.debate_id
      WHERE p.topic_id=$1 ORDER BY p.id DESC LIMIT 1`,
      [topicId],
    )
  ).rows[0];
  if (!row) return null;
  const debate = link(row);
  return {
    yes: row.yes,
    accounts: row.accounts,
    switching: row.switching,
    revealedAt: row.revealedAt,
    lastDebate: debate && { ...debate, liveEndedAt: row.liveEndedAt },
    debatesCounted: row.debatesCounted,
  };
}

/** Every point of the topic in recording order, the latest 2,000 at most. */
export async function topicHistory(
  database: Queryable,
  topicId: string,
): Promise<EndorsementHistoryPoint[]> {
  const rows = (
    await database.query<
      LinkRow & {
        id: string;
        revealedAt: string;
        turnNumber: number;
        yes: number;
        accounts: number;
      }
    >(
      `SELECT h.id::text AS id, h."revealedAt", h."turnNumber", h.slug, h.title, h.yes, h.accounts
      FROM (SELECT p.id, ${utcText("p.revealed_at")} AS "revealedAt",
          p.turn_number AS "turnNumber", ${LINK_COLUMNS},
          p.topic_yes AS yes, p.topic_accounts AS accounts
        FROM endorsement_points p JOIN debates d ON d.id=p.debate_id
        WHERE p.topic_id=$1 ORDER BY p.id DESC LIMIT $2) h
      ORDER BY h.id`,
      [topicId, ENDORSEMENT_HISTORY_LIMIT],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    revealedAt: row.revealedAt,
    turnNumber: row.turnNumber,
    debate: link(row),
    yes: row.yes,
    accounts: row.accounts,
  }));
}

/** Each published counted debate's final figure, from its latest point. */
export async function debateResults(
  database: Queryable,
  topicId: string,
): Promise<EndorsementDebateResult[]> {
  return (
    await database.query<EndorsementDebateResult>(
      `SELECT DISTINCT ON (p.debate_id) p.debate_id::text AS "debateId",
        p.turn_number AS "throughTurn", p.debate_yes AS yes,
        p.debate_accounts AS accounts, p.debate_switching AS switching
      FROM endorsement_points p JOIN debates d ON d.id=p.debate_id
      WHERE p.topic_id=$1 AND d.publication_state='published' AND NOT d.is_demo
      ORDER BY p.debate_id, p.id DESC`,
      [topicId],
    )
  ).rows;
}

export function createEndorsementRepository(database: Queryable, rail: string) {
  return Object.freeze({
    /** The topic page's figure, history and per-debate results. */
    async topic(topicId: string): Promise<TopicEndorsementPage> {
      const [figure, history, debates] = await Promise.all([
        topicFigure(database, topicId),
        topicHistory(database, topicId),
        debateResults(database, topicId),
      ]);
      return { figure, history, debates };
    },
    topicFigure: (topicId: string) => topicFigure(database, topicId),
    topicHistory: (topicId: string) => topicHistory(database, topicId),
    debateResults: (topicId: string) => debateResults(database, topicId),
    /** Pass the client of the transaction that reads the turn windows. */
    debateEndorsement: (client: Queryable, debateId: string) =>
      debateEndorsement(client, debateId, rail),
  });
}
