import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { runExclusiveDatabaseJob } from "../../platform/database-jobs.ts";
import { assertDebaterSettings } from "../transcription/debater-settings.ts";
import {
  activeRules,
  remindScheduledDebate,
  settleUnansweredNowChallenges,
  retireOpenQueueRequests,
  cancelUnstartedDebate,
  createPairedEvent,
  ensureAvailable,
  lockUsers,
  MatchConflictError,
  MatchNotFoundError,
  profileFor,
  reservationFor,
} from "./repository.ts";
import {
  DEVICE_CHECK_MINUTES,
  OFFER_SECONDS,
  REMINDER_MINUTES,
  PRESENCE_SECONDS,
  QUEUE_JOIN_SECONDS,
  SCHEDULED_JOIN_SECONDS,
} from "./timings.ts";

export {
  OFFER_SECONDS,
  PRESENCE_SECONDS,
  QUEUE_JOIN_SECONDS,
  SCHEDULED_JOIN_SECONDS,
} from "./timings.ts";

// Live topic queue (Decision 0011). A ticket waits on one topic and side; the oldest ticket on
// each side is paired into an offer that both players accept within 30 seconds. Locks are always
// taken in the same order: player locks (`lockUsers`), then the offer row, then ticket rows.

// Timings live in ./timings.ts. Presence stays above 60 seconds because browsers can slow timers
// in hidden tabs to once a minute while clients poll.
const RETENTION_DAYS = 30;
const SWEEP_TOPICS = 25;
const SWEEP_OFFERS = 100;
const SWEEP_NO_SHOWS = 50;

type Side = "A" | "B";
type TicketStatus = "searching" | "offered" | "matched" | "closed";
type ClosedReason =
  | "left"
  | "declined"
  | "missed"
  | "stale"
  | "unavailable"
  | "topic_closed"
  | "booking";

interface TicketRow {
  id: string;
  userId: string;
  topicId: string;
  side: Side;
  status: TicketStatus;
}

interface OfferRow {
  id: string;
  topicId: string;
  ticketAId: string;
  ticketBId: string;
  userAId: string;
  userBId: string;
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
  acceptedAAt: Date | null;
  acceptedBAt: Date | null;
  debateId: string | null;
  open: boolean;
}

export interface MatchmakingState {
  serverNow: string;
  ticket: {
    id: string;
    topicSlug: string;
    topicTitle: string;
    side: Side;
    sideLabel: string;
    status: TicketStatus;
    closedReason: ClosedReason | null;
    queuedAt: string;
  } | null;
  offer: {
    id: string;
    deadlineAt: string;
    acceptedByMe: boolean;
    acceptedByOpponent: boolean;
  } | null;
  // The debate a matched ticket or an accepted "now" challenge created; joinDeadlineAt is when
  // an unstarted one is cancelled.
  debate: {
    id: string;
    slug: string;
    status: string;
    joinDeadlineAt: string;
  } | null;
  // A "now" challenge being answered: incoming for the target, outgoing for the challenger.
  challenge: {
    id: string;
    direction: "incoming" | "outgoing";
    handle: string;
    displayName: string;
    topicTitle: string;
    sideLabel: string;
    respondBy: string;
  } | null;
  // The player's next booked debate, from a day ahead until its join window closes, so every
  // page can remind them shortly before it starts.
  upcoming: {
    id: string;
    slug: string;
    status: string;
    proposition: string;
    startsAt: string;
    joinDeadlineAt: string;
  } | null;
}

const ticketFields = `id, user_id AS "userId", topic_id AS "topicId", side, status`;
const offerFields = `id, topic_id AS "topicId", ticket_a_id AS "ticketAId",
  ticket_b_id AS "ticketBId", user_a_id AS "userAId", user_b_id AS "userBId", status,
  accepted_a_at AS "acceptedAAt", accepted_b_at AS "acceptedBAt", debate_id AS "debateId",
  deadline_at > clock_timestamp() AS "open"`;
const fresh = `last_seen_at > CURRENT_TIMESTAMP - make_interval(secs => ${PRESENCE_SECONDS})`;

async function closeTicket(
  client: PoolClient,
  ticketId: string,
  reason: ClosedReason,
) {
  await client.query(
    `UPDATE matchmaking_tickets SET status = 'closed', closed_reason = $2,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('searching', 'offered')`,
    [ticketId, reason],
  );
}

