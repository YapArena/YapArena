import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { RoomServiceClient } from "livekit-server-sdk";
import request from "../scripts/test-http-request.ts";
import * as serverProtocol from "../dist/features/transcription/protocol.js";
import * as agentProtocol from "../dist-transcriber/features/transcription/protocol.js";
import {
  createDebateRateLimit,
  createTranscriptionIngestRouter,
} from "../dist/features/transcription/ingest-router.js";
import { createTranscriberDispatcher } from "../dist/features/transcription/dispatch.js";
import { createDebaterSettingsRouter } from "../dist/features/transcription/settings-router.js";
import { parseDebaterSettings } from "../dist/features/transcription/debater-settings.js";
import { createMediaProvider } from "../dist/features/media/provider.js";

const { ingestHeaders, signIngest } = serverProtocol;

const id = "33333333-3333-4333-8333-333333333333";
const secret = "synthetic-transcription-ingest-secret-32b";
const now = 1_793_000_000_000;
const segment = (overrides = {}) => ({
  provider: "deepgram",
  role: "primary",
  language: "fr",
  side: "A",
  startAt: now - 3000,
  endAt: now - 500,
  text: "  Le nucléaire est la seule énergie pilotable décarbonée.  ",
  words: [
    { w: "Le", s: 0, e: 200, c: 0.98 },
    { w: "nucléaire", s: 210, e: 700 },
  ],
  latencyMs: 420,
  audioMs: 2500,
  ...overrides,
});
const update = (overrides = {}) => ({
  jobId: "AJ_test-1",
  sequence: 0,
  turnNumber: 1,
  sentAt: now,
  segments: [segment()],
  ...overrides,
});

// The server and the transcriber agent compile their own copy of the protocol.
for (const [build, protocol] of [
  ["server", serverProtocol],
  ["transcriber agent", agentProtocol],
]) {
  const {
    INGEST_MAX_SKEW_MS,
    parseSessionRequest,
    parseTranscriptUpdate,
    signIngest,
    verifyIngest,
  } = protocol;
  describe(`transcription ingest protocol (${build} build)`, () => {
    it("parses a valid update and trims segment text", () => {
      const parsed = parseTranscriptUpdate(update());
      assert.equal(parsed.segments[0].text, segment().text.trim());
      assert.deepEqual(parsed.segments[0].words[1], {
        w: "nucléaire",
        s: 210,
        e: 700,
      });
      assert.deepEqual(parseSessionRequest({ jobId: "AJ_1" }), {
        jobId: "AJ_1",
      });
    });

    it("rejects unknown fields, bad values and exceeded limits", () => {
      const invalid = [
        null,
        [],
        { ...update(), extra: true },
        update({ jobId: "bad id" }),
        update({ sequence: -1 }),
        update({ turnNumber: 0 }),
        update({ sentAt: 12 }),
        update({ segments: Array.from({ length: 21 }, () => segment()) }),
        update({ segments: [segment({ provider: "whisper" })] }),
        update({ segments: [segment({ role: "secondary" })] }),
        update({ segments: [segment({ language: "de" })] }),
        update({ segments: [segment({ side: "C" })] }),
        update({ segments: [segment({ endAt: now - 4000 })] }),
        update({ segments: [segment({ text: "   " })] }),
        update({ segments: [segment({ text: "x".repeat(1001) })] }),
        update({ segments: [segment({ latencyMs: -1 })] }),
        update({ segments: [segment({ audioMs: 1.5 })] }),
        update({ segments: [segment({ words: [{ w: "", s: 0, e: 1 }] })] }),
        update({ segments: [segment({ words: [{ w: "a", s: 5, e: 1 }] })] }),
        update({
          segments: [segment({ words: [{ w: "a", s: 0, e: 1, c: 2 }] })],
        }),
        update({
          segments: [segment({ words: [{ w: "a", s: 0, e: 1, x: 1 }] })],
        }),
        update({ segments: [{ ...segment(), extra: 1 }] }),
      ];
      for (const value of invalid)
        assert.equal(parseTranscriptUpdate(value), null, JSON.stringify(value));
      assert.equal(parseSessionRequest({ jobId: "AJ", other: 1 }), null);
      assert.equal(parseSessionRequest("AJ"), null);
    });

    it("verifies HMAC signatures within the clock skew", () => {
      const body = JSON.stringify(update()),
        timestamp = String(now),
        signature = signIngest(secret, timestamp, body);
      assert.equal(verifyIngest(secret, timestamp, signature, body, now), true);
      assert.equal(
        verifyIngest(secret, timestamp, signature, `${body} `, now),
        false,
      );
      assert.equal(
        verifyIngest(`${secret}x`, timestamp, signature, body, now),
        false,
      );
      assert.equal(
        verifyIngest(
          secret,
          timestamp,
          signature,
          body,
          now + INGEST_MAX_SKEW_MS + 1,
        ),
        false,
      );
      for (const [t, s] of [
        [undefined, signature],
        ["12", signature],
        [timestamp, undefined],
        [timestamp, "nothex"],
      ])
        assert.equal(verifyIngest(secret, t, s, body, now), false);
    });
  });
}

