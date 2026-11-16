import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it, mock } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  livekitConnectSources,
  recordingTemplatePolicy,
  renderRecordingTemplate,
} from "../dist/features/media/recording-template.js";
import {
  FRAME_DECODE_TIMEOUT_MS,
  RECORDING_LAYOUT,
  SIDES,
  assignSides,
  hasDecodedFrame,
  shouldStartRecording,
  templateParams,
} from "../public/recording-template-model.js";
import { createLogger } from "../dist/platform/logger.js";

const speaker = (identity, side, extra = {}) => ({
  identity: `speaker-${identity}`,
  metadata: side ? JSON.stringify({ side }) : undefined,
  joinedAt: 1000,
  camera: true,
  ...extra,
});

describe("recording page sides", () => {
  it("puts side A left and side B right whatever order people joined in", () => {
    assert.deepEqual(SIDES, ["A", "B"]);
    assert.equal(RECORDING_LAYOUT, "sides-v1");
    const a = speaker("a", "A", { joinedAt: 2000 });
    const b = speaker("b", "B", { joinedAt: 1000 });
    for (const people of [
      [a, b],
      [b, a],
    ])
      assert.deepEqual(assignSides(people), {
        A: "speaker-a",
        B: "speaker-b",
      });
  });

  it("leaves a half black rather than guessing a side", () => {
    const viewer = {
      identity: "viewer-1",
      metadata: JSON.stringify({ side: "A" }),
      joinedAt: 5000,
      camera: true,
    };
    const agent = {
      identity: "agent-transcriber",
      metadata: undefined,
      joinedAt: 5000,
      camera: false,
    };
    assert.deepEqual(
      assignSides([
        viewer,
        agent,
        speaker("nobody", undefined),
        speaker("broken", undefined, { metadata: "{not json" }),
        speaker("other", undefined, {
          metadata: JSON.stringify({ side: "C" }),
        }),
        speaker("b", "B"),
      ]),
      { A: null, B: "speaker-b" },
    );
    assert.deepEqual(assignSides([]), { A: null, B: null });
  });

  it("keeps a reconnecting speaker on their own side", () => {
    // A speaker drops and returns with a fresh token while LiveKit still
    // lists the old participant: the one with a camera wins, then the newest.
    const stale = speaker("old", "A", { joinedAt: 1000, camera: false });
    const fresh = speaker("new", "A", { joinedAt: 9000, camera: true });
    const b = speaker("b", "B");
    assert.deepEqual(assignSides([stale, b, fresh]), {
      A: "speaker-new",
      B: "speaker-b",
    });
    assert.deepEqual(assignSides([fresh, stale, b]), {
      A: "speaker-new",
      B: "speaker-b",
    });
    // Before the new camera arrives, the newer join wins.
    const arriving = { ...fresh, camera: false };
    assert.equal(assignSides([stale, arriving]).A, "speaker-new");
    // With nothing else to go on, the identity order decides, either way round.
    const twin = speaker("z", "A", { joinedAt: 9000 });
    assert.equal(assignSides([twin, fresh]).A, "speaker-new");
    assert.equal(assignSides([fresh, twin]).A, "speaker-new");
    // A side whose speaker left is black; the other side does not move.
    assert.deepEqual(assignSides([b]), { A: null, B: "speaker-b" });
  });
});

describe("recording page start and parameters", () => {
  it("starts like LiveKit's page", () => {
    const probe = (values) =>
      shouldStartRecording({
        elapsedMs: 0,
        hasVideoTracks: false,
        hasSubscribedTracks: false,
        hasDecodedFrames: false,
        ...values,
      });
    assert.equal(probe({ hasDecodedFrames: true }), true);
    assert.equal(probe({ hasSubscribedTracks: true, elapsedMs: 400 }), false);
    assert.equal(probe({ hasSubscribedTracks: true, elapsedMs: 600 }), true);
    assert.equal(
      probe({
        hasVideoTracks: true,
        hasSubscribedTracks: true,
        elapsedMs: FRAME_DECODE_TIMEOUT_MS,
      }),
      false,
    );
    assert.equal(
      probe({
        hasVideoTracks: true,
        hasSubscribedTracks: true,
        elapsedMs: FRAME_DECODE_TIMEOUT_MS + 1,
      }),
      true,
    );
    assert.equal(probe({ hasVideoTracks: true, elapsedMs: 60_000 }), false);
  });

  it("reads decoded frames from WebRTC stats", () => {
    assert.equal(
      hasDecodedFrame({ type: "inbound-rtp", framesDecoded: 3 }),
      true,
    );
    for (const stat of [
      { type: "inbound-rtp", framesDecoded: 0 },
      { type: "inbound-rtp" },
      { type: "outbound-rtp", framesDecoded: 3 },
      { type: "inbound-rtp", framesDecoded: "3" },
      null,
      "inbound-rtp",
    ])
      assert.equal(hasDecodedFrame(stat), false);
  });

  it("reads egress's query string and reports what is missing", () => {
    assert.deepEqual(
      templateParams(
        "?url=wss%3A%2F%2Fa.livekit.cloud&token=t&layout=sides-v1",
      ),
      { url: "wss://a.livekit.cloud", token: "t", layout: "sides-v1" },
    );
    assert.deepEqual(templateParams("?url=wss://a&token=t"), {
      url: "wss://a",
      token: "t",
      layout: "",
    });
    for (const search of ["", "?url=wss://a", "?token=t", "?url=&token=t"])
      assert.deepEqual(templateParams(search), {
        error: "missing required params url and token",
      });
  });
});

