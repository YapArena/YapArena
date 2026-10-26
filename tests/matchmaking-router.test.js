import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createMatchmakingRouter } from "../dist/features/matching/matchmaking-router.js";
import {
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";

const offerId = "55555555-5555-4555-8555-555555555555";
const state = {
  serverNow: "2026-10-25T12:00:00.000Z",
  ticket: null,
  offer: null,
  debate: null,
};

function fixture({ failure, debateId = null, streams } = {}) {
  const calls = [];
  const actions = [];
  const run =
    (name, value = state) =>
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
    accept: run("accept", { state, debateId }),
    decline: run("decline"),
    waiting: run("waiting", { sideA: 2, sideB: 0 }),
  };
  const identity = {
    async getRoles(user) {
      return user === "7" ? ["participant"] : [];
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
    assert.deepEqual((await user("get", "/me")).body.state, state);
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
