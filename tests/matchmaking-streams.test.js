import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createMatchmakingStreams } from "../dist/features/matching/matchmaking-streams.js";
import { createPgListener } from "../dist/platform/pg-listener.js";

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
  events() {
    return this.frames
      .filter((frame) => frame.startsWith("event: state"))
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
  const streams = createMatchmakingStreams({
    databaseUrl: "postgresql://localhost/queue",
    matchmaking: {
      async state(userId) {
        reads.push(userId);
        if (options.failState) throw new Error("database busy");
        return { serverNow: "now", ticket: { id: `ticket-${userId}` } };
      },
      async touchMany(userIds) {
        touches.push([...userIds]);
        if (options.failTouch) throw new Error("database busy");
      },
    },
    logger: { warn: (_details, message) => warnings.push(message) },
    listen: (url, _logger, callback, _count, settings) => {
      assert.equal(url, "postgresql://localhost/queue");
      assert.deepEqual(settings, {
        channel: "yaparena_user_v1",
        name: "matchmaking",
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
    wake: (payload) => wake(payload),
  };
}

describe("live queue streams", () => {
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
      "live queue presence failed",
      "live queue update failed",
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
});
