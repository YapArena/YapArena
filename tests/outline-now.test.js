import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LISTENING,
  createNowLine,
  nowLine,
  speakerName,
} from "../public/outline-now.js";
import { createLiveOutline } from "../public/live-outline.js";
import { FakeElement, fakeDocument, outlinePanel } from "./helpers/fake-dom.js";

// The phone line under the speakers (first-run build plan PR 8): the
// argument being made now, from the AI outline's state (Decision 0012).

const debateId = "11111111-1111-4111-8111-111111111111";
const sides = {
  A: { name: "Maya Chen", label: "Free for everyone" },
  B: { name: null, label: "Fix service first" },
};
const span = { startMs: 0, endMs: 1000 };
const argument = (id, label, rebuts = null) => ({
  id,
  label,
  span,
  points: [],
  lastPoint: 0,
  rebuts,
});
const view = (current) => ({
  version: 1,
  current,
  turns: [],
  flags: new Set(),
});
const turn = (turnNumber, args, side = "A", language = "en") => ({
  turnNumber,
  side,
  language,
  arguments: args,
});
const live = (turnNumber, activeSide, state = "running") => ({
  eventStatus: "live",
  state,
  activeSide,
  turnNumber,
});

describe("the argument line's rules", () => {
  it("names a speaker by first name, or by their side's label", () => {
    assert.equal(speakerName("A", sides), "Maya");
    assert.equal(speakerName("B", sides), "Fix service first");
    assert.equal(
      speakerName("A", { ...sides, A: { name: "  ", label: "For" } }),
      "For",
    );
  });

  it("shows the current turn's newest argument, as an argument or a counterargument", () => {
    const current = turn(5, [
      argument("t5a1", "Fares fund a third"),
      argument("t5a2", "A congestion charge can replace fares", "t4a1"),
    ]);
    assert.deepEqual(nowLine(view(current), null, sides), {
      kind: "counter",
      kicker: "Counterargument · Maya · turn 5",
      label: "A congestion charge can replace fares",
      lang: "en",
    });
    assert.deepEqual(
      nowLine(
        view(turn(6, [argument("t6a1", "Service first")], "B", "fr")),
        live(6, "B"),
        sides,
      ),
      {
        kind: "argument",
        kicker: "Argument · Fix service first · turn 6",
        label: "Service first",
        lang: "fr",
      },
    );
  });

  it("listens for the next speaker once the media is ahead of the outline", () => {
    const current = turn(5, [argument("t5a1", "Fares fund a third")]);
    const listening = {
      kind: "listening",
      kicker: "Fix service first · turn 6",
      label: LISTENING,
      lang: "",
    };
    assert.deepEqual(nowLine(view(current), live(6, "B"), sides), listening);
    assert.deepEqual(nowLine(view(null), live(6, "B"), sides), listening);
    assert.deepEqual(
      nowLine(view(turn(6, [], "B")), live(6, "B"), sides),
      listening,
    );
    assert.equal(LISTENING, "Listening for the next argument…");
  });

  it("shows nothing without a view, an argument, or once the debate ended", () => {
    const current = turn(5, [argument("t5a1", "Fares fund a third")]);
    assert.equal(nowLine(null, live(5, "A"), sides), null);
    assert.equal(nowLine(view(null), null, sides), null);
    assert.equal(nowLine(view(turn(1, [])), null, sides), null);
    // Before the first turn the media names no turn yet.
    assert.equal(nowLine(view(null), live(null, null, "idle"), sides), null);
    assert.equal(
      nowLine(view(current), { ...live(5, "A"), state: "ended" }, sides),
      null,
    );
    assert.equal(
      nowLine(view(current), { ...live(5, "A"), eventStatus: "ended" }, sides),
      null,
    );
    // A pause keeps the last argument on screen.
    assert.equal(
      nowLine(view(current), live(5, "A", "paused"), sides).kind,
      "argument",
    );
  });
});

function line() {
  const element = new FakeElement("p");
  element.dataset.outlineNow = "";
  element.hidden = true;
  const kicker = new FakeElement("span");
  kicker.dataset.outlineNowKicker = "";
  const label = new FakeElement("span");
  label.dataset.outlineNowLabel = "";
  element.append(kicker, label);
  return { element, kicker, label };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener: (type, listener) => listeners.set(type, listener),
    emit: (type, detail) =>
      listeners.get(type)?.(new CustomEvent(type, { detail })),
    listeners,
  };
}

