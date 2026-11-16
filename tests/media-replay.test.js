import assert from "node:assert/strict";
import { it } from "node:test";
import { createReplayPlayer } from "../public/media-replay.js";

function fixture({ native = true, supported = true, preview = false } = {}) {
  const handlers = new Map();
  const jobs = new Map();
  const records = [];
  let timerId = 0;
  let network = true;
  let requests = 0;
  let requestError;
  let grantProvider;
  let playError;
  let sound;
  const instances = [];
  const video = {
    currentTime: 27,
    playbackRate: 1.5,
    paused: true,
    textTracks: [{ mode: "showing" }],
    hidden: true,
    muted: false,
    dataset: {},
    addEventListener(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    removeEventListener(event, fn) {
      handlers.get(event)?.delete(fn);
    },
    emit(event) {
      for (const fn of handlers.get(event) || []) fn();
    },
    canPlayType() {
      return native ? "probably" : "";
    },
    querySelector() {
      return { src: "", dataset: { originalSrc: "/captions.vtt" } };
    },
    load() {
      this.loadCount = (this.loadCount || 0) + 1;
      this.currentTime = 0;
      this.paused = true;
    },
    removeAttribute() {},
    pause() {
      this.paused = true;
    },
    async play() {
      if (playError) throw playError;
      this.paused = false;
      this.emit("playing");
    },
  };
  class FakeHls {
    static Events = {
      MANIFEST_PARSED: "manifest",
      FRAG_BUFFERED: "fragment",
      ERROR: "error",
    };
    static isSupported() {
      return supported;
    }
    constructor(config) {
      this.config = config;
      this.events = new Map();
      instances.push(this);
    }
    on(event, fn) {
      this.events.set(event, fn);
    }
    emit(event, data) {
      this.events.get(event)?.(event, data);
    }
    attachMedia(node) {
      assert.equal(node, video);
    }
    loadSource(url) {
      this.url = url;
    }
    startLoad(position) {
      this.position = position;
      this.stopped = false;
    }
    stopLoad() {
      this.stopped = true;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const player = createReplayPlayer({
    preview,
    video,
    Hls: FakeHls,
    request: async () => {
      requests++;
      if (requestError) throw requestError;
      if (grantProvider) return grantProvider(requests);
      return {
        type: "hls",
        url: "https://media.example/master.m3u8",
        captionsUrl: "https://media.example/captions.vtt",
        expiresIn: 300,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    },
    diagnostics: {
      start: (mode, prepared) =>
        records.push({ event: "attempt", mode, prepared }),
      record: (event, data) => records.push({ event, ...data }),
      finish: (outcome) => records.push({ event: "outcome", outcome }),
    },
    say: (message) => records.push({ message }),
    soundRequired: (value) => {
      sound = value;
    },
    online: () => network,
    schedule: (fn, ms) => {
      jobs.set(++timerId, { fn, ms });
      return timerId;
    },
    cancel: (id) => jobs.delete(id),
  });
  return {
    player,
    video,
    instances,
    jobs,
    records,
    handlers,
    get requests() {
      return requests;
    },
    get sound() {
      return sound;
    },
    setError: (error) => {
      requestError = error;
    },
    setGrantProvider: (provider) => {
      grantProvider = provider;
    },
    setPlayError: (error) => {
      playError = error;
    },
    offline: () => {
      network = false;
    },
    online: () => {
      network = true;
    },
    async run(ms) {
      const found = [...jobs].find(
        ([, job]) => ms === undefined || job.ms === ms,
      );
      assert.ok(found, "expected timer");
      jobs.delete(found[0]);
      await found[1].fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
it("keeps an autoplay preview on the smallest HLS rendition and bounded buffer after preparation", async () => {
  const f = fixture({ native: false, preview: true });
  await f.player.prepare();
  await f.player.start();
  const hls = f.instances.at(-1);
  assert.equal(hls.config.autoLevelCapping, 0);
  assert.equal(hls.config.maxBufferLength, 2);
  assert.equal(hls.config.maxMaxBufferLength, 4);
  assert.equal(hls.config.maxBufferSize, 2_000_000);
  f.player.destroy();
  assert.equal(hls.destroyed, true);
});
it("prepares one native replay and preserves position, speed, captions and paused state on renewal", async () => {
  const f = fixture();
  await f.player.prepare();
  await f.player.prepare();
  assert.equal(f.requests, 1);
  assert.equal(f.video.paused, true);
  f.video.emit("loadedmetadata");
  assert.equal(f.video.currentTime, 27);
  assert.equal(f.video.playbackRate, 1.5);
  assert.equal(f.video.textTracks[0].mode, "showing");
  await f.player.start();
  assert.equal(f.records.find((r) => r.event === "attempt").prepared, true);
  assert.equal(f.video.paused, false);
  f.video.currentTime = 68;
  f.video.playbackRate = 2;
  f.video.textTracks[0].mode = "disabled";
  f.video.pause();
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  f.video.emit("loadedmetadata");
  assert.equal(f.video.currentTime, 68);
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.video.paused, true);
  assert.equal(f.video.textTracks[0].mode, "disabled");
  f.player.destroy();
  assert.equal(f.jobs.size, 0);
  for (const handlers of f.handlers.values()) assert.equal(handlers.size, 0);
});
it("marks the video with the recording's camera layout from each grant", async () => {
  const f = fixture();
  f.setGrantProvider((count) => ({
    type: "mp4",
    url: `https://media.example/${count}.mp4`,
    expiresIn: 300,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    ...(count === 1 ? {} : { layout: "sides-v1" }),
  }));
  await f.player.prepare();
  // Older servers send no layout; every recording before it is LiveKit's grid.
  assert.equal(f.video.dataset.replayLayout, "livekit-grid");
  await f.player.start();
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests, 2);
  assert.equal(f.video.dataset.replayLayout, "sides-v1");
  f.player.destroy();
});
it("starts cold HLS at the low rendition then enables adaptation with bounded preload", async () => {
  const f = fixture({ native: false });
  await f.player.prepare();
  const hls = f.instances[0];
  assert.equal(hls.config.startLevel, 0);
  assert.equal(hls.config.maxBufferSize, 2000000);
  hls.emit("manifest");
  hls.emit("fragment");
  assert.equal(hls.stopped, true);
  await f.player.start();
  assert.equal(hls.config.maxBufferLength, 15);
  assert.equal(hls.stopped, false);
  f.video.emit("loadedmetadata");
  f.video.emit("waiting");
  await f.run(270000);
  assert.equal(hls.destroyed, true);
  const renewed = f.instances[1];
  f.video.emit("loadedmetadata");
  assert.equal(f.video.paused, false);
  hls.emit("manifest");
  hls.emit("fragment");
  hls.emit("error", { fatal: true });
  assert.equal(f.jobs.size, 2);
  renewed.emit("error", { fatal: false });
  f.player.destroy();
  const cold = fixture({ native: false });
  await cold.player.start();
  assert.equal(cold.records.find((r) => r.event === "attempt").prepared, false);
  cold.player.destroy();
});
it("exposes sound activation separately and stops access on authorization revocation", async () => {
  const f = fixture();
  f.setPlayError({ name: "NotAllowedError" });
  await f.player.start();
  assert.equal(f.sound, true);
  assert.ok(f.records.some((r) => r.event === "sound_activation_required"));
  f.setPlayError(undefined);
  await f.player.activateSound();
  assert.equal(f.sound, false);
  assert.equal(f.video.muted, false);
  f.setError({ status: 404 });
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.records.some((r) => r.outcome === "authorization_denied"));
  assert.equal(f.jobs.size, 0);
  assert.equal(f.video.paused, true);
  f.player.destroy();
});
it("suspends offline recovery, bounds failed retries, and rejects unsupported HLS", async () => {
  const f = fixture();
  await f.player.start();
  f.offline();
  f.player.offline();
  f.video.emit("error");
  assert.equal(f.jobs.size, 0);
  f.video.emit("waiting");
  assert.equal(f.jobs.size, 0);
  f.online();
  f.setError(new Error("temporary"));
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await f.run();
  assert.ok(f.records.some((r) => r.outcome === "technical_failure"));
  f.player.destroy();
  const unsupported = fixture({ native: false, supported: false });
  await assert.rejects(unsupported.player.start(), /not supported/);
  assert.ok(unsupported.records.some((r) => r.event === "replay_recovery"));
  unsupported.player.destroy();
});
it("discards an outstanding access response after leave and coalesces renewal", async () => {
  const f = fixture();
  await f.player.start();
  f.video.emit("loadedmetadata");
  for (let i = 0; i < 10; i++) {
    f.video.currentTime += 1;
    await f.run(1000);
  }
  assert.ok(f.records.some((r) => r.event === "recovery_stable"));
  f.player.online();
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests, 2);
  f.player.stop();
  f.player.offline();
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests, 2);
  f.player.destroy();
});
it("retains the pending position and play intent across renewals before metadata", async () => {
  for (const paused of [false, true]) {
    const f = fixture();
    await f.player.start();
    f.video.emit("loadedmetadata");
    f.video.currentTime = 68;
    f.video.playbackRate = 2;
    f.video.textTracks[0].mode = "showing";
    f.video.paused = paused;
    f.player.online();
    await new Promise((resolve) => setImmediate(resolve));
    f.player.online();
    await new Promise((resolve) => setImmediate(resolve));
    f.video.emit("loadedmetadata");
    assert.equal(f.video.currentTime, 68);
    assert.equal(f.video.playbackRate, 2);
    assert.equal(f.video.paused, paused);
    assert.equal(f.video.textTracks[0].mode, "showing");
    f.player.destroy();
  }
});
it("cannot declare replay recovery stable after pause, offline or error", async () => {
  for (const interruption of [
    "pause",
    "offline",
    "error",
    "ended",
    "background",
  ]) {
    const f = fixture();
    await f.player.start();
    f.video.emit("loadedmetadata");
    if (interruption === "offline") {
      f.offline();
      f.player.offline();
    } else if (interruption === "background") f.player.background();
    else f.video.emit(interruption);
    assert.equal(
      [...f.jobs.values()].some((job) => job.ms === 1000),
      false,
      interruption + " cancels stability evidence",
    );
    f.player.destroy();
  }
});
it("requires continuing playback progress rather than a transport or playing signal", async () => {
  const f = fixture();
  await f.player.start();
  f.video.emit("loadedmetadata");
  await f.run(1000); // no decoded media time progress
  assert.equal(
    f.records.some((r) => r.event === "recovery_stable"),
    false,
  );
  f.player.destroy();
});
it("preserves replay state while a cached page is suspended and resumed", async () => {
  const f = fixture();
  await f.player.start();
  f.video.emit("loadedmetadata");
  f.video.currentTime = 68;
  f.player.suspend();
  assert.equal(f.video.paused, true);
  assert.equal(f.jobs.size, 0);
  f.player.resume();
  await new Promise((resolve) => setImmediate(resolve));
  f.video.emit("loadedmetadata");
  assert.equal(f.video.currentTime, 68);
  assert.equal(f.video.paused, false);
  f.player.destroy();
});
it("cancels access pending at suspension without consuming a fresh resume grant", async () => {
  const f = fixture();
  const complete = [];
  f.setGrantProvider(() => new Promise((resolve) => complete.push(resolve)));
  const start = f.player.start();
  await new Promise((resolve) => setImmediate(resolve));
  f.player.suspend();
  f.player.resume();
  await new Promise((resolve) => setImmediate(resolve));
  const grant = {
    type: "hls",
    url: "https://media.example/master.m3u8",
    expiresIn: 300,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  complete[0](grant);
  await start;
  assert.equal(f.video.loadCount || 0, 0);
  assert.equal(f.jobs.size, 0);
  f.player.online();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests, 2, "old finally cannot clear the newer grant");
  complete[1](grant);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.video.loadCount, 1);
  f.video.emit("loadedmetadata");
  assert.equal(f.video.paused, false);
  f.player.destroy();
});
it("ignores old HLS manifest and failure callbacks while a cached page is suspended", async () => {
  const f = fixture({ native: false });
  await f.player.prepare();
  await f.player.start();
  const hls = f.instances[0];
  f.player.suspend();
  hls.emit("manifest");
  hls.emit("error", { fatal: true });
  assert.equal(hls.stopped, true);
  assert.equal(f.jobs.size, 0);
  f.player.destroy();
});
