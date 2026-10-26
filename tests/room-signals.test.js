import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  publicChange,
  publicFrame,
  roomCursor,
  roomSignals,
} from "../dist/features/community/delivery.js";
import {
  createCommunityStream,
  createDeadlineFollower,
  createSignalRefresh,
  deadlineDelay,
  roomTopics,
  roundDeadlines,
  roundStates,
  watchRoom,
} from "../public/community-stream.js";

const room = "22222222-2222-4222-8222-222222222222";
const summary = {
  eventId: room,
  likes: "3",
  chatState: "open",
  chatWritable: true,
  eventStatus: "live",
  revision: "9",
};

describe("room signal wire format", () => {
  it("sends media, round and activity references as summary changes naming a projection", () => {
    // The browser listens for exactly the kinds the server sends.
    assert.deepEqual([...roomSignals], [...roomTopics]);
    for (const kind of roomSignals)
      assert.deepEqual(
        publicChange("summary", { body: "never sent" }, summary, kind),
        { type: "summary", message: null, summary, refresh: kind },
      );
    assert.deepEqual(publicChange("summary", null, summary), {
      type: "summary",
      message: null,
      summary,
    });
    const message = { id: "4", body: "visible" };
    assert.deepEqual(publicChange("message", message, summary), {
      type: "message",
      message,
      summary,
    });
  });
  it("projects references in cursor order for durable HTTP recovery", () => {
    const value = {
      head: "4",
      floor: "0",
      eligible: true,
      summary,
      items: [],
      hasMore: false,
      events: [
        { cursor: "2", kind: "summary", refresh: "media", message: null },
        {
          cursor: "3",
          kind: "message",
          refresh: null,
          message: { id: "8", body: "Hi" },
        },
        { cursor: "4", kind: "summary", refresh: "round", message: null },
      ],
    };
    const frame = publicFrame(room, "1", value);
    assert.equal(frame.cursor, roomCursor(room, "4"));
    assert.deepEqual(
      frame.changes.map((c) => [c.type, c.refresh]),
      [
        ["summary", "media"],
        ["message", undefined],
        ["summary", "round"],
      ],
    );
    // Clients that predate signals accept every change type they receive.
    assert.ok(
      frame.changes.every((c) => ["message", "summary"].includes(c.type)),
    );
  });
});

class Source {
  static instances = [];
  handlers = new Map();
  constructor(url) {
    this.url = url;
    Source.instances.push(this);
  }
  addEventListener(type, fn) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type, value, id) {
    this.handlers.get(type)?.({ data: JSON.stringify(value), lastEventId: id });
  }
}
function stream(overrides = {}) {
  Source.instances = [];
  const signals = new EventTarget();
  const received = [];
  const health = [];
  signals.addEventListener("yap:room-signal", (e) => received.push(e.detail));
  signals.addEventListener("yap:room-stream", (e) => health.push(e.detail));
  let failing = false;
  const transport = createCommunityStream({
    room,
    EventSourceClass: Source,
    apply() {
      if (failing) throw Error("synthetic application failure");
    },
    unavailable() {},
    status() {},
    degraded() {},
    beforeConnect() {},
    setTimer: () => 0,
    clearTimer() {},
    signals,
    ...overrides,
  });
  return {
    transport,
    signals,
    received,
    health,
    fail(value) {
      failing = value;
    },
  };
}
const frame = (cursor, changes = [], kind = "changes") => ({
  version: 1,
  roomId: room,
  cursor: roomCursor(room, cursor),
  kind,
  ...(kind === "snapshot"
    ? { snapshot: { summary, items: [], hasMore: false } }
    : { changes }),
});
const signal = (refresh) => ({
  type: "summary",
  message: null,
  summary,
  refresh,
});

