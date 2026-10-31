import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { it } from "node:test";
import {
  createMediaRecovery,
  mayRecoverDisconnect,
  isMovingSpeakerAccess,
} from "../public/media-recovery.js";
import {
  createMediaDiagnostics,
  observePlayback,
} from "../public/media-diagnostics.js";
import { createReplayPlayer } from "../public/media-replay.js";
import { createReplayLibraryLoader } from "../public/media-replay-library.js";
import {
  createPlaybackReporter,
  playbackDimensions,
} from "../public/media-telemetry.js";
import { createMediaTracks } from "../public/media-tracks.js";
import {
  speakerButtonState,
  stopMediaSession,
} from "../public/media-session.js";
import { joinSpeaker } from "../public/media-speaker.js";
import { mediaPresentation } from "../public/media-presentation.js";
import {
  createDeadlineFollower,
  createSignalRefresh,
  watchRoom,
} from "../public/community-stream.js";

// The build emits media-entry only inside media.bundle.js, so transform the
// source exactly as the per-file build did and run it without its imports.
const source = transformSync(
  readFileSync(new URL("../frontend/media-entry.ts", import.meta.url), "utf8"),
  { loader: "ts" },
).code.replace(/^import[\s\S]*?;\n/gm, "");
// Viewers poll media status only while the room stream is not live.
const viewerPoll = 6000;
const settle = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function node() {
  const handlers = new Map();
  return {
    handlers,
    dataset: {},
    hidden: true,
    disabled: false,
    textContent: "",
    currentTime: 0,
    paused: true,
    playCalls: 0,
    textTracks: [],
    addEventListener(event, fn) {
      handlers.set(event, fn);
    },
    removeEventListener(event) {
      handlers.delete(event);
    },
    async click() {
      await handlers.get("click")?.({ currentTarget: this });
      await settle();
    },
    setAttribute() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    replaceChildren() {},
    append() {},
    children: [],
    insertBefore() {},
    removeAttribute() {},
    remove() {},
    load() {},
    pause() {
      this.paused = true;
    },
    async play() {
      this.playCalls++;
      this.paused = false;
    },
    canPlayType() {
      return "probably";
    },
  };
}
function fixture() {
  const elements = new Map();
  for (const name of [
    "status",
    "clock",
    "microphone",
    "videos",
    "viewer",
    "speaker",
    "replay",
    "replay-video",
    "operator",
    "sound",
    "leave",
    "mute",
  ])
    elements.set(`[data-media-${name}]`, node());
  const captionButton = node();
  const replayAction = node();
  replayAction.dataset.mediaAction = "replay";
  elements.get("[data-media-operator]").querySelector = () => captionButton;
  elements.get("[data-media-operator]").querySelectorAll = () => [replayAction];
  const root = {
    dataset: {
      mediaEvent: "33333333-3333-4333-8333-333333333333",
      mediaReplayPlayer: "/assets/replay.bundle.js",
    },
    querySelector: (selector) => elements.get(selector),
    // The scoreboard's yap:turn events (frontend/debate-layout.ts).
    turns: [],
    dispatchEvent(event) {
      this.turns.push(event.detail);
      return true;
    },
  };
  const jobs = new Map();
  const intervals = new Map();
  const listeners = new Map();
  // Room signals and stream health arrive as window events from community.js.
  const roomEvents = new EventTarget();
  let index = 0;
  let viewerGrant;
  let stateResponse;
  let eventStatus = "live";
  let speaker = false;
  const requests = [];
  const rooms = [];
  const calls = [];
  const RoomEvent = Object.fromEntries(
    [
      "TrackSubscribed",
      "TrackUnsubscribed",
      "ParticipantDisconnected",
      "Reconnecting",
      "Reconnected",
      "ParticipantPermissionsChanged",
      "AudioPlaybackStatusChanged",
      "Disconnected",
    ].map((name) => [name, name]),
  );
  class Room {
    constructor(options = {}) {
      this.options = options;
      this.handlers = new Map();
      this.remoteParticipants = new Map();
      this.canPlaybackAudio = false;
      this.localParticipant = {
        identity: "speaker-1",
        permissions: { canPublishSources: [1, 2] },
        isMicrophoneEnabled: false,
        async setCameraEnabled() {
          return {
            track: { kind: "video", attach: () => node(), detach() {} },
          };
        },
        async setMicrophoneEnabled(enabled) {
          this.isMicrophoneEnabled = enabled;
          calls.push(["microphone", enabled]);
        },
        async publishTrack(track) {
          calls.push(["publish", track]);
          return { track };
        },
      };
      rooms.push(this);
    }
    on(event, fn) {
      this.handlers.set(event, fn);
    }
    emit(event, ...args) {
      this.handlers.get(event)?.(...args);
    }
    async prepareConnection() {
      calls.push("prepare");
    }
    async startAudio() {
      calls.push("sound");
      this.canPlaybackAudio = true;
    }
    async connect() {
      calls.push("connect");
    }
    async disconnect() {
      calls.push("disconnect");
      this.emit("Disconnected", 1);
    }
    sdkPageLeave() {
      // LiveKit's default beforeunload handler emits CLIENT_INITIATED before
      // application pagehide cleanup. Preserve this order in the regression.
      if (this.options.disconnectOnPageLeave !== false) void this.disconnect();
    }
  }
  const storage = new Map();
  const window = {
    crypto: { randomUUID: () => "synthetic" },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (fn, ms) => {
      jobs.set(++index, { fn, ms });
      return index;
    },
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn) => {
      intervals.set(++index, fn);
      return index;
    },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (event, fn) =>
      event.startsWith("yap:room")
        ? roomEvents.addEventListener(event, fn)
        : listeners.set(event, fn),
    removeEventListener: (event, fn) =>
      roomEvents.removeEventListener(event, fn),
    dispatchEvent: (event) => roomEvents.dispatchEvent(event),
  };
  const navigator = {
    onLine: true,
    userAgent: "synthetic Chrome/1",
    mediaDevices: {
      async getUserMedia() {
        calls.push("capture");
        const mic = {
          enabled: true,
          stop() {},
          getSettings: () => ({ deviceId: "microphone-1" }),
        };
        const camera = {
          stop() {},
          getSettings: () => ({ deviceId: "camera-1" }),
        };
        return {
          getAudioTracks: () => [mic],
          getVideoTracks: () => [camera],
          getTracks: () => [mic, camera],
        };
      },
    },
  };
  const document = {
    hidden: false,
    // Pages without the live outline (Decision 0012) have no captions line.
    querySelector: (selector) =>
      selector === "[data-live-captions],[data-live-outline]" ? null : root,
    addEventListener: (event, fn) => listeners.set(event, fn),
  };
  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    async json() {
      return body;
    },
  });
  const requestDetails = [];
  let speakerGrant;
  const fetch = async (url, options) => {
    requests.push(url);
    requestDetails.push({ url, options });
    if (url.endsWith("/roles")) return response({ roles: [] });
    if (url.endsWith("/speaker-seat"))
      return speaker
        ? response({ side: "A", userId: "1" })
        : response({ error: "not a speaker" }, 404);
    if (url.endsWith("/viewer-token"))
      return viewerGrant
        ? viewerGrant
        : response({ token: "synthetic", url: "wss://synthetic.example" });
    if (url.endsWith("/speaker-token"))
      return (
        speakerGrant ??
        response({
          token: "synthetic",
          url: "wss://synthetic.example",
          side: "A",
        })
      );
    if (url.endsWith("/device-check")) return response({});
    if (url.endsWith("/playback")) return response({}, 204);
    if (url.endsWith("/replay"))
      return response({
        type: "hls",
        url: "https://media.example/master.m3u8",
        expiresIn: 300,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
    if (stateResponse) return stateResponse;
    return response({
      eventStatus,
      preparationUrl: "wss://synthetic.example",
      state: { revision: 1, state: "running", activeSide: "A" },
      serverNow: new Date().toISOString(),
    });
  };
  const context = vm.createContext({
    CustomEvent,
    window,
    document,
    navigator,
    fetch,
    Room,
    RoomEvent,
    Track: { Source: { Microphone: 2 }, sourceToProto: (value) => value },
    createMediaRecovery,
    mayRecoverDisconnect,
    isMovingSpeakerAccess,
    createMediaDiagnostics,
    observePlayback: (element, options) =>
      observePlayback(element, {
        ...options,
        schedule: window.setInterval,
        cancel: window.clearInterval,
      }),
    createReplayPlayer,
    createReplayLibraryLoader,
    createPlaybackReporter,
    playbackDimensions,
    createMediaTracks,
    speakerButtonState,
    stopMediaSession,
    joinSpeaker,
    mediaPresentation,
    createDeadlineFollower,
    createSignalRefresh,
    watchRoom,
    performance,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    Date,
    console,
  });
  return {
    rooms,
    storage,
    roomEvents,
    intervals,
    requests,
    requestDetails,
    calls,
    jobs,
    listeners,
    replayAction,
    navigator,
    document,
    window,
    element: (name) => elements.get(`[data-media-${name}]`),
    // early runs before the page's first requests complete.
    async start(early) {
      vm.runInContext(source, context);
      early?.();
      await settle();
    },
    setGrant: (grant) => {
      viewerGrant = grant;
    },
    setSpeakerGrant: (grant) => {
      speakerGrant = grant;
    },
    setStateResponse: (state) => {
      stateResponse = state;
    },
    response,
    setStatus: (status) => {
      eventStatus = status;
    },
    speaker: () => {
      speaker = true;
    },
    async timer(ms) {
      const [id, job] = [...jobs].find(([, job]) => job.ms === ms) || [];
      assert.ok(job, `timer ${ms}`);
      jobs.delete(id);
      await job.fn();
      await settle();
    },
  };
}

it("keeps an automatically published replay paused until Play replay is pressed", async () => {
  const f = fixture();
  const state = { revision: 1, state: "ended", recordingStatus: "ready" };
  const snapshot = (eventStatus) =>
    f.response({
      eventStatus,
      automaticReplayPublication: true,
      state,
      serverNow: new Date().toISOString(),
    });
  f.setStateResponse(snapshot("ended"));
  await f.start();
  const video = f.element("replay-video");
  assert.match(f.element("status").textContent, /published automatically/);
  assert.equal(f.replayAction.hidden, true);
  assert.equal(f.element("replay").hidden, true);
  assert.equal(
    f.requests.some((url) => url.endsWith("/replay")),
    false,
  );
  assert.equal(video.playCalls, 0);

  f.setStateResponse(snapshot("replay"));
  await f.timer(viewerPoll);
  assert.equal(f.element("replay").hidden, false);
  assert.equal(f.requests.filter((url) => url.endsWith("/replay")).length, 1);
  video.handlers.get("loadedmetadata")();
  await f.timer(viewerPoll);
  assert.equal(video.playCalls, 0);
  assert.equal(video.paused, true);
  assert.equal(video.hidden, true);

  await f.element("replay").click();
  assert.ok(video.playCalls > 0);
  assert.equal(video.paused, false);
  assert.equal(video.hidden, false);
  f.listeners.get("pagehide")();
});

it("prepares without joining or capturing and rejoins viewers only after terminal transport failure", async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(f.calls, ["prepare"]);
  assert.equal(
    f.requests.some((url) => url.endsWith("/viewer-token")),
    false,
  );
  await f.element("viewer").click();
  assert.ok(f.calls.includes("sound"));
  assert.ok(f.calls.includes("connect"));
  const room = f.rooms[0];
  room.emit("Reconnecting");
  await f.timer(viewerPoll);
  assert.match(f.element("status").textContent, /Reconnecting/);
  assert.equal(
    f.requests.filter((url) => url.endsWith("/viewer-token")).length,
    1,
  );
  room.emit("Disconnected", 9);
  const retry = [...f.jobs.values()].find((job) => job.ms < 400);
  assert.ok(retry);
  await f.timer(retry.ms);
  assert.equal(
    f.requests.filter((url) => url.endsWith("/viewer-token")).length,
    2,
  );
  await f.element("leave").click();
  assert.equal(f.element("leave").hidden, true);
  f.listeners.get("pagehide")();
  assert.equal(f.jobs.size, 0);
});