// Back into the queue with the original queue time, so a player who did nothing wrong keeps
// their place.
async function requeueTicket(client: PoolClient, ticketId: string) {
  await client.query(
    `UPDATE matchmaking_tickets SET status = 'searching', last_seen_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'offered'`,
    [ticketId],
  );
}

async function lockOffer(client: PoolClient, offerId: string) {
  const result = await client.query<OfferRow>(
    `SELECT ${offerFields} FROM match_offers WHERE id = $1 FOR UPDATE`,
    [offerId],
  );
  return result.rows[0] ?? null;
}

// Starting and live debates plus pending offers each need a recording slot.
async function hasCapacity(client: PoolClient, capacity: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "matchmaking:capacity",
  ]);
  const result = await client.query<{ used: number }>(
    `SELECT (SELECT count(*) FROM debates WHERE NOT is_demo AND (status = 'live' OR
        (status IN ('scheduled', 'ready') AND scheduled_at BETWEEN
          CURRENT_TIMESTAMP - interval '15 minutes' AND CURRENT_TIMESTAMP + interval '5 minutes')))::int
      + (SELECT count(*) FROM match_offers WHERE status = 'pending')::int AS used`,
  );
  return (result.rows[0]?.used ?? 0) < capacity;
}

async function oldestWaiting(client: PoolClient, topicId: string, side: Side) {
  const result = await client.query<TicketRow>(
    `SELECT ${ticketFields} FROM matchmaking_tickets
     WHERE topic_id = $1 AND side = $2 AND status = 'searching' AND ${fresh}
     ORDER BY priority_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [topicId, side],
  );
  return result.rows[0] ?? null;
}

// Pairs the longest-waiting ticket on each side of a topic. Returns false when no pair or no
// recording slot is available.
async function pairOldest(
  client: PoolClient,
  topicId: string,
  capacity: number,
) {
  if (!(await hasCapacity(client, capacity))) return false;
  const a = await oldestWaiting(client, topicId, "A");
  if (!a) return false;
  const b = await oldestWaiting(client, topicId, "B");
  if (!b) return false;
  await client.query(
    `INSERT INTO match_offers (topic_id, ticket_a_id, ticket_b_id, user_a_id, user_b_id,
       status, deadline_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', clock_timestamp() + make_interval(secs => $6))`,
    [topicId, a.id, b.id, a.userId, b.userId, OFFER_SECONDS],
  );
  await client.query(
    `UPDATE matchmaking_tickets SET status = 'offered', updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::uuid[])`,
    [[a.id, b.id]],
  );
  return true;
}

// A player who no longer qualifies (already seated, profile unpublished) cannot be matched.
async function unavailableSides(client: PoolClient, offer: OfferRow) {
  const sides: Side[] = [];
  const now = reservationFor(
    "now",
    new Date(),
    (await activeRules(client)).rules,
  );
  for (const [side, userId] of [
    ["A", offer.userAId],
    ["B", offer.userBId],
  ] as const) {
    try {
      await ensureAvailable(client, userId, now);
      await profileFor(client, userId);
    } catch (error) {
      if (!(error instanceof MatchConflictError)) throw error;
      sides.push(side);
    }
  }
  return sides;
}

// Both accepted: create the debate starting now, or cancel and requeue whoever still qualifies.
async function finalize(client: PoolClient, offer: OfferRow, actorId: string) {
  const topic = await client.query<{ title: string }>(
    "SELECT title FROM topics WHERE id = $1 AND publication_state = 'published'",
    [offer.topicId],
  );
  const unavailable = await unavailableSides(client, offer);
  if (!topic.rows[0] || unavailable.length) {
    await client.query(
      "UPDATE match_offers SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [offer.id],
    );
    for (const [side, ticketId] of [
      ["A", offer.ticketAId],
      ["B", offer.ticketBId],
    ] as const) {
      if (!topic.rows[0]) await closeTicket(client, ticketId, "topic_closed");
      else if (unavailable.includes(side))
        await closeTicket(client, ticketId, "unavailable");
      else await requeueTicket(client, ticketId);
    }
    return null;
  }
  const event = await createPairedEvent(client, {
    topicId: offer.topicId,
    proposition: topic.rows[0].title,
    sideAUserId: offer.userAId,
    sideBUserId: offer.userBId,
    scheduledAt: new Date(),
    booking: "now",
    actorId,
    acceptedRequestId: null,
    notice: "Your debate is ready. Join now.",
  });
  await client.query(
    `UPDATE match_offers SET status = 'accepted', debate_id = $2,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [offer.id, event.id],
  );
  await client.query(
    `UPDATE matchmaking_tickets SET status = 'matched', debate_id = $2,
       updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
    [[offer.ticketAId, offer.ticketBId], event.id],
  );
  return event;
}

// The offer expired: players who accepted go back into the queue; the others leave it.
async function expireOffer(client: PoolClient, offer: OfferRow) {
  await client.query(
    "UPDATE match_offers SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [offer.id],
  );
  for (const [accepted, ticketId] of [
    [offer.acceptedAAt, offer.ticketAId],
    [offer.acceptedBAt, offer.ticketBId],
  ] as const) {
    if (accepted) await requeueTicket(client, ticketId);
    else await closeTicket(client, ticketId, "missed");
  }
}

// Debates that never went live in their join window are cancelled. In a queue match, whoever had
// joined goes back into the queue with their original queue time.
async function resolveNoShows(client: PoolClient) {
  const due = await client.query<{
    id: string;
    status: string;
    readyA: boolean;
    readyB: boolean;
    ticketAId: string | null;
    ticketBId: string | null;
  }>(
    `SELECT d.id, d.status, d.ready_a_at IS NOT NULL AS "readyA",
       d.ready_b_at IS NOT NULL AS "readyB", o.ticket_a_id AS "ticketAId",
       o.ticket_b_id AS "ticketBId"
     FROM debates d LEFT JOIN match_offers o ON o.debate_id = d.id AND o.status = 'accepted'
     WHERE d.status IN ('scheduled', 'ready') AND NOT d.is_demo
       AND d.scheduled_at <= CURRENT_TIMESTAMP - make_interval(secs =>
         CASE WHEN o.id IS NULL AND NOT EXISTS (SELECT 1 FROM match_requests r
             WHERE r.debate_id = d.id AND r.mode = 'now')
           THEN ${SCHEDULED_JOIN_SECONDS} ELSE ${QUEUE_JOIN_SECONDS} END)
     ORDER BY d.scheduled_at LIMIT ${SWEEP_NO_SHOWS} FOR UPDATE OF d SKIP LOCKED`,
  );
  for (const debate of due.rows) {
    await cancelUnstartedDebate(client, debate.id, debate.status);
    for (const [joined, ticketId] of [
      [debate.readyA, debate.ticketAId],
      [debate.readyB, debate.ticketBId],
    ] as const)
      if (joined && ticketId)
        await client.query(
          `INSERT INTO matchmaking_tickets (user_id, topic_id, side, status, priority_at)
           SELECT user_id, topic_id, side, 'searching', priority_at
           FROM matchmaking_tickets WHERE id = $1 ON CONFLICT DO NOTHING`,
          [ticketId],
        );
  }
  return due.rows.length;
}

export function createMatchmaking(
  database: Pool,
  {
    liveDebateCapacity,
    requireDeviceCheck = false,
    // While the live outline is on, queueing needs a debate language and transcription consent:
    // a 30-second accept leaves no time for forms (Decision 0011).
    requireDebaterSettings = false,
  }: {
    liveDebateCapacity: number;
    requireDeviceCheck?: boolean;
    requireDebaterSettings?: boolean;
  },
) {
  async function participantOffer(userId: string, offerId: string) {
    const result = await database.query<OfferRow>(
      `SELECT ${offerFields} FROM match_offers WHERE id = $1`,
      [offerId],
    );
    const offer = result.rows[0];
    if (!offer || (offer.userAId !== userId && offer.userBId !== userId))
      throw new MatchNotFoundError("match not found");
    return offer;
  }

  async function decline(userId: string, offerId: string) {
    const initial = await participantOffer(userId, offerId);
    await withTransaction(database, async (client) => {
      await lockUsers(client, initial.userAId, initial.userBId);
      const offer = await lockOffer(client, offerId);
      if (!offer || offer.status !== "pending")
        throw new MatchConflictError("this match is no longer available");
      const mine = offer.userAId === userId ? "A" : "B";
      await client.query(
        "UPDATE match_offers SET status = 'declined', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [offer.id],
      );
      await closeTicket(
        client,
        mine === "A" ? offer.ticketAId : offer.ticketBId,
        "declined",
      );
      await requeueTicket(
        client,
        mine === "A" ? offer.ticketBId : offer.ticketAId,
      );
    });
  }

  async function ticketState(
    userId: string,
  ): Promise<Omit<MatchmakingState, "challenge" | "upcoming">> {
    const result = await database.query<{
      id: string;
      side: Side;
      status: TicketStatus;
      closedReason: ClosedReason | null;
      priorityAt: Date;
      topicSlug: string;
      topicTitle: string;
      sideLabel: string;
      debateId: string | null;
      debateSlug: string | null;
      debateStatus: string | null;
      joinDeadlineAt: Date | null;
      serverNow: Date;
    }>(
      `SELECT t.id, t.side, t.status, t.closed_reason AS "closedReason",
           t.priority_at AS "priorityAt", tp.slug AS "topicSlug", tp.title AS "topicTitle",
           CASE WHEN t.side = 'A' THEN tp.side_a_label ELSE tp.side_b_label END AS "sideLabel",
           d.id AS "debateId", d.slug AS "debateSlug", d.status AS "debateStatus",
           d.scheduled_at + make_interval(secs => ${QUEUE_JOIN_SECONDS}) AS "joinDeadlineAt",
           clock_timestamp() AS "serverNow"
         FROM matchmaking_tickets t JOIN topics tp ON tp.id = t.topic_id
         LEFT JOIN debates d ON d.id = t.debate_id
         WHERE t.user_id = $1 AND (t.status IN ('searching', 'offered')
           OR t.updated_at > CURRENT_TIMESTAMP - interval '2 minutes')
         ORDER BY t.status IN ('searching', 'offered') DESC, t.updated_at DESC LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      const now = await database.query<{ serverNow: Date }>(
        'SELECT clock_timestamp() AS "serverNow"',
      );
      return {
        serverNow: new Date(now.rows[0]!.serverNow).toISOString(),
        ticket: null,
        offer: null,
        debate: null,
      };
    }
    let offer: MatchmakingState["offer"] = null;
    if (row.status === "offered") {
      const found = await database.query<{
        id: string;
        deadlineAt: Date;
        mine: Date | null;
        theirs: Date | null;
      }>(
        `SELECT id, deadline_at AS "deadlineAt",
             CASE WHEN ticket_a_id = $1 THEN accepted_a_at ELSE accepted_b_at END AS mine,
             CASE WHEN ticket_a_id = $1 THEN accepted_b_at ELSE accepted_a_at END AS theirs
           FROM match_offers WHERE (ticket_a_id = $1 OR ticket_b_id = $1) AND status = 'pending'`,
        [row.id],
      );
      const entry = found.rows[0];
      if (entry)
        offer = {
          id: entry.id,
          deadlineAt: new Date(entry.deadlineAt).toISOString(),
          acceptedByMe: Boolean(entry.mine),
          acceptedByOpponent: Boolean(entry.theirs),
        };
    }
    return {
      serverNow: new Date(row.serverNow).toISOString(),
      ticket: {
        id: row.id,
        topicSlug: row.topicSlug,
        topicTitle: row.topicTitle,
        side: row.side,
        sideLabel: row.sideLabel,
        status: row.status,
        closedReason: row.closedReason,
        queuedAt: new Date(row.priorityAt).toISOString(),
      },
      offer,
      debate:
        row.status === "matched" &&
        row.debateId &&
        row.debateSlug &&
        row.debateStatus &&
        row.joinDeadlineAt
          ? {
              id: row.debateId,
              slug: row.debateSlug,
              status: row.debateStatus,
              joinDeadlineAt: new Date(row.joinDeadlineAt).toISOString(),
            }
          : null,
    };
  }

  async function nowChallenge(
    userId: string,
  ): Promise<MatchmakingState["challenge"]> {
    const result = await database.query<{
      id: string;
      outgoing: boolean;
      handle: string;
      displayName: string;
      topicTitle: string;
      sideLabel: string;
      respondBy: Date;
    }>(
      `SELECT r.id, r.initiator_user_id = $1 AS outgoing, p.handle,
         p.display_name AS "displayName", t.title AS "topicTitle",
         CASE WHEN (r.initiator_user_id = $1) = (r.requested_side = 'A')
           THEN t.side_a_label ELSE t.side_b_label END AS "sideLabel",
         r.respond_by AS "respondBy"
       FROM match_requests r JOIN topics t ON t.id = r.topic_id
       JOIN public_profiles p ON p.user_id = CASE WHEN r.initiator_user_id = $1
         THEN r.target_user_id ELSE r.initiator_user_id END
       WHERE r.status = 'open' AND r.kind = 'direct' AND r.mode = 'now'
         AND r.respond_by > CURRENT_TIMESTAMP
         AND (r.initiator_user_id = $1 OR r.target_user_id = $1)
       ORDER BY r.respond_by LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          direction: row.outgoing ? "outgoing" : "incoming",
          handle: row.handle,
          displayName: row.displayName,
          topicTitle: row.topicTitle,
          sideLabel: row.sideLabel,
          respondBy: new Date(row.respondBy).toISOString(),
        }
      : null;
  }

  async function nowChallengeDebate(
    userId: string,
  ): Promise<MatchmakingState["debate"]> {
    const result = await database.query<{
      id: string;
      slug: string;
      status: string;
      joinDeadlineAt: Date;
    }>(
      `SELECT d.id, d.slug, d.status,
         d.scheduled_at + make_interval(secs => ${QUEUE_JOIN_SECONDS}) AS "joinDeadlineAt"
       FROM match_requests r JOIN debates d ON d.id = r.debate_id
       WHERE r.kind = 'direct' AND r.mode = 'now' AND r.status = 'accepted'
         AND (r.initiator_user_id = $1 OR r.target_user_id = $1)
         AND r.updated_at > CURRENT_TIMESTAMP - interval '2 minutes'
       ORDER BY r.updated_at DESC LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          slug: row.slug,
          status: row.status,
          joinDeadlineAt: new Date(row.joinDeadlineAt).toISOString(),
        }
      : null;
  }

  async function upcomingDebate(
    userId: string,
  ): Promise<MatchmakingState["upcoming"]> {
    const result = await database.query<{
      id: string;
      slug: string;
      status: string;
      proposition: string;
      startsAt: Date;
      joinDeadlineAt: Date;
    }>(
      `SELECT d.id, d.slug, d.status, d.proposition, d.scheduled_at AS "startsAt",
         d.scheduled_at + make_interval(secs => ${SCHEDULED_JOIN_SECONDS}) AS "joinDeadlineAt"
       FROM event_participants p JOIN debates d ON d.id = p.debate_id
       WHERE p.user_id = $1 AND p.active AND d.status IN ('scheduled', 'ready')
         AND NOT d.is_demo
         AND d.scheduled_at < CURRENT_TIMESTAMP + interval '1 day'
         AND d.scheduled_at > CURRENT_TIMESTAMP - make_interval(secs => ${SCHEDULED_JOIN_SECONDS})
         -- Queue and "now" debates have their own 90-second join countdown.
         AND NOT EXISTS (SELECT 1 FROM match_offers o WHERE o.debate_id = d.id)
         AND NOT EXISTS (SELECT 1 FROM match_requests r
           WHERE r.debate_id = d.id AND r.mode = 'now')
       ORDER BY d.scheduled_at LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          slug: row.slug,
          status: row.status,
          proposition: row.proposition,
          startsAt: new Date(row.startsAt).toISOString(),
          joinDeadlineAt: new Date(row.joinDeadlineAt).toISOString(),
        }
      : null;
  }

  const matchmaking = Object.freeze({
    // Whether entering the queue needs a recent camera and microphone check.
    deviceCheckRequired: requireDeviceCheck,

    async state(userId: string): Promise<MatchmakingState> {
      const [base, challenge, challengeDebate, upcoming] = await Promise.all([
        ticketState(userId),
        nowChallenge(userId),
        nowChallengeDebate(userId),
        upcomingDebate(userId),
      ]);
      return {
        ...base,
        debate: base.debate ?? challengeDebate,
        challenge,
        upcoming,
      };
    },

    async enter(userId: string, input: { topicSlug: string; side: Side }) {
      await withTransaction(database, async (client) => {
        await lockUsers(client, userId);
        await profileFor(client, userId);
        if (requireDebaterSettings) await assertDebaterSettings(client, userId);
        await ensureAvailable(
          client,
          userId,
          reservationFor("now", new Date(), (await activeRules(client)).rules),
        );
        if (requireDeviceCheck) {
          const checked = await client.query(
            `SELECT 1 FROM account_device_checks WHERE user_id = $1 AND camera_ok
               AND microphone_ok AND checked_at > CURRENT_TIMESTAMP
                 - make_interval(mins => ${DEVICE_CHECK_MINUTES})`,
            [userId],
          );
          if (!checked.rows[0])
            throw new MatchConflictError(
              "check your camera and microphone before entering the queue",
            );
        }
        const topic = await client.query<{ id: string }>(
          `SELECT id FROM topics WHERE slug = $1 AND publication_state = 'published'
             AND is_demo = false`,
          [input.topicSlug],
        );
        const topicId = topic.rows[0]?.id;
        if (!topicId) throw new MatchNotFoundError("topic not found");
        const active = await client.query<TicketRow>(
          `SELECT ${ticketFields} FROM matchmaking_tickets
           WHERE user_id = $1 AND status IN ('searching', 'offered')`,
          [userId],
        );
        const current = active.rows[0];
        if (current) {
          if (current.topicId !== topicId || current.side !== input.side)
            throw new MatchConflictError("you are already in a queue");
          return;
        }
        await client.query(
          `INSERT INTO matchmaking_tickets (user_id, topic_id, side, status)
           VALUES ($1, $2, $3, 'searching')`,
          [userId, topicId, input.side],
        );
        await pairOldest(client, topicId, liveDebateCapacity);
      });
      return matchmaking.state(userId);
    },

    // Presence for every player with an open live stream, refreshed by the web process.
    async touchMany(userIds: readonly string[]) {
      if (!userIds.length) return 0;
      await database.query(
        `INSERT INTO matchmaking_presence (user_id) SELECT unnest($1::bigint[])
         ON CONFLICT (user_id) DO UPDATE SET seen_at = CURRENT_TIMESTAMP`,
        [userIds],
      );
      const result = await database.query(
        `UPDATE matchmaking_tickets SET last_seen_at = CURRENT_TIMESTAMP
         WHERE user_id = ANY($1::bigint[]) AND status IN ('searching', 'offered')`,
        [userIds],
      );
      return result.rowCount ?? 0;
    },

    // Presence for the polling client: queue presence and "online" for "now" challenges.
    async touch(userId: string) {
      await database.query(
        `INSERT INTO matchmaking_presence (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET seen_at = CURRENT_TIMESTAMP`,
        [userId],
      );
      await database.query(
        `UPDATE matchmaking_tickets SET last_seen_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND status IN ('searching', 'offered')`,
        [userId],
      );
      return matchmaking.state(userId);
    },

    async leave(userId: string) {
      const leaveSearching = () =>
        database.query(
          `UPDATE matchmaking_tickets SET status = 'closed', closed_reason = 'left',
             updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND status = 'searching'`,
          [userId],
        );
      if (!(await leaveSearching()).rowCount) {
        const pending = await database.query<{ id: string }>(
          `SELECT o.id FROM match_offers o JOIN matchmaking_tickets t
             ON t.id IN (o.ticket_a_id, o.ticket_b_id)
           WHERE t.user_id = $1 AND t.status = 'offered' AND o.status = 'pending'`,
          [userId],
        );
        if (pending.rows[0]) {
          try {
            await decline(userId, pending.rows[0].id);
          } catch (error) {
            if (!(error instanceof MatchConflictError)) throw error;
          }
        }
        // The offer may have expired meanwhile and put this player back in the queue.
        await leaveSearching();
      }
      return matchmaking.state(userId);
    },

    async accept(userId: string, offerId: string) {
      const initial = await participantOffer(userId, offerId);
      const debate = await withTransaction(database, async (client) => {
        await lockUsers(client, initial.userAId, initial.userBId);
        const offer = await lockOffer(client, offerId);
        if (offer?.status === "accepted") return null;
        if (!offer || offer.status !== "pending" || !offer.open)
          throw new MatchConflictError("this match is no longer available");
        const column =
          offer.userAId === userId ? "accepted_a_at" : "accepted_b_at";
        const updated = await client.query<OfferRow>(
          `UPDATE match_offers SET ${column} = COALESCE(${column}, clock_timestamp()),
             updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${offerFields}`,
          [offer.id],
        );
        const current = updated.rows[0]!;
        if (!current.acceptedAAt || !current.acceptedBAt) return null;
        return finalize(client, current, userId);
      });
      return {
        state: await matchmaking.state(userId),
        debateId: debate?.id ?? null,
      };
    },

    async decline(userId: string, offerId: string) {
      await decline(userId, offerId);
      return matchmaking.state(userId);
    },

    async waiting(topicSlug: string) {
      const result = await database.query<{ side: Side; count: number }>(
        `SELECT t.side, count(*)::int AS count FROM matchmaking_tickets t
         JOIN topics tp ON tp.id = t.topic_id
         WHERE tp.slug = $1 AND tp.publication_state = 'published'
           AND t.status = 'searching' AND t.${fresh}
         GROUP BY t.side`,
        [topicSlug],
      );
      const count = (side: Side) =>
        result.rows.find((row) => row.side === side)?.count ?? 0;
      return { sideA: count("A"), sideB: count("B") };
    },

    // One pass of the 1-second job: expire offers, cancel no-shows, drop absent players, then pair
    // what remains.
    async sweep() {
      return runExclusiveDatabaseJob(
        database,
        "matchmaking",
        async (client) => {
          const due = await client.query<OfferRow>(
            `SELECT ${offerFields} FROM match_offers
           WHERE status = 'pending' AND deadline_at <= CURRENT_TIMESTAMP
           ORDER BY deadline_at LIMIT ${SWEEP_OFFERS} FOR UPDATE SKIP LOCKED`,
          );
          await retireOpenQueueRequests(client);
          const unanswered = await settleUnansweredNowChallenges(client);
          // Booked well ahead, a scheduled debate reminds both speakers shortly before it starts.
          const reminders = await client.query<{ id: string; status: string }>(
            `SELECT d.id, d.status FROM debates d
             WHERE d.status IN ('scheduled', 'ready') AND NOT d.is_demo
               AND d.scheduled_at BETWEEN CURRENT_TIMESTAMP
                 AND CURRENT_TIMESTAMP + make_interval(mins => ${REMINDER_MINUTES})
               AND d.scheduled_at > d.created_at + make_interval(mins => ${REMINDER_MINUTES})
               AND NOT EXISTS (SELECT 1 FROM event_history h
                 WHERE h.debate_id = d.id AND h.action = 'reminded')
             ORDER BY d.scheduled_at LIMIT 50 FOR UPDATE OF d SKIP LOCKED`,
          );
          for (const debate of reminders.rows)
            await remindScheduledDebate(client, debate.id, debate.status);
          for (const offer of due.rows) await expireOffer(client, offer);
          const noShows = await resolveNoShows(client);
          // A queue match must end before the player's next booking begins.
          const window = reservationFor(
            "now",
            new Date(),
            (await activeRules(client)).rules,
          );
          const booked = await client.query(
            `UPDATE matchmaking_tickets t SET status = 'closed', closed_reason = 'booking',
               updated_at = CURRENT_TIMESTAMP
             WHERE t.status = 'searching' AND EXISTS (
               SELECT 1 FROM event_participants p WHERE p.user_id = t.user_id AND p.active
                 AND tstzrange(COALESCE(p.reserved_from, '-infinity'),
                   COALESCE(p.reserved_until, 'infinity')) && tstzrange($1, $2))`,
            [window.from, window.until],
          );
          const stale = await client.query(
            `UPDATE matchmaking_tickets SET status = 'closed', closed_reason = 'stale',
             updated_at = CURRENT_TIMESTAMP
           WHERE status = 'searching' AND NOT (${fresh})`,
          );
          const topics = await client.query<{ topicId: string }>(
            `SELECT topic_id AS "topicId" FROM matchmaking_tickets
           WHERE status = 'searching' AND ${fresh}
           GROUP BY topic_id HAVING bool_or(side = 'A') AND bool_or(side = 'B')
           ORDER BY min(priority_at) LIMIT ${SWEEP_TOPICS}`,
          );
          let paired = 0;
          for (const { topicId } of topics.rows)
            while (await pairOldest(client, topicId, liveDebateCapacity))
              paired += 1;
          return {
            unanswered,
            reminded: reminders.rows.length,
            noShows,
            booked: booked.rowCount ?? 0,
            expired: due.rows.length,
            stale: stale.rowCount ?? 0,
            paired,
          };
        },
      );
    },

    async pruneExpired() {
      const result = await database.query(
        `DELETE FROM matchmaking_tickets WHERE id IN (
           SELECT id FROM matchmaking_tickets WHERE status IN ('matched', 'closed')
             AND updated_at < CURRENT_TIMESTAMP - make_interval(days => ${RETENTION_DAYS})
           LIMIT 1000)`,
      );
      return result.rowCount ?? 0;
    },
  });
  return matchmaking;
}
