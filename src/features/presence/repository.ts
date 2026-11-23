import type { PoolClient } from "pg";

// Decision 0017: signed-in viewers present at a live debate. A heartbeat from
// the debate page records the account in debate_viewers (latest heartbeat) and
// in coin_window_viewers for each turn window open at that moment. A debater
// records nothing while seated. "Present now" also leaves out the debate's
// current debaters when it is read, so a viewer who takes a seat stops counting
// at once, and one who leaves a seat counts again with their next heartbeat.

/** Seconds since the last heartbeat for an account to count as present now. */
export const PRESENT_SECONDS = 45;
/** How often the debate page sends a heartbeat, in milliseconds. */
export const HEARTBEAT_MS = 20_000;

// True when the user (column) currently holds a seat of the debate (column).
const seated = (debate: string, user: string) =>
  `EXISTS (SELECT 1 FROM debates sd JOIN public_profiles sp
    ON sp.id IN (sd.speaker_a_profile_id, sd.speaker_b_profile_id)
    WHERE sd.id=${debate} AND sp.user_id=${user})`;

/**
 * Records one heartbeat of a signed-in account watching a live, published
 * debate. Returns false, recording nothing, when the debate is not live or
 * the account holds one of its seats. Callers authenticate the account.
 */
export async function recordViewer(
  client: PoolClient,
  debateId: string,
  userId: string,
) {
  const live = (
    await client.query<{ seated: boolean }>(
      `SELECT ${seated("d.id", "$2::bigint")} AS seated
      FROM debates d JOIN topics t ON t.id=d.topic_id
      WHERE d.id=$1 AND d.status='live' AND d.publication_state='published'
        AND t.publication_state='published'`,
      [debateId, userId],
    )
  ).rows[0];
  if (!live || live.seated) return false;
  await client.query(
    `INSERT INTO debate_viewers(debate_id,user_id) VALUES($1,$2)
    ON CONFLICT (debate_id,user_id) DO UPDATE SET last_seen_at=clock_timestamp()`,
    [debateId, userId],
  );
  await recordWindowViewer(client, debateId, userId);
  return true;
}

/**
 * Records the account as present in the duel window of the debate's running
 * turn, while it is open. A window whose turn ended early takes no more
 * viewers, like it takes no more orders. Placing a ticket counts as presence
 * too. Callers hold the open windows' round locks shared, so settlement never
 * counts mid-insert.
 */
export async function recordWindowViewer(
  client: PoolClient,
  debateId: string,
  userId: string,
) {
  await client.query(
    `INSERT INTO coin_window_viewers(round_id,user_id)
    SELECT r.id,$2::bigint FROM coin_debate_rounds r
    WHERE r.debate_id=$1 AND r.turn_number IS NOT NULL AND r.state='open'
      AND r.terms->>'rule'='fd-v1'
      AND clock_timestamp()>=r.opens_at AND clock_timestamp()<r.closes_at
      AND EXISTS (SELECT 1 FROM debate_media m
        WHERE m.debate_id=r.debate_id AND m.turn_number=r.turn_number)
    ON CONFLICT (round_id,user_id) DO NOTHING`,
    [debateId, userId],
  );
}

/**
 * Accounts present at any point while a turn window was open: each was a
 * viewer, not a debater, when recorded. Rows are refused after the window's
 * cutoff, so the count is fixed once the window closes, however seats change
 * later; settlement relies on that.
 */
export async function viewersInWindow(client: PoolClient, roundId: string) {
  return Number(
    (
      await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM coin_window_viewers WHERE round_id=$1",
        [roundId],
      )
    ).rows[0]!.count,
  );
}

/**
 * Accounts with a heartbeat in the last withinSeconds, without the debate's
 * current debaters, in ascending id order.
 */
export async function viewerIdsNow(
  client: Pick<PoolClient, "query">,
  debateId: string,
  withinSeconds = PRESENT_SECONDS,
) {
  return (
    await client.query<{ userId: string }>(
      `SELECT v.user_id::text AS "userId" FROM debate_viewers v
      WHERE v.debate_id=$1 AND v.last_seen_at>clock_timestamp()-make_interval(secs=>$2)
        AND NOT ${seated("v.debate_id", "v.user_id")}
      ORDER BY v.user_id`,
      [debateId, withinSeconds],
    )
  ).rows.map((row) => row.userId);
}

/** The number of accounts viewerIdsNow returns. */
export async function viewersNow(
  client: Pick<PoolClient, "query">,
  debateId: string,
  withinSeconds = PRESENT_SECONDS,
) {
  return (await viewerIdsNow(client, debateId, withinSeconds)).length;
}
