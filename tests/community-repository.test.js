import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCommunityRepository,
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
  CommunityRateError,
} from "../dist/features/community/repository.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const appealId = "33333333-3333-4333-8333-333333333333";
const now = new Date();
const event = {
  id: eventId,
  slug: "community-test",
  status: "live",
  proposition: "Test",
  topicTitle: "Topic",
  sideALabel: "For",
  sideBLabel: "Against",
  speakerA: "Alice",
  speakerB: "Bob",
  scheduledAt: now,
};
const caseRecord = {
  id: caseId,
  reporterUserId: "2",
  debateId: eventId,
  targetType: "chat",
  targetChatId: "10",
  reasonCode: "spam",
  detail: "Repeated promotion",
  status: "open",
  action: null,
  reviewerUserId: null,
  decisionReason: null,
  decisionNote: null,
  decidedAt: null,
  createdAt: now,
  subjectUserId: "1",
  chatBody: "Unsafe message",
  chatState: "open",
};
const appealRecord = {
  id: appealId,
  caseId,
  appellantUserId: "1",
  reason: "Please review",
  status: "open",
  reviewerUserId: null,
  decisionNote: null,
  decidedAt: null,
  createdAt: now,
};
const chat = {
  id: "10",
  debateId: eventId,
  authorUserId: "1",
  authorName: "Alice",
  body: "Hello",
  state: "visible",
  createdAt: now,
  clientMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  revision: "0",
};
const rows = (items = []) => ({ rows: items, rowCount: items.length });

