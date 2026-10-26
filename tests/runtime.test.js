import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createRuntime } from "../dist/platform/runtime.js";

describe("service runtime", () => {
  for (const failing of ["play", "sandbox"])
    it(`awaits both market jobs when ${failing} recovery fails`, async () => {
      let callback,
        finish,
        closed = false;
      const calls = [],
        errors = [];
      const run = (kind) => async () => {
        calls.push(kind);
        if (kind === failing) throw new Error(`${kind} failed`);
        await new Promise((resolve) => {
          finish = resolve;
        });
      };
      const runtime = createRuntime({
        a4: { tick: run("play") },
        coinDebates: { tick: run("sandbox") },
        database: {
          end: async () => {
            closed = true;
          },
        },
        sessions: { deleteExpired: async () => {} },
        logger: {
          info() {},
          error: ({ error }) => errors.push(error.message),
        },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        setIntervalFn: (fn, ms) => {
          if (ms === 1000) callback = fn;
          return { unref() {} };
        },
        clearIntervalFn() {},
      });
      await runtime.start();
      const first = callback();
      await Promise.resolve();
      await Promise.resolve();
      callback();
      assert.deepEqual(calls, ["play", "sandbox"]);
      const stopped = runtime.stop();
      await Promise.resolve();
      assert.equal(closed, false);
      finish();
      await first;
      await stopped;
      assert.equal(closed, true);
      assert.deepEqual(errors, [`${failing} failed`]);
    });

  it("recovers media revocations without overlapping claims and awaits in-flight recovery on shutdown", async () => {
    let callback,
      finish,
      calls = 0,
      cleared = 0,
      closed = false;
    const runtime = createRuntime({
      database: {
        end: async () => {
          closed = true;
        },
      },
      sessions: { deleteExpired: async () => {} },
      mediaAccountRevocation: {
        flush: async () => {
          calls++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (fn, ms) => {
        if (ms === 1000) callback = fn;
        return { unref() {} };
      },
      clearIntervalFn: () => {
        cleared++;
      },
    });
    await runtime.start();
    const first = callback();
    callback();
    assert.equal(calls, 1);
    const stop = runtime.stop();
    await Promise.resolve();
    assert.equal(closed, false);
    finish();
    await first;
    await stop;
    assert.equal(closed, true);
    assert.equal(cleared, 2);
  });
  it("runs only maintenance when no web app is supplied", async () => {
    const callbacks = new Map();
    const events = [];
    const runtime = createRuntime({
      database: { end: async () => events.push("closed") },
      sessions: { deleteExpired: async () => events.push("cleanup") },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(3600000)();
    await runtime.stop();
    assert.deepEqual(events, ["cleanup", "closed"]);
  });

  it("starts a web server without duplicate background jobs when disabled", async () => {
    const events = [];
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => events.push("closed") },
      sessions: { deleteExpired: async () => 0 },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      backgroundJobs: false,
      setIntervalFn: () => {
        throw new Error("web service must not start a clock");
      },
    });
    await runtime.start();
    await runtime.stop();
    assert.deepEqual(events, ["closed"]);
  });

  it("verifies the database before listening and closes resources", async () => {
    const events = [];
    const server = { close: (callback) => callback() };
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          events.push("listen");
          queueMicrotask(callback);
          return { ...server, once: () => {} };
        },
      },
      database: { end: mock.fn(async () => events.push("database closed")) },
      communityStreams: {
        start: async () => events.push("listener registered"),
        stop: async () => events.push("streams drained"),
      },
      sessions: { deleteExpired: async () => 0 },
      logger: { info: () => {}, error: () => {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => events.push("verified"),
    });

    await runtime.start();
    await runtime.stop();

    assert.deepEqual(events, [
      "verified",
      "listener registered",
      "listen",
      "streams drained",
      "database closed",
    ]);
  });

  it("does not listen when database verification fails", async () => {
    const listen = mock.fn();
    const runtime = createRuntime({
      app: { listen },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      logger: { info: () => {}, error: () => {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {
        throw new Error("pending migration");
      },
    });

    await assert.rejects(runtime.start(), /pending migration/);
    assert.equal(listen.mock.callCount(), 0);
  });

  it("runs bounded session cleanup without stopping the service on errors", async () => {
    let cleanupCalls = 0;
    const errors = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          const server = { close: (done) => done(), once: () => {} };
          queueMicrotask(callback);
          return server;
        },
      },
      database: { end: async () => {} },
      sessions: {
        deleteExpired: async () => {
          cleanupCalls += 1;
          if (cleanupCalls === 1) return 2;
          throw new Error("temporary cleanup failure");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => errors.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      cleanupIntervalMs: 2,
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });

    await runtime.start();
    await cleanup();
    await cleanup();
    await runtime.stop();

    assert.equal(cleanupCalls, 2);
    assert.deepEqual(errors, ["temporary cleanup failure"]);
  });

  it("expires account confirmation state and audit records independently", async () => {
    const events = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      accountSecurityCleanup: async () => {
        events.push("confirmations");
        throw new Error("confirmation cleanup failed");
      },
      identity: {
        deleteExpiredAudit: async () => {
          events.push("audit");
          return 3;
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, [
      "confirmations",
      "confirmation cleanup failed",
      "audit",
    ]);
  });

  it("expires debate requests without affecting other maintenance", async () => {
    const events = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      matching: {
        expireRequests: async () => {
          events.push("matching");
          throw new Error("matching cleanup failed");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, ["matching", "matching cleanup failed"]);
  });

  it("prunes community records and logs a failed retention run without stopping cleanup", async () => {
    const events = [];
    let cleanup;
    let runs = 0;
    const runtime = createRuntime({
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      community: {
        pruneExpired: async () => {
          runs += 1;
          if (runs === 1) events.push("pruned");
          else throw new Error("retention unavailable");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, ["pruned", "retention unavailable"]);
  });

  it("prunes consented measurement and logs a failed retention run", async () => {
    const events = [];
    let cleanup;
    let runs = 0;
    const runtime = createRuntime({
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      measurement: {
        pruneExpired: async () => {
          runs += 1;
          if (runs === 1) events.push("pruned");
          else throw new Error("measurement retention unavailable");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, ["pruned", "measurement retention unavailable"]);
  });

  it("advances media turns and stops recordings independently of session cleanup", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => events.push("database closed") },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => ({
          turns: [{ debateId: "event-1", side: "B" }],
          ended: ["event-2"],
        }),
        claimRecordingStops: async () => [
          { debateId: "event-1", egressId: "egress-1" },
        ],
        recordingStopFailed: async () => {},
      },
      mediaProvider: {
        setTurn: async (_id, side) => events.push(`turn:${side}`),
        stopRecording: async (id) => events.push(`stop:${id}`),
      },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, [
      "turn:B",
      "turn:null",
      "stop:egress-1",
      "database closed",
    ]);
  });

  it("logs a media clock failure and keeps the service alive", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => {
          throw new Error("database unavailable");
        },
        claimRecordingStops: async () => [],
        recordingStopFailed: async () => {},
      },
      logger: { info() {}, error: ({ error }) => events.push(error.message) },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, ["database unavailable"]);
  });

  it("retries an unsuccessful recording stop without losing the durable request", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => ({ turns: [], ended: [] }),
        claimRecordingStops: async () => [
          { debateId: "event-1", egressId: "egress-1" },
        ],
        recordingStopFailed: async (id) => events.push(`retry:${id}`),
      },
      mediaProvider: {
        setTurn: async () => {},
        stopRecording: async () => {
          throw new Error("egress unavailable");
        },
      },
      logger: { info() {}, error: ({ error }) => events.push(error.message) },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, ["egress unavailable", "retry:event-1"]);
  });
});
