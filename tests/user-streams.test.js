import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import pg from "pg";
import {
  createUserStreams,
  parseNotice,
} from "../dist/platform/user-streams.js";
import { createPgListener } from "../dist/platform/pg-listener.js";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import request from "../scripts/test-http-request.ts";

class FakeResponse extends EventEmitter {
  writableLength = 0;
  frames = [];
  statusCode = 200;
  headers = {};
  body;
  ended = false;
  status(code) {
    this.statusCode = code;
    return this;
  }
  set(name, value) {
    if (typeof name === "string") this.headers[name] = value;
    else Object.assign(this.headers, name);
    return this;
  }
  json(value) {
    this.body = value;
  }
  flushHeaders() {}
  write(frame) {
    this.frames.push(frame.toString());
    return true;
  }
  end() {
    this.ended = true;
  }
  destroy() {}
  events(kind = "state") {
    return this.frames
      .filter((frame) => frame.startsWith(`event: ${kind}\n`))
      .map((frame) => JSON.parse(frame.split("data: ")[1]));
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  const reads = [];
  const touches = [];
  const warnings = [];
  const timers = new Map();
  let wake;
  const listener = { started: false, stopped: false };
  const streams = createUserStreams({
    databaseUrl: "postgresql://localhost/queue",
    kinds: {
      state: {
        async read(userId) {
          reads.push(userId);
          if (options.failState) throw new Error("database busy");
          return { serverNow: "now", ticket: { id: `ticket-${userId}` } };
        },
      },
      results: {},
    },
    channels: { yaparena_user_v1: "state", yaparena_results_v1: "results" },
    presence: async (userIds) => {
      touches.push([...userIds]);
      if (options.failTouch) throw new Error("database busy");
    },
    logger: { warn: (_details, message) => warnings.push(message) },
    listen: (url, _logger, callback, _count, settings) => {
      assert.equal(url, "postgresql://localhost/queue");
      assert.deepEqual(settings, {
        channels: ["yaparena_user_v1", "yaparena_results_v1"],
        name: "user-streams",
      });
      wake = callback;
      return {
        async start() {
          listener.started = true;
        },
        async stop() {
          listener.stopped = true;
        },
      };
    },
    setIntervalFn: (callback, ms) => {
      timers.set(ms, callback);
      return { unref() {} };
    },
    clearIntervalFn: () => {},
    ...options.limits,
  });
  return {
    streams,
    reads,
    touches,
    warnings,
    timers,
    listener,
    wake: (payload, channel = "yaparena_user_v1") => wake(payload, channel),
  };
}

describe("personal live update streams", () => {
  it("sends the player's state on connect and after each change notice", async () => {
    const f = fixture();
    await f.streams.start();
    assert.equal(f.listener.started, true);
    const first = new FakeResponse();
    const second = new FakeResponse();
    f.streams.subscribe("7", first);
    f.streams.subscribe("7", second);
    await settle();
    assert.equal(
      first.headers["Content-Type"],
      "text/event-stream; charset=utf-8",
    );
    assert.deepEqual(first.events(), [
      { serverNow: "now", ticket: { id: "ticket-7" } },
    ]);
    assert.deepEqual(f.touches, [["7"], ["7"]]);
    f.reads.length = 0;
    f.wake("7");
    f.wake("7");
    f.wake("8");
    f.wake("not-a-user");
    await settle();
    await settle();
    assert.deepEqual(f.reads, ["7"]);
    assert.equal(first.events().length, 2);
    assert.equal(second.events().length, 2);
  });

  it("resynchronizes every player after the listener reconnects", async () => {
    const f = fixture();
    f.streams.subscribe("7", new FakeResponse());
    f.streams.subscribe("9", new FakeResponse());
    await settle();
    f.reads.length = 0;
    f.wake(undefined);
    await settle();
    await settle();
    assert.deepEqual(f.reads.sort(), ["7", "9"]);
  });

  it("limits streams per player and per process", async () => {
    const f = fixture({ limits: { streamsPerUser: 1, maxStreams: 2 } });
    f.streams.subscribe("7", new FakeResponse());
    const extra = new FakeResponse();
    f.streams.subscribe("7", extra);
    assert.equal(extra.statusCode, 503);
    assert.equal(extra.headers["Retry-After"], "10");
    f.streams.subscribe("8", new FakeResponse());
    const full = new FakeResponse();
    f.streams.subscribe("9", full);
    assert.equal(full.statusCode, 503);
  });

  it("frees a slot when a stream closes", async () => {
    const f = fixture({ limits: { streamsPerUser: 1 } });
    const first = new FakeResponse();
    f.streams.subscribe("7", first);
    first.emit("close");
    const again = new FakeResponse();
    f.streams.subscribe("7", again);
    assert.equal(again.statusCode, 200);
    await settle();
    f.reads.length = 0;
    again.emit("close");
    f.wake("7");
    await settle();
    assert.deepEqual(f.reads, []);
  });

  it("sends heartbeats, refreshes presence and closes everything on stop", async () => {
    const f = fixture();
    await f.streams.start();
    const response = new FakeResponse();
    f.streams.subscribe("7", response);
    await settle();
    f.timers.get(15_000)();
    assert.ok(response.frames.includes(": heartbeat\n\n"));
    f.touches.length = 0;
    f.timers.get(20_000)();
    await settle();
    assert.deepEqual(f.touches, [["7"]]);
    await f.streams.stop();
    assert.equal(response.ended, true);
    assert.equal(f.listener.stopped, true);
  });

  it("logs failed reads and presence updates without closing streams", async () => {
    const f = fixture({ failState: true, failTouch: true });
    const response = new FakeResponse();
    f.streams.subscribe("7", response);
    await settle();
    await settle();
    assert.deepEqual(f.warnings.sort(), [
      "live update failed",
      "live update presence failed",
    ]);
    assert.equal(response.ended, false);
  });

  it("refuses a listener channel that is not a plain identifier", () => {
    for (const channel of ["user; DROP TABLE users", "Upper", ""])
      assert.throws(
        () =>
          createPgListener(
            "postgresql://x",
            {},
            () => {},
            () => {},
            { channel },
          ),
        /plain identifier/,
      );
  });

  it("forwards results notices from their own channel or the user channel", async () => {
    const f = fixture();
    const response = new FakeResponse();
    f.streams.subscribe("7", response);
    await settle();
    f.reads.length = 0;
    f.wake("7", "yaparena_results_v1");
    f.wake(JSON.stringify({ user: "7", kind: "results" }));
    f.wake(JSON.stringify({ user: 7, kind: "results" }), "yaparena_results_v1");
    await settle();
    await settle();
    // One commit's notices share a single push, which carries no body; nothing is read.
    assert.deepEqual(response.events("results"), [{}]);
    assert.deepEqual(f.reads, []);
    f.wake(JSON.stringify({ user: "7", kind: "unknown" }));
    f.wake(JSON.stringify({ user: "7", kind: "state" }));
    await settle();
    await settle();
    assert.deepEqual(f.reads, ["7"]);
    assert.equal(response.events("results").length, 1);
  });

  it("re-sends only kinds with data after a reconnect", async () => {
    const f = fixture();
    const response = new FakeResponse();
    f.streams.subscribe("7", response);
    await settle();
    f.wake(undefined);
    await settle();
    await settle();
    assert.equal(response.events("state").length, 2);
    assert.deepEqual(response.events("results"), []);
  });

  it("reads a notice's player and kind", () => {
    const kinds = new Set(["state", "results"]);
    assert.deepEqual(parseNotice("42", "state", kinds), {
      user: "42",
      kind: "state",
    });
    assert.equal(parseNotice("42", "", kinds), null);
    assert.equal(parseNotice("42", "missing", kinds), null);
    assert.deepEqual(
      parseNotice('{"user":42,"kind":"results"}', "state", kinds),
      { user: "42", kind: "results" },
    );
    for (const payload of [
      undefined,
      "0",
      "not json",
      "null",
      '"42"',
      '{"user":"x","kind":"results"}',
      '{"user":"42"}',
      '{"user":"42","kind":"other"}',
    ])
      assert.equal(parseNotice(payload, "state", kinds), null, payload);
  });

  it("refuses kind names that cannot be SSE event names", () => {
    assert.throws(
      () =>
        createUserStreams({
          databaseUrl: "postgresql://x",
          logger: { warn() {} },
          kinds: { "Bad kind": {} },
          channels: {},
          listen: () => ({ async start() {}, async stop() {} }),
        }),
      /lowercase names/,
    );
  });

  it("listens on every channel through one connection and names each notice's channel", async () => {
    const Original = pg.Client;
    const clients = [];
    const listened = [];
    class Client extends EventEmitter {
      constructor() {
        super();
        clients.push(this);
      }
      async connect() {}
      async query(sql) {
        if (sql.startsWith("LISTEN")) listened.push(sql);
        return { rows: [{ safe: true }] };
      }
      async end() {}
    }
    pg.Client = Client;
    const wakes = [];
    const listener = createPgListener(
      "synthetic",
      { warn() {} },
      (payload, channel) => wakes.push([payload, channel]),
      () => {},
      { channels: ["yaparena_user_v1", "yaparena_results_v1"], name: "user" },
    );
    try {
      await listener.start();
      assert.equal(clients.length, 1);
      assert.deepEqual(listened, [
        "LISTEN yaparena_user_v1",
        "LISTEN yaparena_results_v1",
      ]);
      clients[0].emit("notification", {
        channel: "yaparena_results_v1",
        payload: "7",
      });
      clients[0].emit("notification", { channel: "other", payload: "8" });
      assert.deepEqual(wakes, [
        [undefined, undefined],
        ["7", "yaparena_results_v1"],
      ]);
    } finally {
      await listener.stop();
      pg.Client = Original;
    }
    assert.throws(
      () =>
        createPgListener(
          "x",
          {},
          () => {},
          () => {},
          {
            channels: ["yaparena_user_v1", "Bad"],
          },
        ),
      /plain identifier/,
    );
    assert.throws(
      () =>
        createPgListener(
          "x",
          {},
          () => {},
          () => {},
          { channels: [] },
        ),
      /plain identifier/,
    );
  });

  it("serves /api/me/stream to the signed-in player only", async () => {
    const subscribed = [];
    const app = (signedIn) =>
      createApp({
        userStreams: {
          subscribe(userId, response) {
            subscribed.push(userId);
            response.status(204).end();
          },
        },
        sessions: {
          findUserByTokenHash: async () =>
            signedIn
              ? { id: "7", email: null, createdAt: new Date("2026-09-01") }
              : null,
          create: async () => {},
          deleteByTokenHash: async () => false,
        },
        users: { create: async () => ({}), findByEmail: async () => null },
        messages: { isReady: async () => {} },
        logger: createLogger({ enabled: false }),
      });
    const anonymous = await request(app(false)).get("/api/me/stream");
    assert.equal(anonymous.status, 401);
    const member = await request(app(true))
      .get("/api/me/stream")
      .set("Cookie", "session=test");
    assert.equal(member.status, 204);
    assert.equal(member.headers["cache-control"], "no-store");
    assert.deepEqual(subscribed, ["7"]);
  });
});