function fake(options = {}) {
  const queries = [];
  const value = (key, fallback) => (key in options ? options[key] : fallback);
  const result = async (sql, parameters = []) => {
    queries.push([sql, parameters]);
    if (sql.includes(") candidates")) return rows([{ id: eventId }]);
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
      sql.includes("pg_advisory_xact_lock")
    )
      return rows();
    if (sql.includes("SELECT d.id FROM debates d JOIN topics"))
      return rows(value("missing", false) ? [] : [{ id: eventId }]);
    if (sql.includes("FROM debates d JOIN topics"))
      return rows(value("missing", false) ? [] : [event]);
    if (sql.includes("FROM debates WHERE id"))
      return rows(
        value("missing", false)
          ? []
          : [
              {
                id: eventId,
                slug: "community-test",
                status: value("eventStatus", "live"),
                publicationState: value("publicationState", "published"),
                isDemo: value("demo", false),
              },
            ],
      );
    if (sql.includes("COALESCE((SELECT state FROM event_chat_controls"))
      return rows([
        {
          likes: "2",
          liked: parameters[1] === "1",
          chatState: value("chatState", "open"),
        },
      ]);
    if (sql.includes("r.client_message_id = $3"))
      return rows(
        value("accepted", []).map((item) => ({
          ...item,
          payloadMatches: item.payloadMatches ?? item.body === parameters[3],
        })),
      );
    if (sql.includes("r.client_message_id=ANY($3::uuid[])"))
      return rows(value("accepted", []));
    if (sql.includes("m.id > $2") && sql.includes("FROM event_chat_messages m"))
      return rows(value("newChatRows", [chat]));
    if (sql.includes("m.id = ANY($2::bigint[])"))
      return rows(value("watchedChatRows", [chat]));
    if (
      sql.includes("FROM event_chat_messages m") &&
      sql.includes("m.state = 'visible'")
    )
      return rows(value("chatRows", [chat]));
    if (
      sql.includes("FROM community_restrictions") &&
      sql.includes("WHERE user_id")
    )
      // The shared lookup reads the latest expiry; a case decision checks for any row.
      return sql.includes("max(expires_at)")
        ? rows([
            {
              expiresAt: value("restricted", false)
                ? new Date(Date.now() + 60_000)
                : null,
            },
          ])
        : rows(value("restricted", false) ? [{}] : []);
    if (sql.includes("FROM public_profiles WHERE user_id"))
      return rows(value("hasProfile", true) ? [{ authorName: "Alice" }] : []);
    if (sql.includes("SELECT state FROM event_chat_controls"))
      return rows([{ state: value("chatState", "open") }]);
    if (sql.includes("AS recent") && sql.includes("AS hourly"))
      return rows([
        {
          recent: String(value("recent", 0)),
          hourly: String(value("hourly", 0)),
          retryAfterSeconds: value("retryAfterSeconds", 10),
          retryAt: now,
        },
      ]);
    if (sql.includes("INSERT INTO event_chat_messages")) return rows([chat]);
    if (sql.includes("SELECT 1 FROM event_likes WHERE debate_id"))
      return rows(value("currentLike", false) ? [{}] : []);
    if (sql.includes("FROM event_like_changes") && sql.includes("AS total"))
      return rows([{ total: String(value("likeChanges", 0)) }]);
    if (sql.includes("SELECT COUNT(*)::text AS likes FROM event_likes"))
      return rows([{ likes: "1" }]);
    if (sql.includes("COUNT(*)::text AS total FROM moderation_cases"))
      return rows([{ total: String(value("reports", 0)) }]);
    if (
      sql.includes(
        "FROM event_chat_messages WHERE id = $1 AND state = 'visible'",
      )
    )
      return rows(
        value("chatTarget", { debateId: eventId, authorUserId: "1" })
          ? [value("chatTarget", { debateId: eventId, authorUserId: "1" })]
          : [],
      );
    if (sql.includes("INSERT INTO moderation_cases"))
      return rows([{ id: caseId }]);
    if (
      sql.includes("FROM moderation_cases c") &&
      sql.includes("WHERE c.id = $1")
    )
      return rows(
        value("caseMissing", false) ? [] : [value("caseRecord", caseRecord)],
      );
    if (
      sql.includes("FROM moderation_cases c") &&
      sql.includes("WHERE c.status")
    )
      return rows(value("cases", [caseRecord]));
    if (
      sql.includes("FROM moderation_cases c") &&
      sql.includes("WHERE c.reporter_user_id")
    )
      return rows(
        value("myCases", [
          { ...caseRecord, appealId: null, appealStatus: null },
        ]),
      );
    if (sql.includes("FROM event_participants"))
      return rows(value("ownEvent", false) ? [{}] : []);
    if (
      sql.includes("FROM community_restrictions") &&
      sql.includes("WHERE user_id")
    )
      return rows(value("activeRestriction", false) ? [{}] : []);
    if (sql.includes("SELECT 1 FROM moderation_appeals WHERE case_id"))
      return rows(value("existingAppeal", false) ? [{}] : []);
    if (sql.includes('SELECT case_id AS "caseId" FROM moderation_appeals'))
      return rows(value("appealMissing", false) ? [] : [{ caseId }]);
    if (sql.includes("FROM moderation_appeals WHERE id = $1 FOR UPDATE"))
      return rows([value("appealRecord", appealRecord)]);
    if (sql.includes("FROM moderation_appeals WHERE status = 'open'"))
      return rows(value("appeals", [appealRecord]));
    if (sql.includes("FROM moderation_appeals WHERE case_id"))
      return rows([appealRecord]);
    if (sql.includes("FROM community_audit_events WHERE case_id"))
      return rows([{ action: "reported" }]);
    if (sql.includes("INSERT INTO moderation_appeals"))
      return rows([{ id: appealId }]);
    if (sql.startsWith("UPDATE event_chat_messages"))
      return { rows: [], rowCount: value("chatChanged", true) ? 1 : 0 };
    if (sql.startsWith("UPDATE event_chat_controls"))
      return { rows: [], rowCount: value("controlChanged", true) ? 1 : 0 };
    if (sql.startsWith("DELETE FROM")) return { rows: [], rowCount: 1 };
    return rows();
  };
  const client = { query: result, release() {} };
  const pool = { query: result, connect: async () => client };
  return { community: createCommunityRepository(pool), queries };
}

