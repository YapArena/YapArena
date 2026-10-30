import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorTint,
  clockText,
  liveTurnView,
  openWindow,
  playingTurn,
  replayTurnView,
  turnLabel,
} from "../public/debate-layout-model.js";

const names = { A: "Maya Chen", B: "Léo Tremblay" };
const turn = (overrides = {}) => ({
  debateId: "debate",
  eventStatus: "live",
  state: "running",
  activeSide: "A",
  turnNumber: 3,
  turnDeadlineAt: "2026-10-30T23:30:42Z",
  serverOffset: 0,
  ...overrides,
});
const window = (turnNumber, side, overrides = {}) => ({
  id: `w${turnNumber}`,
  turnNumber,
  side,
  opensAt: `2026-10-30T23:${String(20 + turnNumber).padStart(2, "0")}:00Z`,
  closesAt: `2026-10-30T23:${String(21 + turnNumber).padStart(2, "0")}:00Z`,
  state: "open",
  voidReason: null,
  revealMode: "five_day",
  revealAt: null,
  recording: {
    startSeconds: (turnNumber - 1) * 60,
    endSeconds: turnNumber * 60,
  },
  ...overrides,
});

describe("debate scoreboard", () => {
  it("names the speaker, the listener and the turn while a turn runs", () => {
    assert.deepEqual(liveTurnView(turn(), null, names, 10), {
      activeSide: "A",
      states: { A: "speaking", B: "listening" },
      hole: "",
      label: "Turn 3 of 10",
      summary: "Turn 3 of 10 · Maya Chen is speaking",
    });
    const second = liveTurnView(
      turn({ activeSide: "B", turnNumber: 4 }),
      null,
      names,
      null,
    );
    assert.deepEqual(second.states, { A: "listening", B: "speaking" });
    assert.equal(second.label, "Turn 4");
    assert.equal(second.summary, "Turn 4 · Léo Tremblay is speaking");
  });

  it("falls back to the open turn window without a media snapshot", () => {
    const view = liveTurnView(null, window(5, "B"), names, 10);
    assert.equal(view.activeSide, "B");
    assert.equal(view.label, "Turn 5 of 10");
    assert.equal(liveTurnView(null, null, names, 10), null);
    // A running turn with no number takes the window's.
    assert.equal(
      liveTurnView(turn({ turnNumber: null }), window(3, "A"), names, 10).label,
      "Turn 3 of 10",
    );
  });

  it("shows who opens before the first turn, and pauses", () => {
    const idle = liveTurnView(
      turn({ state: "idle", activeSide: null }),
      null,
      names,
      10,
    );
    assert.equal(idle.activeSide, null);
    assert.deepEqual(idle.states, { A: "next", B: "" });
    assert.equal(idle.hole, "Next · Maya");
    const paused = liveTurnView(
      turn({ state: "paused", activeSide: "B" }),
      null,
      names,
      10,
    );
    assert.equal(paused.activeSide, null);
    assert.deepEqual(paused.states, { A: "", B: "next" });
    assert.equal(paused.hole, "Paused");
    assert.equal(paused.label, "Turn 3 of 10");
  });

  it("closes after the debate and leaves other statuses to the server", () => {
    const ended = liveTurnView(
      turn({ eventStatus: "ended", state: "ended" }),
      null,
      names,
      10,
    );
    assert.equal(ended.hole, "Closed");
    assert.equal(ended.activeSide, null);
    assert.equal(
      liveTurnView(turn({ eventStatus: "scheduled" }), null, names, 10),
      null,
    );
  });

  it("follows the replay's playing turn and its time left", () => {
    const windows = [window(1, "A"), window(2, "B"), window(3, "A")];
    assert.deepEqual(playingTurn(windows, 84), {
      turnNumber: 2,
      side: "B",
      left: 36,
    });
    assert.equal(playingTurn(windows, 600), null);
    assert.equal(playingTurn([window(1, "A", { recording: null })], 10), null);
    const view = replayTurnView(playingTurn(windows, 84), 10);
    assert.equal(view.hole, "0:36");
    assert.equal(view.label, "Turn 2 of 10");
    assert.deepEqual(view.states, { A: "listening", B: "speaking" });
    assert.equal(replayTurnView(null, 10), null);
  });

  it("finds the open window at a time", () => {
    const windows = [window(1, "A", { state: "settled" }), window(2, "B")];
    assert.equal(
      openWindow(windows, Date.parse("2026-10-30T23:22:30Z")).turnNumber,
      2,
    );
    assert.equal(openWindow(windows, Date.parse("2026-10-30T23:21:30Z")), null);
  });

  it("formats turns and clocks", () => {
    assert.equal(turnLabel(null, 10), "");
    assert.equal(turnLabel(7, 10), "Turn 7 of 10");
    assert.equal(clockText(42), "0:42");
    assert.equal(clockText(41.2), "0:42");
    assert.equal(clockText(60), "1:00");
    assert.equal(clockText(-3), "0:00");
  });
});

describe("chat author colours", () => {
  it("gives each author a stable index into the visit's five colours", () => {
    const authors = [
      "Jules",
      "maple owl",
      "Inès",
      "Nadia R.",
      "Tom Lee",
      "Marc-André",
      "dev.p",
      "You",
    ];
    const tints = authors.map(authorTint);
    assert.deepEqual(authors.map(authorTint), tints);
    for (const tint of tints)
      assert.ok(Number.isInteger(tint) && tint >= 0 && tint < 5);
    assert.ok(new Set(tints).size >= 3, "names spread over the palette");
    assert.equal(authorTint(""), authorTint(""));
  });
});
