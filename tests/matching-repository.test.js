import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMatchingRepository,
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";

const id = "11111111-1111-4111-8111-111111111111";
const topicId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const future = new Date(Date.now() + 3 * 60 * 60 * 1000);
const row = (rows = []) => ({ rows, rowCount: rows.length });

function fake(options = {}) {
  const queries = [];
  const state = {
    request: options.request ?? null,
    event: options.event ?? {
      id: eventId,
      slug: `debate-${eventId}`,
      status: "scheduled",
      publicationState: "published",
      topicId,
      proposition: "Should this be debated?",
      speakerAProfileId: "profile-1",
      speakerBProfileId: "profile-2",
      rulesVersion: "preview-1",
      rulesSnapshot: { financial_terms: "not_active" },
      scheduledAt: future,
      readyAAt: null,
      readyBAt: null,
      liveStartedAt: null,
      liveEndedAt: null,
      endedReason: null,
    },
  };
  async function query(sql, values = []) {
    queries.push([sql, values]);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return row();
    if (sql.includes("pg_advisory_xact_lock")) return row([{}]);
    if (sql.startsWith("SELECT id FROM public_profiles WHERE user_id"))
      return row(
        options.profileMissing ? [] : [{ id: `profile-${values[0]}` }],
      );
    if (sql.startsWith("SELECT 1 FROM event_participants WHERE user_id"))
      return row(
        sql.includes("debate_id = $2")
          ? [{}]
          : options.activeUser === values[0]
            ? [{}]
            : [],
      );
    if (sql.startsWith("SELECT 1 FROM match_requests WHERE initiator_user_id"))
      return row(options.outgoing ? [{}] : []);
    if (sql.startsWith("SELECT id FROM topics WHERE slug"))
      return row(options.topicMissing ? [] : [{ id: topicId }]);
    if (sql.startsWith("SELECT 1 FROM topics WHERE id"))
      return row(options.topicMissing ? [] : [{}]);
    if (sql.startsWith('SELECT user_id AS "userId" FROM public_profiles'))
      return row(
        options.targetMissing ? [] : [{ userId: options.targetId ?? "2" }],
      );
    if (sql.startsWith("INSERT INTO match_requests")) {
      state.request = {
        id,
        kind: values[0],
        status: "open",
        initiatorUserId: values[1],
        targetUserId: values[2],
        topicId,
        topicSlug: "civil-ai",
        proposition: values[4],
        requestedSide: values[5],
        scheduledAt: values[6],
        expiresAt: values[7],
        debateId: null,
        debateSlug: null,
      };
      return row([{ id }]);
    }
    if (
      sql.includes("FROM match_requests r JOIN topics t") &&
      sql.includes("WHERE r.id = $1")
    )
      return row(
        state.request?.id === values[0]
          ? [
              {
                ...state.request,
                debateSlug:
                  state.request.debateId === state.event.id
                    ? state.event.slug
                    : null,
              },
            ]
          : [],
      );
    if (sql.startsWith("SELECT version, rules FROM event_rule_versions"))
      return row(
        options.ruleMissing
          ? []
          : [
              {
                version: "preview-1",
                rules: { financial_terms: "not_active" },
              },
            ],
      );
    if (sql.startsWith("INSERT INTO debates")) {
      state.event = {
        ...state.event,
        slug: values[0],
        topicId: values[1],
        proposition: values[2],
        speakerAProfileId: values[3],
        speakerBProfileId: values[4],
        scheduledAt: values[7],
      };
      return row([state.event]);
    }
    if (
      sql.startsWith("INSERT INTO event_participants") ||
      sql.startsWith("INSERT INTO event_history") ||
      sql.startsWith("INSERT INTO account_notifications")
    )
      return row();
    if (sql.startsWith("UPDATE match_requests SET status = 'accepted'")) {
      state.request.status = "accepted";
      state.request.debateId = values[1];
      return row();
    }
    if (sql.startsWith("UPDATE match_requests SET status = 'conflicted'"))
      return row(options.conflicted ?? []);
    if (sql.startsWith("UPDATE match_requests SET status = 'expired'"))
      return row(options.expired ?? []);
    if (sql.startsWith("UPDATE match_requests SET status = $2")) {
      state.request.status = values[1];
      return row();
    }
    if (sql.startsWith("INSERT INTO topics"))
      return row([{ id: topicId, slug: values[1], publicationState: "draft" }]);
    if (sql.startsWith("SELECT id, slug, title, summary, side_a_label"))
      return row([{ id: topicId }]);
    if (sql.startsWith("UPDATE topics SET publication_state"))
      return row(
        options.topicMissing
          ? []
          : [{ id: topicId, publicationState: "published" }],
      );
    if (
      sql.includes("FROM match_requests r JOIN topics t") &&
      sql.includes("ORDER BY r.created_at")
    )
      return row(
        state.request
          ? [
              {
                ...state.request,
                debateSlug:
                  state.request.debateId === state.event.id
                    ? state.event.slug
                    : null,
              },
            ]
          : [],
      );
    if (
      sql.startsWith("SELECT id, slug, status, publication_state") &&
      sql.includes("FROM debates WHERE id IN")
    )
      return row([state.event]);
    if (
      sql.startsWith("SELECT id, slug, status, publication_state") &&
      sql.includes("FROM debates WHERE id = $1")
    )
      return row(options.eventMissing ? [] : [state.event]);
    if (sql.startsWith("SELECT id, action, from_status"))
      return row([{ action: "scheduled" }]);
    if (sql.startsWith("SELECT id, event_type AS"))
      return row([{ id: "1", message: "Update" }]);
    if (sql.startsWith("UPDATE account_notifications"))
      return row(values[0] === "1" ? [{ id: "1" }] : []);
    if (
      sql.startsWith(
        'SELECT state, recording_status AS "recordingStatus" FROM debate_media',
      )
    )
      return row([
        {
          state: state.event.status === "ended" ? "ended" : "running",
          recordingStatus:
            state.event.status === "ended" ? "ready" : "recording",
        },
      ]);
    if (sql.startsWith("SELECT side FROM event_participants"))
      return row(
        options.notParticipant
          ? []
          : [{ side: options.side ?? (values[1] === "2" ? "B" : "A") }],
      );
    if (
      sql.startsWith("UPDATE debates SET ready_a_at") ||
      sql.startsWith("UPDATE debates SET ready_b_at")
    ) {
      const side = sql.includes("ready_a_at = CURRENT_TIMESTAMP") ? "A" : "B";
      state.event[side === "A" ? "readyAAt" : "readyBAt"] = new Date();
      if (state.event.readyAAt && state.event.readyBAt)
        state.event.status = "ready";
      return row([state.event]);
    }
    if (sql.startsWith("UPDATE debates SET status = $2")) {
      state.event = { ...state.event, status: values[1] };
      if (values[2] === "start") state.event.liveStartedAt = new Date();
      if (values[2] === "end") state.event.liveEndedAt = new Date();
      if (values[2] === "reschedule") {
        state.event.scheduledAt = values[3];
        state.event.readyAAt = null;
        state.event.readyBAt = null;
      }
      return row([state.event]);
    }
    if (sql.startsWith("UPDATE event_participants SET active")) return row();
    if (sql.startsWith('SELECT user_id AS "userId" FROM event_participants'))
      return row([{ userId: "1" }, { userId: "2" }]);
    // Direct challenges (Decision 0011): open-challenge counts, presence and time proposals.
    if (sql.startsWith("SELECT count(*)::int AS count FROM match_requests"))
      return row([{ count: options.outgoing ? 1 : 0 }]);
    if (sql.startsWith("SELECT 1 FROM matchmaking_presence")) return row();
    if (
      sql.startsWith("INSERT INTO challenge_time_proposals") ||
      sql.startsWith("UPDATE challenge_time_proposals")
    )
      return row();
    if (
      sql.startsWith('SELECT id, proposed_by AS "proposedBy"') ||
      sql.startsWith('SELECT id, request_id AS "requestId"')
    )
      return row(options.proposals ?? []);
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { repository: createMatchingRepository(pool), queries, state };
}

const direct = {
  kind: "direct",
  topicSlug: "civil-ai",
  targetHandle: "other-speaker",
  proposition: "Should this be debated?",
  requestedSide: "A",
  scheduledAt: future,
};

describe("matching repository transaction boundaries", () => {
  it("creates a private topic, lists it, and publishes only the owned draft", async () => {
    const { repository, queries } = fake();
    assert.equal(
      (
        await repository.createTopic("1", {
          slug: "civil-ai",
          title: "Civil AI",
          summary: "A topic",
          sideALabel: "For",
          sideBLabel: "Against",
        })
      ).publicationState,
      "draft",
    );
    assert.equal((await repository.listOwnTopics("1")).length, 1);
    assert.equal(
      (await repository.publishTopic("1", "civil-ai")).publicationState,
      "published",
    );
    assert.equal((await repository.listRules()).version, "preview-1");
    assert.ok(
      queries.some(
        ([sql, params]) =>
          sql.includes("creator_user_id = $1") && params[0] === "1",
      ),
    );
  });

  it("opens a direct challenge under an account lock and creates a mapped event", async () => {
    const { repository, queries, state } = fake({
      conflicted: [{ id: "other", initiatorUserId: "3", targetUserId: "2" }],
    });
    const request = await repository.createRequest("1", direct);
    assert.equal(request.targetUserId, "2");
    const event = await repository.acceptRequest("2", id);
    assert.equal(event.speakerAProfileId, "profile-1");
    assert.equal(event.speakerBProfileId, "profile-2");
    assert.equal(state.request.status, "accepted");
    assert.ok(queries.some(([sql]) => sql.includes("pg_advisory_xact_lock")));
    assert.ok(
      queries.some(([sql]) =>
        sql.includes("UPDATE match_requests SET status = 'conflicted'"),
      ),
    );
    const requests = await repository.listRequests("1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].debateSlug, event.slug);
    assert.ok(
      queries.some(
        ([sql]) =>
          sql.includes("FROM match_requests r JOIN topics t") &&
          sql.includes("LEFT JOIN debates d ON d.id = r.debate_id") &&
          sql.includes('d.slug AS "debateSlug"'),
      ),
    );
    assert.equal((await repository.listEvents("1")).length, 1);
    assert.equal((await repository.getEvent(eventId)).id, eventId);
    assert.equal(await repository.isParticipant("1", eventId), true);
    assert.equal(
      (await repository.getEventHistory(eventId))[0].action,
      "scheduled",
    );
    assert.equal((await repository.listNotifications("1")).length, 1);
    assert.equal(await repository.markNotificationRead("1", "1"), true);
    assert.equal(await repository.markNotificationRead("1", "2"), false);
  });

  it("maps a queue entrant to the opposite side and closes the queue", async () => {
    const { repository, state } = fake();
    await repository.createRequest("1", {
      ...direct,
      kind: "queue",
      targetHandle: undefined,
      requestedSide: "B",
    });
    assert.equal((await repository.listQueue()).length, 1);
    const event = await repository.joinQueue("2", id);
    assert.equal(event.speakerAProfileId, "profile-2");
    assert.equal(event.speakerBProfileId, "profile-1");
    assert.equal(state.request.status, "accepted");
  });

  it("rejects missing profiles, active users, missing topics, duplicate outgoing requests, and self challenges", async () => {
    await assert.rejects(
      () =>
        fake({ profileMissing: true }).repository.createRequest("1", direct),
      MatchConflictError,
    );
    await assert.rejects(
      () => fake({ activeUser: "1" }).repository.createRequest("1", direct),
      MatchConflictError,
    );
    await assert.rejects(
      () => fake({ topicMissing: true }).repository.createRequest("1", direct),
      MatchNotFoundError,
    );
    await assert.rejects(
      () => fake({ outgoing: true }).repository.createRequest("1", direct),
      MatchConflictError,
    );
    await assert.rejects(
      () => fake({ targetMissing: true }).repository.createRequest("1", direct),
      MatchNotFoundError,
    );
    await assert.rejects(
      () => fake({ targetId: "1" }).repository.createRequest("1", direct),
      MatchConflictError,
    );
  });

  it("rejects stale, self, and unavailable acceptances without writing an event", async () => {
    const expired = fake();
    await expired.repository.createRequest("1", direct);
    expired.state.request.expiresAt = new Date(0);
    await assert.rejects(
      () => expired.repository.acceptRequest("2", id),
      MatchConflictError,
    );
    const self = fake();
    await self.repository.createRequest("1", {
      ...direct,
      kind: "queue",
      targetHandle: undefined,
    });
    await assert.rejects(
      () => self.repository.joinQueue("1", id),
      MatchConflictError,
    );
    const active = fake({ activeUser: "2" });
    await active.repository.createRequest("1", direct);
    await assert.rejects(
      () => active.repository.acceptRequest("2", id),
      MatchConflictError,
    );
    // A booking's time window comes from the active rules, so none means no request.
    const missingRule = fake({ ruleMissing: true });
    await assert.rejects(
      () => missingRule.repository.createRequest("1", direct),
      /no event rules are active/,
    );
    const wrongOwner = fake();
    await wrongOwner.repository.createRequest("1", direct);
    await assert.rejects(
      () => wrongOwner.repository.acceptRequest("3", id),
      MatchNotFoundError,
    );
    await assert.rejects(
      () => fake().repository.acceptRequest("2", id),
      MatchNotFoundError,
    );
    await assert.rejects(
      () => fake().repository.joinQueue("2", id),
      MatchNotFoundError,
    );
    const hiddenTopic = fake();
    await hiddenTopic.repository.createRequest("1", direct);
    const unavailable = fake({
      request: hiddenTopic.state.request,
      topicMissing: true,
    });
    await assert.rejects(
      () => unavailable.repository.acceptRequest("2", id),
      MatchConflictError,
    );
  });

  it("declines, withdraws, and expires requests with durable history", async () => {
    const declined = fake();
    await declined.repository.createRequest("1", direct);
    assert.equal(
      (await declined.repository.closeRequest("2", id, "declined")).status,
      "declined",
    );
    await assert.rejects(
      () => declined.repository.closeRequest("2", id, "declined"),
      MatchConflictError,
    );
    const withdrawn = fake();
    await withdrawn.repository.createRequest("1", direct);
    assert.equal(
      (await withdrawn.repository.closeRequest("1", id, "withdrawn")).status,
      "withdrawn",
    );
    await assert.rejects(
      () => withdrawn.repository.closeRequest("2", id, "withdrawn"),
      MatchNotFoundError,
    );
    const expiry = fake({
      expired: [{ id, initiatorUserId: "1", targetUserId: "2" }],
    });
    assert.equal(await expiry.repository.expireRequests(), 1);
  });

  it("records readiness and restricts lifecycle transitions", async () => {
    const { repository, state } = fake();
    assert.equal(
      (await repository.markReady("1", eventId)).status,
      "scheduled",
    );
    assert.equal((await repository.markReady("2", eventId)).status, "ready");
    assert.equal((await repository.markReady("1", eventId)).status, "ready");
    const scheduledAt = state.event.scheduledAt;
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "start",
          "speaker check complete",
        )
      ).status,
      "live",
    );
    assert.equal(state.event.scheduledAt, scheduledAt);
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "end",
          "debate complete",
        )
      ).status,
      "ended",
    );
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "replay",
          "recording attached",
        )
      ).status,
      "replay",
    );
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "void_review",
          "integrity incident",
        )
      ).status,
      "void_review",
    );
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "cancel",
          "review complete",
        )
      ).status,
      "cancelled",
    );
    await assert.rejects(
      () => repository.operatorTransition("9", eventId, "start", "closed"),
      MatchConflictError,
    );
  });

  it("requires a participant for readiness and applies reschedule/no-show policy", async () => {
    await assert.rejects(
      () => fake({ eventMissing: true }).repository.markReady("1", eventId),
      MatchNotFoundError,
    );
    await assert.rejects(
      () =>
        fake({ eventMissing: true }).repository.operatorTransition(
          "9",
          eventId,
          "start",
          "missing event",
        ),
      MatchNotFoundError,
    );
    await assert.rejects(
      () => fake({ notParticipant: true }).repository.markReady("8", eventId),
      MatchNotFoundError,
    );
    const { repository, state } = fake();
    await assert.rejects(
      () =>
        repository.operatorTransition(
          "9",
          eventId,
          "no_show",
          "missing speaker",
        ),
      MatchConflictError,
    );
    await assert.rejects(
      () =>
        repository.operatorTransition(
          "9",
          eventId,
          "reschedule",
          "new time",
          new Date(),
        ),
      MatchConflictError,
    );
    const newTime = new Date(Date.now() + 4 * 60 * 60 * 1000);
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "reschedule",
          "new time",
          newTime,
        )
      ).scheduledAt,
      newTime,
    );
    state.event.scheduledAt = new Date(Date.now() - 20 * 60 * 1000);
    assert.equal(
      (
        await repository.operatorTransition(
          "9",
          eventId,
          "no_show",
          "missing speaker",
        )
      ).status,
      "cancelled",
    );
  });
});
