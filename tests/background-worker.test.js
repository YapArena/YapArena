import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../dist/platform/config.js";
import { createMetrics } from "../dist/platform/metrics.js";
import { createBackgroundWorker } from "../dist/services.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://yaparena_runtime@localhost:5432/yaparena",
};
// Settings the jobs worker must ignore: it never calls Auth0.
const signIn = {
  AUTH0_ISSUER_BASE_URL: "https://tenant.example.test",
  AUTH0_CLIENT_ID: "test-client-0123456789",
  AUTH0_CLIENT_SECRET: "test-client-secret-0123456789",
  REDIS_SECURITY_URL: "redis://127.0.0.1:6379",
  REDIS_NAMESPACE: "test",
  REDIS_KEY_SECRET: "k".repeat(32),
};
const media = {
  LIVEKIT_URL: "http://localhost:7880",
  LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "secret",
  MEDIA_S3_ENDPOINT: "http://localhost:8333",
  MEDIA_S3_PUBLIC_ENDPOINT: "http://localhost:8333",
  MEDIA_S3_REGION: "us-east-1",
  MEDIA_S3_BUCKET: "replays",
  MEDIA_S3_ACCESS_KEY: "local",
  MEDIA_S3_SECRET_KEY: "local-secret",
  MEDIA_REPLAY_EDGE_URL: "https://replay.example",
  MEDIA_REPLAY_SIGNING_SECRET: "s".repeat(32),
  MEDIA_REPLAY_PACKAGING_ENABLED: "true",
};

// Every query fails, so each job runs its real code and reports a failure
// without reaching PostgreSQL, a sign-in provider, Redis or LiveKit.
function startWorker(environment) {
  const events = [];
  const errors = [];
  const ran = [];
  const timers = [];
  const cleared = [];
  const unavailable = async () => {
    throw new Error("database unavailable");
  };
  const metrics = createMetrics();
  const worker = createBackgroundWorker({
    config: loadConfig(environment),
    database: {
      query: unavailable,
      connect: unavailable,
      end: async () => events.push("database closed"),
    },
    logger: {
      info: (details, message) => {
        if (message === "background job ran") ran.push(details.job);
      },
      warn() {},
      debug() {},
      error: (_details, message) => errors.push(message),
    },
    metrics,
    verifyDatabase: async () => events.push("verified"),
    setIntervalFn: (callback, interval) => {
      const timer = { interval, callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer.interval),
  });
  return { worker, events, errors, ran, timers, cleared, metrics };
}

async function authJourney(metrics) {
  return Object.fromEntries(
    (await metrics.authJourney.get()).values.map(({ labels, value }) => [
      labels.event,
      value,
    ]),
  );
}

describe("background worker", () => {
  it("starts every maintenance job without media configured", async () => {
    const { worker, events, errors, ran, timers, cleared, metrics } =
      startWorker(base);
    await worker.start();
    // The 15-second timer is the heartbeat; it beats once at start too.
    assert.deepEqual(
      timers.map(({ interval }) => interval),
      [1000, 3600000, 15000],
    );
    await new Promise(setImmediate);
    assert.ok(errors.includes("jobs heartbeat failed"));
    await timers.find(({ interval }) => interval === 3600000).callback();
    assert.ok(errors.includes("community retention cleanup failed"));
    assert.ok(errors.includes("product measurement retention cleanup failed"));
    assert.ok(errors.includes("expired account authorization cleanup failed"));
    await timers.find(({ interval }) => interval === 1000).callback();
    assert.deepEqual(ran, ["cleanup", "a4-recovery"]);
    await worker.stop();
    assert.deepEqual(events, ["verified", "database closed"]);
    assert.deepEqual(cleared.sort(), [1000, 15000, 3600000]);
    assert.deepEqual(await authJourney(metrics), {});
  });

  it("runs media jobs but no sign-in provider jobs with every setting present", async () => {
    const { worker, events, errors, ran, timers, cleared, metrics } =
      startWorker({
        ...base,
        ...signIn,
        ...media,
        COIN_SANDBOX_ENABLED: "true",
      });
    await worker.start();
    // The coin treasury check runs at start, then once a minute (founder D1).
    assert.deepEqual(
      timers.map(({ interval }) => interval).sort((a, b) => a - b),
      [1000, 1000, 1000, 15000, 60000, 3600000],
    );
    await new Promise(setImmediate);
    assert.deepEqual(await authJourney(metrics), {});
    for (const timer of timers.filter(({ interval }) => interval === 1000))
      await timer.callback();
    assert.ok(errors.includes("speaker access revocation failed"));
    assert.ok(errors.includes("A4 recovery tick failed"));
    assert.ok(errors.includes("media clock failed"));
    await timers.find(({ interval }) => interval === 60000).callback();
    assert.ok(errors.includes("coin treasury check failed"));
    assert.deepEqual(ran.sort(), [
      "a4-recovery",
      "coin-treasury",
      "media-clock",
      "speaker-revocation",
    ]);
    await worker.stop();
    assert.deepEqual(events, ["verified", "database closed"]);
    assert.equal(cleared.length, timers.length);
  });
});
