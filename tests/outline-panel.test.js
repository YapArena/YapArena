import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANNOUNCE_EVERY_MS,
  createOutlinePanel,
  sideText,
} from "../public/outline-panel.js";
import {
  createLiveOutline,
  DATA_ONLY_DELAY_MS,
  FALLBACK_SPREAD_MS,
  startLiveOutline,
} from "../public/live-outline.js";
import { emptyView } from "../public/outline-state.js";
import { fakeDocument, outlinePanel } from "./helpers/fake-dom.js";

// Decision 0012: the AI outline panel and the page module that feeds it from
// LiveKit, the bootstrap state and, as a fallback, the room signal.

const sides = {
  A: { name: "Alice", label: "For" },
  B: { name: null, label: "Against" },
};
const span = { startMs: 0, endMs: 1000 };
const point = (id, text) => ({ id, text, span });
const argument = (id, label, points = [], rebuts = null) => ({
  id,
  label,
  span,
  points,
  lastPoint: points.length,
  rebuts,
});
const turn = (turnNumber, args, side = "A", language = "fr") => ({
  turnNumber,
  side,
  language,
  arguments: args,
});
const view = (current, { turns = [], flags = [], version = 1 } = {}) => ({
  version,
  current,
  turns,
  flags: new Set(flags),
});

function harness(options = {}) {
  const page = fakeDocument();
  const frames = [];
  const timers = [];
  const flags = [];
  let clock = 0;
  const dom = outlinePanel({});
  const panel = createOutlinePanel({
    root: dom.root,
    sides,
    document: page,
    frame: (callback) => frames.push(callback),
    now: () => clock,
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    onFlag: (turnNumber, id) => flags.push([turnNumber, id]),
    ...options,
  });
  const flush = () => {
    while (frames.length) frames.shift()();
  };
  return {
    ...dom,
    page,
    panel,
    frames,
    timers,
    flags,
    flush,
    tick: (ms) => (clock += ms),
  };
}
const labels = (list) =>
  list.children.map(
    (node) => node.querySelector(".live-outline-label-text").textContent,
  );
const pointsOf = (node) =>
  node
    .querySelector(".live-outline-points")
    .children.map(
      (child) => child.querySelector(".live-outline-point-text").textContent,
    );

