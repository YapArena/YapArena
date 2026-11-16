// Decision 0016: a vertical phone replay drawn into one canvas per side
// (frontend/replay-split.ts), and the replay's pause key, D9
// (frontend/replay-pause.ts). The video stays the source of sound and time.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const { mountReplaySplit } = await import("../public/replay-split.js");
const { PAUSE_LABEL, PLAY_LABEL, mountPauseKey, pauseKeyView } =
  await import("../public/replay-pause.js");

function emitter(target = {}) {
  const handlers = new Map();
  return Object.assign(target, {
    handlers,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    emit(type, event = {}) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
    },
    listening() {
      return [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
    },
  });
}

function fakeVideo({ frames = true } = {}) {
  const requested = new Map();
  let next = 0;
  const video = emitter({
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    paused: true,
    ended: false,
    controls: true,
    dataset: {},
    requested,
    cancelled: [],
    pauseCalls: 0,
    pause() {
      this.pauseCalls++;
      this.paused = true;
      this.emit("pause");
    },
    play() {
      this.paused = false;
      this.emit("play");
      return Promise.resolve();
    },
  });
  if (frames) {
    video.requestVideoFrameCallback = (fn) => {
      requested.set(++next, fn);
      return next;
    };
    video.cancelVideoFrameCallback = (handle) => {
      video.cancelled.push(handle);
      requested.delete(handle);
    };
  }
  video.frame = () => {
    const callbacks = [...requested.values()];
    requested.clear();
    for (const fn of callbacks) fn(0, {});
  };
  return video;
}

function fakeCanvas(width = 390, height = 346) {
  const draws = [];
  return {
    clientWidth: width,
    clientHeight: height,
    width: 300,
    height: 150,
    draws,
    options: undefined,
    getContext(kind, options) {
      this.options = options;
      return kind === "2d"
        ? { drawImage: (...args) => draws.push(args) }
        : null;
    },
  };
}

let animation;
let observers;
let windowEvents;
beforeEach(() => {
  animation = { next: 0, requested: new Map(), cancelled: [] };
  observers = [];
  windowEvents = emitter({ devicePixelRatio: 3 });
  globalThis.window = windowEvents;
  globalThis.requestAnimationFrame = (fn) => {
    animation.requested.set(++animation.next, fn);
    return animation.next;
  };
  globalThis.cancelAnimationFrame = (handle) => {
    animation.cancelled.push(handle);
    animation.requested.delete(handle);
  };
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
});
afterEach(() => {
  delete globalThis.window;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  delete globalThis.ResizeObserver;
});

function mount(video = fakeVideo()) {
  const canvasA = fakeCanvas();
  const canvasB = fakeCanvas();
  const stop = mountReplaySplit({ video, canvasA, canvasB });
  return { video, canvasA, canvasB, stop };
}