describe("transcription ingest routes", () => {
  function app({ allow = () => true, ingest, session } = {}) {
    const calls = [];
    const server = express();
    server.use(
      "/api/internal/transcription",
      express.raw({ type: "application/json", limit: "32kb" }),
      createTranscriptionIngestRouter({
        repository: {
          async ingest(debateId, value) {
            calls.push(["ingest", debateId, value]);
            return ingest
              ? ingest(value)
              : { status: 200, body: { accepted: true } };
          },
          async session(debateId, jobId) {
            calls.push(["session", debateId, jobId]);
            return session === undefined ? { debateId, jobId } : session;
          },
        },
        secret,
        allow,
        now: () => now,
      }),
    );
    return { server, calls };
  }
  const post = (server, path, value, { sign = true, raw } = {}) => {
    const body = raw ?? JSON.stringify(value),
      timestamp = String(now);
    const test = request(server)
      .post(`/api/internal/transcription/debates/${id}/${path}`)
      .set("Content-Type", "application/json");
    if (sign)
      test
        .set(ingestHeaders.timestamp, timestamp)
        .set(ingestHeaders.signature, signIngest(secret, timestamp, body));
    return test.send(body);
  };

  it("accepts signed updates and passes parsed values to the repository", async () => {
    const { server, calls } = app();
    const response = await post(server, "updates", update());
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(calls[0][1], id);
    assert.equal(calls[0][2].segments[0].text, segment().text.trim());
  });

  it("relays repository refusals with their status", async () => {
    const { server } = app({
      ingest: () => ({ status: 409, body: { code: "stale_turn" } }),
    });
    const response = await post(server, "updates", update());
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { code: "stale_turn" });
  });

  it("refuses unsigned, invalid, oversized and rate-limited requests", async () => {
    const { server, calls } = app();
    assert.equal(
      (await post(server, "updates", update(), { sign: false })).status,
      401,
    );
    assert.equal(
      (await post(server, "updates", null, { raw: "{not json" })).status,
      400,
    );
    assert.equal(
      (await post(server, "updates", { ...update(), extra: 1 })).status,
      400,
    );
    assert.equal(
      (
        await post(server, "updates", null, {
          raw: JSON.stringify({ pad: "x".repeat(33 * 1024) }),
        })
      ).status,
      413,
    );
    const bad = await request(server)
      .post("/api/internal/transcription/debates/not-a-uuid/updates")
      .set("Content-Type", "application/json")
      .send("{}");
    assert.equal(bad.status, 404);
    const limited = app({ allow: () => false });
    const refused = await post(limited.server, "updates", update());
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["retry-after"], "1");
    assert.equal(calls.length, 0);
  });

  it("returns the session state for a restarting job", async () => {
    const { server, calls } = app();
    const response = await post(server, "session", { jobId: "AJ_1" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["session", id, "AJ_1"]);
    assert.equal((await post(server, "session", { job: 1 })).status, 400);
    const missing = app({ session: null });
    assert.equal(
      (await post(missing.server, "session", { jobId: "AJ_1" })).status,
      404,
    );
  });

  it("limits each debate with a bounded token bucket", () => {
    let time = 0;
    const allow = createDebateRateLimit({
      capacity: 2,
      perSecond: 1,
      maxDebates: 2,
      now: () => time,
    });
    assert.deepEqual([allow("a"), allow("a"), allow("a")], [true, true, false]);
    time = 1000;
    assert.equal(allow("a"), true);
    assert.equal(allow("b"), true);
    assert.equal(allow("c"), false, "the table is full of active debates");
    time = 10_000;
    assert.equal(allow("c"), true, "refilled debates make room");
  });
});

describe("transcriber dispatch", () => {
  function fixture({ claim = 1, fail = false } = {}) {
    const calls = [];
    const dispatcher = createTranscriberDispatcher({
      repository: {
        async claimDispatch(debateId) {
          calls.push(["claim", debateId]);
          return claim;
        },
        async dispatchSettled(debateId, dispatchId) {
          calls.push(["settled", debateId, dispatchId]);
        },
        async dispatchCandidates() {
          return [id, "44444444-4444-4444-8444-444444444444"];
        },
      },
      client: {
        async createDispatch(room, agent, options) {
          calls.push(["dispatch", room, agent, options]);
          if (fail) throw new Error("livekit unavailable");
          return { id: "AD_1" };
        },
      },
      agentName: "yaparena-transcriber",
      roomName: (debateId) => `debate-${debateId}`,
      logger: { warn: (...args) => calls.push(["warn", ...args]) },
    });
    return { dispatcher, calls };
  }

  it("dispatches a claimed debate once with its ID as metadata", async () => {
    const { dispatcher, calls } = fixture();
    assert.equal(await dispatcher.dispatch(id), true);
    assert.deepEqual(calls.slice(0, 3), [
      ["claim", id],
      [
        "dispatch",
        `debate-${id}`,
        "yaparena-transcriber",
        { metadata: JSON.stringify({ debateId: id }) },
      ],
      ["settled", id, "AD_1"],
    ]);
  });

  it("skips debates claimed elsewhere and never throws", async () => {
    const claimed = fixture({ claim: null });
    assert.equal(await claimed.dispatcher.dispatch(id), false);
    assert.equal(claimed.calls.length, 1);
    const failing = fixture({ fail: true });
    assert.equal(await failing.dispatcher.dispatch(id), false);
    assert.deepEqual(failing.calls[2], ["settled", id, null]);
    assert.equal(failing.calls[3][0], "warn");
  });

  it("warms every candidate", async () => {
    const { dispatcher } = fixture();
    assert.deepEqual(await dispatcher.tick(), { dispatched: 2 });
  });
});