describe("community repository policy", () => {
  it("shows each chat author's avatar without sending their handle", async () => {
    const { community } = fake({
      chatRows: [
        { ...chat, id: "3", authorHandle: "alice-a", authorAvatar: "yap-owl" },
        { ...chat, id: "2", authorHandle: "maya-chen", authorAvatar: null },
        {
          ...chat,
          id: "1",
          authorName: "Participant",
          authorHandle: null,
          authorAvatar: null,
        },
      ],
    });
    const { items } = await community.listChat(eventId);
    assert.deepEqual(
      items.map((item) => item.authorAvatarId),
      // Oldest first: none for "Participant", a handle's default, a choice.
      [null, "yap-critter", "yap-owl"],
    );
    for (const item of items) {
      assert.equal("authorHandle" in item, false);
      assert.equal("authorAvatar" in item, false);
    }
  });

  it("reconciles only the authenticated sender's accepted keys and redacts removal", async () => {
    const db = fake({ accepted: [{ ...chat, state: "removed" }] });
    const items = await db.community.reconcileSubmissions(eventId, "1", [
      chat.clientMessageId,
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].clientMessageId, chat.clientMessageId);
    assert.equal(items[0].body, null);
    assert.equal("authorUserId" in items[0], false);
    const query = db.queries.find(([sql]) =>
      sql.includes("r.client_message_id=ANY($3::uuid[])"),
    );
    assert.deepEqual(query[1], [eventId, "1", [chat.clientMessageId]]);
    assert.ok(db.queries[0][0].includes("REPEATABLE READ READ ONLY"));
    assert.equal(db.queries.at(-1)[0], "COMMIT");
  });
  it("exposes only published event fields, visible chat, and a bounded cursor", async () => {
    const { community, queries } = fake({
      chatRows: Array.from({ length: 51 }, (_, index) => ({
        ...chat,
        id: String(index + 1),
      })),
    });
    assert.equal((await community.publicEvent(eventId)).proposition, "Test");
    assert.equal(
      (await community.publicEventBySlug("community-test")).id,
      eventId,
    );
    assert.deepEqual(await community.summary(eventId, "1"), {
      eventId,
      likes: 2,
      liked: true,
      chatState: "open",
      chatWritable: true,
    });
    const page = await community.listChat(eventId, "90");
    assert.equal(page.items.length, 50);
    assert.equal(page.hasMore, true);
    assert.equal("authorUserId" in page.items[0], false);
    assert.ok(queries.find(([sql]) => sql.includes("m.state = 'visible'")));
    assert.equal(
      await fake({ missing: true }).community.publicEventBySlug("missing"),
      null,
    );
    await assert.rejects(
      () => fake({ missing: true }).community.listChat(eventId),
      CommunityNotFoundError,
    );
  });

  it("catches up in ascending order and checks watched messages within the event", async () => {
    const incoming = Array.from({ length: 51 }, (_, index) => ({
      ...chat,
      id: String(index + 11),
    }));
    const { community, queries } = fake({
      newChatRows: incoming,
      watchedChatRows: [chat],
    });
    const page = await community.syncChat(eventId, "10", ["10", "9"]);
    assert.equal(page.items.length, 50);
    assert.equal(page.items[0].id, "11");
    assert.equal(page.items.at(-1).id, "60");
    assert.equal(page.hasMore, true);
    assert.deepEqual(
      page.watched.map((item) => item.id),
      ["10"],
    );
    assert.equal("authorUserId" in page.items[0], false);
    assert.ok(
      queries.some(
        ([sql, params]) =>
          sql.includes("m.id = ANY($2::bigint[])") &&
          params[0] === eventId &&
          params[1].length === 2,
      ),
    );
  });

  it("serializes chat, checks live status, profile, pause, restriction, and account limits", async () => {
    const allowed = fake();
    assert.equal(
      (await allowed.community.postChat(eventId, "1", "Hello")).body,
      "Hello",
    );
    assert.ok(
      allowed.queries.find(([sql]) => sql.includes("pg_advisory_xact_lock")),
    );
    assert.ok(allowed.queries.find(([sql]) => sql.includes("FOR UPDATE")));
    for (const [options, error] of [
      [{ restricted: true }, CommunityForbiddenError],
      [{ eventStatus: "ended" }, CommunityConflictError],
      [{ hasProfile: false }, CommunityForbiddenError],
      [{ chatState: "paused" }, CommunityConflictError],
      [{ recent: 1 }, CommunityRateError],
      [{ hourly: 30 }, CommunityRateError],
      [{ missing: true }, CommunityNotFoundError],
      [{ demo: true }, CommunityNotFoundError],
    ])
      await assert.rejects(
        () => fake(options).community.postChat(eventId, "1", "Hello"),
        error,
      );
  });

  it("acknowledges accepted keys before new-write eligibility and never consumes quota", async () => {
    for (const options of [
      { restricted: true },
      { hasProfile: false },
      { eventStatus: "ended" },
      { chatState: "paused" },
      { hourly: 30 },
    ]) {
      const { community, queries } = fake({ ...options, accepted: [chat] });
      const ack = await community.postChat(
        eventId,
        "1",
        " Hello ",
        chat.clientMessageId,
        false,
      );
      assert.deepEqual(
        ack,
        (await community.listChat(eventId, undefined, "1")).items[0],
      );
      assert.equal(ack.id, "10");
      assert.equal("authorUserId" in ack, false);
      assert.ok(
        !queries.some(
          ([sql]) =>
            sql.includes("INSERT INTO event_chat_messages") ||
            sql.includes("AS recent"),
        ),
      );
      assert.ok(
        queries.some(
          ([sql, params]) =>
            sql.includes("r.client_message_id = $3") && params[1] === "1",
        ),
      );
    }
    await assert.rejects(
      () =>
        fake({ accepted: [chat] }).community.postChat(
          eventId,
          "1",
          "Different",
          chat.clientMessageId,
        ),
      (error) => error.code === "CHAT_PAYLOAD_CONFLICT",
    );
    await assert.rejects(
      () =>
        fake({ accepted: [chat], missing: true }).community.postChat(
          eventId,
          "1",
          "Hello",
          chat.clientMessageId,
        ),
      CommunityNotFoundError,
    );
    await assert.rejects(
      () =>
        fake().community.postChat(
          eventId,
          "1",
          "Hello",
          chat.clientMessageId,
          false,
        ),
      CommunityForbiddenError,
    );
  });

  it("redacts removed acknowledgments and limits correlation to the authenticated owner", async () => {
    const removed = { ...chat, state: "removed", revision: "1" };
    const { community } = fake({
      accepted: [removed],
      watchedChatRows: [removed],
    });
    const ack = await community.postChat(
      eventId,
      "1",
      "Hello",
      chat.clientMessageId,
    );
    assert.equal(ack.body, null);
    assert.equal(ack.state, "removed");
    assert.equal(ack.revision, "1");
    assert.equal(
      (await community.listChat(eventId)).items[0].clientMessageId,
      null,
    );
    assert.equal(
      (await community.listChat(eventId, undefined, "2")).items[0]
        .clientMessageId,
      null,
    );
    const sync = await community.syncChat(eventId, "10", ["10"], "1");
    assert.deepEqual(sync.watched, []);
    assert.deepEqual(sync.removed, [ack]);
    assert.equal(
      (await community.syncChat(eventId, "0", [])).removed.length,
      0,
    );
  });

  it("acknowledges a purged receipt without reopening chat, charging allowance, or exposing its hash", async () => {
    const tombstone = {
      ...chat,
      body: null,
      state: "removed",
      revision: "3",
      streamRevision: "9007199254740993",
      payloadMatches: true,
    };
    const db = fake({
      accepted: [tombstone],
      eventStatus: "ended",
      restricted: true,
      recent: 1,
    });
    const ack = await db.community.postChat(
      eventId,
      "1",
      "Hello",
      chat.clientMessageId,
      false,
    );
    assert.equal(ack.id, chat.id);
    assert.equal(ack.body, null);
    assert.equal(ack.revision, "3");
    assert.equal(ack.streamRevision, "9007199254740993");
    assert.equal("payloadMatches" in ack, false);
    assert.equal("bodyHash" in ack, false);
    assert.ok(
      !db.queries.some(
        ([sql]) =>
          sql.includes("AS recent") ||
          sql.includes("INSERT INTO event_chat_messages"),
      ),
    );
    await assert.rejects(
      fake({
        accepted: [{ ...tombstone, payloadMatches: false }],
      }).community.postChat(eventId, "1", "Different", chat.clientMessageId),
      (error) => error.code === "CHAT_PAYLOAD_CONFLICT",
    );
  });

  it("returns server timing for both posting windows and binds new keys to the insert", async () => {
    for (const options of [
      { recent: 1 },
      { hourly: 30 },
      { recent: 1, hourly: 30 },
    ]) {
      await assert.rejects(
        () =>
          fake(options).community.postChat(
            eventId,
            "1",
            "Hello",
            chat.clientMessageId,
          ),
        (error) => {
          assert.equal(error.retryAfterSeconds, 10);
          assert.equal(error.retryAt, now);
          assert.equal(
            error.code,
            options.hourly ? "CHAT_HOURLY_LIMIT" : "CHAT_COOLDOWN",
          );
          return true;
        },
      );
    }
    const { community, queries } = fake();
    await community.postChat(eventId, "1", "Hello", chat.clientMessageId);
    assert.deepEqual(
      queries.find(([sql]) =>
        sql.includes("INSERT INTO event_chat_messages"),
      )[1],
      [eventId, "1", "Hello", chat.clientMessageId],
    );
  });

  it("makes likes idempotent and refuses restricted writes", async () => {
    const { community, queries } = fake();
    assert.deepEqual(await community.setLike(eventId, "1", true), {
      liked: true,
      likes: 1,
    });
    const unlike = fake({ currentLike: true });
    assert.deepEqual(await unlike.community.setLike(eventId, "1", false), {
      liked: false,
      likes: 1,
    });
    assert.ok(
      queries.find(([sql]) =>
        sql.includes("ON CONFLICT (debate_id, user_id) DO NOTHING"),
      ),
    );
    assert.ok(
      unlike.queries.find(([sql]) => sql.includes("DELETE FROM event_likes")),
    );
    assert.ok(
      queries.find(([sql]) => sql.includes("INSERT INTO event_like_changes")),
    );
    const repeat = fake({ currentLike: true, likeChanges: 10 });
    assert.equal(
      (await repeat.community.setLike(eventId, "1", true)).liked,
      true,
    );
    assert.equal(
      repeat.queries.some(([sql]) =>
        sql.includes("INSERT INTO event_like_changes"),
      ),
      false,
    );
    await assert.rejects(
      () => fake({ likeChanges: 10 }).community.setLike(eventId, "1", true),
      CommunityRateError,
    );
    await assert.rejects(
      () => fake({ restricted: true }).community.setLike(eventId, "1", true),
      CommunityForbiddenError,
    );
  });

  it("reports chat and events with one-account limits and private evidence", async () => {
    const { community, queries } = fake();
    assert.equal(
      (await community.report("2", "chat", "10", "spam", "Repeated text"))
        .status,
      "open",
    );
    assert.equal(
      (await community.report("2", "event", eventId, "other", "Event issue"))
        .status,
      "open",
    );
    assert.ok(queries.find(([sql]) => sql.includes("community_audit_events")));
    await assert.rejects(
      () =>
        fake({ chatTarget: null }).community.report(
          "2",
          "chat",
          "10",
          "spam",
          "detail",
        ),
      CommunityNotFoundError,
    );
    await assert.rejects(
      () => fake().community.report("1", "chat", "10", "spam", "detail"),
      CommunityForbiddenError,
    );
    await assert.rejects(
      () =>
        fake({ reports: 5 }).community.report(
          "2",
          "event",
          eventId,
          "other",
          "detail",
        ),
      CommunityRateError,
    );
    await assert.rejects(
      () =>
        fake({ restricted: true }).community.report(
          "2",
          "event",
          eventId,
          "other",
          "detail",
        ),
      CommunityForbiddenError,
    );
  });

  it("keeps cases private and presents an owner-safe personal view", async () => {
    const { community } = fake();
    assert.equal((await community.listCases())[0].id, caseId);
    assert.equal(
      (await community.getCase(caseId)).history[0].action,
      "reported",
    );
    assert.equal((await community.listAppeals())[0].id, appealId);
    const reporterView = (await community.listMyCases("2"))[0];
    assert.equal(reporterView.detail, "Repeated promotion");
    assert.equal("reporterUserId" in reporterView, false);
    const subjectView = (await community.listMyCases("1"))[0];
    assert.equal(subjectView.detail, null);
    await assert.rejects(
      () => fake({ caseMissing: true }).community.getCase(caseId),
      CommunityNotFoundError,
    );
  });

  it("guards case actions, removes chat, restricts accounts, and pauses only event chat", async () => {
    const base = [caseId, "3", "remove_chat", "spam", "A clear review note"];
    const notified = fake();
    assert.equal(
      (await notified.community.decideCase(...base)).status,
      "actioned",
    );
    assert.deepEqual(
      notified.queries
        .filter(([sql]) => sql.includes("INSERT INTO account_notifications"))
        .map(([, params]) => params[0]),
      ["2", "1"],
    );
    assert.equal(
      (
        await fake().community.decideCase(
          caseId,
          "3",
          "restrict_account",
          "spam",
          "A clear review note",
        )
      ).action,
      "restrict_account",
    );
    const eventCase = {
      ...caseRecord,
      targetType: "event",
      targetChatId: null,
      subjectUserId: null,
    };
    assert.equal(
      (
        await fake({ caseRecord: eventCase }).community.decideCase(
          caseId,
          "3",
          "pause_chat",
          "other",
          "A clear review note",
        )
      ).action,
      "pause_chat",
    );
    assert.equal(
      (
        await fake().community.decideCase(
          caseId,
          "3",
          "dismiss",
          "other",
          "No policy violation",
        )
      ).status,
      "dismissed",
    );
    for (const [options, actor, action, error] of [
      [
        { caseRecord: { ...caseRecord, status: "actioned" } },
        "3",
        "remove_chat",
        CommunityConflictError,
      ],
      [{}, "2", "remove_chat", CommunityForbiddenError],
      [{}, "1", "remove_chat", CommunityForbiddenError],
      [{}, "3", "pause_chat", CommunityConflictError],
      [{ caseRecord: eventCase }, "3", "remove_chat", CommunityConflictError],
      [
        { caseRecord: eventCase, ownEvent: true },
        "3",
        "pause_chat",
        CommunityForbiddenError,
      ],
      [{ chatChanged: false }, "3", "remove_chat", CommunityConflictError],
      [{ restricted: true }, "3", "restrict_account", CommunityConflictError],
      [
        { caseRecord: eventCase, controlChanged: false },
        "3",
        "pause_chat",
        CommunityConflictError,
      ],
    ])
      await assert.rejects(
        () =>
          fake(options).community.decideCase(
            caseId,
            actor,
            action,
            "spam",
            "A clear review note",
          ),
        error,
      );
  });

  it("accepts one timely affected-user appeal and requires independent review", async () => {
    const actioned = {
      ...caseRecord,
      status: "actioned",
      action: "remove_chat",
      reviewerUserId: "3",
      decidedAt: now,
    };
    assert.equal(
      (
        await fake({ caseRecord: actioned }).community.appeal(
          caseId,
          "1",
          "Please reconsider",
        )
      ).status,
      "open",
    );
    for (const [options, userId, error] of [
      [{ caseRecord }, "1", CommunityForbiddenError],
      [{ caseRecord: actioned }, "2", CommunityForbiddenError],
      [
        { caseRecord: { ...actioned, decidedAt: new Date(0) } },
        "1",
        CommunityConflictError,
      ],
      [
        { caseRecord: actioned, existingAppeal: true },
        "1",
        CommunityConflictError,
      ],
    ])
      await assert.rejects(
        () =>
          fake(options).community.appeal(caseId, userId, "Please reconsider"),
        error,
      );
    const appealed = fake({ caseRecord: actioned });
    assert.equal(
      (
        await appealed.community.decideAppeal(
          appealId,
          "4",
          "overturned",
          "Removal was wrong",
        )
      ).status,
      "overturned",
    );
    assert.equal(
      appealed.queries.filter(([sql]) =>
        sql.includes("INSERT INTO account_notifications"),
      )[0][1][0],
      "1",
    );
    const restrictedCase = { ...actioned, action: "restrict_account" };
    assert.equal(
      (
        await fake({ caseRecord: restrictedCase }).community.decideAppeal(
          appealId,
          "4",
          "overturned",
          "Restriction was wrong",
        )
      ).status,
      "overturned",
    );
    assert.equal(
      (
        await fake({ caseRecord: actioned }).community.decideAppeal(
          appealId,
          "4",
          "upheld",
          "Original action stands",
        )
      ).status,
      "upheld",
    );
    for (const [options, reviewer, error] of [
      [
        { appealMissing: true, caseRecord: actioned },
        "4",
        CommunityNotFoundError,
      ],
      [
        {
          caseRecord: actioned,
          appealRecord: { ...appealRecord, status: "upheld" },
        },
        "4",
        CommunityConflictError,
      ],
      [{ caseRecord: actioned }, "3", CommunityForbiddenError],
      [{ caseRecord: actioned }, "1", CommunityForbiddenError],
    ])
      await assert.rejects(
        () =>
          fake(options).community.decideAppeal(
            appealId,
            reviewer,
            "overturned",
            "Review note",
          ),
        error,
      );
  });

  it("resumes only a pause caused by the case and prunes expired records", async () => {
    const paused = { ...caseRecord, status: "actioned", action: "pause_chat" };
    assert.equal(
      (
        await fake({ caseRecord: paused }).community.resumeChat(
          caseId,
          "3",
          "Review is complete",
        )
      ).chatState,
      "open",
    );
    await assert.rejects(
      () => fake().community.resumeChat(caseId, "3", "Review is complete"),
      CommunityConflictError,
    );
    await assert.rejects(
      () =>
        fake({ caseRecord: paused }).community.resumeChat(
          caseId,
          "2",
          "Review is complete",
        ),
      CommunityForbiddenError,
    );
    await assert.rejects(
      () =>
        fake({ caseRecord: paused, ownEvent: true }).community.resumeChat(
          caseId,
          "3",
          "Review is complete",
        ),
      CommunityForbiddenError,
    );
    await assert.rejects(
      () =>
        fake({
          caseRecord: paused,
          controlChanged: false,
        }).community.resumeChat(caseId, "3", "Review is complete"),
      CommunityConflictError,
    );
    assert.deepEqual(await fake().community.pruneExpired(), {
      cases: 1,
      contentActions: 1,
      chat: 1,
      likes: 1,
      likeChanges: 1,
    });
  });
});
