import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";
import { recordingStart } from "../dist/features/media/provider.js";
import { createMediaWebhookRouter } from "../dist/features/media/router.js";

// Decision 0012 (F10): replay viewers join the turn window playing at their
// replay position, measured from the recording file's start.

const roundId = "44444444-4444-4444-8444-444444444444";
const debateId = "33333333-3333-4333-8333-333333333333";

describe("recording clock", () => {
  it("reads LiveKit's nanosecond file start, or nothing when unknown", () => {
    assert.equal(
      recordingStart(1_792_979_219_825_123_456n).toISOString(),
      new Date(1_792_979_219_825).toISOString(),
    );
    assert.equal(recordingStart(0n), null);
  });

  it("hands the completed recording's start to the media repository", async () => {
    const calls = [];
    const app = express();
    app.use((req, _res, next) => {
      req.log = { warn() {} };
      next();
    });
    app.use(
      "/webhook",
      express.raw({ type: "application/webhook+json" }),
      createMediaWebhookRouter({
        media: {
          async recordingEnded(...args) {
            calls.push(args);
            return { debateId, state: "ended" };
          },
        },
        provider: {
          async webhook() {
            return {
              event: "egress_ended",
              egressInfo: {
                egressId: "egress-1",
                status: 3,
                fileResults: [
                  {
                    filename: "recording.mp4",
                    size: 10n,
                    startedAt: 1_792_979_219_825_000_000n,
                  },
                ],
              },
            };
          },
        },
      }),
    );
    const response = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/webhook+json")
      .send("{}");
    assert.equal(response.status, 204);
    assert.equal(calls[0][3].getTime(), 1_792_979_219_825);
  });
});

describe("replay position on the submit route", () => {
  function app() {
    const submitted = [];
    const server = express();
    server.use(express.json(), cookieParser());
    server.use((req, _res, next) => {
      req.user = { id: "7" };
      next();
    });
    server.use(
      createCoinSandboxRouter({
        sandbox: {},
        debates: {
          async submit(_context, id, _key, input) {
            submitted.push([id, input]);
            return { id: "request", created: true };
          },
        },
        operations: {},
        environment: "test",
        applicationOrigin: "http://app.test",
      }),
    );
    const post = (body) =>
      request(server)
        .post(`/rounds/${roundId}/submit`)
        .set("Origin", "http://app.test")
        .set("X-YapArena-Session", "1")
        .set("Idempotency-Key", "key-1")
        .set("Cookie", "session=token")
        .send(body);
    return { post, submitted };
  }
  const order = { side: "YES", ceiling: "0.5", quantity: 1 };

  it("passes a replay position in whole milliseconds, and omits it when live", async () => {
    const { post, submitted } = app();
    assert.equal((await post(order)).status, 201);
    assert.equal(submitted[0][1].replayPositionMs, undefined);
    assert.equal(
      (await post({ ...order, replayPositionSeconds: 90.5004 })).status,
      201,
    );
    assert.equal(submitted[1][1].replayPositionMs, 90500);
  });

  it("refuses a malformed replay position", async () => {
    const { post, submitted } = app();
    for (const replayPositionSeconds of [-1, "90", 86_401, null])
      assert.equal(
        (await post({ ...order, replayPositionSeconds })).status,
        400,
        String(replayPositionSeconds),
      );
    assert.equal(submitted.length, 0);
  });
});