describe("recording page route", () => {
  const logger = createLogger({ enabled: false });
  const messages = { list: mock.fn(async () => []) };
  const sessions = {
    findUserByTokenHash: async () => null,
    deleteByTokenHash: async () => false,
  };
  const provider = (sources) => ({
    publicUrl: "wss://trial.livekit.cloud",
    playbackOrigin: "https://storage.example",
    ...(sources && { recordingConnectSources: sources }),
  });

  it("allows the LiveKit hosts egress may hand the page", () => {
    assert.deepEqual(
      livekitConnectSources([
        "https://trial.livekit.cloud",
        "wss://trial.livekit.cloud",
      ]),
      [
        "wss://trial.livekit.cloud",
        "https://trial.livekit.cloud",
        "wss://*.livekit.cloud",
        "https://*.livekit.cloud",
      ],
    );
    assert.deepEqual(
      livekitConnectSources(["http://livekit:7880", "ws://localhost:7880"]),
      [
        "ws://livekit:7880",
        "http://livekit:7880",
        "ws://localhost:7880",
        "http://localhost:7880",
      ],
    );
  });

  it("serves the page publicly, uncached, unindexed and under its own policy", async () => {
    const sources = livekitConnectSources(["wss://trial.livekit.cloud"]);
    for (const environment of ["development", "production"]) {
      const app = createApp({
        messages,
        sessions,
        logger,
        environment,
        productionService: environment === "production",
        applicationOrigin: "https://arena.example",
        mediaProvider: provider(sources),
      });
      const response = await request(app).get("/recording-template/");
      assert.equal(response.status, 200);
      assert.match(response.headers["content-type"], /^text\/html/);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-robots-tag"], "noindex, nofollow");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.equal(
        response.headers["content-security-policy"],
        recordingTemplatePolicy(sources),
      );
      // Egress adds its query string; the page is the same.
      const withQuery = await request(app).get(
        "/recording-template/?url=wss%3A%2F%2Ftrial.livekit.cloud&token=t&layout=sides-v1",
      );
      assert.equal(withQuery.text, response.text);
    }
    const policy = recordingTemplatePolicy(sources);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'(;|$)/);
    assert.match(policy, /style-src 'self'(;|$)/);
    assert.match(
      policy,
      /connect-src 'self' wss:\/\/trial\.livekit\.cloud https:\/\/trial\.livekit\.cloud wss:\/\/\*\.livekit\.cloud https:\/\/\*\.livekit\.cloud(;|$)/,
    );
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /unsafe/);
  });

  it("draws side A before side B with muted videos and the recording script", () => {
    const page = renderRecordingTemplate();
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(page, /data-recording="sides-v1"/);
    const a = page.indexOf('data-recording-side="A"');
    const b = page.indexOf('data-recording-side="B"');
    assert.ok(a > 0 && b > a);
    assert.equal(
      page.match(/<video muted autoplay playsinline hidden><\/video>/g).length,
      2,
    );
    assert.match(page, /<div data-recording-audio hidden><\/div>/);
    assert.match(
      page,
      /<link rel="stylesheet" href="\/assets\/recording-template\.css\?v=[0-9a-f]{12}">/,
    );
    assert.match(
      page,
      /<script defer src="\/assets\/recording\.bundle\.js\?v=[0-9a-f]{12}"><\/script>/,
    );
    // No inline script or style, which the policy would block: every script
    // element is the one external bundle, and there is no style element or
    // style attribute.
    const scripts = page.split("<script").length - 1;
    assert.equal(scripts, 1);
    assert.equal(page.split('<script defer src="/assets/').length - 1, 1);
    assert.equal(page.includes("<style"), false);
    assert.equal(page.includes("style="), false);
  });

  it("exists only with media, and tolerates a provider without sources", async () => {
    const without = createApp({ messages, sessions, logger });
    assert.equal(
      (await request(without).get("/recording-template/")).status,
      404,
    );
    const older = createApp({
      messages,
      sessions,
      logger,
      mediaProvider: provider(),
    });
    const response = await request(older).get("/recording-template/");
    assert.equal(response.status, 200);
    assert.match(
      response.headers["content-security-policy"],
      /connect-src 'self';/,
    );
  });

  it("builds the recording bundle with egress's start and end signals", async () => {
    const bundle = await readFile(
      new URL("../public/recording.bundle.js", import.meta.url),
      "utf8",
    );
    assert.match(bundle, /START_RECORDING/);
    assert.match(bundle, /END_RECORDING/);
    const style = await readFile(
      new URL("../public/recording-template.css", import.meta.url),
      "utf8",
    );
    assert.match(style, /grid-template-columns: 1fr 1fr;/);
    assert.match(style, /object-fit: cover;/);
  });
});