describe("replay split", () => {
  it("sizes each canvas for the screen, capped at twice, and draws its side", () => {
    const { video, canvasA, canvasB } = mount();
    for (const canvas of [canvasA, canvasB]) {
      assert.equal(canvas.width, 780);
      assert.equal(canvas.height, 692);
      assert.deepEqual(canvas.options, { alpha: false });
      assert.equal(canvas.draws.length, 1, "a paused replay shows its frame");
      assert.equal(canvas.draws[0][0], video);
      assert.deepEqual(canvas.draws[0].slice(5), [0, 0, 780, 692]);
    }
    assert.equal(canvasA.draws[0][1], 12, "side A is the left tile");
    assert.equal(canvasB.draws[0][1], 648, "side B is the right tile");
    assert.equal(video.dataset.replaySplit, "");
  });

  it("draws on every video frame while playing, and stops when paused", () => {
    const { video, canvasA } = mount();
    video.paused = false;
    video.emit("play");
    video.emit("playing");
    assert.equal(video.requested.size, 1, "one frame request at a time");
    video.frame();
    video.frame();
    assert.equal(canvasA.draws.length, 3);
    assert.equal(video.requested.size, 1);
    video.paused = true;
    video.emit("pause");
    assert.equal(video.cancelled.length, 1);
    assert.equal(video.requested.size, 0);
    assert.equal(canvasA.draws.length, 4, "the paused frame is drawn");
    assert.equal(animation.requested.size, 0);
  });

  it("stops asking for frames at the end", () => {
    const { video, canvasA } = mount();
    video.paused = false;
    video.emit("play");
    video.ended = true;
    video.frame();
    assert.equal(video.requested.size, 0);
    video.emit("ended");
    assert.equal(canvasA.draws.length, 3);
  });

  it("falls back to animation frames without requestVideoFrameCallback", () => {
    const { video, canvasB } = mount(fakeVideo({ frames: false }));
    video.paused = false;
    video.emit("play");
    assert.equal(animation.requested.size, 1);
    const [[, tick]] = animation.requested;
    animation.requested.clear();
    tick(16);
    assert.equal(canvasB.draws.length, 2);
    assert.equal(animation.requested.size, 1);
    video.paused = true;
    video.emit("pause");
    assert.deepEqual(animation.cancelled, [2]);
  });

  it("redraws once after a seek, new data or a rendition change", () => {
    const { video, canvasA } = mount();
    for (const type of ["seeked", "loadeddata", "resize"]) video.emit(type);
    assert.equal(canvasA.draws.length, 4);
    video.videoWidth = 854;
    video.videoHeight = 480;
    video.emit("resize");
    assert.ok(Math.abs(canvasA.draws.at(-1)[1] - (12 * 854) / 1280) < 1e-9);
  });

  it("draws nothing before the video has a frame", () => {
    const video = fakeVideo();
    video.readyState = 1;
    const { canvasA } = mount(video);
    video.emit("seeked");
    assert.equal(canvasA.draws.length, 0);
    video.readyState = 2;
    video.videoWidth = 0;
    video.emit("loadeddata");
    assert.equal(canvasA.draws.length, 0);
  });

  it("resizes with its boxes and the pixel ratio", () => {
    const { canvasA, canvasB } = mount();
    const [observer] = observers;
    assert.deepEqual(observer.targets, [canvasA, canvasB]);
    canvasA.clientWidth = 320;
    canvasA.clientHeight = 262;
    observer.callback([]);
    assert.deepEqual([canvasA.width, canvasA.height], [640, 524]);
    assert.equal(canvasA.draws.at(-1)[7], 640);
    windowEvents.devicePixelRatio = 1;
    windowEvents.emit("resize");
    assert.deepEqual([canvasB.width, canvasB.height], [390, 346]);
  });

  it("leaves a canvas alone when its size has not changed", () => {
    const { canvasA } = mount();
    let writes = 0;
    let width = canvasA.width;
    Object.defineProperty(canvasA, "width", {
      get: () => width,
      set: (value) => {
        writes++;
        width = value;
      },
    });
    observers[0].callback([]);
    assert.equal(writes, 0, "setting a canvas size would clear it");
  });

  it("stops cleanly and only once", () => {
    const { video, canvasA, stop } = mount();
    video.paused = false;
    video.emit("play");
    stop();
    stop();
    assert.equal(video.listening(), 0);
    assert.equal(windowEvents.listening(), 0);
    assert.equal(observers[0].disconnected, true);
    assert.deepEqual(video.cancelled, [1]);
    assert.equal("replaySplit" in video.dataset, false);
    const drawn = canvasA.draws.length;
    video.emit("seeked");
    assert.equal(canvasA.draws.length, drawn);
  });

  it("works without ResizeObserver", () => {
    delete globalThis.ResizeObserver;
    const { canvasA, stop } = mount();
    assert.equal(canvasA.width, 780);
    stop();
  });

  it("skips a canvas that has no 2D context", () => {
    const video = fakeVideo();
    const canvasA = fakeCanvas();
    canvasA.getContext = () => null;
    const canvasB = fakeCanvas();
    mountReplaySplit({ video, canvasA, canvasB, pixelRatio: () => 1 });
    assert.equal(canvasB.draws.length, 1);
    assert.equal(canvasB.width, 390);
  });

  it("follows the recording's layout once the replay grant names it", () => {
    const { video, canvasA, canvasB } = mount();
    assert.equal(canvasB.draws.at(-1)[1], 648, "LiveKit's grid until then");
    video.dataset.replayLayout = "sides-v1";
    video.emit("loadeddata");
    assert.equal(canvasA.draws.at(-1)[1], 1);
    assert.equal(canvasB.draws.at(-1)[1], 641, "side B is the right half");
  });

  it("takes a fixed layout", () => {
    const video = fakeVideo();
    const canvasA = fakeCanvas();
    const canvasB = fakeCanvas();
    mountReplaySplit({
      video,
      canvasA,
      canvasB,
      layout: {
        width: 1280,
        height: 720,
        gap: 0,
        inset: 0,
        leftSide: "B",
      },
    });
    assert.equal(canvasA.draws[0][1], 640);
    assert.equal(canvasB.draws[0][1], 0);
  });
});