describe("room signals from the page's EventSource", () => {
  it("announces applied references once, in order, and a snapshot as every projection", async () => {
    const s = stream();
    s.transport.start();
    const source = Source.instances[0];
    source.emit("community", frame("5", [], "snapshot"), roomCursor(room, "5"));
    await delay(0);
    source.emit(
      "community",
      frame("7", [
        signal("media"),
        { type: "message", message: null, summary },
        signal("round"),
        signal("window"),
      ]),
      roomCursor(room, "7"),
    );
    await delay(0);
    // A duplicate and a plain chat change announce nothing.
    source.emit(
      "community",
      frame("7", [signal("media")]),
      roomCursor(room, "7"),
    );
    source.emit(
      "community",
      frame("8", [{ type: "summary", message: null, summary }]),
      roomCursor(room, "8"),
    );
    await delay(0);
    assert.deepEqual(s.received, [
      {
        room,
        cursor: "5",
        topics: ["media", "round", "activity", "window"],
      },
      { room, cursor: "7", topics: ["media", "round", "window"] },
    ]);
    s.transport.stop();
  });
  it("announces nothing for a frame the page failed to apply", async () => {
    const s = stream();
    s.transport.start();
    s.fail(true);
    Source.instances[0].emit(
      "community",
      frame("3", [signal("activity")]),
      roomCursor(room, "3"),
    );
    await delay(0);
    assert.deepEqual(s.received, []);
    assert.equal(s.transport.cursor, null);
    s.transport.stop();
  });
  it("reports live only for a healthy EventSource, and repeats its state on request", async () => {
    const s = stream();
    s.transport.start();
    // Polled frames still announce references but do not make the stream live.
    await s.transport.acceptHttp(frame("2", [signal("media")]));
    assert.deepEqual(s.health, []);
    assert.equal(s.received.length, 1);
    Source.instances[0].emit("heartbeat", { version: 1 });
    assert.deepEqual(s.health, [{ room, live: true }]);
    s.signals.dispatchEvent(
      new CustomEvent("yap:room-stream-query", { detail: { room } }),
    );
    s.signals.dispatchEvent(
      new CustomEvent("yap:room-stream-query", {
        detail: { room: "33333333-3333-4333-8333-333333333333" },
      }),
    );
    assert.equal(s.health.length, 2);
    s.transport.suspend();
    assert.deepEqual(s.health.at(-1), { room, live: false });
    s.transport.reconnect();
    Source.instances
      .at(-1)
      .emit("community", frame("3", [signal("round")]), roomCursor(room, "3"));
    await delay(0);
    assert.deepEqual(s.health.at(-1), { room, live: true });
    Source.instances.at(-1).onerror();
    assert.deepEqual(s.health.at(-1), { room, live: false });
    s.transport.stop();
    // Heartbeat, the echoed query and the reconnect.
    assert.equal(s.health.filter((h) => h.live).length, 3);
  });
  it("stops reporting live when the room is no longer public", async () => {
    const s = stream();
    s.transport.start();
    Source.instances[0].emit(
      "community",
      frame("1", []),
      roomCursor(room, "1"),
    );
    await delay(0);
    Source.instances[0].emit("unavailable", { version: 1, roomId: room });
    assert.deepEqual(s.health.at(-1), { room, live: false });
    const polled = stream();
    polled.transport.start();
    Source.instances[0].emit("heartbeat", { version: 1 });
    await polled.transport.acceptHttp(frame("1", []));
    Source.instances[0].emit("heartbeat", { version: 1 });
    await polled.transport.acceptHttp({
      version: 1,
      roomId: room,
      kind: "unavailable",
    });
    assert.deepEqual(polled.health.at(-1), { room, live: false });
  });
  it("works without page events", () => {
    const s = createCommunityStream({
      room,
      EventSourceClass: Source,
      apply() {},
      unavailable() {},
      status() {},
      degraded() {},
      beforeConnect() {},
      setTimer: () => 0,
      clearTimer() {},
    });
    s.start();
    s.stop();
    assert.equal(
      typeof watchRoom({ room, topics: [], signal() {}, health() {} }),
      "function",
    );
  });
});

describe("room watchers in other bundles", () => {
  it("filters by room and topic, reports health changes, and learns the current state", () => {
    const events = new EventTarget();
    events.addEventListener("yap:room-stream-query", (e) => {
      if (e.detail.room === room)
        events.dispatchEvent(
          new CustomEvent("yap:room-stream", { detail: { room, live: true } }),
        );
    });
    const signals = [];
    const health = [];
    const stop = watchRoom({
      room,
      topics: ["round", "activity"],
      events,
      signal: (topic, cursor) => signals.push([topic, cursor]),
      health: (live) => health.push(live),
    });
    assert.deepEqual(health, [true]);
    const send = (detail) =>
      events.dispatchEvent(new CustomEvent("yap:room-signal", { detail }));
    send({ room, cursor: "9007199254740993", topics: ["media", "activity"] });
    send({ room: "other", cursor: "10", topics: ["round"] });
    send({ room, cursor: "11", topics: ["media"] });
    assert.deepEqual(signals, [["activity", 9007199254740993n]]);
    for (const live of [true, false, false])
      events.dispatchEvent(
        new CustomEvent("yap:room-stream", { detail: { room, live } }),
      );
    events.dispatchEvent(
      new CustomEvent("yap:room-stream", {
        detail: { room: "other", live: true },
      }),
    );
    assert.deepEqual(health, [true, false]);
    stop();
    send({ room, cursor: "12", topics: ["round"] });
    assert.equal(signals.length, 1);
  });
});