it("suspends viewer polling offline and in background, and resumes one poll chain after return", async () => {
  const f = fixture();
  await f.start();
  assert.equal(
    [...f.jobs.values()].filter((job) => job.ms === viewerPoll).length,
    1,
  );
  f.document.hidden = true;
  f.listeners.get("visibilitychange")();
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms === viewerPoll),
    false,
  );
  f.document.hidden = false;
  f.listeners.get("visibilitychange")();
  f.listeners.get("visibilitychange")();
  await settle();
  assert.equal(
    [...f.jobs.values()].filter((job) => job.ms === viewerPoll).length,
    1,
  );
  f.navigator.onLine = false;
  f.listeners.get("offline")();
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms === viewerPoll),
    false,
  );
  f.navigator.onLine = true;
  f.listeners.get("online")();
  await settle();
  assert.equal(
    [...f.jobs.values()].filter((job) => job.ms === viewerPoll).length,
    1,
  );
  f.listeners.get("pagehide")({ persisted: true });
  f.listeners.get("pageshow")({ persisted: true });
  await settle();
  assert.equal(
    [...f.jobs.values()].filter((job) => job.ms === viewerPoll).length,
    1,
  );
  f.listeners.get("pagehide")();
});

it("does not let older lifecycle HTTP results restore ended media, including large revisions", async () => {
  const f = fixture();
  await f.start();
  f.setStateResponse(
    f.response({
      streamRevision: "9007199254740993",
      eventStatus: "ended",
      state: { revision: 2, state: "ended" },
      serverNow: new Date().toISOString(),
    }),
  );
  await f.timer(viewerPoll);
  assert.equal(f.element("viewer").hidden, true);
  for (const streamRevision of ["9007199254740992", "bad"]) {
    f.setStateResponse(
      f.response({
        streamRevision,
        eventStatus: "live",
        state: { revision: 3, state: "running" },
        serverNow: new Date().toISOString(),
      }),
    );
    await f.timer(viewerPoll);
    assert.equal(f.element("viewer").hidden, true);
  }
  f.listeners.get("pagehide")();
});
it("preserves speaker rejoin and mute intent through SDK navigation while releasing page resources", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  await f.element("speaker").click();
  await f.element("mute").click();
  const key = "media-speaker:33333333-3333-4333-8333-333333333333:1";
  assert.equal(f.storage.get(key), "1");
  for (const room of f.rooms) room.sdkPageLeave();
  f.listeners.get("pagehide")();
  await settle();
  assert.equal(f.storage.get(key), "1");
  assert.equal(f.storage.get(`${key}:muted`), "1");
  assert.ok(f.calls.includes("disconnect"));
  assert.equal(f.jobs.size, 0);
  assert.equal(f.intervals.size, 0);
});
it("requests device takeover only on manual Join and retries committed moving-access conflicts without takeover", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  f.setSpeakerGrant(
    f.response(
      { error: "Moving speaker access.", code: "speaking_access_moving" },
      409,
    ),
  );
  await f.element("speaker").click();
  const attempts = () =>
    f.requestDetails.filter((entry) => entry.url.endsWith("/speaker-token"));
  assert.deepEqual(JSON.parse(attempts()[0].options.body), {
    replaceExisting: true,
  });
  assert.match(f.element("status").textContent, /Moving speaker access/);
  const [timer, job] = [...f.jobs].find(
    ([, entry]) => entry.ms >= 187 && entry.ms <= 313,
  );
  assert.ok(job, "moving-access conflict must keep bounded recovery active");
  f.jobs.delete(timer);
  f.setSpeakerGrant(undefined);
  await job.fn();
  await settle();
  assert.deepEqual(JSON.parse(attempts()[1].options.body), {
    replaceExisting: false,
  });
  assert.equal(
    f.storage.get("media-speaker:33333333-3333-4333-8333-333333333333:1"),
    "1",
  );
  f.listeners.get("pagehide")();
});
it("stops automatic speaker recovery on another-device denial instead of repeatedly taking the slot", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  f.setSpeakerGrant(
    f.response(
      { error: "Moving speaker access.", code: "speaking_access_moving" },
      409,
    ),
  );
  await f.element("speaker").click();
  const [timer, job] = [...f.jobs].find(
    ([, entry]) => entry.ms >= 187 && entry.ms <= 313,
  );
  f.jobs.delete(timer);
  f.setSpeakerGrant(
    f.response({ error: "Speaker access is active on another device." }, 409),
  );
  await job.fn();
  await settle();
  assert.equal(
    [...f.jobs.values()].some((entry) => entry.ms < 400),
    false,
  );
  const count = f.requests.filter((url) =>
    url.endsWith("/speaker-token"),
  ).length;
  assert.match(f.element("status").textContent, /another device/);
  f.listeners.get("online")();
  await settle();
  assert.equal(
    f.requests.filter((url) => url.endsWith("/speaker-token")).length,
    count,
  );
  f.listeners.get("pagehide")();
});
it("cancels joins whose authorization response arrives after leave", async () => {
  const f = fixture();
  await f.start();
  let resolveGrant;
  f.setGrant(
    new Promise((resolve) => {
      resolveGrant = resolve;
    }),
  );
  const joining = f.element("viewer").click();
  await settle();
  await f.element("leave").click();
  resolveGrant(f.response({ token: "late", url: "wss://synthetic.example" }));
  await joining;
  assert.equal(f.calls.includes("connect"), false);
  f.listeners.get("pagehide")();
});
it("revives media after cached history return without reloading drafts or reconnecting ended events", async () => {
  for (const ended of [false, true]) {
    const f = fixture();
    await f.start();
    await f.element("viewer").click();
    f.listeners.get("pagehide")({ persisted: true });
    await settle();
    assert.equal(f.calls.filter((call) => call === "disconnect").length, 1);
    if (ended) f.setStatus("ended");
    f.listeners.get("pageshow")?.({ persisted: true });
    await settle();
    if (!ended) {
      const retry = [...f.jobs.values()].find((job) => job.ms < 400);
      assert.ok(retry, "eligible cached return must reconnect");
      await f.timer(retry.ms);
      assert.equal(f.calls.filter((call) => call === "connect").length, 2);
      assert.ok(f.intervals.size > 0);
    } else {
      assert.equal(f.calls.filter((call) => call === "connect").length, 1);
    }
    f.listeners.get("pagehide")();
    await settle();
    assert.equal(f.jobs.size, 0);
    assert.equal(f.intervals.size, 0);
  }
});
it("refuses cached speaker capture after failed eligibility or a second page hide", async () => {
  for (const status of [401, 403, 404, 503]) {
    const f = fixture();
    f.speaker();
    await f.start();
    await f.element("speaker").click();
    f.listeners.get("pagehide")({ persisted: true });
    await settle();
    f.setStateResponse(f.response({ error: "unavailable" }, status));
    f.listeners.get("pageshow")({ persisted: true });
    await settle();
    assert.equal(f.calls.filter((call) => call === "capture").length, 1);
    assert.equal(
      [...f.jobs.values()].some((job) => job.ms < 400),
      false,
    );
    f.listeners.get("pagehide")();
  }
  const f = fixture();
  await f.start();
  await f.element("viewer").click();
  f.listeners.get("pagehide")({ persisted: true });
  await settle();
  let complete;
  f.setStateResponse(new Promise((resolve) => (complete = resolve)));
  f.listeners.get("pageshow")({ persisted: true });
  await settle();
  f.listeners.get("pagehide")();
  complete(f.response({ eventStatus: "live", state: { revision: 1 } }));
  await settle();
  assert.equal(f.calls.filter((call) => call === "connect").length, 1);
  assert.equal(f.jobs.size, 0);
});
it("does not fight duplicate identity or removal and suspends application retries offline", async () => {
  for (const reason of [2, 4, 5, 10]) {
    const f = fixture();
    await f.start();
    await f.element("viewer").click();
    f.rooms[0].emit("Disconnected", reason);
    assert.equal(
      [...f.jobs.values()].some((job) => job.ms < 400),
      false,
    );
    f.listeners.get("online")();
    await settle();
    assert.equal(
      f.requests.filter((url) => url.endsWith("/viewer-token")).length,
      1,
    );
    f.listeners.get("pagehide")();
  }
  const f = fixture();
  await f.start();
  await f.element("viewer").click();
  f.navigator.onLine = false;
  f.listeners.get("offline")();
  f.rooms[0].emit("Disconnected", 9);
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms < 400),
    false,
  );
  f.navigator.onLine = true;
  f.listeners.get("online")();
  assert.ok([...f.jobs.values()].some((job) => job.ms < 400));
  f.listeners.get("pagehide")();
});
it("stops after debate end and preserves a speaker's deliberate mute and chosen devices", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  await f.element("speaker").click();
  assert.equal(f.element("mute").hidden, false);
  await f.element("mute").click();
  assert.ok(
    f.calls.some(
      (call) =>
        Array.isArray(call) && call[0] === "microphone" && call[1] === false,
    ),
  );
  f.rooms[0].emit(
    "ParticipantPermissionsChanged",
    {},
    f.rooms[0].localParticipant,
  );
  await settle();
  assert.equal(
    f.calls.filter((call) => Array.isArray(call) && call[0] === "publish")
      .length,
    1,
  );
  f.setStatus("ended");
  await f.timer(viewerPoll);
  assert.equal(f.calls.at(-1), "disconnect");
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms < 400),
    false,
  );
  f.listeners.get("pagehide")();
});