describe("outline panel", () => {
  it("names a side by its debater when known", () => {
    assert.equal(sideText("A", sides), "Alice (For)");
    assert.equal(sideText("B", sides), "Against");
  });

  it("paints once per frame, keyed by argument and point", () => {
    const h = harness();
    h.panel.show(emptyView);
    h.panel.show(emptyView);
    assert.equal(h.frames.length, 1, "one frame for several changes");
    h.flush();
    assert.equal(h.turn.textContent, "Appears when a debater speaks");
    assert.equal(h.list.children.length, 0);
    assert.equal(h.earlier.hidden, true);

    const earlierTurn = {
      turnNumber: 1,
      side: "B",
      language: "en",
      arguments: [{ id: "t1a1", label: "Costs too much", rebuts: null }],
      final: true,
    };
    const first = view(
      turn(2, [
        argument(
          "t2a1",
          "Le coût baisse",
          [point("t2a1p1", "Prix divisés")],
          "t1a1",
        ),
        argument("t2a2", "Sûreté", [
          point("t2a2p1", "Aucun accident"),
          point("t2a2p2", "Contrôles"),
        ]),
      ]),
      { turns: [earlierTurn], flags: ["t2a2p2"] },
    );
    h.panel.show(first);
    h.flush();
    assert.equal(h.turn.textContent, "Turn 2 · Alice (For)");
    assert.equal(h.list.lang, "fr");
    assert.deepEqual(labels(h.list), ["Le coût baisse", "Sûreté"]);
    const [costNode, safetyNode] = h.list.children;
    // A card per argument: a counterargument when it rebuts another.
    assert.equal(costNode.dataset.kind, "counter");
    assert.equal(
      costNode.querySelector(".live-outline-kicker").textContent,
      "Counterargument",
    );
    assert.equal(
      safetyNode.querySelector(".live-outline-kicker").textContent,
      "Argument",
    );
    assert.equal(
      safetyNode.querySelector(".live-outline-foot").textContent,
      "2 points",
    );
    const rebuts = costNode.querySelector(".live-outline-rebuts");
    assert.equal(rebuts.hidden, false);
    assert.equal(rebuts.textContent, "RebutsCosts too much");
    assert.equal(
      rebuts.querySelector(".live-outline-jump").dataset.jump,
      "t1a1",
    );
    assert.equal(safetyNode.querySelector(".live-outline-rebuts").hidden, true);
    assert.deepEqual(pointsOf(safetyNode), ["Aucun accident", "Contrôles"]);
    const flagged = safetyNode.querySelector(".live-outline-points")
      .children[1];
    assert.ok(
      flagged.querySelector(".live-outline-flagged"),
      "a flagged point is marked",
    );
    assert.equal(flagged.querySelector(".live-outline-flag"), null);
    assert.equal(
      costNode.classList.contains("is-changed"),
      false,
      "the first paint does not flash",
    );
    // Earlier turns, newest first, in their own language, as cards.
    assert.equal(h.earlier.hidden, false);
    assert.equal(h.turns.children[0].lang, "en");
    assert.equal(
      h.turns.children[0].querySelector(".live-outline-earlier-turn")
        .textContent,
      "Turn 1 · Against",
    );
    const earlierCard = h.turns.children[0].querySelector(
      ".live-outline-argument",
    );
    assert.equal(
      earlierCard.querySelector(".live-outline-label-text").textContent,
      "Costs too much",
    );
    assert.equal(
      earlierCard.querySelector(".live-outline-replies").textContent,
      "Rebutted byLe coût baisse",
      "an earlier argument links to its rebuttal",
    );
    assert.equal(
      earlierCard.querySelector(".live-outline-foot").textContent,
      "1 rebuttal",
    );

    // A reworded label flashes its argument. A reworded point flashes the
    // point, and the card too while it's closed (the point is out of sight).
    safetyNode.querySelector(".live-outline-toggle").click();
    const second = view(
      turn(2, [
        argument(
          "t2a1",
          "Le coût baisse vite",
          [point("t2a1p1", "Prix divisés")],
          "t1a1",
        ),
        argument("t2a2", "Sûreté", [point("t2a2p1", "Aucun accident grave")]),
      ]),
      { turns: first.turns, flags: ["t2a2p2"] },
    );
    const earlierItem = h.turns.children[0];
    h.panel.show(second);
    h.flush();
    assert.equal(
      h.list.children[0],
      costNode,
      "the same node is updated in place",
    );
    assert.equal(costNode.classList.contains("is-changed"), true);
    assert.equal(safetyNode.classList.contains("is-changed"), false);
    const changedPoint = safetyNode.querySelector(".live-outline-points")
      .children[0];
    assert.equal(changedPoint.classList.contains("is-changed"), true);
    assert.deepEqual(
      pointsOf(safetyNode),
      ["Aucun accident grave"],
      "a removed point goes",
    );
    assert.equal(
      h.turns.children[0],
      earlierItem,
      "unchanged earlier turns are not rebuilt",
    );
    costNode.dispatch("animationend", { target: costNode });
    changedPoint.dispatch("animationend");
    assert.equal(costNode.classList.contains("is-changed"), false);
    assert.equal(changedPoint.classList.contains("is-changed"), false);

    // A rebutted argument of the current turn, and an argument that goes away.
    h.panel.show(
      view(
        turn(2, [
          argument("t2a2", "Sûreté"),
          argument("t2a3", "Déchets", [], "t2a2"),
        ]),
        {
          turns: first.turns,
        },
      ),
    );
    h.flush();
    assert.deepEqual(labels(h.list), ["Sûreté", "Déchets"]);
    assert.equal(
      h.list.children[1].querySelector(".live-outline-rebuts").textContent,
      "RebutsSûreté",
    );
    h.panel.show(view(turn(2, [argument("t2a4", "Inconnu", [], "t9a9")])));
    h.flush();
    assert.equal(
      h.list.children[0].querySelector(".live-outline-rebuts").hidden,
      true,
    );

    // A new turn starts with fresh nodes.
    const before = h.list.children[0];
    h.panel.show(view(turn(3, [argument("t2a4", "Inconnu")], "B", "en")));
    h.flush();
    assert.notEqual(h.list.children[0], before);
    assert.equal(h.turn.textContent, "Turn 3 · Against");
  });

  it("shows flag buttons on the speaker's own items and reports a flag", () => {
    const h = harness();
    h.panel.show(
      view(turn(1, [argument("t1a1", "Un", [point("t1a1p1", "x")])])),
    );
    h.flush();
    const buttons = h.root.querySelectorAll(".live-outline-flag");
    assert.equal(buttons.length, 2);
    assert.ok(
      buttons.every((button) => button.hidden),
      "hidden for viewers",
    );
    h.panel.setSpeaker("A");
    assert.ok(buttons.every((button) => !button.hidden));
    buttons.find((button) => button.dataset.flag === "t1a1p1").click();
    assert.deepEqual(h.flags, [[1, "t1a1p1"]]);
    h.panel.setSpeaker("B");
    assert.ok(buttons.every((button) => button.hidden));
    h.panel.setSpeaker("A");
    // A flag recorded on the server replaces the button with a mark.
    h.panel.show(
      view(turn(1, [argument("t1a1", "Un", [point("t1a1p1", "x")])]), {
        flags: ["t1a1"],
      }),
    );
    h.flush();
    const card = h.list.children[0];
    assert.ok(
      card
        .querySelector(".live-outline-card")
        .querySelector(":scope > .live-outline-flagged"),
    );
    assert.equal(
      card.querySelector(".live-outline-actions .live-outline-flag"),
      null,
    );
    // New nodes get the button in its current state.
    h.panel.show(
      view(turn(1, [argument("t1a1", "Un"), argument("t1a2", "Deux")]), {
        flags: ["t1a1"],
      }),
    );
    h.flush();
    const added = h.list.children[1].querySelector(".live-outline-flag");
    assert.equal(added.hidden, false);
    const panelWithoutHandler = harness({ onFlag: undefined });
    panelWithoutHandler.panel.show(view(turn(1, [argument("t1a1", "Un")])));
    panelWithoutHandler.flush();
    panelWithoutHandler.root.querySelector(".live-outline-flag").click();
  });

  it("opens a card to show its points and keeps it open", () => {
    const h = harness();
    const one = view(
      turn(1, [
        argument("t1a1", "Un", [point("t1a1p1", "x"), point("t1a1p2", "y")]),
        argument("t1a2", "Deux"),
      ]),
    );
    h.panel.show(one);
    h.flush();
    const [card, plain] = h.list.children;
    const toggle = card.querySelector(".live-outline-toggle");
    const more = card.querySelector(".live-outline-more");
    assert.equal(card.dataset.expandable, "true");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), more.id);
    assert.equal(more.hidden, true);
    assert.equal(
      plain.querySelector(".live-outline-toggle"),
      null,
      "a card with nothing more to show is not a button",
    );
    assert.equal(plain.dataset.expandable, "false");
    assert.equal(plain.querySelector(".live-outline-foot").hidden, true);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(more.hidden, false);
    assert.ok("open" in card.dataset);
    // A repaint keeps it open; a point arriving makes the other one a button.
    h.panel.show(
      view(
        turn(1, [
          argument("t1a1", "Un", [point("t1a1p1", "x")]),
          argument("t1a2", "Deux", [point("t1a2p1", "z")]),
        ]),
        { version: 2 },
      ),
    );
    h.flush();
    assert.equal(more.hidden, false);
    assert.equal(
      card.querySelector(".live-outline-foot").textContent,
      "1 point",
    );
    const label = plain.querySelector(".live-outline-label");
    assert.equal(
      label.children[0].className,
      "live-outline-toggle",
      "the label text moves into the new button",
    );
    assert.equal(
      label.children[0].querySelector(".live-outline-label-text").textContent,
      "Deux",
    );
    assert.equal(
      plain.classList.contains("is-changed"),
      true,
      "a closed card flashes when a point arrives",
    );
    toggle.click();
    assert.equal(more.hidden, true);
  });

  it("gives earlier turns the points this page saw and links rebuttals", () => {
    const h = harness();
    const first = turn(1, [
      argument("t1a1", "Un", [point("t1a1p1", "x")]),
      argument("t1a2", "Deux"),
    ]);
    h.panel.show(view(first));
    h.flush();
    h.list.children[0].querySelector(".live-outline-toggle").click();
    const summary = {
      turnNumber: 1,
      side: "A",
      language: "fr",
      arguments: [
        { id: "t1a1", label: "Un", rebuts: null, continues: null },
        { id: "t1a2", label: "Deux", rebuts: null, continues: null },
      ],
      final: true,
    };
    const earlierTurns = [summary];
    h.panel.show(
      view(turn(2, [argument("t2a1", "Contre", [], "t1a1")], "B"), {
        turns: earlierTurns,
        version: 2,
      }),
    );
    h.flush();
    const [seen, unseen] = h.turns.children[0].querySelectorAll(
      ".live-outline-argument",
    );
    assert.deepEqual(pointsOf(seen), ["x"], "points seen live stay");
    assert.equal(
      seen.querySelector(".live-outline-more").hidden,
      false,
      "a card opened earlier stays open",
    );
    assert.equal(seen.querySelector(".live-outline-flag"), null);
    assert.equal(unseen.dataset.expandable, "false");
    // The rebuttal opens, shows and focuses the card it answers, and back.
    const counter = h.list.children[0];
    assert.equal(counter.dataset.expandable, "true");
    counter.querySelector(".live-outline-jump").click();
    assert.equal(seen.querySelector(".live-outline-more").hidden, false);
    assert.equal(seen.querySelector(".live-outline-toggle").focused, 1);
    assert.deepEqual(seen.scrolledInto, { block: "nearest" });
    assert.equal(seen.classList.contains("is-changed"), true);
    const back = seen
      .querySelector(".live-outline-replies")
      .querySelector(".live-outline-jump");
    assert.equal(back.dataset.jump, "t2a1");
    back.click();
    assert.equal(counter.querySelector(".live-outline-more").hidden, false);
    // A new rebuttal in the current turn links the earlier card in place.
    assert.equal(unseen.dataset.expandable, "false");
    h.panel.show(
      view(
        turn(
          2,
          [
            argument("t2a1", "Contre", [], "t1a1"),
            argument("t2a2", "Encore", [], "t1a2"),
          ],
          "B",
        ),
        { turns: earlierTurns, version: 3 },
      ),
    );
    h.flush();
    assert.equal(
      h.turns.children[0].querySelectorAll(".live-outline-argument")[1],
      unseen,
      "the earlier card is updated, not rebuilt",
    );
    assert.equal(unseen.dataset.expandable, "true");
    assert.equal(
      unseen.querySelector(".live-outline-replies").textContent,
      "Rebutted byEncore",
    );
    // No link to an argument that isn't on the page.
    h.panel.show(
      view(turn(2, [argument("t2a1", "Contre", [], "t1a2")], "B"), {
        version: 4,
      }),
    );
    h.flush();
    assert.equal(
      h.list.children[0].querySelector(".live-outline-rebuts").hidden,
      true,
    );
  });

  it("opens the speaker's own cards to their flag buttons", () => {
    const h = harness();
    h.panel.show(view(turn(1, [argument("t1a1", "Un")])));
    h.flush();
    const card = h.list.children[0];
    assert.equal(card.dataset.expandable, "false");
    h.panel.setSpeaker("A");
    h.flush();
    assert.equal(card.dataset.expandable, "true");
    h.panel.setSpeaker(null);
    h.flush();
    assert.equal(card.dataset.expandable, "false");
  });

  it("does not paint while the tab is hidden", () => {
    const h = harness();
    h.page.hidden = true;
    h.panel.show(view(turn(1, [argument("t1a1", "Un")])));
    assert.equal(h.frames.length, 0);
    h.page.hidden = false;
    h.page.listeners.get("visibilitychange")();
    h.flush();
    assert.deepEqual(labels(h.list), ["Un"]);
    // A frame that fires after the tab was hidden paints nothing.
    h.panel.show(view(turn(1, [argument("t1a1", "Deux")])));
    h.page.hidden = true;
    h.flush();
    assert.deepEqual(labels(h.list), ["Un"]);
    h.page.listeners.get("visibilitychange")();
    assert.equal(h.frames.length, 0);
  });

  it("announces new arguments at most every ten seconds", () => {
    const h = harness();
    h.panel.announce([]);
    assert.equal(h.live.textContent, "");
    h.panel.announce(["Un"]);
    assert.equal(h.live.textContent, "New argument: Un");
    h.tick(1000);
    h.panel.announce(["Deux"]);
    h.panel.announce(["Trois"]);
    assert.equal(h.timers.length, 1, "one pending announcement");
    assert.equal(h.timers[0].ms, ANNOUNCE_EVERY_MS - 1000);
    assert.equal(h.live.textContent, "New argument: Un");
    h.tick(9000);
    h.timers.shift().callback();
    assert.equal(h.live.textContent, "New arguments: Deux; Trois");
  });
});

