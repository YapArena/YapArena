import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { assertDebaterSettings } from "../transcription/debater-settings.ts";
import {
  BOOKING_LEAD_SECONDS,
  CHALLENGE_PENDING_DAYS,
  DEFAULT_MAXIMUM_DURATION_SECONDS,
  NOW_RESPONSE_SECONDS,
  ONLINE_SECONDS,
  OPEN_CHALLENGES_LIMIT,
  QUEUE_JOIN_SECONDS,
  SCHEDULED_JOIN_SECONDS,
} from "./timings.ts";

export class MatchConflictError extends Error {}
export class MatchNotFoundError extends Error {}

type Side = "A" | "B";
type RequestKind = "direct" | "queue";
type RequestStatus =
  "open" | "accepted" | "declined" | "withdrawn" | "expired" | "conflicted";

export interface MatchRequest {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  initiatorUserId: string;
  targetUserId: string | null;
  topicId: string;
  topicSlug: string;
  sideALabel: string;
  sideBLabel: string;
  proposition: string;
  requestedSide: Side;
  // The agreed time, or the earliest proposed one; null for a "now" challenge.
  scheduledAt: Date | null;
  expiresAt: Date;
  debateId: string | null;
  debateSlug: string | null;
  createdAt: Date;
  mode?: "now" | "scheduled";
  // While set and in the future, an online target is answering a "now" challenge.
  respondBy?: Date | null;
}

export interface TimeProposal {
  id: string;
  proposedBy: string;
  startsAt: Date;
}

export interface EventRecord {
  id: string;
  slug: string;
  status: string;
  publicationState: string;
  topicId: string;
  proposition: string;
  speakerAProfileId: string | null;
  speakerBProfileId: string | null;
  rulesVersion: string;
  rulesSnapshot: object;
  scheduledAt: Date | null;
  readyAAt: Date | null;
  readyBAt: Date | null;
  liveStartedAt: Date | null;
  liveEndedAt: Date | null;
  endedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const requestFields = `r.id, r.kind, r.status, r.initiator_user_id AS "initiatorUserId",
  r.target_user_id AS "targetUserId", r.topic_id AS "topicId", t.slug AS "topicSlug",
  t.side_a_label AS "sideALabel", t.side_b_label AS "sideBLabel",
  r.proposition, r.requested_side AS "requestedSide", r.scheduled_at AS "scheduledAt",
  r.expires_at AS "expiresAt", r.debate_id AS "debateId",
  d.slug AS "debateSlug", r.created_at AS "createdAt", r.mode,
  r.respond_by AS "respondBy"`;
const eventFields = `id, slug, status, publication_state AS "publicationState",
  topic_id AS "topicId", proposition, speaker_a_profile_id AS "speakerAProfileId",
  speaker_b_profile_id AS "speakerBProfileId", rules_version AS "rulesVersion",
  rules_snapshot AS "rulesSnapshot", scheduled_at AS "scheduledAt",
  ready_a_at AS "readyAAt", ready_b_at AS "readyBAt",
  live_started_at AS "liveStartedAt", live_ended_at AS "liveEndedAt",
  ended_reason AS "endedReason", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function lockUsers(client: PoolClient, ...ids: string[]) {
  for (const id of [...new Set(ids)].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  )) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `match:${id}`,
    ]);
  }
}

export async function profileFor(client: PoolClient, userId: string) {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM public_profiles WHERE user_id = $1 AND publication_state = 'published' AND is_demo = false",
    [userId],
  );
  if (!result.rows[0])
    throw new MatchConflictError("a published participant profile is required");
  return result.rows[0].id;
}

export interface Reservation {
  from: Date;
  until: Date;
}

/** The enabled platform rule version, which every new debate snapshots. */
export async function activeRules(client: PoolClient) {
  const rule = await client.query<{ version: string; rules: object }>(
    "SELECT version, rules FROM event_rule_versions WHERE enabled ORDER BY created_at DESC LIMIT 1",
  );
  if (!rule.rows[0]) throw new MatchConflictError("no event rules are active");
  return rule.rows[0];
}

function maximumSeconds(rules: object) {
  const value =
    "maximum_duration_seconds" in rules
      ? rules.maximum_duration_seconds
      : undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAXIMUM_DURATION_SECONDS;
}

/**
 * The time a seat holds (Decision 0011): a scheduled debate from a few minutes before its start
 * to its latest possible end; a queue match from now to the end of its join window plus the
 * rules' maximum duration.
 */
export function reservationFor(
  booking: "now" | "scheduled",
  start: Date,
  rules: object,
): Reservation {
  const lead = booking === "scheduled" ? BOOKING_LEAD_SECONDS : 0;
  const join =
    booking === "scheduled" ? SCHEDULED_JOIN_SECONDS : QUEUE_JOIN_SECONDS;
  return {
    from: new Date(start.getTime() - lead * 1000),
    until: new Date(start.getTime() + (join + maximumSeconds(rules)) * 1000),
  };
}

// A player's seats must not overlap. A seat recorded before reservations has no window and
// blocks every time until its debate ends; a live debate can overrun its window after pauses,
// so it also blocks the next 15 minutes. Callers hold the player's lock (`lockUsers`).
export async function ensureAvailable(
  client: PoolClient,
  userId: string,
  reservation: Reservation,
) {
  const result = await client.query(
    `SELECT 1 FROM event_participants WHERE user_id = $1 AND active
       AND tstzrange(COALESCE(reserved_from, '-infinity'), GREATEST(
         COALESCE(reserved_until, 'infinity'),
         CASE WHEN EXISTS (SELECT 1 FROM debates WHERE debates.id = event_participants.debate_id
           AND debates.status = 'live') THEN CURRENT_TIMESTAMP + interval '15 minutes' END))
         && tstzrange($2, $3)
     LIMIT 1`,
    [userId, reservation.from, reservation.until],
  );
  if (result.rows[0])
    throw new MatchConflictError(
      "participant already has a debate at that time",
    );
}

async function record(
  client: PoolClient,
  subject: { debateId?: string; requestId?: string },
  actorId: string | null,
  action: string,
  from: string | null,
  to: string,
  reason: string | null = null,
) {
  await client.query(
    `INSERT INTO event_history (debate_id, request_id, actor_user_id, action, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      subject.debateId ?? null,
      subject.requestId ?? null,
      actorId,
      action,
      from,
      to,
      reason,
    ],
  );
}