const mediaRoom = "33333333-3333-4333-8333-333333333333";
const statusReads = (f) =>
  f.requests.filter((url) => url === `/api/media/events/${mediaRoom}`).length;
const roomStream = (f, live, room = mediaRoom) =>
  f.roomEvents.dispatchEvent(
    new CustomEvent("yap:room-stream", { detail: { room, live } }),
  );
const roomSignal = (f, cursor, topics = ["media"], room = mediaRoom) =>
  f.roomEvents.dispatchEvent(
    new CustomEvent("yap:room-signal", { detail: { room, cursor, topics } }),
  );
const scheduled = (f, ms) => [...f.jobs.values()].some((job) => job.ms === ms);
const liveState = (streamRevision, extra = {}) => ({
  streamRevision,
  eventStatus: "live",
  preparationUrl: "wss://synthetic.example",
  state: { revision: 2, state: "paused", activeSide: null, ...extra },
  serverNow: new Date().toISOString(),
});
it("replaces status polling with room signals while the room stream is live", async () => {
  const f = fixture();
  await f.start();
  assert.ok(scheduled(f, viewerPoll));
  roomStream(f, true);
  assert.equal(scheduled(f, viewerPoll), false);
  // A slow safety read remains while the stream is live.
  assert.ok(scheduled(f, 60000));
  f.setStateResponse(f.response(liveState("5")));
  const before = statusReads(f);
  roomSignal(f, "5");
  await settle();
  assert.equal(statusReads(f), before + 1);
  // Other projections and rooms do not read media status.
  roomSignal(f, "6", ["round", "activity"]);
  roomSignal(f, "6", ["media"], "44444444-4444-4444-8444-444444444444");
  await settle();
  assert.equal(statusReads(f), before + 1);
  // A read still behind the signal retries once the server catches up.
  roomSignal(f, "7");
  await settle();
  assert.equal(statusReads(f), before + 2);
  assert.ok(scheduled(f, 500));
  f.setStateResponse(f.response(liveState("7")));
  await f.timer(500);
  assert.equal(statusReads(f), before + 3);
  assert.equal(scheduled(f, 1000), false);
  // A dropped stream may have missed a signal: read now, then poll again.
  roomStream(f, false);
  await settle();
  assert.equal(statusReads(f), before + 4);
  assert.ok(scheduled(f, viewerPoll));
  f.listeners.get("pagehide")();
  roomSignal(f, "8");
  await settle();
  assert.equal(statusReads(f), before + 4);
});
it("polls a connected speaker at the slower fallback only while the stream is down", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  await f.element("speaker").click();
  await f.timer(viewerPoll);
  assert.ok(scheduled(f, 2000));
  roomStream(f, true);
  assert.equal(scheduled(f, 2000), false);
  roomStream(f, false);
  await settle();
  assert.ok(scheduled(f, 2000));
  f.listeners.get("pagehide")();
});
it("reads media status shortly after the turn deadline instead of polling", async () => {
  const f = fixture();
  const deadline = new Date(Date.now() + 10000).toISOString();
  f.setStateResponse(
    f.response(
      liveState("3", {
        state: "running",
        activeSide: "A",
        turnDeadlineAt: deadline,
      }),
    ),
  );
  await f.start();
  roomStream(f, true);
  const follow = [...f.jobs.values()].filter(
    (job) => job.ms > 11000 && job.ms <= 12000,
  );
  assert.equal(follow.length, 1, "deadline plus grace");
  assert.equal(scheduled(f, viewerPoll), false);
  f.listeners.get("pagehide")();
});
it("holds media signals until the first status read and skips cursors it covers", async () => {
  const f = fixture();
  f.setStateResponse(f.response(liveState("8")));
  await f.start(() => roomSignal(f, "8"));
  // The first read reported cursor 8, so the held signal needs no second read.
  assert.equal(statusReads(f), 1);
  roomSignal(f, "8");
  await settle();
  assert.equal(statusReads(f), 1);
  roomSignal(f, "9");
  await settle();
  assert.equal(statusReads(f), 2);
  f.listeners.get("pagehide")();
});
it("ignores media signals once the status endpoint refuses the page", async () => {
  const f = fixture();
  f.setStateResponse(f.response({ error: "resource not found" }, 404));
  await f.start(() => roomSignal(f, "3"));
  assert.equal(statusReads(f), 1);
  assert.equal(f.element("replay-video").hidden, true);
  roomSignal(f, "4");
  roomStream(f, true);
  roomStream(f, false);
  await settle();
  assert.equal(statusReads(f), 1, "no reads, retries or reconnect reads");
  // Polling continues, and a successful read resumes signal handling.
  assert.ok(scheduled(f, viewerPoll));
  f.setStateResponse(f.response(liveState("5")));
  await f.timer(viewerPoll);
  roomSignal(f, "6");
  await settle();
  assert.equal(statusReads(f), 3);
  f.listeners.get("pagehide")();
});