const debateId = "d";
function fakeRoom(identity = "viewer-1", metadata = "") {
  const handlers = new Map();
  return {
    handlers,
    disconnected: 0,
    localParticipant: { identity, metadata },
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    async disconnect() {
      this.disconnected++;
    },
    send(message, topic = "yap.outline.v1") {
      const payload = new TextEncoder().encode(JSON.stringify(message));
      handlers.get("dataReceived")(payload, undefined, undefined, topic);
    },
  };
}
const edits = (version, turnNumber, list) => ({
  v: 1,
  type: "edits",
  debateId,
  version,
  turnNumber,
  side: "A",
  language: "fr",
  edits: list,
});
const add = (id, label) => ({ op: "add_argument", id, label, span });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function page({
  live = true,
  replay = false,
  state,
  answers = [],
  connect,
} = {}) {
  const bootstrap = {
    debateId,
    live,
    replay,
    sides,
    state:
      state === undefined
        ? {
            kind: "snapshot",
            debateId,
            version: 1,
            current: turn(1, [argument("t1a1", "Un")]),
            turns: [],
            flags: [],
          }
        : state,
  };
  const dom = outlinePanel(bootstrap);
  const timers = [];
  const reads = [];
  const posts = [];
  const rooms = [];
  const listeners = new Map();
  let visible = true;
  let postStatus = 201;
  const dependencies = {
    async fetchJson(path) {
      reads.push(path);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async post(path, body) {
      posts.push([path, body]);
      return postStatus;
    },
    async connectData(id) {
      assert.equal(id, debateId);
      if (connect) return connect();
      const room = fakeRoom();
      rooms.push(room);
      return room;
    },
    events: {
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    random: () => 0.5,
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    visible: () => visible,
  };
  const frames = [];
  const outline = createLiveOutline(dom.root, dependencies, {
    document: fakeDocument(),
    frame: (callback) => frames.push(callback),
    setTimer: () => undefined,
  });
  return {
    ...dom,
    outline,
    timers,
    reads,
    posts,
    rooms,
    paint: () => {
      while (frames.length) frames.shift()();
    },
    signal: (topics) => {
      listeners.get("yap:room-signal")({ detail: { topics } });
    },
    playback: (detail) =>
      listeners.get("yap:playback")(
        new CustomEvent("yap:playback", { detail }),
      ),
    hide: () => (visible = false),
    setPostStatus: (status) => (postStatus = status),
    runTimers: async () => {
      while (timers.length) timers.shift().callback();
      await settle();
    },
  };
}
const edits0 = (from, version, versions = []) => ({
  kind: "edits",
  debateId,
  from,
  version,
  versions,
});

describe("live outline page module", () => {
  it("starts from the page's state and follows LiveKit versions", async () => {
    const p = page({ answers: [edits0(1, 1)] });
    p.paint();
    assert.deepEqual(labels(p.list), ["Un"]);
    assert.equal(p.timers[0].ms, DATA_ONLY_DELAY_MS);
    await p.runTimers();
    assert.equal(
      p.rooms.length,
      1,
      "a data-only connection while the video is not joined",
    );
    assert.deepEqual(p.reads, [
      `/api/public/debates/${debateId}/outline?after=1`,
    ]);
    const room = p.rooms[0];
    room.send(edits(2, 1, [add("t1a2", "Deux")]));
    room.send(edits(2, 1, [add("t1a2", "Deux")]));
    room.send(edits(3, 1, [add("t1a3", "Trois")]), "other-topic");
    room.send({ ...edits(3, 1, []), debateId: "other" });
    p.paint();
    assert.equal(p.outline.view.version, 2);
    assert.deepEqual(labels(p.list), ["Un", "Deux"]);
    assert.equal(p.reads.length, 1, "no HTTP request per version");
    assert.equal(p.live.textContent, "New argument: Deux");
  });

  it("repairs a gap with one catch-up read", async () => {
    const p = page({
      answers: [
        edits0(1, 1),
        edits0(1, 3, [
          {
            version: 2,
            turnNumber: 1,
            side: "A",
            language: "fr",
            edits: [add("t1a2", "Deux")],
          },
          {
            version: 3,
            turnNumber: 1,
            side: "A",
            language: "fr",
            edits: [add("t1a3", "Trois")],
          },
        ]),
        new Error("offline"),
      ],
    });
    await p.runTimers();
    const room = p.rooms[0];
    room.send(edits(4, 1, [add("t1a4", "Quatre")]));
    room.send(edits(5, 1, [add("t1a5", "Cinq")]));
    await settle();
    assert.equal(p.reads.length, 2, "concurrent gaps share one read");
    assert.equal(p.outline.view.version, 3);
    room.send(edits(5, 1, []));
    await settle();
    assert.equal(p.reads.length, 3);
    assert.equal(p.outline.view.version, 3, "a failed read keeps the copy");
  });

  it("hands over to the page's own Room and marks the speaker", async () => {
    const p = page({ answers: [edits0(1, 1), edits0(1, 1)] });
    await p.runTimers();
    const data = p.rooms[0];
    const speaker = fakeRoom("speaker-7", JSON.stringify({ side: "A" }));
    p.outline.attach(speaker);
    p.outline.attach(speaker);
    await settle();
    assert.equal(data.disconnected, 1, "the data-only connection closes");
    assert.equal(p.reads.length, 2, "one catch-up per new connection");
    p.paint();
    assert.equal(p.root.querySelector(".live-outline-flag").hidden, false);
    p.root.querySelector(".live-outline-flag").click();
    await settle();
    assert.deepEqual(p.posts, [
      [
        `/api/debates/${debateId}/outline/flags`,
        { turnNumber: 1, itemId: "t1a1" },
      ],
    ]);
    assert.ok(p.outline.view.flags.has("t1a1"));
    p.paint();
    assert.ok(p.root.querySelector(".live-outline-flagged"));
    // Signals do not open a second connection or re-read while LiveKit works.
    p.signal(["media", "outline"]);
    assert.equal(p.timers.length, 0);
  });

  it("does not mark viewers or malformed speaker metadata", async () => {
    for (const room of [
      fakeRoom("viewer-1", JSON.stringify({ side: "A" })),
      fakeRoom("speaker-1", "{"),
      fakeRoom("speaker-1", JSON.stringify({ side: "C" })),
      fakeRoom("speaker-1"),
    ]) {
      const p = page({ live: false, answers: [edits0(1, 1)] });
      p.outline.attach(room);
      await settle();
      p.paint();
      assert.equal(p.root.querySelector(".live-outline-flag").hidden, true);
    }
  });

  it("keeps a refused flag off the page", async () => {
    const p = page({ live: false, answers: [edits0(1, 1)] });
    p.outline.attach(fakeRoom("speaker-1", JSON.stringify({ side: "A" })));
    p.setPostStatus(409);
    p.paint();
    p.root.querySelector(".live-outline-flag").click();
    await settle();
    assert.equal(p.outline.view.flags.size, 0);
  });

  it("falls back to the room signal when LiveKit is unavailable", async () => {
    const p = page({
      state: null,
      answers: [edits0(0, 0)],
      connect: async () => {
        throw new Error("no LiveKit");
      },
    });
    p.paint();
    assert.equal(p.turn.textContent, "Appears when a debater speaks");
    await p.runTimers();
    p.signal(["outline"]);
    assert.equal(
      p.timers[0].ms,
      0.5 * FALLBACK_SPREAD_MS,
      "re-reads are spread",
    );
    await p.runTimers();
    assert.deepEqual(p.reads, [
      `/api/public/debates/${debateId}/outline?after=0`,
    ]);
    p.signal(["window"]);
    assert.equal(p.timers.length, 0);
  });

  it("connects when the debate goes live after the page loaded", async () => {
    const p = page({ live: false, answers: [edits0(1, 1)] });
    assert.equal(p.timers.length, 0);
    p.signal(["media"]);
    assert.equal(p.timers[0].ms, DATA_ONLY_DELAY_MS);
    await p.runTimers();
    assert.equal(p.rooms.length, 1);
    // A hidden page waits for the next signal.
    const hidden = page({ live: true });
    hidden.hide();
    await hidden.runTimers();
    assert.equal(hidden.rooms.length, 0);
  });

  it("drops a data-only connection that finishes after the page joined", async () => {
    let release;
    const late = fakeRoom();
    const p = page({
      answers: [edits0(1, 1)],
      connect: () => new Promise((resolve) => (release = () => resolve(late))),
    });
    p.timers.shift().callback();
    p.outline.attach(fakeRoom());
    release();
    await settle();
    assert.equal(late.disconnected, 1);
  });

  it("replaces an earlier turn with its final outline from LiveKit", async () => {
    const p = page({
      state: {
        kind: "snapshot",
        debateId,
        version: 1,
        finals: 0,
        current: turn(2, [argument("t2a1", "Deux")], "B"),
        turns: [
          {
            turnNumber: 1,
            side: "A",
            language: "fr",
            arguments: [
              { id: "t1a1", label: "Brouillon", rebuts: null, continues: null },
            ],
            final: false,
          },
        ],
        flags: [],
      },
      answers: [edits0(1, 1)],
    });
    await p.runTimers();
    const room = p.rooms[0];
    room.send({
      v: 1,
      type: "final",
      debateId,
      turn: {
        turnNumber: 1,
        side: "A",
        language: "fr",
        arguments: [
          {
            id: "t1a1",
            label: "Version finale",
            rebuts: null,
            continues: null,
          },
        ],
        final: true,
      },
    });
    room.send({ v: 1, type: "final", debateId: "other", turn: {} });
    p.paint();
    assert.equal(p.outline.view.turns[0].arguments[0].label, "Version finale");
    assert.match(p.turns.children[0].textContent, /Version finale/);
  });

  it("follows the replay player's position with one timeline read", async () => {
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
          edits: [add("t1a1", "Premier")],
        },
        {
          version: 2,
          at: 4000,
          turnNumber: 1,
          side: "A",
          language: "fr",
          edits: [add("t1a2", "Deuxième")],
        },
      ],
      turns: [],
    };
    const p = page({ live: false, replay: true, answers: [timeline] });
    p.playback({ debateId, positionSeconds: 2, playing: true });
    await settle();
    assert.deepEqual(p.reads, [
      `/api/public/debates/${debateId}/outline/timeline`,
    ]);
    p.paint();
    assert.deepEqual(labels(p.list), ["Premier"]);
    p.playback({ debateId, positionSeconds: 5, playing: true });
    p.playback({ debateId: "other", positionSeconds: 0.1, playing: true });
    p.playback({ debateId, positionSeconds: "x", playing: true });
    p.playback(null);
    p.paint();
    assert.deepEqual(labels(p.list), ["Premier", "Deuxième"]);
    assert.equal(p.reads.length, 1, "no request during playback");
    // Without a timeline the page keeps the debate's final outline.
    const offline = page({
      live: false,
      replay: true,
      answers: [new Error("offline")],
    });
    await settle();
    offline.playback({ debateId, positionSeconds: 5, playing: true });
    offline.paint();
    assert.deepEqual(labels(offline.list), ["Un"]);
  });

  it("starts nothing on a page without the outline", () => {
    const attach = startLiveOutline(debateId, { querySelector: () => null });
    attach(fakeRoom());
    assert.equal(typeof startLiveOutline(debateId, undefined), "function");
  });
});