describe("debater settings routes", () => {
  function app() {
    const saved = [];
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { id: "7" };
      next();
    });
    server.use(
      "/api/me/debater-settings",
      createDebaterSettingsRouter({
        async get(userId) {
          return { userId, language: null, consented: false };
        },
        async save(userId, input) {
          saved.push([userId, input]);
          return { language: input.language, consented: input.consent };
        },
      }),
    );
    return { server, saved };
  }

  it("reads and saves the signed-in debater's settings", async () => {
    const { server, saved } = app();
    const read = await request(server).get("/api/me/debater-settings");
    assert.equal(read.status, 200);
    assert.equal(read.headers["cache-control"], "private, no-store");
    assert.equal(read.body.userId, "7");
    const write = await request(server)
      .put("/api/me/debater-settings")
      .send({ language: "en", consent: true });
    assert.equal(write.status, 200);
    assert.deepEqual(saved, [["7", { language: "en", consent: true }]]);
  });

  it("refuses anything but a language and a consent choice", async () => {
    const { server, saved } = app();
    for (const body of [
      {},
      { language: "de", consent: true },
      { language: "fr", consent: "yes" },
      { language: "fr", consent: true, extra: 1 },
    ])
      assert.equal(
        (await request(server).put("/api/me/debater-settings").send(body))
          .status,
        400,
      );
    assert.equal(saved.length, 0);
    assert.equal(parseDebaterSettings([]), null);
    assert.equal(parseDebaterSettings(null), null);
  });
});

describe("turn hints in room metadata", () => {
  const config = {
    livekitUrl: "https://live.example",
    livekitPublicUrl: "wss://live.example",
    livekitKey: "synthetic-key",
    livekitSecret: "synthetic-live-secret-more-than-32-characters",
    s3Region: "auto",
    s3Bucket: "synthetic",
    s3AccessKey: "synthetic-key",
    s3SecretKey: "synthetic-secret",
  };
  const hint = (turnNumber, mediaState = "running") => ({
    v: 1,
    debateStatus: "live",
    mediaState,
    turnNumber,
    activeSide: "A",
    turnDeadlineAt: "2026-10-25T00:01:00.000Z",
  });

  it("writes each changed turn once, after permissions, and never fails the turn", async (t) => {
    const writes = [],
      order = [];
    t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => {
      order.push("permissions");
      return [];
    });
    let failing = false;
    t.mock.method(
      RoomServiceClient.prototype,
      "updateRoomMetadata",
      async (room, metadata) => {
        order.push("metadata");
        if (failing) throw new Error("room unavailable");
        writes.push([room, JSON.parse(metadata)]);
      },
    );
    const provider = createMediaProvider(config, undefined, {
      turnMetadata: true,
    });
    await provider.setTurn(id, "A", hint(1));
    await provider.setTurn(id, "A", hint(1));
    assert.deepEqual(order, ["permissions", "metadata", "permissions"]);
    assert.deepEqual(writes, [[`debate-${id}`, hint(1)]]);
    failing = true;
    await provider.setTurn(id, "A", hint(2));
    failing = false;
    await provider.setTurn(id, "A", hint(2));
    await provider.setTurn(id, null, hint(2, "ended"));
    await provider.setTurn(id, null, hint(2, "ended"));
    assert.deepEqual(
      writes.map(([, value]) => [value.turnNumber, value.mediaState]),
      [
        [1, "running"],
        [2, "running"],
        [2, "ended"],
        [2, "ended"],
      ],
      "a failed write is retried, and an ended room is not remembered",
    );
  });

  it("writes nothing when the live outline is off", async (t) => {
    t.mock.method(
      RoomServiceClient.prototype,
      "listParticipants",
      async () => [],
    );
    const write = t.mock.method(
      RoomServiceClient.prototype,
      "updateRoomMetadata",
      async () => {},
    );
    await createMediaProvider(config).setTurn(id, "A", hint(1));
    assert.equal(write.mock.callCount(), 0);
  });
});