function timers() {
  const jobs = [];
  return {
    jobs,
    setTimer: (fn, ms) => jobs.push({ fn, ms }) - 1,
    clearTimer: (id) => {
      if (id !== undefined && jobs[id]) jobs[id].cleared = true;
    },
    async run() {
      const job = jobs.find((j) => !j.cleared && !j.ran);
      job.ran = true;
      job.fn();
      await delay(0);
      return job.ms;
    },
    pending: () => jobs.filter((j) => !j.cleared && !j.ran).map((j) => j.ms),
  };
}
describe("signal-driven projection reads", () => {
  it("coalesces signals that arrive during a read into one more read", async () => {
    const t = timers();
    let reads = 0;
    let release;
    const refresh = createSignalRefresh({
      read: () =>
        new Promise((resolve) => {
          reads++;
          release = () => resolve("10");
        }),
      ...t,
    });
    refresh.request(5n);
    refresh.request(6n);
    refresh.request(7n);
    assert.equal(reads, 1);
    release();
    await delay(0);
    assert.equal(reads, 2);
    release();
    await delay(0);
    assert.equal(reads, 2);
    assert.deepEqual(t.pending(), []);
  });
  it("re-reads with bounded backoff while the projection is behind the signal", async () => {
    const t = timers();
    const observed = ["4", "4", "4", "4", "4"];
    let reads = 0;
    const refresh = createSignalRefresh({
      read: async () => observed[reads++],
      ...t,
    });
    refresh.request(5n);
    await delay(0);
    assert.deepEqual(t.pending(), [500]);
    assert.equal(await t.run(), 500);
    assert.equal(await t.run(), 1000);
    assert.equal(await t.run(), 2000);
    assert.equal(reads, 4);
    assert.deepEqual(t.pending(), [], "gives up after three retries");
    // Catching up, or a projection without revisions, stops retrying.
    observed[reads] = "5";
    refresh.request(5n);
    await delay(0);
    assert.deepEqual(t.pending(), []);
    const unversioned = createSignalRefresh({ read: async () => null, ...t });
    unversioned.request(99n);
    await delay(0);
    assert.deepEqual(t.pending(), []);
  });
  it("skips a signal the projection's last read already covers", async () => {
    const t = timers();
    let reads = 0;
    let known = "7";
    const refresh = createSignalRefresh({
      read: async () => {
        reads++;
        known = "9";
        return known;
      },
      current: () => known,
      ...t,
    });
    refresh.request(7n);
    refresh.request(3n);
    await delay(0);
    assert.equal(reads, 0);
    refresh.request(8n);
    await delay(0);
    assert.equal(reads, 1);
    refresh.request(9n);
    await delay(0);
    assert.equal(reads, 1);
    assert.deepEqual(t.pending(), []);
  });
  it("retries a failed read and stops cleanly", async () => {
    const t = timers();
    let reads = 0;
    const refresh = createSignalRefresh({
      read: async () => {
        reads++;
        throw Error("network");
      },
      ...t,
    });
    refresh.request();
    await delay(0);
    assert.deepEqual(t.pending(), [500]);
    refresh.stop();
    assert.deepEqual(t.pending(), []);
    refresh.request();
    await delay(0);
    assert.equal(reads, 1);
  });
});

describe("server deadline follow-up", () => {
  const at = Date.parse("2026-10-24T12:00:00.000Z");
  const iso = (offset) => new Date(at + offset).toISOString();
  it("reads shortly after the next deadline, and backs off while one is due", () => {
    assert.equal(deadlineDelay([], at), null);
    assert.equal(deadlineDelay([null, undefined, "invalid"], at), null);
    assert.equal(deadlineDelay([iso(10000), iso(4000)], at), 6000);
    assert.equal(deadlineDelay([iso(-1)], at), 2000);
    assert.equal(deadlineDelay([iso(-1)], at, 3), 16000);
    assert.equal(deadlineDelay([iso(-1)], at, 4), null);
    assert.equal(deadlineDelay([iso(-1), iso(30000)], at, 4), 32000);
  });
  it("counts consecutive observations of the same due state", () => {
    const follow = createDeadlineFollower();
    const due = [iso(-1)];
    assert.equal(follow(due, "open", at), 2000);
    assert.equal(follow(due, "open", at), 4000);
    assert.equal(follow(due, "locked", at), 2000);
    assert.equal(follow([iso(5000)], "locked", at), 7000);
    assert.equal(follow(due, "locked", at), 2000);
  });
  it("lists the A4 deadlines a run view has not shown yet", () => {
    const rounds = [
      { state: "settled", opensAt: iso(-9), closesAt: iso(-8) },
      { state: "open", opensAt: iso(-1), closesAt: iso(1) },
      { state: "locked", opensAt: iso(-3), closesAt: iso(-2) },
      { state: "pending", opensAt: iso(-5), closesAt: iso(-4) },
      { state: "scheduled", opensAt: iso(2), closesAt: iso(3) },
      { state: "void", opensAt: iso(-7), closesAt: iso(-6) },
    ];
    assert.deepEqual(
      roundDeadlines({ state: "running", revealAt: iso(4), rounds }),
      [iso(1), iso(-2), iso(4), iso(2)],
    );
    assert.deepEqual(
      roundDeadlines({ state: "paused", rounds: rounds.slice(3) }),
      [iso(3)],
    );
    assert.deepEqual(roundDeadlines(null), []);
    assert.deepEqual(roundDeadlines({ id: "x" }), []);
    assert.equal(
      roundStates({ state: "running", rounds }),
      "running:settled,open,locked,pending,scheduled,void",
    );
    assert.equal(roundStates(undefined), ":");
  });
});