async function notify(
  client: PoolClient,
  userId: string,
  type: string,
  message: string,
  subject: { debateId?: string; requestId?: string },
) {
  await client.query(
    `INSERT INTO account_notifications (user_id, event_type, message, debate_id, request_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      type,
      message,
      subject.debateId ?? null,
      subject.requestId ?? null,
    ],
  );
}

async function requestById(
  client: PoolClient,
  id: string,
  lock = false,
): Promise<MatchRequest | null> {
  const result = await client.query<MatchRequest>(
    `SELECT ${requestFields} FROM match_requests r JOIN topics t ON t.id = r.topic_id
     LEFT JOIN debates d ON d.id = r.debate_id
     WHERE r.id = $1${lock ? " FOR UPDATE OF r" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

// Creates a debate with both seats for an agreed pair, closes both players' other open requests
// and notifies them. Request acceptance and the live queue both end here (Decision 0011). The
// caller holds both players' locks (`lockUsers`).
export async function createPairedEvent(
  client: PoolClient,
  pair: {
    topicId: string;
    proposition: string;
    sideAUserId: string;
    sideBUserId: string;
    scheduledAt: Date;
    // A queue match starts now; a challenge is booked for its agreed time.
    booking: "now" | "scheduled";
    actorId: string;
    acceptedRequestId: string | null;
    notice: string;
  },
) {
  const aUser = pair.sideAUserId;
  const bUser = pair.sideBUserId;
  if (aUser === bUser)
    throw new MatchConflictError("participants must be distinct");
  const rule = await activeRules(client);
  const reservation = reservationFor(
    pair.booking,
    pair.scheduledAt,
    rule.rules,
  );
  await ensureAvailable(client, aUser, reservation);
  await ensureAvailable(client, bUser, reservation);
  const [aProfile, bProfile] = await Promise.all([
    profileFor(client, aUser),
    profileFor(client, bUser),
  ]);
  const topic = await client.query(
    "SELECT 1 FROM topics WHERE id = $1 AND publication_state = 'published'",
    [pair.topicId],
  );
  if (!topic.rows[0]) throw new MatchConflictError("topic is no longer public");
  const created = await client.query<EventRecord>(
    `INSERT INTO debates (slug, topic_id, proposition, speaker_a_profile_id,
       speaker_b_profile_id, status, publication_state, rules_version, rules_snapshot, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', 'published', $6, $7, $8)
     RETURNING ${eventFields}`,
    [
      `debate-${randomUUID()}`,
      pair.topicId,
      pair.proposition,
      aProfile,
      bProfile,
      rule.version,
      rule.rules,
      pair.scheduledAt,
    ],
  );
  const event = created.rows[0];
  if (!event) throw new Error("created event was not returned");
  await client.query(
    `INSERT INTO event_participants (debate_id, user_id, side, reserved_from, reserved_until)
     VALUES ($1, $2, 'A', $4, $5), ($1, $3, 'B', $4, $5)`,
    [event.id, aUser, bUser, reservation.from, reservation.until],
  );
  if (pair.acceptedRequestId)
    await client.query(
      "UPDATE match_requests SET status = 'accepted', debate_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [pair.acceptedRequestId, event.id],
    );
  const conflicted = await client.query<{
    id: string;
    initiatorUserId: string;
    targetUserId: string | null;
  }>(
    `UPDATE match_requests SET status = 'conflicted', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'open' AND id IS DISTINCT FROM $1::uuid AND
       (initiator_user_id = ANY($2::bigint[]) OR target_user_id = ANY($2::bigint[]))
       AND tstzrange(scheduled_at - make_interval(secs => $3),
         scheduled_at + make_interval(secs => $4)) && tstzrange($5, $6)
     RETURNING id, initiator_user_id AS "initiatorUserId", target_user_id AS "targetUserId"`,
    [
      pair.acceptedRequestId,
      [aUser, bUser],
      BOOKING_LEAD_SECONDS,
      SCHEDULED_JOIN_SECONDS + maximumSeconds(rule.rules),
      reservation.from,
      reservation.until,
    ],
  );
  for (const entry of conflicted.rows) {
    await record(
      client,
      { requestId: entry.id },
      pair.actorId,
      "conflicted",
      "open",
      "conflicted",
    );
    await notify(
      client,
      entry.initiatorUserId,
      "challenge.conflicted",
      "A debate request closed because a participant joined another event.",
      { requestId: entry.id },
    );
    if (entry.targetUserId)
      await notify(
        client,
        entry.targetUserId,
        "challenge.conflicted",
        "A debate challenge closed because a participant joined another event.",
        { requestId: entry.id },
      );
  }
  if (pair.acceptedRequestId)
    await record(
      client,
      { requestId: pair.acceptedRequestId },
      pair.actorId,
      "accepted",
      "open",
      "accepted",
    );
  await record(
    client,
    { debateId: event.id },
    pair.actorId,
    "scheduled",
    null,
    "scheduled",
  );
  await notify(client, aUser, "event.scheduled", pair.notice, {
    debateId: event.id,
  });
  await notify(client, bUser, "event.scheduled", pair.notice, {
    debateId: event.id,
  });
  return event;
}

// Cancels a debate that never went live because a speaker did not join in time, releasing both
// seats. Runs from the jobs worker with no actor (Decision 0011). Returns the speakers' user ids.
export async function cancelUnstartedDebate(
  client: PoolClient,
  debateId: string,
  fromStatus: string,
) {
  await client.query(
    `UPDATE debates SET status = 'cancelled', ended_reason = 'automatic_no_show',
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [debateId],
  );
  const speakers = await client.query<{ userId: string }>(
    `UPDATE event_participants SET active = false WHERE debate_id = $1
     RETURNING user_id AS "userId"`,
    [debateId],
  );
  await record(
    client,
    { debateId },
    null,
    "no_show",
    fromStatus,
    "cancelled",
    "A speaker did not join before the join window closed.",
  );
  for (const speaker of speakers.rows)
    await notify(
      client,
      speaker.userId,
      "event.no_show",
      "Your debate was cancelled because a speaker didn't join in time.",
      { debateId },
    );
  return speakers.rows.map((speaker) => speaker.userId);
}

// The open-request list is replaced by the live queue (Decision 0011): its open posts close with
// a notice the first time the queue runs.
export async function retireOpenQueueRequests(client: PoolClient) {
  const retired = await client.query<{ id: string; initiatorUserId: string }>(
    `UPDATE match_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'queue' AND status = 'open'
     RETURNING id, initiator_user_id AS "initiatorUserId"`,
  );
  for (const entry of retired.rows) {
    await record(
      client,
      { requestId: entry.id },
      null,
      "expired",
      "open",
      "expired",
      "The open request list was replaced by the live queue.",
    );
    await notify(
      client,
      entry.initiatorUserId,
      "challenge.expired",
      "Open requests were replaced by the live queue. Open a topic to queue on a side.",
      { requestId: entry.id },
    );
  }
  return retired.rows.length;
}

// Shortly before a scheduled debate, both speakers get an in-app reminder, once.
export async function remindScheduledDebate(
  client: PoolClient,
  debateId: string,
  status: string,
) {
  await record(client, { debateId }, null, "reminded", status, status);
  const speakers = await client.query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM event_participants WHERE debate_id = $1 AND active`,
    [debateId],
  );
  for (const speaker of speakers.rows)
    await notify(
      client,
      speaker.userId,
      "event.starting",
      "Your debate starts in a few minutes. Join now.",
      { debateId },
    );
}

// A "now" challenge nobody answered in time stays open: it can still be accepted while the
// challenger is online, or either player proposes a time.
export async function settleUnansweredNowChallenges(client: PoolClient) {
  const settled = await client.query<{
    id: string;
    initiatorUserId: string;
    targetUserId: string;
  }>(
    `UPDATE match_requests SET respond_by = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'open' AND respond_by IS NOT NULL AND respond_by <= CURRENT_TIMESTAMP
     RETURNING id, initiator_user_id AS "initiatorUserId", target_user_id AS "targetUserId"`,
  );
  for (const entry of settled.rows) {
    await record(
      client,
      { requestId: entry.id },
      null,
      "unanswered",
      "open",
      "open",
    );
    await notify(
      client,
      entry.initiatorUserId,
      "challenge.unanswered",
      "Your challenge to debate now wasn't answered in time. It stays open so you can agree a time.",
      { requestId: entry.id },
    );
    await notify(
      client,
      entry.targetUserId,
      "challenge.unanswered",
      "You missed a challenge to debate now. You can still accept it while they're online, or propose a time.",
      { requestId: entry.id },
    );
  }
  return settled.rows.length;
}

// A "now" challenge can reach a player seen on the site this recently.
export async function isOnline(client: PoolClient, userId: string) {
  const result = await client.query(
    `SELECT 1 FROM matchmaking_presence WHERE user_id = $1
       AND seen_at > CURRENT_TIMESTAMP - make_interval(secs => ${ONLINE_SECONDS})`,
    [userId],
  );
  return Boolean(result.rows[0]);
}

async function openProposals(client: PoolClient, requestId: string) {
  const result = await client.query<TimeProposal>(
    `SELECT id, proposed_by AS "proposedBy", starts_at AS "startsAt"
     FROM challenge_time_proposals WHERE request_id = $1 AND status = 'open'
     ORDER BY starts_at FOR UPDATE`,
    [requestId],
  );
  return result.rows;
}

async function addProposals(
  client: PoolClient,
  requestId: string,
  proposerId: string,
  times: readonly Date[],
) {
  for (const time of times)
    await client.query(
      `INSERT INTO challenge_time_proposals (request_id, proposed_by, starts_at, status)
       VALUES ($1, $2, $3, 'open')`,
      [requestId, proposerId, time],
    );
}

async function completeMatch(
  client: PoolClient,
  request: MatchRequest,
  secondUserId: string,
  actorId: string,
  booking: { mode: "now" | "scheduled"; at: Date | null } = {
    mode: "scheduled",
    at: request.scheduledAt,
  },
) {
  if (
    request.status !== "open" ||
    new Date(request.expiresAt).getTime() <= Date.now()
  )
    throw new MatchConflictError("request is no longer open");
  if (request.initiatorUserId === secondUserId)
    throw new MatchConflictError("participants must be distinct");
  if (!booking.at) throw new MatchConflictError("propose a time first");
  return createPairedEvent(client, {
    topicId: request.topicId,
    proposition: request.proposition,
    sideAUserId:
      request.requestedSide === "A" ? request.initiatorUserId : secondUserId,
    sideBUserId:
      request.requestedSide === "B" ? request.initiatorUserId : secondUserId,
    scheduledAt: booking.at,
    booking: booking.mode,
    actorId,
    acceptedRequestId: request.id,
    notice:
      booking.mode === "now"
        ? "Your debate is ready. Join now."
        : "Your debate is scheduled.",
  });
}

export function createMatchingRepository(
  database: Pool,
  {
    // While the live outline is on, a player chooses a debate language and consents to
    // transcription before sending, joining or accepting a debate (Decisions 0011 and 0012).
    requireDebaterSettings = false,
  }: { requireDebaterSettings?: boolean } = {},
) {
  const debaterReady = async (client: PoolClient, userId: string) => {
    if (requireDebaterSettings) await assertDebaterSettings(client, userId);
  };
  return Object.freeze({
    async createTopic(
      userId: string,
      input: {
        slug: string;
        title: string;
        summary: string;
        sideALabel: string;
        sideBLabel: string;
      },
    ) {
      const result = await database.query(
        `INSERT INTO topics (creator_user_id, slug, title, summary, side_a_label, side_b_label)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug, title, summary, side_a_label AS "sideALabel",
           side_b_label AS "sideBLabel", publication_state AS "publicationState"`,
        [
          userId,
          input.slug,
          input.title,
          input.summary,
          input.sideALabel,
          input.sideBLabel,
        ],
      );
      return result.rows[0];
    },
    async listOwnTopics(userId: string) {
      const result = await database.query(
        `SELECT id, slug, title, summary, side_a_label AS "sideALabel",
           side_b_label AS "sideBLabel", publication_state AS "publicationState"
         FROM topics WHERE creator_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );
      return result.rows;
    },
    async publishTopic(userId: string, slug: string) {
      const result = await database.query(
        `UPDATE topics SET publication_state = 'published', updated_at = CURRENT_TIMESTAMP
         WHERE creator_user_id = $1 AND slug = $2 AND publication_state = 'draft' AND is_demo = false
         RETURNING id, slug, title, publication_state AS "publicationState"`,
        [userId, slug],
      );
      return result.rows[0] ?? null;
    },
    async listRules() {
      const result = await database.query(
        "SELECT version, rules FROM event_rule_versions WHERE enabled ORDER BY created_at DESC LIMIT 1",
      );
      return result.rows[0] ?? null;
    },
    async createRequest(
      userId: string,
      input: {
        kind: RequestKind;
        topicSlug: string;
        targetHandle?: string;
        proposition: string;
        requestedSide: Side;
        // The open list's single time, or a challenge's only proposed time.
        scheduledAt?: Date;
        // A direct challenge is either "now" or proposes one to three times (Decision 0011).
        mode?: "now" | "scheduled";
        proposedTimes?: readonly Date[];
      },
    ) {
      const mode =
        input.kind === "direct" ? (input.mode ?? "scheduled") : "scheduled";
      const times =
        mode === "now"
          ? []
          : [
              ...(input.proposedTimes?.length
                ? input.proposedTimes
                : input.scheduledAt
                  ? [input.scheduledAt]
                  : []),
            ].sort((a, b) => a.getTime() - b.getTime());
      if (mode === "scheduled" && !times.length)
        throw new MatchConflictError("propose at least one time");
      return withTransaction(database, async (client) => {
        await lockUsers(client, userId);
        await profileFor(client, userId);
        await debaterReady(client, userId);
        const { rules } = await activeRules(client);
        if (mode === "now")
          await ensureAvailable(
            client,
            userId,
            reservationFor("now", new Date(), rules),
          );
        for (const time of times)
          await ensureAvailable(
            client,
            userId,
            reservationFor("scheduled", time, rules),
          );
        const expired = await client.query<{
          id: string;
          targetUserId: string | null;
        }>(
          `UPDATE match_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP
           WHERE initiator_user_id = $1 AND status = 'open' AND expires_at <= CURRENT_TIMESTAMP
           RETURNING id, target_user_id AS "targetUserId"`,
          [userId],
        );
        for (const entry of expired.rows) {
          await record(
            client,
            { requestId: entry.id },
            null,
            "expired",
            "open",
            "expired",
          );
          if (entry.targetUserId)
            await notify(
              client,
              entry.targetUserId,
              "challenge.expired",
              "A debate challenge expired.",
              { requestId: entry.id },
            );
        }
        // One open post on the old list; several open challenges (Decision 0011).
        const outgoing = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM match_requests WHERE initiator_user_id = $1
             AND status = 'open' AND kind = $2`,
          [userId, input.kind],
        );
        const open = outgoing.rows[0]?.count ?? 0;
        if (input.kind === "queue" && open > 0)
          throw new MatchConflictError("an outgoing request is already open");
        if (open >= OPEN_CHALLENGES_LIMIT)
          throw new MatchConflictError(
            `you can have ${OPEN_CHALLENGES_LIMIT} open challenges at a time`,
          );
        const topic = await client.query<{ id: string }>(
          "SELECT id FROM topics WHERE slug = $1 AND publication_state = 'published'",
          [input.topicSlug],
        );
        if (!topic.rows[0]) throw new MatchNotFoundError("topic not found");
        let targetId: string | null = null;
        if (input.kind === "direct") {
          const target = await client.query<{ userId: string }>(
            `SELECT user_id AS "userId" FROM public_profiles
             WHERE handle = $1 AND publication_state = 'published' AND is_demo = false AND user_id IS NOT NULL`,
            [input.targetHandle],
          );
          targetId = target.rows[0]?.userId ?? null;
          if (!targetId) throw new MatchNotFoundError("participant not found");
          if (targetId === userId)
            throw new MatchConflictError("participants must be distinct");
          const already = await client.query(
            `SELECT 1 FROM match_requests WHERE initiator_user_id = $1 AND target_user_id = $2
               AND status = 'open' AND kind = 'direct'`,
            [userId, targetId],
          );
          if (already.rows[0])
            throw new MatchConflictError(
              "you already have an open challenge with this player",
            );
        }
        const scheduledAt = times[0] ?? null;
        const expiresAt =
          input.kind === "direct"
            ? new Date(
                Date.now() + CHALLENGE_PENDING_DAYS * 24 * 60 * 60 * 1000,
              )
            : new Date(
                Math.min(
                  Date.now() + 24 * 60 * 60 * 1000,
                  scheduledAt!.getTime() - 30 * 60 * 1000,
                ),
              );
        // A "now" challenge waits two minutes for an online target; otherwise it is pending.
        const answering =
          mode === "now" &&
          targetId !== null &&
          (await isOnline(client, targetId));
        const respondBy = answering
          ? new Date(Date.now() + NOW_RESPONSE_SECONDS * 1000)
          : null;
        const created = await client.query<MatchRequest>(
          `INSERT INTO match_requests (kind, status, initiator_user_id, target_user_id,
             topic_id, proposition, requested_side, scheduled_at, expires_at, mode, respond_by)
           VALUES ($1, 'open', $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            input.kind,
            userId,
            targetId,
            topic.rows[0].id,
            input.proposition,
            input.requestedSide,
            scheduledAt,
            expiresAt,
            mode,
            respondBy,
          ],
        );
        const request = await requestById(client, created.rows[0]!.id);
        if (!request) throw new Error("created request was not returned");
        if (input.kind === "direct")
          await addProposals(client, request.id, userId, times);
        await record(
          client,
          { requestId: request.id },
          userId,
          "opened",
          null,
          "open",
        );
        if (targetId)
          await notify(
            client,
            targetId,
            "challenge.received",
            answering
              ? "You are challenged to debate now. Answer within two minutes."
              : "You have a new debate challenge.",
            { requestId: request.id },
          );
        return request;
      });
    },
    // Either player answers the other's latest times with one to three new ones.
    async proposeTimes(
      userId: string,
      requestId: string,
      times: readonly Date[],
    ) {
      return withTransaction(database, async (client) => {
        const initial = await requestById(client, requestId);
        if (
          !initial ||
          initial.kind !== "direct" ||
          (initial.initiatorUserId !== userId &&
            initial.targetUserId !== userId)
        )
          throw new MatchNotFoundError("request not found");
        await lockUsers(client, initial.initiatorUserId, initial.targetUserId!);
        const request = await requestById(client, requestId, true);
        if (
          !request ||
          request.status !== "open" ||
          new Date(request.expiresAt).getTime() <= Date.now()
        )
          throw new MatchConflictError("request is no longer open");
        const { rules } = await activeRules(client);
        const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
        for (const time of sorted)
          await ensureAvailable(
            client,
            userId,
            reservationFor("scheduled", time, rules),
          );
        await client.query(
          `UPDATE challenge_time_proposals SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
           WHERE request_id = $1 AND status = 'open'`,
          [requestId],
        );
        await addProposals(client, requestId, userId, sorted);
        await client.query(
          `UPDATE match_requests SET scheduled_at = $2, mode = 'scheduled', respond_by = NULL,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [requestId, sorted[0]],
        );
        await record(client, { requestId }, userId, "proposed", "open", "open");
        await notify(
          client,
          userId === request.initiatorUserId
            ? request.targetUserId!
            : request.initiatorUserId,
          "challenge.proposed",
          "New times were proposed for your debate challenge.",
          { requestId },
        );
        return (await requestById(client, requestId))!;
      });
    },
    // Published players matching a handle prefix or part of a display name.
    async searchPeople(userId: string, query: string) {
      const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
      const result = await database.query<{
        handle: string;
        displayName: string;
      }>(
        `SELECT handle, display_name AS "displayName" FROM public_profiles
         WHERE publication_state = 'published' AND is_demo = false AND user_id IS NOT NULL
           AND user_id <> $1 AND (handle LIKE $2 OR display_name ILIKE $3)
         ORDER BY handle = $4 DESC, handle LIMIT 8`,
        [
          userId,
          `${escaped.toLowerCase()}%`,
          `%${escaped}%`,
          query.toLowerCase(),
        ],
      );
      return result.rows;
    },
    // A player's requests, with both players' names and the debate's status for the challenge list.
    async listRequests(userId: string) {
      const result = await database.query<
        MatchRequest & {
          initiatorHandle: string | null;
          initiatorName: string | null;
          targetHandle: string | null;
          targetName: string | null;
          debateStatus: string | null;
        }
      >(
        `SELECT ${requestFields}, d.status AS "debateStatus", pi.handle AS "initiatorHandle",
           pi.display_name AS "initiatorName", pt.handle AS "targetHandle",
           pt.display_name AS "targetName"
         FROM match_requests r JOIN topics t ON t.id = r.topic_id
         LEFT JOIN debates d ON d.id = r.debate_id
         LEFT JOIN public_profiles pi ON pi.user_id = r.initiator_user_id
         LEFT JOIN public_profiles pt ON pt.user_id = r.target_user_id
         WHERE r.initiator_user_id = $1 OR r.target_user_id = $1
         ORDER BY r.created_at DESC LIMIT 50`,
        [userId],
      );
      const proposals = await database.query<
        TimeProposal & { requestId: string }
      >(
        `SELECT id, request_id AS "requestId", proposed_by AS "proposedBy", starts_at AS "startsAt"
         FROM challenge_time_proposals WHERE request_id = ANY($1::uuid[]) AND status = 'open'
         ORDER BY starts_at`,
        [result.rows.map((request) => request.id)],
      );
      return result.rows.map((request) => ({
        ...request,
        proposals: proposals.rows
          .filter((proposal) => proposal.requestId === request.id)
          .map(({ id, proposedBy, startsAt }) => ({
            id,
            proposedBy,
            startsAt,
          })),
      }));
    },
    async listQueue() {
      const result = await database.query<MatchRequest>(
        `SELECT ${requestFields} FROM match_requests r JOIN topics t ON t.id = r.topic_id
         LEFT JOIN debates d ON d.id = r.debate_id
         WHERE r.kind = 'queue' AND r.status = 'open' AND r.expires_at > CURRENT_TIMESTAMP
           AND t.publication_state = 'published'
         ORDER BY r.created_at LIMIT 50`,
      );
      return result.rows;
    },
    // The target accepts "now", or either player accepts one of the other's proposed times.
    async acceptRequest(
      userId: string,
      requestId: string,
      choice: { proposalId?: string } = {},
    ) {
      return withTransaction(database, async (client) => {
        const initial = await requestById(client, requestId);
        const participant = (request: MatchRequest | null) =>
          request?.kind === "direct" &&
          (request.targetUserId === userId ||
            request.initiatorUserId === userId);
        if (!initial || !participant(initial))
          throw new MatchNotFoundError("request not found");
        await lockUsers(client, initial.initiatorUserId, initial.targetUserId!);
        const request = await requestById(client, requestId, true);
        if (!request || !participant(request))
          throw new MatchNotFoundError("request not found");
        await debaterReady(client, userId);
        const target = request.targetUserId!;
        if (request.mode === "now" && !choice.proposalId) {
          if (userId !== target)
            throw new MatchConflictError("wait for the other player to accept");
          const answering =
            request.respondBy &&
            new Date(request.respondBy).getTime() > Date.now();
          if (!answering && !(await isOnline(client, request.initiatorUserId)))
            throw new MatchConflictError(
              "the other player isn't online now; propose a time instead",
            );
          return completeMatch(client, request, target, userId, {
            mode: "now",
            at: new Date(),
          });
        }
        const proposals = await openProposals(client, requestId);
        if (!proposals.length) {
          // Requests opened before time proposals: the target accepts the original time.
          if (userId !== target)
            throw new MatchConflictError("wait for the other player to accept");
          return completeMatch(client, request, target, userId);
        }
        const chosen = choice.proposalId
          ? proposals.find((proposal) => proposal.id === choice.proposalId)
          : proposals.length === 1
            ? proposals[0]
            : undefined;
        if (!chosen)
          throw new MatchConflictError(
            choice.proposalId
              ? "that time is no longer proposed"
              : "choose one of the proposed times",
          );
        if (chosen.proposedBy === userId)
          throw new MatchConflictError(
            "the other player has to accept the times you proposed",
          );
        if (new Date(chosen.startsAt).getTime() <= Date.now() + 5 * 60 * 1000)
          throw new MatchConflictError("that time has passed; propose another");
        const event = await completeMatch(client, request, target, userId, {
          mode: "scheduled",
          at: new Date(chosen.startsAt),
        });
        await client.query(
          `UPDATE challenge_time_proposals SET status = CASE WHEN id = $2 THEN 'accepted'
             ELSE 'closed' END, updated_at = CURRENT_TIMESTAMP
           WHERE request_id = $1 AND status = 'open'`,
          [requestId, chosen.id],
        );
        await client.query(
          "UPDATE match_requests SET scheduled_at = $2 WHERE id = $1",
          [requestId, chosen.startsAt],
        );
        return event;
      });
    },
    async joinQueue(userId: string, requestId: string) {
      return withTransaction(database, async (client) => {
        const initial = await requestById(client, requestId);
        if (!initial || initial.kind !== "queue")
          throw new MatchNotFoundError("queue entry not found");
        await lockUsers(client, initial.initiatorUserId, userId);
        const request = await requestById(client, requestId, true);
        if (!request || request.kind !== "queue")
          throw new MatchNotFoundError("queue entry not found");
        await debaterReady(client, userId);
        return completeMatch(client, request, userId, userId);
      });
    },
    async closeRequest(
      userId: string,
      requestId: string,
      action: "declined" | "withdrawn",
    ) {
      return withTransaction(database, async (client) => {
        const request = await requestById(client, requestId, true);
        if (
          !request ||
          (action === "withdrawn"
            ? request.initiatorUserId !== userId
            : request.targetUserId !== userId)
        )
          throw new MatchNotFoundError("request not found");
        if (request.status !== "open")
          throw new MatchConflictError("request is no longer open");
        await client.query(
          "UPDATE match_requests SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [requestId, action],
        );
        await record(client, { requestId }, userId, action, "open", action);
        await notify(
          client,
          action === "declined"
            ? request.initiatorUserId
            : (request.targetUserId ?? request.initiatorUserId),
          `challenge.${action}`,
          `A debate request was ${action}.`,
          { requestId },
        );
        return { ...request, status: action };
      });
    },
    async expireRequests() {
      return withTransaction(database, async (client) => {
        const expired = await client.query<{
          id: string;
          initiatorUserId: string;
          targetUserId: string | null;
        }>(
          `UPDATE match_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP
           WHERE status = 'open' AND expires_at <= CURRENT_TIMESTAMP
           RETURNING id, initiator_user_id AS "initiatorUserId", target_user_id AS "targetUserId"`,
        );
        for (const entry of expired.rows) {
          await record(
            client,
            { requestId: entry.id },
            null,
            "expired",
            "open",
            "expired",
          );
          await notify(
            client,
            entry.initiatorUserId,
            "challenge.expired",
            "Your debate request expired.",
            { requestId: entry.id },
          );
          if (entry.targetUserId)
            await notify(
              client,
              entry.targetUserId,
              "challenge.expired",
              "A debate challenge expired.",
              { requestId: entry.id },
            );
        }
        return expired.rows.length;
      });
    },
    async listEvents(userId: string) {
      const result = await database.query<EventRecord>(
        `SELECT ${eventFields} FROM debates WHERE id IN
           (SELECT debate_id FROM event_participants WHERE user_id = $1)
         ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );
      return result.rows;
    },
    async getEvent(id: string) {
      const result = await database.query<EventRecord>(
        `SELECT ${eventFields} FROM debates WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },
    async isParticipant(userId: string, eventId: string) {
      const result = await database.query(
        "SELECT 1 FROM event_participants WHERE user_id = $1 AND debate_id = $2",
        [userId, eventId],
      );
      return Boolean(result.rows[0]);
    },
    async getEventHistory(id: string) {
      const result = await database.query(
        `SELECT id, action, from_status AS "fromStatus", to_status AS "toStatus",
           reason, occurred_at AS "occurredAt" FROM event_history
         WHERE debate_id = $1 ORDER BY occurred_at, id LIMIT 100`,
        [id],
      );
      return result.rows;
    },
    async listNotifications(userId: string) {
      const result = await database.query(
        `SELECT id, event_type AS "eventType", message, debate_id AS "debateId",
           request_id AS "requestId", read_at AS "readAt", created_at AS "createdAt"
         FROM account_notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [userId],
      );
      return result.rows;
    },
    async markNotificationRead(userId: string, id: string) {
      const result = await database.query(
        "UPDATE account_notifications SET read_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING id",
        [id, userId],
      );
      return Boolean(result.rows[0]);
    },
    async markReady(userId: string, id: string) {
      return withTransaction(database, async (client) => {
        const event = await client.query<EventRecord>(
          `SELECT ${eventFields} FROM debates WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = event.rows[0];
        if (!current) throw new MatchNotFoundError("event not found");
        if (current.status !== "scheduled" && current.status !== "ready")
          throw new MatchConflictError("event is not awaiting readiness");
        const participant = await client.query<{ side: Side }>(
          "SELECT side FROM event_participants WHERE debate_id = $1 AND user_id = $2",
          [id, userId],
        );
        const side = participant.rows[0]?.side;
        if (!side) throw new MatchNotFoundError("event not found");
        const column = side === "A" ? "ready_a_at" : "ready_b_at";
        if (side === "A" ? current.readyAAt : current.readyBAt) return current;
        const result = await client.query<EventRecord>(
          `UPDATE debates SET ${column} = CURRENT_TIMESTAMP,
             status = CASE WHEN ${side === "A" ? "ready_b_at" : "ready_a_at"} IS NOT NULL THEN 'ready' ELSE status END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${eventFields}`,
          [id],
        );
        const updated = result.rows[0]!;
        await record(
          client,
          { debateId: id },
          userId,
          "participant_ready",
          current.status,
          updated.status,
        );
        if (updated.status === "ready") {
          const users = await client.query<{ userId: string }>(
            "SELECT user_id AS " +
              '"userId"' +
              " FROM event_participants WHERE debate_id = $1",
            [id],
          );
          for (const user of users.rows)
            await notify(
              client,
              user.userId,
              "event.ready",
              "Both speakers are ready.",
              { debateId: id },
            );
        }
        return updated;
      });
    },
    // A null actor is the system: automatic start (Decision 0011).
    async operatorTransition(
      actorId: string | null,
      id: string,
      action:
        | "start"
        | "end"
        | "replay"
        | "void_review"
        | "cancel"
        | "reschedule"
        | "no_show",
      reason: string,
      scheduledAt?: Date,
    ) {
      return withTransaction(database, async (client) => {
        const found = await client.query<EventRecord>(
          `SELECT ${eventFields} FROM debates WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const event = found.rows[0];
        if (!event) throw new MatchNotFoundError("event not found");
        const transitions: Record<string, readonly string[]> = {
          start: ["ready"],
          end: ["live"],
          replay: ["ended"],
          void_review: ["scheduled", "ready", "live", "ended", "replay"],
          cancel: ["scheduled", "ready", "void_review"],
          reschedule: ["scheduled", "ready"],
          no_show: ["scheduled", "ready"],
        };
        if (!transitions[action]!.includes(event.status))
          throw new MatchConflictError("invalid event transition");
        if (action === "start" || action === "end" || action === "replay") {
          const media = await client.query<{
            state: string;
            recordingStatus: string;
          }>(
            `SELECT state, recording_status AS "recordingStatus" FROM debate_media WHERE debate_id = $1`,
            [id],
          );
          const state = media.rows[0];
          if (
            action === "start" &&
            (state?.state !== "running" ||
              state.recordingStatus !== "recording")
          )
            throw new MatchConflictError(
              "active media recording required before live start",
            );
          if (action === "end" && !state)
            throw new MatchConflictError(
              "media session required before event end",
            );
          if (
            action === "replay" &&
            (state?.state !== "ended" || state.recordingStatus !== "ready")
          )
            throw new MatchConflictError(
              "verified recording required before replay",
            );
        }
        if (
          action === "reschedule" &&
          (!scheduledAt || scheduledAt.getTime() <= Date.now() + 60 * 60 * 1000)
        )
          throw new MatchConflictError(
            "new start must be at least one hour away",
          );
        if (
          action === "no_show" &&
          (new Date(event.scheduledAt!).getTime() + 15 * 60 * 1000 >
            Date.now() ||
            (event.readyAAt && event.readyBAt))
        )
          throw new MatchConflictError("no-show review is not eligible yet");
        const next =
          action === "start"
            ? "live"
            : action === "end"
              ? "ended"
              : action === "replay"
                ? "replay"
                : action === "void_review"
                  ? "void_review"
                  : action === "cancel" || action === "no_show"
                    ? "cancelled"
                    : "scheduled";
        const updated = await client.query<EventRecord>(
          `UPDATE debates SET status = $2, scheduled_at = CASE WHEN $3 = 'reschedule' THEN $4 ELSE scheduled_at END,
             ready_a_at = CASE WHEN $3 = 'reschedule' THEN NULL ELSE ready_a_at END,
             ready_b_at = CASE WHEN $3 = 'reschedule' THEN NULL ELSE ready_b_at END,
             live_started_at = CASE WHEN $3 = 'start' THEN CURRENT_TIMESTAMP ELSE live_started_at END,
             live_ended_at = CASE WHEN $3 = 'end' OR ($3 = 'void_review' AND status = 'live') THEN CURRENT_TIMESTAMP ELSE live_ended_at END,
             ended_reason = CASE WHEN $3 IN ('end', 'cancel', 'void_review', 'no_show') THEN $5 ELSE ended_reason END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${eventFields}`,
          [id, next, action, scheduledAt ?? null, reason],
        );
        if (
          next === "ended" ||
          next === "cancelled" ||
          (next === "void_review" && event.status === "live")
        )
          await client.query(
            "UPDATE event_participants SET active = false WHERE debate_id = $1",
            [id],
          );
        await record(
          client,
          { debateId: id },
          actorId,
          action,
          event.status,
          next,
          reason,
        );
        const users = await client.query<{ userId: string }>(
          `SELECT user_id AS "userId" FROM event_participants WHERE debate_id = $1`,
          [id],
        );
        for (const user of users.rows)
          await notify(
            client,
            user.userId,
            `event.${action}`,
            `Your debate was ${action === "reschedule" ? "rescheduled" : next.replace("_", " ")}.`,
            { debateId: id },
          );
        return updated.rows[0]!;
      });
    },
  });
}
