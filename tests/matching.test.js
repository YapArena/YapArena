import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";
import { createLogger } from "../dist/platform/logger.js";

const id = "11111111-1111-4111-8111-111111111111";
const user = { id: "7", email: null, createdAt: new Date("2026-09-01") };
const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const topicInput = {
  slug: "civil-ai",
  title: "Civil use of AI",
  summary: "Should cities use AI for public services?",
  sideALabel: "For",
  sideBLabel: "Against",
};
const requestInput = {
  kind: "direct",
  topicSlug: "civil-ai",
  targetHandle: "other-speaker",
  proposition: "Should cities use AI for public services?",
  requestedSide: "A",
  scheduledAt,
};

function fixture({
  signedIn = true,
  roles = ["participant"],
  failure,
  participant = true,
  publicationState = "published",
  debateAutoStart,
} = {}) {
  const calls = [];
  const event = {
    id,
    slug: `debate-${id}`,
    status: "scheduled",
    publicationState,
  };
  const matching = {
    listRules: async () => ({
      version: "preview-1",
      rules: { financial_terms: "not_active" },
    }),
    listOwnTopics: async () => [],
    createTopic: async (ownerId, input) => {
      calls.push(["topic", ownerId, input]);
      if (failure) throw failure;
      return { ...input, publicationState: "draft" };
    },
    publishTopic: async (ownerId, slug) => {
      calls.push(["publish", ownerId, slug]);
      return slug === "civil-ai" ? { slug } : null;
    },
    listRequests: async () => [],
    listQueue: async () => [],
    createRequest: async (ownerId, input) => {
      calls.push(["request", ownerId, input]);
      if (failure) throw failure;
      return { id, ...input };
    },
    acceptRequest: async (ownerId, requestId) => {
      calls.push(["accept", ownerId, requestId]);
      if (failure) throw failure;
      return event;
    },
    joinQueue: async (ownerId, requestId) => {
      calls.push(["join", ownerId, requestId]);
      if (failure) throw failure;
      return event;
    },
    closeRequest: async (ownerId, requestId, action) => {
      calls.push(["close", ownerId, requestId, action]);
      return { id, status: action };
    },
    listEvents: async () => [event],
    getEvent: async () => event,
    isParticipant: async () => participant,
    getEventHistory: async () => [{ action: "scheduled" }],
    markReady: async (ownerId, eventId) => {
      calls.push(["ready", ownerId, eventId]);
      return { ...event, status: "ready" };
    },
    operatorTransition: async (ownerId, eventId, action, reason, nextTime) => {
      calls.push(["transition", ownerId, eventId, action, reason, nextTime]);
      return { ...event, status: action };
    },
    listNotifications: async () => [],
    markNotificationRead: async (_ownerId, notificationId) =>
      notificationId === "1",
  };
  const app = createApp({
    matching,
    debateAutoStart,
    identity: { getRoles: async () => roles },
    sessions: {
      findUserByTokenHash: async () => (signedIn ? user : null),
      create: async () => {},
      deleteByTokenHash: async () => false,
    },
    users: { create: async () => ({}), findByEmail: async () => null },
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
  });
  const agent = () => request(app);
  const authenticated = (method, path) =>
    agent()[method](path).set("Cookie", "session=test");
  return { app, calls, authenticated };
}

