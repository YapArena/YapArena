import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  createMatchmakingRouter,
  createPublicMatchmakingRouter,
} from "../dist/features/matching/matchmaking-router.js";
import {
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";
import { DebaterSettingsRequiredError } from "../dist/features/transcription/debater-settings.js";

const offerId = "55555555-5555-4555-8555-555555555555";
const state = {
  serverNow: "2026-10-25T12:00:00.000Z",
  ticket: null,
  offer: null,
  debate: null,
};

function fixture({ failure, debateId = null, streams, current = state } = {}) {
  const calls = [];
  const actions = [];
  const run =
    (name, value = current) =>
    async (...args) => {
      calls.push([name, ...args]);
      if (failure) throw failure;
      return value;
    };
  const matchmaking = {
    state: run("state"),
    touch: run("touch"),
    enter: run("enter"),
    leave: run("leave"),
    accept: run("accept", { state: current, debateId }),
    decline: run("decline"),
    waiting: run("waiting", { sideA: 2, sideB: 0 }),
    deviceCheckRequired: true,
  };
  // Account 9 is a participant under a community restriction.
  const identity = {
    async getRoles(user) {
      return user === "7" || user === "9" ? ["participant"] : [];
    },
    async restriction(user) {
      return user === "9" ? { expiresAt: new Date("2026-11-09") } : null;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.header("x-user") };
    next();
  });
  app.use(
    "/api/matchmaking",
    createMatchmakingRouter({
      matchmaking,
      identity,
      recordProductAction: async (_request, action) => {
        actions.push(action);
      },
      streams,
    }),
  );
  app.use((error, _req, res, _next) => {
    void _next;
    return res.status(500).json({ error: error.message });
  });
  return { app, calls, actions };
}

describe("live topic queue API", () => {
  it("validates queue entry and requires the participant role", async () => {
    const f = fixture();
    const post = (body, user = "7") =>
      request(f.app)
        .post("/api/matchmaking/tickets")
        .set("x-user", user)
        .send(body);
    assert.equal(
      (await post({ topicSlug: "nuclear-power", side: "A" }, "8")).status,
      403,
    );
    for (const body of [
      {},
      { topicSlug: "nuclear-power", side: "C" },
      { topicSlug: "Bad Slug", side: "A" },
      { topicSlug: "nuclear-power", side: "A", extra: true },
      ["nuclear-power"],
    ])
      assert.equal((await post(body)).status, 400);
    const created = await post({ topicSlug: "nuclear-power", side: "B" });
    assert.equal(created.status, 201);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.deepEqual(created.body.state, state);
    assert.deepEqual(f.calls.at(-1), [
      "enter",
      "7",
      { topicSlug: "nuclear-power", side: "B" },
    ]);
  });

  it("keeps a restricted player out of the queue and offers, but lets them leave", async () => {
    const f = fixture();
    const as9 = (method, path) =>
      request(f.app)[method](path).set("x-user", "9");
    const offer = "11111111-1111-4111-8111-111111111111";
    for (const [method, path, body] of [
      [
        "post",
        "/api/matchmaking/tickets",
        { topicSlug: "nuclear-power", side: "A" },
      ],
      ["post", `/api/matchmaking/offers/${offer}/accept`, {}],
    ]) {
      const response = await as9(method, path).send(body);
      assert.equal(response.status, 403, path);
      assert.equal(response.body.code, "account_restricted");
    }
    assert.deepEqual(f.calls, []);
    assert.equal(
      (await as9("delete", "/api/matchmaking/tickets/current")).status,
      200,
    );
    assert.equal(
      (await as9("post", `/api/matchmaking/offers/${offer}/decline`)).status,
      200,
    );
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ["leave", "decline"],
    );
  });

  it("opens the live stream for the signed-in player, or tells clients to poll", async () => {
    const without = await request(fixture().app)
      .get("/api/matchmaking/stream")
      .set("x-user", "7");
    assert.equal(without.status, 503);
    const subscribed = [];
    const f = fixture({
      streams: {
        subscribe(userId, response) {
          subscribed.push(userId);
          response.status(200).json({ subscribed: true });
        },
      },
    });
    const opened = await request(f.app)
      .get("/api/matchmaking/stream")
      .set("x-user", "8");
    assert.equal(opened.status, 200);
    assert.deepEqual(subscribed, ["8"]);
  });

  it("serves state, presence, leaving and waiting counts", async () => {
    const f = fixture();
    const user = (method, path) =>
      request(f.app)[method](`/api/matchmaking${path}`).set("x-user", "7");
    assert.deepEqual((await user("get", "/me")).body, {
      state,
      deviceCheckRequired: true,
    });
    assert.equal((await user("post", "/presence")).status, 200);
    assert.equal((await user("delete", "/tickets/current")).status, 200);
    assert.deepEqual(
      (await user("get", "/topics/nuclear-power/waiting")).body.waiting,
      { sideA: 2, sideB: 0 },
    );
    assert.equal((await user("get", "/topics/BAD/waiting")).status, 404);
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ["state", "touch", "leave", "waiting"],
    );
  });

  it("sends the paired player's name, handle, avatar and side with the offer", async () => {
    const offered = {
      ...state,
      ticket: {
        id: "77777777-7777-4777-8777-777777777777",
        topicSlug: "nuclear-power",
        topicTitle: "Canada should expand nuclear power",
        side: "A",
        sideLabel: "For",
        status: "offered",
        closedReason: null,
        queuedAt: "2026-10-25T11:59:00.000Z",
      },
      offer: {
        id: offerId,
        deadlineAt: "2026-10-25T12:00:30.000Z",
        acceptedByMe: false,
        acceptedByOpponent: true,
        opponent: {
          handle: "maya-chen",
          displayName: "Maya Chen",
          avatarId: "yap-critter",
          sideLabel: "Against",
        },
      },
    };
    const f = fixture({ current: offered });
    const me = await request(f.app)
      .get("/api/matchmaking/me")
      .set("x-user", "7");
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.state.offer.opponent, offered.offer.opponent);
    assert.deepEqual(f.calls.at(-1), ["state", "7"]);
  });

  it("accepts and declines offers, recording a completed match", async () => {
    const f = fixture({ debateId: "66666666-6666-4666-8666-666666666666" });
    const post = (path, user = "7") =>
      request(f.app).post(`/api/matchmaking${path}`).set("x-user", user);
    assert.equal((await post("/offers/not-a-uuid/accept")).status, 404);
    assert.equal((await post("/offers/not-a-uuid/decline")).status, 404);
    assert.equal((await post(`/offers/${offerId}/accept`, "8")).status, 403);
    const accepted = await post(`/offers/${offerId}/accept`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.state, state);
    assert.deepEqual(f.actions, [
      {
        type: "match_accepted",
        debateId: "66666666-6666-4666-8666-666666666666",
      },
    ]);
    assert.equal((await post(`/offers/${offerId}/decline`)).status, 200);
    assert.deepEqual(f.calls.at(-1), ["decline", "7", offerId]);
  });

  it("does not record a match until both players accept", async () => {
    const f = fixture();
    await request(f.app)
      .post(`/api/matchmaking/offers/${offerId}/accept`)
      .set("x-user", "7");
    assert.deepEqual(f.actions, []);
  });

  it("asks for debater settings before queueing, with a code screens can act on", async () => {
    const f = fixture({
      failure: new DebaterSettingsRequiredError(["language", "consent"]),
    });
    const response = await request(f.app)
      .post("/api/matchmaking/tickets")
      .set("x-user", "7")
      .send({ topicSlug: "nuclear-power", side: "A" });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "debater_settings_required");
    assert.deepEqual(response.body.missing, ["language", "consent"]);
    assert.match(response.body.error, /account settings/);
  });

  it("maps queue conflicts and missing matches to client errors", async () => {
    for (const [failure, status, message] of [
      [new MatchConflictError("this match is no longer available"), 409],
      [new MatchNotFoundError("match not found"), 404],
      [
        Object.assign(new Error("duplicate"), { code: "23505" }),
        409,
        "you are already in a queue",
      ],
      [new Error("database down"), 500],
    ]) {
      const f = fixture({ failure });
      for (const path of [
        `/offers/${offerId}/accept`,
        `/offers/${offerId}/decline`,
        "/tickets",
      ]) {
        const response = await request(f.app)
          .post(`/api/matchmaking${path}`)
          .set("x-user", "7")
          .send(
            path === "/tickets"
              ? { topicSlug: "nuclear-power", side: "A" }
              : {},
          );
        assert.equal(response.status, status);
        if (message) assert.equal(response.body.error, message);
      }
    }
  });
});

