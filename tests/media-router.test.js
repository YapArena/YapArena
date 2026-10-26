import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  createMediaRouter,
  createMediaWebhookRouter,
} from "../dist/features/media/router.js";
import { MediaConflictError } from "../dist/features/media/repository.js";

const id = "33333333-3333-4333-8333-333333333333";
function fixture(overrides = {}) {
  const calls = [];
  const event = { status: "live", publicationState: "published" };
  const state = {
    debateId: id,
    state: "running",
    activeSide: "A",
    revision: 3,
    egressId: "egress-1",
    recordingStatus: "recording",
    recordingKey: `debates/${id}/recording.mp4`,
  };
  const media = {
    async getPublicSnapshot() {
      const current = await this.getPublicEvent();
      return current?.publicationState === "published"
        ? {
            state: await this.get(),
            eventStatus: current.status,
            serverNow: new Date().toISOString(),
            streamRevision: "1",
          }
        : null;
    },
    async get() {
      calls.push("get");
      return state;
    },
    async getPublicEvent() {
      return event;
    },
    async sideFor(_id, user) {
      return user === "1" ? "A" : null;
    },
    async assertDeviceReady() {
      calls.push("assertDeviceReady");
    },
    async checkDevice(_id, _user, camera, microphone) {
      calls.push("checkDevice");
      return { cameraOk: camera, microphoneOk: microphone };
    },
    async checkAccountDevice(user, camera, microphone) {
      calls.push(`checkAccountDevice:${user}:${camera}:${microphone}`);
      return { cameraOk: camera, microphoneOk: microphone };
    },
    async start(_id, egress, key) {
      calls.push(`start:${egress}:${key}`);
      return state;
    },
    async undoFailedStart() {
      calls.push("undoFailedStart");
    },
    async stop() {
      calls.push("stop");
      return state;
    },
    async pause(_id, actor, reason) {
      calls.push(`pause:${actor}:${reason}`);
      return { ...state, state: "paused" };
    },
    async resume() {
      calls.push("resume");
      return state;
    },
    async recordingEnded() {
      calls.push("recordingEnded");
      return state;
    },
    async captions() {
      return "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello";
    },
    async setCaptions() {
      calls.push("setCaptions");
    },
    ...overrides.media,
  };
  const provider = {
    publicUrl: "ws://localhost:7880",
    async token(_id, _user, publish) {
      calls.push(`token:${publish}`);
      return "jwt";
    },
    async connectedSpeakers() {
      return 2;
    },
    async beginRecording() {
      calls.push("beginRecording");
      return { egressId: "egress-1", key: state.recordingKey };
    },
    async stopRecording() {
      calls.push("stopRecording");
    },
    async setTurn(_id, side) {
      calls.push(`setTurn:${side}`);
    },
    async replayUrl() {
      return "http://localhost:8333/replay";
    },
    async replayAccess(key) {
      return { url: await this.replayUrl(key), expiresIn: 3600 };
    },
    async thumbnail() {
      calls.push("thumbnail");
      return Buffer.from([255, 216, 255, 0, 255, 217]);
    },
    async publishCaptions() {
      calls.push("publishCaptions");
    },
    async webhook() {
      return {};
    },
    ...overrides.provider,
  };
  const matching = {
    async operatorTransition(_user, _id, action) {
      calls.push(`transition:${action}`);
      return {
        status:
          action === "start" ? "live" : action === "end" ? "ended" : "replay",
      };
    },
    ...overrides.matching,
  };
  const identity = {
    async getRoles(user) {
      return user === "9" ? ["operator"] : ["participant"];
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error() {}, warn() {} };
    next();
  });
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    if (!req.header("x-user"))
      return res.status(401).json({ error: "authentication required" });
    req.user = { id: req.header("x-user") };
    next();
  };
  app.use(
    "/api/media",
    createMediaRouter({ media, provider, matching, identity, requireAuth }),
  );
  app.use((error, _req, res, _next) => {
    void _next;
    return res.status(500).json({ error: error.message });
  });
  return { app, media, provider, calls, event, state };
}