function fakeButton() {
  return emitter({
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  });
}

function press(button) {
  let stopped = false;
  button.emit("click", { stopPropagation: () => (stopped = true) });
  return stopped;
}

describe("replay pause key", () => {
  it("says what a press does", () => {
    assert.deepEqual(pauseKeyView({ paused: false, ended: false }), {
      state: "playing",
      label: PAUSE_LABEL,
    });
    assert.deepEqual(pauseKeyView({ paused: true, ended: false }), {
      state: "paused",
      label: PLAY_LABEL,
    });
    assert.deepEqual(pauseKeyView({ paused: false, ended: true }), {
      state: "paused",
      label: PLAY_LABEL,
    });
    assert.equal(PAUSE_LABEL, "Pause replay");
    assert.equal(PLAY_LABEL, "Play replay");
  });

  it("replaces the native controls and pauses and plays the video", async () => {
    const video = fakeVideo();
    const button = fakeButton();
    const unmount = mountPauseKey(button, video);
    assert.equal(video.controls, false);
    assert.equal(button.attributes.get("aria-label"), "Play replay");
    assert.equal(button.dataset.replayState, "paused");
    assert.equal(press(button), true, "a press doesn't toggle the controls");
    assert.equal(video.paused, false);
    assert.equal(button.attributes.get("aria-label"), "Pause replay");
    assert.equal(button.dataset.replayState, "playing");
    press(button);
    assert.equal(video.pauseCalls, 1);
    assert.equal(button.attributes.get("aria-label"), "Play replay");
    unmount();
    unmount();
    assert.equal(video.controls, true);
    assert.equal(video.listening(), 0);
    assert.equal(button.listening(), 0);
  });

  it("follows the video when something else plays, pauses or ends it", () => {
    const video = fakeVideo();
    const button = fakeButton();
    mountPauseKey(button, video);
    video.paused = false;
    video.emit("playing");
    assert.equal(button.dataset.replayState, "playing");
    video.ended = true;
    video.emit("ended");
    assert.equal(button.attributes.get("aria-label"), "Play replay");
    video.paused = true;
    video.ended = false;
    video.emit("emptied");
    assert.equal(button.dataset.replayState, "paused");
  });

  it("plays through the given start and stays on Play when it is refused", async () => {
    const video = fakeVideo();
    const button = fakeButton();
    let starts = 0;
    mountPauseKey(button, video, {
      play: () => {
        starts++;
        return Promise.reject(new Error("NotAllowedError"));
      },
    });
    press(button);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(button.attributes.get("aria-label"), "Play replay");
  });

  it("leaves a video without native controls as it was", () => {
    const video = fakeVideo();
    video.controls = false;
    const unmount = mountPauseKey(fakeButton(), video);
    unmount();
    assert.equal(video.controls, false);
  });
});