describe("matching API", () => {
  it("starts the debate when the second speaker is ready, and never fails readiness on a start error", async () => {
    const starts = [];
    let failure;
    const { authenticated } = fixture({
      debateAutoStart: {
        async tryStart(debateId) {
          starts.push(debateId);
          if (failure) throw failure;
          return true;
        },
      },
    });
    const ready = () =>
      authenticated("post", `/api/matching/events/${id}/ready`);
    assert.equal((await ready()).body.event.status, "ready");
    failure = new Error("egress unavailable");
    assert.equal((await ready()).status, 200);
    assert.deepEqual(starts, [id, id]);
  });

  it("requires a session and exposes no account data anonymously", async () => {
    const { app } = fixture({ signedIn: false });
    for (const path of [
      "/api/matching/topics/mine",
      "/api/matching/requests",
      "/api/matching/events",
      "/api/matching/notifications",
    ])
      assert.equal((await request(app).get(path)).status, 401);
  });

  it("creates an owned draft topic and allows its owner to publish", async () => {
    const { authenticated, calls } = fixture();
    assert.equal(
      (await authenticated("post", "/api/matching/topics").send(topicInput))
        .status,
      201,
    );
    assert.deepEqual(calls[0], ["topic", "7", topicInput]);
    assert.equal(
      (await authenticated("post", "/api/matching/topics/civil-ai/publish"))
        .status,
      200,
    );
    assert.deepEqual(calls[1], ["publish", "7", "civil-ai"]);
    assert.equal(
      (await authenticated("post", "/api/matching/topics/other-topic/publish"))
        .status,
      404,
    );
    for (const input of [
      { ...topicInput, sideBLabel: "For" },
      { ...topicInput, slug: "BAD" },
      { ...topicInput, creatorId: "8" },
    ])
      assert.equal(
        (await authenticated("post", "/api/matching/topics").send(input))
          .status,
        400,
      );
  });

  it("validates requests and binds their owner to the session", async () => {
    const { authenticated, calls } = fixture();
    const created = await authenticated("post", "/api/matching/requests").send(
      requestInput,
    );
    assert.equal(created.status, 201);
    assert.equal(calls[0][1], "7");
    assert.equal(calls[0][2].requestedSide, "A");
    assert.equal(calls[0][2].scheduledAt.toISOString(), scheduledAt);
    for (const input of [
      { ...requestInput, requestedSide: "C" },
      {
        ...requestInput,
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      },
      { ...requestInput, targetHandle: "BAD" },
      { ...requestInput, initiatorUserId: "8" },
      { ...requestInput, proposition: "short" },
      { ...requestInput, kind: "queue", targetHandle: "other-speaker" },
    ])
      assert.equal(
        (await authenticated("post", "/api/matching/requests").send(input))
          .status,
        400,
      );
  });

  it("exposes acceptance, queue join, readiness, history, and notifications", async () => {
    const { authenticated, calls } = fixture();
    assert.equal(
      (await authenticated("post", `/api/matching/requests/${id}/accept`))
        .status,
      201,
    );
    assert.equal(
      (await authenticated("post", `/api/matching/queue/${id}/join`)).status,
      201,
    );
    assert.equal(
      (await authenticated("post", `/api/matching/requests/${id}/declined`))
        .status,
      200,
    );
    assert.equal(
      (await authenticated("post", `/api/matching/requests/${id}/withdrawn`))
        .status,
      200,
    );
    assert.equal(
      (await authenticated("post", `/api/matching/events/${id}/ready`)).body
        .event.status,
      "ready",
    );
    assert.equal(
      (await authenticated("get", `/api/matching/events/${id}`)).body.history[0]
        .action,
      "scheduled",
    );
    assert.equal(
      (await authenticated("post", "/api/matching/notifications/1/read"))
        .status,
      204,
    );
    assert.equal(
      (await authenticated("post", "/api/matching/notifications/2/read"))
        .status,
      404,
    );
    assert.equal(calls.filter((entry) => entry[1] === "7").length >= 5, true);
  });

  it("maps missing and conflicting requests to deterministic responses", async () => {
    const conflict = fixture({
      failure: new MatchConflictError("request is no longer open"),
    });
    assert.equal(
      (
        await conflict.authenticated(
          "post",
          `/api/matching/requests/${id}/accept`,
        )
      ).status,
      409,
    );
    const missing = fixture({
      failure: new MatchNotFoundError("request not found"),
    });
    assert.equal(
      (
        await missing.authenticated(
          "post",
          `/api/matching/requests/${id}/accept`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await missing.authenticated("post", "/api/matching/requests/bad/accept"))
        .status,
      404,
    );
  });

  it("restricts operator transitions and participant mutations by role", async () => {
    const sponsor = fixture({ roles: ["sponsor"] });
    assert.equal(
      (
        await sponsor
          .authenticated("post", "/api/matching/topics")
          .send(topicInput)
      ).status,
      403,
    );
    assert.equal(
      (
        await sponsor
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({ action: "cancel", reason: "A scheduling problem" })
      ).status,
      403,
    );
    const operator = fixture({ roles: ["operator"] });
    assert.equal(
      (
        await operator
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({ action: "cancel", reason: "A scheduling problem" })
      ).status,
      200,
    );
    assert.equal(operator.calls[0][1], "7");
    assert.equal(
      (
        await operator
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({ action: "cancel" })
      ).status,
      400,
    );
    assert.equal(
      (
        await operator
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({
            action: "reschedule",
            reason: "A scheduling problem",
            scheduledAt: "bad",
          })
      ).status,
      400,
    );
  });

  it("serves bounded account collections and rejects malformed resource identifiers", async () => {
    const { authenticated } = fixture();
    for (const path of [
      "/rules",
      "/topics/mine",
      "/requests",
      "/queue",
      "/events",
      "/notifications",
    ])
      assert.equal(
        (await authenticated("get", `/api/matching${path}`)).status,
        200,
        path,
      );
    for (const path of [
      "/requests/bad/accept",
      "/queue/bad/join",
      "/requests/bad/declined",
      "/events/bad",
      "/events/bad/ready",
      "/notifications/bad/read",
    ])
      assert.equal(
        (
          await authenticated(
            path.endsWith("/ready") ||
              path.endsWith("/read") ||
              path.endsWith("/join") ||
              path.endsWith("/accept") ||
              path.endsWith("/declined")
              ? "post"
              : "get",
            `/api/matching${path}`,
          )
        ).status,
        404,
        path,
      );
  });

  it("validates direct and queue proposals at the API boundary", async () => {
    const { authenticated } = fixture();
    assert.equal(
      (
        await authenticated("post", "/api/matching/requests").send({
          ...requestInput,
          kind: "queue",
          targetHandle: undefined,
        })
      ).status,
      201,
    );
    for (const body of [
      null,
      [],
      {},
      { ...requestInput, kind: "direct", targetHandle: undefined },
      { ...requestInput, scheduledAt: "2026-09-30T00:00:00+00:00" },
      {
        ...requestInput,
        scheduledAt: new Date(
          Date.now() + 91 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      { ...requestInput, topicSlug: "BAD" },
    ])
      assert.equal(
        (await authenticated("post", "/api/matching/requests").send(body))
          .status,
        400,
      );
    for (const body of [
      null,
      [],
      {},
      { ...topicInput, title: "x" },
      { ...topicInput, summary: "x" },
    ])
      assert.equal(
        (await authenticated("post", "/api/matching/topics").send(body)).status,
        400,
      );
  });

  it("converts unique conflicts and refuses invalid operator actions", async () => {
    const duplicate = fixture({ failure: { code: "23505" } });
    assert.equal(
      (
        await duplicate
          .authenticated("post", "/api/matching/topics")
          .send(topicInput)
      ).status,
      409,
    );
    const operator = fixture({ roles: ["operator"] });
    for (const body of [
      { action: "unknown", reason: "Some reason" },
      { action: "cancel", reason: "x" },
      { action: "cancel", reason: "Some reason", ownerId: "8" },
      { action: "reschedule", reason: "Some reason", scheduledAt: "invalid" },
    ])
      assert.equal(
        (
          await operator
            .authenticated("post", `/api/matching/events/${id}/transition`)
            .send(body)
        ).status,
        400,
      );
    assert.equal(
      (
        await operator
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({
            action: "reschedule",
            reason: "Scheduling conflict",
            scheduledAt,
          })
      ).status,
      200,
    );
    assert.equal(
      (
        await operator
          .authenticated("post", `/api/matching/events/${id}/transition`)
          .send({ action: "no_show", reason: "Speaker absent" })
      ).status,
      200,
    );
  });

  it("keeps event history private to speakers and operators", async () => {
    const viewer = fixture({ participant: false });
    const viewed = await viewer.authenticated(
      "get",
      `/api/matching/events/${id}`,
    );
    assert.equal(viewed.status, 200);
    assert.deepEqual(viewed.body.history, []);
    const hidden = fixture({ participant: false, publicationState: "hidden" });
    assert.equal(
      (await hidden.authenticated("get", `/api/matching/events/${id}`)).status,
      404,
    );
    const operator = fixture({
      participant: false,
      publicationState: "hidden",
      roles: ["operator"],
    });
    assert.equal(
      (await operator.authenticated("get", `/api/matching/events/${id}`)).body
        .history[0].action,
      "scheduled",
    );
  });
});
