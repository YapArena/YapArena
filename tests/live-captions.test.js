import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCaption,
  captionLanguage,
  captionText,
  createCaptions,
  emptyCaptions,
  TRANSCRIPTION_TOPIC,
} from "../public/live-captions.js";
import { startLiveOutline } from "../public/live-outline.js";

// Decision 0012: live captions under the video, fed by the transcriber
// agent's LiveKit transcription text streams.

const segment = (id, text, final = false, language = "fr") => ({
  id,
  text,
  final,
  language,
});

describe("caption state", () => {
  it("replaces a segment's interim text and keeps the last finals", () => {
    let state = emptyCaptions;
    state = applyCaption(state, segment("a", "Le"));
    state = applyCaption(state, segment("a", "Le nucléaire  est"));
    assert.equal(captionText(state), "Le nucléaire est");
    state = applyCaption(state, segment("a", "Le nucléaire est sûr.", true));
    state = applyCaption(state, segment("b", "Mais"));
    assert.equal(captionText(state), "Le nucléaire est sûr. Mais");
    for (const id of ["c", "d", "e"])
      state = applyCaption(state, segment(id, id.toUpperCase(), true));
    assert.deepEqual(
      state.finals.map((item) => item.id),
      ["c", "d", "e"],
    );
    assert.equal(state.interim.id, "b", "another segment's interim stays");
    state = applyCaption(state, segment("b", "  "));
    assert.equal(state.interim, null, "an empty update clears its segment");
    assert.equal(captionLanguage(state), "fr");
    assert.equal(captionLanguage(emptyCaptions), undefined);
  });

  it("shows the latest words, cut at a word boundary", () => {
    const state = applyCaption(
      emptyCaptions,
      segment("a", "un deux trois quatre cinq six", true),
    );
    assert.equal(
      captionText(state, 14),
      "…cinq six",
      "a partial word is dropped",
    );
    assert.equal(
      captionText(state, 15),
      "…quatre cinq six",
      "a whole word is kept",
    );
    assert.equal(
      captionText(applyCaption(emptyCaptions, segment("a", "x".repeat(20))), 5),
      "…xxxxx",
    );
  });
});

function page({ hidden = false, stored = null } = {}) {
  const listeners = new Map();
  const make = () => {
    const handlers = new Map();
    return {
      hidden: true,
      textContent: "",
      dataset: {},
      lang: "",
      attributes: new Map(),
      handlers,
      addEventListener(type, fn) {
        handlers.set(type, fn);
      },
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        if (name === "lang") this.lang = "";
        this.attributes.delete(name);
      },
    };
  };
  const container = make(),
    line = make(),
    toggle = make();
  container.querySelector = (selector) =>
    selector === "[data-live-captions-text]"
      ? line
      : selector === "[data-live-captions-toggle]"
        ? toggle
        : null;
  const frames = [];
  const storage = new Map(
    stored === null ? [] : [["yap:live-captions", stored]],
  );
  const document = {
    hidden,
    querySelector: (selector) =>
      selector === "[data-live-captions]" ? container : null,
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  return {
    document,
    container,
    line,
    toggle,
    frames,
    storage,
    listeners,
    options: {
      document,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      frame: (callback) => frames.push(callback),
    },
    flush() {
      for (const callback of frames.splice(0)) callback();
    },
  };
}
function room() {
  const handlers = new Map();
  return {
    handlers,
    registerTextStreamHandler(topic, handler) {
      if (handlers.has(topic)) throw new Error("handler already registered");
      handlers.set(topic, handler);
    },
  };
}
function stream(chunks, attributes, fail = false) {
  return {
    info: { id: "TS_1", attributes },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      if (fail) throw new Error("stream interrupted");
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("captions line", () => {
  it("does nothing on pages without a captions line", () => {
    const empty = {
      hidden: false,
      querySelector: () => null,
      addEventListener() {},
    };
    assert.equal(createCaptions({ document: empty }), undefined);
    const attach = startLiveOutline("33333333-3333-4333-8333-333333333333");
    assert.equal(typeof attach, "function");
  });

  it("paints once per frame from the agent's transcription streams", async () => {
    const p = page();
    const captions = createCaptions(p.options);
    const r = room();
    captions.attach(r);
    captions.attach(r);
    assert.equal(p.container.hidden, false);
    assert.equal(r.handlers.size, 1);
    const handler = r.handlers.get(TRANSCRIPTION_TOPIC);
    handler(
      stream(["Le nucléaire ", "est sûr."], {
        "lk.segment_id": "SG_1_0_0",
        "lk.transcription_final": "false",
        "yap.language": "fr",
      }),
    );
    await settle();
    assert.equal(p.frames.length, 1, "updates batch into one frame");
    p.flush();
    assert.equal(p.line.textContent, "Le nucléaire est sûr.");
    assert.equal(p.line.lang, "fr");
    handler(
      stream(["Le nucléaire est sûr et pilotable."], {
        "lk.segment_id": "SG_1_0_0",
        "lk.transcription_final": "true",
        "yap.language": "fr",
      }),
    );
    handler(stream(["Partial"], {}, true));
    await settle();
    p.flush();
    assert.equal(
      p.line.textContent,
      "Le nucléaire est sûr et pilotable. Partial",
    );
    captions.clear();
    p.flush();
    assert.equal(p.line.textContent, "");
    assert.equal(p.line.lang, "");
  });

  it("skips painting while hidden and paints the latest text on return", async () => {
    const p = page({ hidden: true });
    const captions = createCaptions(p.options);
    captions.update(segment("a", "Hidden text"));
    assert.equal(p.frames.length, 0);
    p.document.hidden = false;
    p.listeners.get("visibilitychange")();
    p.flush();
    assert.equal(p.line.textContent, "Hidden text");
    assert.equal(captions.state.interim.text, "Hidden text");
  });

  it("remembers the viewer's choice and survives unavailable storage", () => {
    const p = page({ stored: "off" });
    createCaptions(p.options);
    assert.equal(p.toggle.attributes.get("aria-pressed"), "false");
    assert.equal(p.toggle.textContent, "Captions off");
    assert.ok("captionsOff" in p.container.dataset);
    p.toggle.handlers.get("click")();
    assert.equal(p.toggle.attributes.get("aria-pressed"), "true");
    assert.equal(p.storage.get("yap:live-captions"), "on");
    assert.equal("captionsOff" in p.container.dataset, false);
    const broken = page();
    createCaptions({
      ...broken.options,
      storage: {
        getItem() {
          throw new Error("blocked");
        },
        setItem() {
          throw new Error("blocked");
        },
      },
    });
    assert.equal(broken.toggle.textContent, "Captions on");
    broken.toggle.handlers.get("click")();
    assert.equal(broken.toggle.textContent, "Captions off");
  });
});