describe("the argument line on the page", () => {
  it("paints only what changed and follows the media's turn", () => {
    const dom = line();
    const bus = events();
    const now = createNowLine(dom.element, sides, bus, debateId);
    now.show(view(turn(5, [argument("t5a1", "Fares fund a third")])));
    assert.equal(dom.element.hidden, false);
    assert.equal(dom.element.dataset.kind, "argument");
    assert.equal(dom.kicker.textContent, "Argument · Maya · turn 5");
    assert.equal(dom.label.textContent, "Fares fund a third");
    assert.equal(dom.label.lang, "en");
    const writes = dom.label.textWrites;
    now.show(view(turn(5, [argument("t5a1", "Fares fund a third")])));
    assert.equal(dom.label.textWrites, writes, "an unchanged label stays");
    // Another debate's turn is ignored; this one's moves the line on.
    bus.emit("yap:turn", { ...live(6, "B"), debateId: "other" });
    assert.equal(dom.element.dataset.kind, "argument");
    bus.emit("yap:turn", { ...live(6, "B"), debateId });
    assert.equal(dom.element.dataset.kind, "listening");
    assert.equal(dom.label.textContent, LISTENING);
    assert.equal(dom.label.getAttribute("lang"), null);
    bus.emit("yap:turn", null);
    bus.emit("yap:turn", {
      ...live(6, "B"),
      debateId,
      eventStatus: "ended",
    });
    assert.equal(dom.element.hidden, true);
    now.show(null);
    assert.equal(dom.element.hidden, true);
  });
});

describe("the outline module feeds the line", () => {
  const bootstrap = (options) => ({
    debateId,
    sides,
    state: {
      kind: "snapshot",
      debateId,
      version: 1,
      current: {
        ...turn(1, [argument("t1a1", "Un")], "A", "fr"),
      },
      turns: [],
      flags: [],
      finals: 0,
    },
    ...options,
  });
  function page(options) {
    const dom = outlinePanel(bootstrap(options));
    const now = line();
    const bus = events();
    const answers = options.answers ?? [];
    const outline = createLiveOutline(
      dom.root,
      {
        fetchJson: async () => answers.shift(),
        post: async () => 201,
        connectData: async () => {
          throw new Error("offline");
        },
        events: bus,
        random: () => 0,
        setTimer: () => undefined,
        visible: () => true,
      },
      { document: fakeDocument(), frame: () => undefined },
      now.element,
    );
    return { outline, now, bus };
  }

  it("shows the live outline's newest argument straight away", () => {
    const { now } = page({ live: true });
    assert.equal(now.element.hidden, false);
    assert.equal(now.label.textContent, "Un");
    assert.equal(now.label.lang, "fr");
  });

  it("waits on a replay until the player reports a position", async () => {
    const timeline = {
      debateId,
      complete: true,
      timed: true,
      versions: [
        {
          version: 1,
          at: 1000,
          turnNumber: 1,
          side: "A",
          language: "fr",
          edits: [{ op: "add_argument", id: "t1a1", label: "Premier", span }],
        },
      ],
      turns: [],
    };
    const { now, bus } = page({
      live: false,
      replay: true,
      answers: [timeline],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(now.element.hidden, true, "the whole outline isn't 'now'");
    bus.emit("yap:playback", { debateId, positionSeconds: 2, playing: true });
    assert.equal(now.element.hidden, false);
    assert.equal(now.label.textContent, "Premier");
  });

  it("leaves a page without the line alone", () => {
    const dom = outlinePanel(bootstrap({ live: true }));
    const outline = createLiveOutline(
      dom.root,
      {
        fetchJson: async () => ({}),
        post: async () => 201,
        connectData: async () => {
          throw new Error("offline");
        },
        events: events(),
        random: () => 0,
        setTimer: () => undefined,
        visible: () => true,
      },
      { document: fakeDocument(), frame: () => undefined },
    );
    assert.equal(outline.view.current.turnNumber, 1);
  });
});