describe("public list of topics with someone waiting", () => {
  const topics = [
    {
      slug: "four-day-week",
      title: "The four-day workweek should become standard",
      sideALabel: "For",
      sideBLabel: "Against",
      waiting: { sideA: 2, sideB: 0 },
    },
  ];
  const stub = (waitingTopics) => ({
    async waitingTopics() {
      return waitingTopics();
    },
  });

  it("serves counts per topic and side without a signed-in player", async () => {
    let calls = 0;
    const app = express().use(
      "/api/matchmaking",
      createPublicMatchmakingRouter({
        matchmaking: stub(async () => {
          calls += 1;
          return topics;
        }),
      }),
    );
    const response = await request(app).get("/api/matchmaking/waiting");
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body, { topics });
    assert.equal(calls, 1);
  });

  // createApp mounts the list before sign-in and leaves every other queue route behind it.
  function app(waitingTopics) {
    const matchmaking = {
      ...stub(waitingTopics),
      async state() {
        throw new Error("signed-in route reached without a session");
      },
      async waiting() {
        throw new Error("signed-in route reached without a session");
      },
    };
    return createApp({
      environment: "test",
      logger: createLogger({ enabled: false }),
      messages: {},
      sessions: { findUserByTokenHash: async () => null },
      identity: {},
      matchmaking,
    });
  }

  it("is public in the app while the rest of the queue still needs sign-in", async () => {
    const server = app(async () => topics);
    const listed = await request(server).get("/api/matchmaking/waiting");
    assert.equal(listed.status, 200);
    assert.equal(listed.headers["cache-control"], "no-store");
    assert.deepEqual(listed.body, { topics });
    for (const path of ["/me", "/topics/four-day-week/waiting"]) {
      const response = await request(server).get(`/api/matchmaking${path}`);
      assert.equal(response.status, 401, path);
      assert.equal(response.body.error, "authentication required");
    }
  });

  it("answers a database failure like the per-topic count", async () => {
    const response = await request(
      app(async () => {
        throw new Error("database down");
      }),
    ).get("/api/matchmaking/waiting");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "internal server error" });
  });
});