describe("media API", () => {
  it("serves a recording thumbnail only for a published verified replay without issuing a media grant", async () => {
    const f = fixture();
    const path = `/api/media/events/${id}/thumbnail`;
    assert.equal((await request(f.app).get(path)).status, 404);
    f.event.status = "replay";
    f.state.recordingStatus = "ready";
    const image = await request(f.app).get(path);
    assert.equal(image.status, 200);
    assert.match(image.headers["content-type"], /image\/jpeg/);
    assert.equal(image.headers["cache-control"], "no-store");
    assert.deepEqual(image.body, Buffer.from([255, 216, 255, 0, 255, 217]));
    f.event.publicationState = "hidden";
    assert.equal((await request(f.app).get(path)).status, 404);
    assert.equal(f.calls.filter((call) => call === "thumbnail").length, 1);
    assert.equal(
      (await request(f.app).get("/api/media/events/BAD/thumbnail")).status,
      404,
    );
    f.event.publicationState = "published";
    f.provider.thumbnail = async () => {
      throw new Error("private storage detail");
    };
    const missing = await request(f.app).get(path);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.text, /private storage/);
    f.media.getPublicEvent = async () => null;
    assert.equal((await request(f.app).get(path)).status, 404);
  });
  it("shows only published state and restricts viewer grants to live events", async () => {
    const f = fixture();
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}`)).body.state
        .activeSide,
      "A",
    );
    assert.equal(
      (await request(f.app).post(`/api/media/events/${id}/viewer-token`)).body
        .token,
      "jwt",
    );
    assert.ok(f.calls.includes("token:false"));
    f.event.status = "ended";
    assert.equal(
      (await request(f.app).post(`/api/media/events/${id}/viewer-token`))
        .status,
      404,
    );
    f.event.publicationState = "draft";
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}`)).status,
      404,
    );
    assert.equal(
      (await request(f.app).get("/api/media/events/nope")).status,
      404,
    );
  });

  it("gates replay and captions on verified published recording", async () => {
    const f = fixture();
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/replay`)).status,
      404,
    );
    f.event.status = "replay";
    f.state.recordingStatus = "ready";
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/replay`)).body
        .expiresIn,
      3600,
    );
    assert.match(
      (await request(f.app).get(`/api/media/events/${id}/captions.vtt`)).text,
      /^WEBVTT/,
    );
    f.state.recordingStatus = "failed";
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/replay`)).status,
      404,
    );
    f.event.publicationState = "draft";
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/captions.vtt`)).status,
      404,
    );
    const broken = fixture({
      provider: {
        async replayUrl() {
          throw new Error("storage down");
        },
      },
    });
    broken.event.status = "replay";
    broken.state.recordingStatus = "ready";
    assert.equal(
      (await request(broken.app).get(`/api/media/events/${id}/replay`)).status,
      503,
    );
  });

  it("checks devices and issues speaker tokens only for the owning seat", async () => {
    const f = fixture();
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/speaker-seat`)).status,
      401,
    );
    assert.deepEqual(
      (
        await request(f.app)
          .get(`/api/media/events/${id}/speaker-seat`)
          .set("x-user", "1")
      ).body,
      { side: "A", userId: "1" },
    );
    assert.equal(
      (
        await request(f.app)
          .get(`/api/media/events/${id}/speaker-seat`)
          .set("x-user", "2")
      ).status,
      404,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/device-check`)
          .send({ cameraOk: true, microphoneOk: true })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/device-check`)
          .set("x-user", "9")
          .send({ cameraOk: true, microphoneOk: true })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/device-check`)
          .set("x-user", "1")
          .send({ cameraOk: "yes" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/device-check`)
          .set("x-user", "1")
          .send({ cameraOk: true, microphoneOk: true })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/speaker-token`)
          .set("x-user", "1")
      ).body.side,
      "A",
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/speaker-token`)
          .set("x-user", "2")
      ).status,
      404,
    );
    f.event.status = "ended";
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/speaker-token`)
          .set("x-user", "1")
      ).status,
      404,
    );
  });

  it("records the queue screen's camera check for signed-in participants only", async () => {
    const f = fixture();
    const check = (user, body) =>
      request(f.app)
        .post("/api/media/device-check")
        .set(user ? { "x-user": user } : {})
        .send(body);
    assert.equal(
      (await check(null, { cameraOk: true, microphoneOk: true })).status,
      401,
    );
    assert.equal(
      (await check("9", { cameraOk: true, microphoneOk: true })).status,
      403,
    );
    assert.equal((await check("1", { cameraOk: "yes" })).status, 400);
    const saved = await check("1", { cameraOk: true, microphoneOk: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.check, { cameraOk: true, microphoneOk: false });
    assert.deepEqual(f.calls, ["checkAccountDevice:1:true:false"]);
  });

  it("starts recording before live, then stops it on operator end", async () => {
    const f = fixture();
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "1")
          .send({ reason: "go live" })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "9")
          .send({ reason: "x" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "9")
          .send({ reason: "both speakers ready" })
      ).status,
      200,
    );
    assert.deepEqual(f.calls.slice(0, 4), [
      "beginRecording",
      `start:egress-1:${f.state.recordingKey}`,
      "transition:start",
      "setTurn:A",
    ]);
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/end`)
          .set("x-user", "9")
          .send({ reason: "time complete" })
      ).status,
      200,
    );
    assert.deepEqual(f.calls.slice(-3), [
      "transition:end",
      "stop",
      "setTurn:null",
    ]);
  });

  it("cleans up orphan recording when start loses a lifecycle race", async () => {
    const f = fixture({
      matching: {
        async operatorTransition() {
          throw new MediaConflictError("start raced");
        },
      },
    });
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "9")
          .send({ reason: "both speakers ready" })
      ).status,
      409,
    );
    assert.ok(f.calls.includes("undoFailedStart"));
    assert.ok(f.calls.includes("stopRecording"));
  });

  it("requires both speakers and exposes explicit pause and resume", async () => {
    let connected = 1;
    const f = fixture({
      provider: {
        async connectedSpeakers() {
          return connected;
        },
      },
    });
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "9")
          .send({ reason: "both speakers ready" })
      ).status,
      409,
    );
    assert.ok(!f.calls.includes("beginRecording"));
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/pause`)
          .set("x-user", "9")
          .send({ reason: "speaker dropped" })
      ).status,
      200,
    );
    assert.ok(f.calls.includes("setTurn:null"));
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/resume`)
          .set("x-user", "9")
          .send({ revision: "3" })
      ).status,
      400,
    );
    connected = 2;
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/resume`)
          .set("x-user", "9")
          .send({ revision: 3 })
      ).status,
      200,
    );
    assert.ok(f.calls.includes("setTurn:A"));
  });

  it("pauses again when LiveKit cannot restore the resumed speaker turn", async () => {
    const f = fixture({
      provider: {
        async setTurn() {
          throw new Error("LiveKit unavailable");
        },
      },
    });
    const response = await request(f.app)
      .post(`/api/media/events/${id}/resume`)
      .set("x-user", "9")
      .send({ revision: 3 });
    assert.equal(response.status, 503);
    assert.ok(
      f.calls.includes("pause:9:Speaker permissions could not be restored."),
    );
  });

  it("requires a verified recording to publish replay and validates WebVTT", async () => {
    const f = fixture();
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/replay`)
          .set("x-user", "9")
          .send({ reason: "recording checked" })
      ).status,
      409,
    );
    f.state.recordingStatus = "ready";
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/replay`)
          .set("x-user", "9")
          .send({ reason: "recording checked" })
      ).body.event.status,
      "replay",
    );
    assert.equal(
      (
        await request(f.app)
          .put(`/api/media/events/${id}/captions`)
          .set("x-user", "9")
          .send({ vtt: "<script>" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .put(`/api/media/events/${id}/captions`)
          .set("x-user", "9")
          .send({ vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello" })
      ).status,
      204,
    );
  });

  it("rejects malformed IDs and missing evidence across media actions", async () => {
    const f = fixture();
    const base = "/api/media/events/invalid";
    for (const path of ["", "/replay", "/captions.vtt"])
      assert.equal((await request(f.app).get(base + path)).status, 404);
    for (const path of [
      "/viewer-token",
      "/device-check",
      "/speaker-token",
      "/start",
      "/end",
      "/pause",
      "/resume",
      "/replay",
    ])
      assert.equal(
        (
          await request(f.app)
            .post(base + path)
            .set(
              "x-user",
              ["/device-check", "/speaker-token"].includes(path) ? "1" : "9",
            )
            .send({
              reason: "test reason",
              revision: 1,
              cameraOk: true,
              microphoneOk: true,
            })
        ).status,
        404,
      );
    assert.equal(
      (
        await request(f.app)
          .put(base + "/captions")
          .set("x-user", "9")
          .send({ vtt: "WEBVTT\n" })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/end`)
          .set("x-user", "9")
          .send({ reason: "x" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/pause`)
          .set("x-user", "9")
          .send({ reason: "x" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/replay`)
          .set("x-user", "9")
          .send({ reason: "x" })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(f.app)
          .put(`/api/media/events/${id}/captions`)
          .set("x-user", "9")
          .send({ vtt: "WEBVTT\n<script>" })
      ).status,
      400,
    );
  });

  it("reports no captions and storage outage without leaking object keys", async () => {
    const f = fixture({
      media: {
        async captions() {
          return null;
        },
      },
    });
    f.event.status = "finalized";
    f.state.recordingStatus = "ready";
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/captions.vtt`)).status,
      404,
    );
    f.state.recordingKey = null;
    assert.equal(
      (await request(f.app).get(`/api/media/events/${id}/replay`)).status,
      404,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/replay`)
          .set("x-user", "9")
          .send({ reason: "recording checked" })
      ).status,
      409,
    );
  });

  it("surfaces device failure and pauses when initial turn permissions fail", async () => {
    const f = fixture({
      media: {
        async assertDeviceReady() {
          throw new MediaConflictError("camera required");
        },
      },
      provider: {
        async setTurn() {
          throw new Error("media permission failure");
        },
      },
    });
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/speaker-token`)
          .set("x-user", "1")
      ).status,
      409,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/start`)
          .set("x-user", "9")
          .send({ reason: "both speakers ready" })
      ).status,
      200,
    );
    assert.ok(f.calls.some((call) => call.startsWith("pause:null")));
  });

  it("keeps a paused debate paused until both speakers have reconnected", async () => {
    const f = fixture({
      provider: {
        async connectedSpeakers() {
          return 1;
        },
      },
    });
    f.state.state = "paused";
    const response = await request(f.app)
      .post(`/api/media/events/${id}/resume`)
      .set("x-user", "9")
      .send({ revision: f.state.revision });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /both speakers must be connected/);
    assert.ok(!f.calls.includes("resume"));
  });

  it("records an operator end even when LiveKit turn revocation is unavailable", async () => {
    const f = fixture({
      provider: {
        async setTurn() {
          throw new Error("LiveKit unavailable");
        },
      },
    });
    const response = await request(f.app)
      .post(`/api/media/events/${id}/end`)
      .set("x-user", "9")
      .send({ reason: "operator stopped debate" });
    assert.equal(response.status, 200);
    assert.ok(f.calls.includes("stop"));
  });

  it("does not delete a live event after permission and pause errors", async () => {
    const f = fixture({
      provider: {
        async setTurn() {
          throw new Error("permission update failed");
        },
      },
      media: {
        async pause() {
          throw new Error("pause failed");
        },
      },
    });
    const response = await request(f.app)
      .post(`/api/media/events/${id}/start`)
      .set("x-user", "9")
      .send({ reason: "both speakers ready" });
    assert.equal(response.status, 200);
    assert.ok(!f.calls.includes("undoFailedStart"));
    assert.ok(!f.calls.includes("stopRecording"));
  });

  it("hides missing events and unavailable media without issuing grants", async () => {
    const missing = fixture({
      media: {
        async getPublicEvent() {
          return null;
        },
        async get() {
          return null;
        },
      },
    });
    assert.equal(
      (await request(missing.app).get(`/api/media/events/${id}`)).status,
      404,
    );
    assert.equal(
      (await request(missing.app).get(`/api/media/events/${id}/replay`)).status,
      404,
    );
    assert.equal(
      (await request(missing.app).get(`/api/media/events/${id}/captions.vtt`))
        .status,
      404,
    );
    assert.equal(
      (await request(missing.app).post(`/api/media/events/${id}/viewer-token`))
        .status,
      404,
    );
    assert.equal(
      (
        await request(missing.app)
          .post(`/api/media/events/${id}/speaker-token`)
          .set("x-user", "1")
      ).status,
      404,
    );
    assert.ok(!missing.calls.some((call) => call.startsWith("token:")));
    const noMedia = fixture({
      media: {
        async get() {
          return null;
        },
      },
    });
    noMedia.event.status = "replay";
    assert.equal(
      (await request(noMedia.app).get(`/api/media/events/${id}/replay`)).status,
      404,
    );
    assert.equal(
      (
        await request(noMedia.app)
          .post(`/api/media/events/${id}/replay`)
          .set("x-user", "9")
          .send({ reason: "ready for replay" })
      ).status,
      409,
    );
  });

  it("returns precise conflict and not-found errors for speaker and operator actions", async () => {
    const f = fixture({
      media: {
        async checkDevice() {
          throw new MediaConflictError("event not awaiting speakers");
        },
        async pause() {
          throw new MediaConflictError("debate is not running");
        },
        async resume() {
          throw new MediaConflictError("state changed");
        },
      },
    });
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/device-check`)
          .set("x-user", "1")
          .send({ cameraOk: true, microphoneOk: false })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/pause`)
          .set("x-user", "9")
          .send({ reason: "speaker dropped" })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(f.app)
          .post(`/api/media/events/${id}/resume`)
          .set("x-user", "9")
          .send({ revision: 3 })
      ).status,
      409,
    );
    const noCaptions = fixture({
      media: {
        async setCaptions() {
          throw new MediaConflictError("recording required");
        },
      },
    });
    assert.equal(
      (
        await request(noCaptions.app)
          .put(`/api/media/events/${id}/captions`)
          .set("x-user", "9")
          .send({ vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText" })
      ).status,
      409,
    );
  });
});

describe("signed media webhooks", () => {
  it("fences speaker departure pauses and preserves a replacement's current turn", async () => {
    const calls = [];
    const identity = "speaker-7c010b32-a0f9-46cb-8f39-8657886819c5";
    const client = {};
    let relevant = false;
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
          async pauseWithClient(actualClient, ...args) {
            assert.equal(actualClient, client);
            calls.push(args);
          },
          async get() {
            // A moderator resumed the debate after the departure committed.
            return { state: "running", activeSide: "B" };
          },
        },
        accountRevocation: {
          async withSpeakerDeparture(debateId, actualIdentity, pause) {
            assert.equal(debateId, id);
            assert.equal(actualIdentity, identity);
            if (!relevant) return false;
            await pause(client);
            return true;
          },
        },
        provider: {
          async webhook() {
            return {
              event: "participant_left",
              room: { name: `debate-${id}` },
              participant: { identity },
            };
          },
          async setTurn(debateId, side) {
            calls.push({ debateId, side });
          },
        },
      }),
    );
    const deliver = () =>
      request(app)
        .post("/webhook")
        .set("Content-Type", "application/webhook+json")
        .send("{}");
    assert.equal((await deliver()).status, 204);
    assert.deepEqual(
      calls,
      [],
      "a delayed old departure must not pause or mute",
    );
    relevant = true;
    assert.equal((await deliver()).status, 204);
    assert.deepEqual(calls, [
      [id, null, "Speaker disconnected. Operator review required."],
      { debateId: id, side: "B" },
    ]);
  });

  it("pauses on speaker drop and recording failure, ignoring non-speakers", async () => {
    const calls = [];
    let event = {
      event: "participant_left",
      room: { name: `debate-${id}` },
      participant: { identity: "speaker-1" },
    };
    const media = {
      async pause(...args) {
        calls.push(args);
      },
      async recordingEnded() {
        return { debateId: id, state: "running" };
      },
      async get() {
        return { state: "running", activeSide: "A" };
      },
    };
    const provider = {
      async webhook() {
        return event;
      },
      async setTurn(_id, side) {
        calls.push(`setTurn:${side}`);
      },
    };
    const app = express();
    app.use((req, _res, next) => {
      req.log = { error() {}, warn() {} };
      next();
    });
    app.use(
      "/webhook",
      express.raw({ type: "application/webhook+json" }),
      createMediaWebhookRouter({ media, provider }),
    );
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.deepEqual(calls, [
      [id, null, "Speaker disconnected. Operator review required."],
      "setTurn:null",
    ]);
    event = {
      event: "participant_joined",
      room: { name: `debate-${id}` },
      participant: { identity: "speaker-1" },
    };
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.ok(calls.includes("setTurn:A"));
    event = {
      event: "egress_ended",
      egressInfo: { egressId: "egress-1", status: 4, fileResults: [] },
    };
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.equal(calls.length, 5);
    assert.equal(calls.at(-1), "setTurn:null");
    event = {
      event: "participant_left",
      room: { name: `debate-${id}` },
      participant: { identity: "viewer-1" },
    };
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.equal(calls.length, 5);
  });

  it("rejects an invalid signature or webhook payload", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.log = { warn() {} };
      next();
    });
    app.use(
      "/webhook",
      express.raw({ type: "application/webhook+json" }),
      createMediaWebhookRouter({
        media: {},
        provider: {
          async webhook() {
            throw new Error("invalid signature");
          },
        },
      }),
    );
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      400,
    );
  });

  it("accepts a completed recording and tolerates stale speaker disconnects", async () => {
    const calls = [];
    let event = {
      event: "egress_ended",
      egressInfo: {
        egressId: "egress-1",
        status: 3,
        fileResults: [{ filename: `debates/${id}/recording.mp4`, size: 100n }],
      },
    };
    const media = {
      async recordingEnded(_egress, success, key) {
        calls.push({ success, key });
        return { debateId: id, state: "ended" };
      },
      async pause() {
        throw new MediaConflictError("already paused");
      },
    };
    const provider = {
      async webhook() {
        return event;
      },
    };
    const app = express();
    app.use((req, _res, next) => {
      req.log = { warn() {} };
      next();
    });
    app.use(
      "/webhook",
      express.raw({ type: "application/webhook+json" }),
      createMediaWebhookRouter({ media, provider }),
    );
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.deepEqual(calls, [
      { success: true, key: `debates/${id}/recording.mp4` },
    ]);
    event.egressInfo.status = 4;
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    assert.deepEqual(calls.at(-1), { success: false, key: null });
    event = {
      event: "participant_left",
      room: { name: `debate-${id}` },
      participant: { identity: "speaker-1" },
    };
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
    event = {
      event: "participant_left",
      room: { name: "unrelated" },
      participant: { identity: "speaker-1" },
    };
    assert.equal(
      (
        await request(app)
          .post("/webhook")
          .set("Content-Type", "application/webhook+json")
          .send("{}")
      ).status,
      204,
    );
  });
});

it("accepts anonymous bounded operational playback reports and denies removed replay renewal", async () => {
  const f = fixture();
  const report = {
    event: "attempt",
    mode: "live",
    prepared: false,
    browser: "chrome",
    device: "desktop",
  };
  assert.equal(
    (
      await request(f.app)
        .post(`/api/media/events/${id}/playback`)
        .send({ reports: [report] })
    ).status,
    204,
  );
  assert.equal(
    (
      await request(f.app)
        .post(`/api/media/events/${id}/playback`)
        .send({ reports: [{ ...report, url: "secret" }] })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(f.app)
        .post("/api/media/events/invalid/playback")
        .send({ reports: [report] })
    ).status,
    404,
  );
  f.event.status = "replay";
  f.state.recordingStatus = "ready";
  assert.equal(
    (await request(f.app).get(`/api/media/events/${id}/replay`)).status,
    200,
  );
  f.event.publicationState = "removed";
  assert.equal(
    (await request(f.app).get(`/api/media/events/${id}/replay`)).status,
    404,
  );
});
