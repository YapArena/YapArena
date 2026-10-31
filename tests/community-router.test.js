import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
  CommunityRateError,
} from "../dist/features/community/repository.js";
import { createLogger } from "../dist/platform/logger.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const appealId = "33333333-3333-4333-8333-333333333333";
const event = {
  id: eventId,
  slug: "debate-community-test",
  status: "live",
  proposition: "Should public debates have chat?",
  topicTitle: "Public debate",
  sideALabel: "For",
  sideBLabel: "Against",
  speakerA: "Alice",
  speakerB: "Bob",
  scheduledAt: new Date("2026-10-01"),
};

function fixture({
  signedIn = true,
  roles = ["participant"],
  failure,
  hidden = false,
  apiRateLimit,
  streams,
  discovery,
} = {}) {
  const calls = [];
  const community = {
    publicEvent: async () => (hidden ? null : event),
    publicEventBySlug: async (slug) =>
      hidden || slug !== event.slug ? null : event,
    summary: async (id, userId) => {
      calls.push(["summary", id, userId]);
      if (failure) throw failure;
      return {
        eventId: id,
        likes: 2,
        liked: !!userId,
        chatState: "open",
        chatWritable: true,
      };
    },
    publicUpdates: async (id, cursor) => {
      calls.push(["updates", id, cursor]);
      return { version: 1, roomId: id, kind: "snapshot" };
    },
    reconcileSubmissions: async (id, userId, keys) => {
      calls.push(["submissions", id, userId, keys]);
      return [];
    },
    listChat: async (id, before) => {
      calls.push(["listChat", id, before]);
      if (failure) throw failure;
      return { items: [{ id: "1", body: "Hello" }], hasMore: false };
    },
    syncChat: async (id, after, watchedIds) => {
      calls.push(["syncChat", id, after, watchedIds]);
      if (failure) throw failure;
      return {
        items: [{ id: "2", body: "New message" }],
        hasMore: false,
        watched: [{ id: "1", body: "Hello" }],
      };
    },
    postChat: async (...args) => {
      calls.push(["postChat", ...args]);
      if (failure) throw failure;
      if (!args[4])
        throw new CommunityForbiddenError(
          "participant role is required to chat",
        );
      return { id: "2", body: args[2] };
    },
    setLike: async (...args) => {
      calls.push(["setLike", ...args]);
      if (failure) throw failure;
      return { liked: args[2], likes: args[2] ? 3 : 2 };
    },
    report: async (...args) => {
      calls.push(["report", ...args]);
      if (failure) throw failure;
      return { id: caseId, status: "open" };
    },
    listMyCases: async (userId) => {
      calls.push(["listMyCases", userId]);
      return [];
    },
    appeal: async (...args) => {
      calls.push(["appeal", ...args]);
      if (failure) throw failure;
      return { id: appealId, status: "open" };
    },
    listCases: async (status) => {
      calls.push(["listCases", status]);
      return [];
    },
    getCase: async (id) => ({ id, history: [] }),
    decideCase: async (...args) => {
      calls.push(["decideCase", ...args]);
      if (failure) throw failure;
      return { id: args[0], status: "actioned" };
    },
    resumeChat: async (...args) => {
      calls.push(["resumeChat", ...args]);
      if (failure) throw failure;
      return { chatState: "open" };
    },
    listAppeals: async () => [],
    decideAppeal: async (...args) => {
      calls.push(["decideAppeal", ...args]);
      if (failure) throw failure;
      return { id: args[0], status: args[2] };
    },
  };
  const app = createApp({
    community,
    discovery,
    communityStreams: streams,
    identity: { getRoles: async () => roles },
    sessions: {
      findUserByTokenHash: async () =>
        signedIn ? { id: "7", email: null, createdAt: new Date() } : null,
    },
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "https://arena.example",
    apiRateLimit,
  });
  const agent = () => request(app);
  const auth = (method, path) =>
    agent()[method](path).set("Cookie", "session=test");
  return { app, calls, auth };
}

describe("community API and share surfaces", () => {
  it("reports bounded ephemeral playback tabs through the publication gate", async () => {
    const { app } = fixture({ signedIn: false });
    const path = `/api/community/events/${eventId}/presence`,
      connection = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.equal(
      (await request(app).post(path).send({ connection, active: true })).body
        .activePlaybackTabs,
      1,
    );
    assert.equal(
      (await request(app).post(path).send({ connection, active: true })).body
        .activePlaybackTabs,
      1,
    );
    assert.equal(
      (await request(app).post(path).send({ connection, active: false })).body
        .activePlaybackTabs,
      0,
    );
    for (const body of [
      {},
      { connection, active: "true" },
      { connection: "bad", active: true },
      { connection, active: true, userId: "1" },
    ])
      assert.equal((await request(app).post(path).send(body)).status, 400);
    assert.equal(
      (
        await request(app)
          .post("/api/community/events/bad/presence")
          .send({ connection, active: true })
      ).status,
      400,
    );
    const hidden = fixture({
      failure: new CommunityNotFoundError("event not found"),
    });
    assert.equal(
      (await request(hidden.app).post(path).send({ connection, active: true }))
        .status,
      404,
    );
  });
  it("serves public durable recovery and validates private owner reconciliation", async () => {
    const { app, auth, calls } = fixture();
    await request(app)
      .get(`/api/community/events/${eventId}/updates`)
      .expect(200);
    assert.deepEqual(calls.at(-1), ["updates", eventId, null]);
    await request(app)
      .get(
        `/api/community/events/${eventId}/updates?cursor=${encodeURIComponent(`v1:${eventId}:9007199254740993`)}`,
      )
      .expect(200);
    assert.equal(calls.at(-1)[2], "9007199254740993");
    await request(app)
      .get(`/api/community/events/${eventId}/updates?cursor=v1:other:1`)
      .expect(400);
    await request(app).get(`/api/community/events/bad/updates`).expect(404);
    await request(app)
      .get(`/api/community/events/${eventId}/chat/submissions?keys=bad`)
      .expect(401);
    await auth(
      "get",
      `/api/community/events/${eventId}/chat/submissions?keys=bad`,
    ).expect(400);
    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await auth(
      "get",
      `/api/community/events/${eventId}/chat/submissions?keys=${key}`,
    ).expect(200);
    assert.deepEqual(calls.at(-1), ["submissions", eventId, "7", [key]]);
  });
  it("admits anonymous streams with room-scoped recovery and origin checks", async () => {
    const calls = [];
    const { app } = fixture({
      signedIn: false,
      streams: {
        subscribe(id, cursor, ip, response) {
          calls.push({ id, cursor, ip });
          response.status(200).end();
        },
      },
    });
    const path = `/api/community/events/${eventId}/stream`;
    await request(app)
      .get(path)
      .set("Last-Event-ID", `v1:${eventId}:9`)
      .expect(200);
    assert.equal(calls.at(-1).cursor, "9");
    await request(app)
      .get(`${path}?cursor=${encodeURIComponent(`v1:${eventId}:8`)}`)
      .set("Last-Event-ID", `v1:${eventId}:9`)
      .expect(200);
    assert.equal(calls.at(-1).cursor, "8");
    await request(app).get(`${path}?cursor=bad`).expect(400);
    await request(app).get(`${path}?cursor=a&cursor=b`).expect(400);
    await request(app)
      .get(path)
      .set("Origin", "https://other.example")
      .expect(403);
    await request(app)
      .get(path)
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
    await request(app).get("/api/community/events/bad/stream").expect(404);
    await request(fixture().app).get(path).expect(503);
  });
  it("lets guests read chat and engagement but keeps mutations and case data private", async () => {
    const { app } = fixture({ signedIn: false });
    assert.equal(
      (await request(app).get(`/api/community/events/${eventId}`)).status,
      200,
    );
    assert.equal(
      (await request(app).get(`/api/community/events/${eventId}/chat`)).body
        .items[0].body,
      "Hello",
    );
    for (const [method, path] of [
      ["post", `/api/community/events/${eventId}/chat`],
      ["put", `/api/community/events/${eventId}/like`],
      ["post", "/api/community/reports"],
      ["get", "/api/community/me/cases"],
      ["get", "/api/community/moderation/cases"],
    ])
      assert.equal((await request(app)[method](path)).status, 401);
  });

  it("validates event and cursor IDs and uses stable public share URLs", async () => {
    const { app } = fixture();
    assert.equal(
      (await request(app).get("/api/community/events/nope")).status,
      404,
    );
    assert.equal(
      (
        await request(app).get(
          `/api/community/events/${eventId}/chat?before=-1`,
        )
      ).status,
      400,
    );
    const qr = await request(app).get(`/debates/${event.slug}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.body.toString(), /<svg/);
    const overlay = await request(app).get(`/overlay/${event.slug}`);
    assert.equal(overlay.status, 200);
    assert.match(overlay.text, /Should public debates have chat/);
    assert.doesNotMatch(overlay.text, /score|tally|sponsor|billing/i);
    assert.equal((await request(app).get("/overlay/not-found")).status, 404);
    // With the site's pages served, browsers get the styled not-found page.
    const styled = await request(fixture({ discovery: {} }).app)
      .get("/overlay/not-found")
      .set("Accept", "text/html");
    assert.equal(styled.status, 404);
    assert.match(styled.text, /404 \/ NO SUCH PAGE/);
    assert.equal(
      (await request(app).get("/debates/not-found/qr.svg")).status,
      404,
    );
  });

  it("serves bounded guest chat sync with ordered cursors and no cache", async () => {
    const { app, calls } = fixture({ signedIn: false });
    const path = `/api/community/events/${eventId}/chat/sync`;
    const result = await request(app).get(`${path}?after=1&watch=2,1,2`);
    assert.equal(result.status, 200);
    assert.equal(result.body.items[0].body, "New message");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(calls.at(-1), ["syncChat", eventId, "1", ["2", "1"]]);
    for (const query of [
      "after=-1",
      "after=abc",
      "watch=1,wat",
      `watch=${Array.from({ length: 201 }, (_, index) => index + 1).join(",")}`,
    ])
      assert.equal((await request(app).get(`${path}?${query}`)).status, 400);
  });

  it("keeps live reads on a separate bounded limit from ordinary API actions", async () => {
    const { app } = fixture({ signedIn: false, apiRateLimit: 1 });
    for (let index = 0; index < 3; index += 1)
      assert.equal(
        (
          await request(app).get(
            `/api/community/events/${eventId}/chat/sync?after=0`,
          )
        ).status,
        200,
      );
    assert.equal((await request(app).get("/health")).status, 200);
    assert.equal((await request(app).get("/health")).status, 429);
  });

  it("validates UUID v4 keys, normalizes them, and opts into owner correlation", async () => {
    const { auth, calls, app } = fixture();
    const path = `/api/community/events/${eventId}/chat`;
    for (const key of [
      null,
      1,
      {},
      "",
      "bad",
      eventId.replace("-4111-", "-1111-"),
    ]) {
      const invalid = await auth("post", path).send({
        body: "Hello",
        clientMessageId: key,
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, "CHAT_INVALID_KEY");
    }
    const key = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    await auth("post", path)
      .send({ body: " Hello ", clientMessageId: key })
      .expect(201);
    assert.deepEqual(calls.at(-1), [
      "postChat",
      eventId,
      "7",
      "Hello",
      key.toLowerCase(),
      true,
    ]);
    await auth("get", `${path}?own=1`).expect(200);
    assert.equal(
      (await request(fixture({ signedIn: false }).app).get(`${path}?own=1`))
        .status,
      401,
    );
    for (const query of [
      "before=9223372036854775808",
      "before=9999999999999999999",
    ])
      await request(app).get(`${path}?${query}`).expect(400);
    await request(app)
      .get(`${path}/sync?after=9223372036854775808`)
      .expect(400);
  });

  it("returns machine codes and Retry-After for account cooldown and payload conflicts", async () => {
    for (const code of ["CHAT_COOLDOWN", "CHAT_HOURLY_LIMIT"]) {
      const { auth } = fixture({
        failure: new CommunityRateError(
          "wait",
          123,
          code,
          new Date("2026-10-06T12:00:00Z"),
        ),
      });
      const result = await auth(
        "post",
        `/api/community/events/${eventId}/chat`,
      ).send({ body: "Hello", clientMessageId: eventId });
      assert.equal(result.status, 429);
      assert.equal(result.headers["retry-after"], "123");
      assert.equal(result.body.code, code);
      assert.equal(result.body.retryAfterSeconds, 123);
    }
    const { auth } = fixture({
      failure: new CommunityConflictError(
        "different text",
        "CHAT_PAYLOAD_CONFLICT",
      ),
    });
    const result = await auth(
      "post",
      `/api/community/events/${eventId}/chat`,
    ).send({ body: "Hello", clientMessageId: eventId });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CHAT_PAYLOAD_CONFLICT");
  });

  it("posts chat and uses idempotent like methods with server-bound account identity", async () => {
    const { auth, calls } = fixture();
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: " Hello ",
        })
      ).status,
      201,
    );
    assert.deepEqual(calls.at(-1), [
      "postChat",
      eventId,
      "7",
      "Hello",
      undefined,
      true,
    ]);
    assert.equal(
      (await auth("put", `/api/community/events/${eventId}/like`)).body.liked,
      true,
    );
    assert.equal(
      (await auth("delete", `/api/community/events/${eventId}/like`)).body
        .liked,
      false,
    );
    assert.equal(
      (await auth("get", `/api/community/events/${eventId}/my-like`)).body
        .liked,
      true,
    );
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: " ",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: "x".repeat(501),
        })
      ).status,
      400,
    );
  });

  it("validates reports, returns rate failures, and exposes a personal case page", async () => {
    const { auth, calls } = fixture();
    const good = {
      targetType: "event",
      targetId: eventId,
      reasonCode: "spam",
      detail: "Repeated promotion",
    };
    assert.equal(
      (await auth("post", "/api/community/reports").send(good)).status,
      201,
    );
    assert.deepEqual(calls.at(-1), [
      "report",
      "7",
      "event",
      eventId,
      "spam",
      "Repeated promotion",
    ]);
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...good,
          reasonCode: "bad",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...good,
          targetId: "bad",
        })
      ).status,
      400,
    );
    assert.equal((await auth("get", "/account/moderation")).status, 200);
    assert.equal((await auth("get", "/api/community/me/cases")).status, 200);
    const limited = fixture({
      failure: new CommunityRateError("report limit reached"),
    });
    assert.equal(
      (await limited.auth("post", "/api/community/reports").send(good)).status,
      429,
    );
  });

  it("requires moderator role for case evidence and decisions", async () => {
    const { auth } = fixture();
    for (const path of [
      "/moderation",
      "/api/community/moderation/cases",
      `/api/community/moderation/cases/${caseId}`,
      "/api/community/moderation/appeals",
    ])
      assert.equal((await auth("get", path)).status, 403);
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/decision`,
        ).send({
          action: "remove_chat",
          reasonCode: "spam",
          note: "Repeated unsafe posts",
        })
      ).status,
      403,
    );
    const mod = fixture({ roles: ["moderator"] });
    assert.equal((await mod.auth("get", "/moderation")).status, 200);
    assert.equal(
      (await mod.auth("get", "/api/community/moderation/cases")).status,
      200,
    );
    assert.equal(
      (await mod.auth("get", `/api/community/moderation/cases/${caseId}`)).body
        .id,
      caseId,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/decision`)
          .send({
            action: "remove_chat",
            reasonCode: "spam",
            note: "Repeated unsafe posts",
          })
      ).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/decision`)
          .send({
            action: "win",
            reasonCode: "spam",
            note: "Repeated unsafe posts",
          })
      ).status,
      400,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/resume-chat`)
          .send({ note: "Issue has been handled" })
      ).status,
      200,
    );
  });

  it("requires a valid appeal and a different moderator decision", async () => {
    const participant = fixture();
    assert.equal(
      (
        await participant
          .auth("post", `/api/community/cases/${caseId}/appeal`)
          .send({ reason: "Please reconsider this action" })
      ).status,
      201,
    );
    assert.equal(
      (
        await participant
          .auth("post", `/api/community/cases/${caseId}/appeal`)
          .send({ reason: "short" })
      ).status,
      400,
    );
    const mod = fixture({ roles: ["moderator"] });
    assert.equal(
      (await mod.auth("get", "/api/community/moderation/appeals")).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth(
            "post",
            `/api/community/moderation/appeals/${appealId}/decision`,
          )
          .send({
            decision: "overturned",
            note: "Original removal was mistaken",
          })
      ).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth(
            "post",
            `/api/community/moderation/appeals/${appealId}/decision`,
          )
          .send({
            decision: "published_winner",
            note: "Original removal was mistaken",
          })
      ).status,
      400,
    );
  });

  it("maps missing, conflict, and forbidden repository outcomes without leaking details", async () => {
    for (const [failure, status] of [
      [new CommunityNotFoundError("event not found"), 404],
      [new CommunityConflictError("chat paused"), 409],
      [new CommunityForbiddenError("community activity is restricted"), 403],
    ]) {
      const { auth } = fixture({ failure });
      assert.equal(
        (
          await auth("post", `/api/community/events/${eventId}/chat`).send({
            body: "Hello",
          })
        ).status,
        status,
      );
    }
  });

  it("rejects malformed targets and decisions before calling the repository", async () => {
    const { auth, calls } = fixture({ roles: ["participant", "moderator"] });
    const invalid = [
      [
        "get",
        `/api/community/events/${eventId}/chat?before=999999999999999999999999`,
      ],
      ["get", "/api/community/events/bad/my-like"],
      ["post", "/api/community/events/bad/chat"],
      ["put", "/api/community/events/bad/like"],
      ["delete", "/api/community/events/bad/like"],
      ["post", "/api/community/cases/bad/appeal"],
      ["get", "/api/community/moderation/cases/bad"],
      ["post", "/api/community/moderation/cases/bad/decision"],
      ["post", "/api/community/moderation/cases/bad/resume-chat"],
      ["post", "/api/community/moderation/appeals/bad/decision"],
    ];
    for (const [method, path] of invalid) {
      const response = await auth(method, path);
      assert.ok([400, 404].includes(response.status), path);
    }
    const report = {
      targetType: "chat",
      targetId: "10",
      reasonCode: "privacy",
      detail: "Private information",
    };
    assert.equal(
      (await auth("post", "/api/community/reports").send(report)).status,
      201,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...report,
          targetType: "profile",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...report,
          detail: "short",
        })
      ).status,
      400,
    );
    assert.equal(
      (await auth("get", "/api/community/moderation/cases?status=invalid"))
        .status,
      400,
    );
    assert.equal(
      (await auth("get", "/api/community/moderation/cases?status=actioned"))
        .status,
      200,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/decision`,
        ).send({
          action: "pause_chat",
          reasonCode: "invalid",
          note: "A sufficiently long note",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/resume-chat`,
        ).send({ note: "short" })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/appeals/${appealId}/decision`,
        ).send({
          decision: "upheld",
          note: "short",
        })
      ).status,
      400,
    );
    assert.equal(calls.filter(([name]) => name === "report").length, 1);
  });

  it("hides unpublished share resources and maps duplicate reports to conflict", async () => {
    const { app } = fixture({ hidden: true });
    assert.equal(
      (await request(app).get(`/debates/${event.slug}/qr.svg`)).status,
      404,
    );
    assert.equal(
      (await request(app).get(`/overlay/${event.slug}`)).status,
      404,
    );
    assert.equal(
      (await request(app).get("/debates/INVALID/qr.svg")).status,
      404,
    );
    const duplicate = fixture({ failure: { code: "23505" } });
    assert.equal(
      (
        await duplicate.auth("post", "/api/community/reports").send({
          targetType: "event",
          targetId: eventId,
          reasonCode: "spam",
          detail: "Repeated promotion",
        })
      ).status,
      409,
    );
    const moderatorOnly = fixture({ roles: ["moderator"] });
    assert.equal(
      (
        await moderatorOnly
          .auth("post", `/api/community/events/${eventId}/chat`)
          .send({ body: "Hello" })
      ).status,
      403,
    );
    assert.equal(
      (await moderatorOnly.auth("put", `/api/community/events/${eventId}/like`))
        .status,
      403,
    );
    assert.equal(
      (
        await moderatorOnly.auth("post", "/api/community/reports").send({
          targetType: "event",
          targetId: eventId,
          reasonCode: "spam",
          detail: "Repeated promotion",
        })
      ).status,
      403,
    );
  });
});
