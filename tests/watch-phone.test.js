import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  closedWatch,
  currentPosition,
  keyLook,
  keyText,
  PHONE_WATCH_QUERY,
  turnSegments,
  watchClock,
  watchOrientation,
  watchReducer,
} from "../public/watch-phone.js";

const names = { A: "Maya Chen", B: "Léo Tremblay" };
const now = Date.parse("2026-11-16T20:00:00Z");
const turn = (overrides = {}) => ({
  debateId: "debate",
  eventStatus: "live",
  state: "running",
  activeSide: "A",
  turnNumber: 7,
  turnDeadlineAt: new Date(now + 15_000).toISOString(),
  serverOffset: 0,
  ...overrides,
});
const input = (overrides = {}) => ({
  turn: turn(),
  window: null,
  playing: null,
  replay: false,
  now,
  turnSeconds: 60,
  total: 10,
  names,
  ...overrides,
});
const window = (turnNumber, overrides = {}) => ({
  id: `w${turnNumber}`,
  turnNumber,
  side: turnNumber % 2 ? "A" : "B",
  opensAt: new Date(now - 30_000).toISOString(),
  closesAt: new Date(now + 30_000).toISOString(),
  state: "open",
  voidReason: null,
  revealMode: "five_day",
  revealAt: null,
  recording: { startSeconds: 360, endSeconds: 420 },
  ...overrides,
});

describe("phone full screen", () => {
  it("names a phone: under 600 px wide, or landscape under 500 px tall", () => {
    assert.equal(
      PHONE_WATCH_QUERY,
      "(max-width: 599px), (orientation: landscape) and (max-height: 499px)",
    );
  });

  it("is vertical unless wider than tall", () => {
    assert.equal(watchOrientation(390, 844), "vertical");
    assert.equal(watchOrientation(844, 390), "horizontal");
    assert.equal(watchOrientation(500, 500), "vertical");
  });

  it("opens with the controls hidden and closes back to nothing", () => {
    const open = watchReducer(closedWatch, { type: "open" });
    assert.deepEqual(open, {
      open: true,
      controls: false,
      sheet: null,
      chat: false,
    });
    // Opening again keeps the state.
    const chatting = watchReducer(open, { type: "chat" });
    assert.equal(watchReducer(chatting, { type: "open" }), chatting);
    assert.deepEqual(watchReducer(chatting, { type: "close" }), closedWatch);
  });

  it("toggles the controls on a tap, puts sheets away and keeps chat", () => {
    let state = watchReducer(closedWatch, { type: "open" });
    state = watchReducer(state, { type: "chat" });
    state = watchReducer(state, { type: "tap" });
    assert.equal(state.controls, true);
    state = watchReducer(state, { type: "sheet", sheet: "turns" });
    assert.equal(state.sheet, "turns");
    state = watchReducer(state, { type: "tap" });
    assert.deepEqual(state, {
      open: true,
      controls: false,
      sheet: null,
      chat: true,
    });
  });

  it("closes a sheet and ignores actions while closed", () => {
    const open = watchReducer(closedWatch, { type: "open" });
    const sheet = watchReducer(open, { type: "sheet", sheet: "more" });
    assert.equal(watchReducer(sheet, { type: "close-sheet" }).sheet, null);
    assert.equal(watchReducer(open, { type: "close-sheet" }), open);
    for (const action of [
      { type: "tap" },
      { type: "chat" },
      { type: "sheet", sheet: "turns" },
      { type: "close-sheet" },
    ])
      assert.equal(watchReducer(closedWatch, action), closedWatch);
  });
});

describe("clock on the seam", () => {
  it("counts the running turn down, coral in its last 10 seconds", () => {
    const clock = watchClock(input());
    assert.equal(clock.phase, "running");
    assert.equal(clock.text, "0:15");
    assert.equal(clock.warn, false);
    assert.equal(clock.turnNumber, 7);
    assert.equal(clock.spent, 0.75);
    assert.equal(clock.label, "15 seconds left in turn 7");
    const ending = watchClock(
      input({
        turn: turn({ turnDeadlineAt: new Date(now + 9_500).toISOString() }),
      }),
    );
    assert.equal(ending.warn, true);
    assert.equal(ending.text, "0:10");
  });

  it("follows the server's clock", () => {
    const clock = watchClock(input({ turn: turn({ serverOffset: 5_000 }) }));
    assert.equal(clock.text, "0:10");
  });

  it("says who's next once the deadline passes", () => {
    const clock = watchClock(
      input({ turn: turn({ turnDeadlineAt: new Date(now).toISOString() }) }),
    );
    assert.equal(clock.phase, "between");
    assert.equal(clock.nextSide, "B");
    assert.equal(clock.nextName, "Léo");
    assert.equal(clock.turnNumber, 8);
    assert.equal(clock.label, "Between turns. Léo Tremblay speaks next");
    const last = watchClock(
      input({
        turn: turn({
          turnNumber: 10,
          activeSide: "B",
          turnDeadlineAt: new Date(now - 1).toISOString(),
        }),
      }),
    );
    assert.equal(last.turnNumber, 10);
    assert.equal(last.nextSide, "A");
  });

  it("opens with side A before the first turn", () => {
    const clock = watchClock(
      input({
        turn: turn({
          state: "idle",
          activeSide: null,
          turnNumber: null,
          turnDeadlineAt: null,
        }),
      }),
    );
    assert.equal(clock.phase, "between");
    assert.equal(clock.nextSide, "A");
    assert.equal(clock.turnNumber, 1);
  });

  it("rests while paused, closed or without a snapshot", () => {
    assert.equal(
      watchClock(input({ turn: turn({ state: "paused" }) })).word,
      "Paused",
    );
    assert.equal(
      watchClock(input({ turn: turn({ eventStatus: "ended" }) })).word,
      "Closed",
    );
    const scheduled = watchClock(
      input({ turn: turn({ eventStatus: "scheduled" }) }),
    );
    assert.equal(scheduled.phase, "rest");
    assert.equal(scheduled.word, "");
    assert.equal(watchClock(input({ turn: null })).phase, "rest");
  });

  it("falls back on the open turn window", () => {
    const clock = watchClock(input({ turn: null, window: window(3) }));
    assert.equal(clock.phase, "running");
    assert.equal(clock.text, "0:30");
    assert.equal(clock.turnNumber, 3);
    const closed = watchClock(
      input({
        turn: null,
        window: window(3, { closesAt: new Date(now).toISOString() }),
      }),
    );
    assert.equal(closed.phase, "rest");
  });

  it("follows the replay's playing turn", () => {
    const clock = watchClock(
      input({
        replay: true,
        turn: null,
        playing: { turnNumber: 4, side: "B", left: 42 },
      }),
    );
    assert.equal(clock.phase, "running");
    assert.equal(clock.text, "0:42");
    assert.equal(clock.turnNumber, 4);
    assert.equal(
      watchClock(input({ replay: true, playing: null })).word,
      "Replay",
    );
  });
});

describe("turn bar", () => {
  it("fills the running turn and lights the ones before it", () => {
    const parts = turnSegments(watchClock(input()));
    assert.equal(parts.length, 10);
    assert.deepEqual(parts[5], { done: true, fill: 1 });
    assert.deepEqual(parts[6], { done: false, fill: 0.75 });
    assert.deepEqual(parts[7], { done: false, fill: 0 });
  });

  it("lights the turn just over between turns", () => {
    const parts = turnSegments(
      watchClock(
        input({ turn: turn({ turnDeadlineAt: new Date(now).toISOString() }) }),
      ),
    );
    assert.deepEqual(parts[6], { done: true, fill: 1 });
    assert.deepEqual(parts[7], { done: false, fill: 0 });
  });

  it("has no segments without a turn count", () => {
    assert.deepEqual(turnSegments(watchClock(input({ total: null }))), []);
  });
});

describe("answer keys", () => {
  const positions = { w7: { side: "YES", quantity: 25 } };

  it("finds the viewer's position on the live turn", () => {
    const windows = [window(6, { state: "settled" }), window(7)];
    assert.deepEqual(
      currentPosition({
        windows,
        positions,
        eventStatus: "live",
        now,
        positionSeconds: null,
      }),
      { side: "YES", quantity: 25 },
    );
    assert.equal(
      currentPosition({
        windows,
        positions: {},
        eventStatus: "live",
        now,
        positionSeconds: null,
      }),
      null,
    );
  });

  it("finds it on the replay's playing turn", () => {
    const windows = [window(7, { state: "settled" })];
    assert.deepEqual(
      currentPosition({
        windows,
        positions,
        eventStatus: "replay",
        now,
        positionSeconds: 380,
      }),
      { side: "YES", quantity: 25 },
    );
    assert.equal(
      currentPosition({
        windows,
        positions,
        eventStatus: "replay",
        now,
        positionSeconds: null,
      }),
      null,
    );
  });

  it("keeps the size on the placed key and dims the other", () => {
    const placed = { side: "NO", quantity: 50 };
    assert.equal(keyText("YES", placed), "Yes");
    assert.equal(keyText("NO", placed), "No · 50");
    assert.equal(keyText("YES", null), "Yes");
    assert.equal(keyLook("NO", placed, true), "placed");
    assert.equal(keyLook("YES", placed, true), "off");
    assert.equal(keyLook("YES", null, false), "open");
    assert.equal(keyLook("YES", null, true), "off");
  });
});

// Decision 0018: a mic's turns on the phone clock.
describe("clock on the seam with a mic", async () => {
  const { clockTurnText, watchSheets } =
    await import("../public/watch-phone.js");
  const past = (turnNumber, kind) => ({
    turnNumber,
    micId: "mic-1",
    kind,
    asker: "zoe",
    target: "B",
    text: null,
  });
  const exchange = [past(8, "question"), past(9, "answer")];
  const mic = (overrides = {}) => ({
    turns: exchange,
    mics: [],
    fund: null,
    ...overrides,
  });
  const over = (overrides) =>
    turn({ turnDeadlineAt: new Date(now - 500).toISOString(), ...overrides });

  it("has the Mic sheet beside Turns and More", () => {
    assert.deepEqual(watchSheets, ["turns", "more", "mic"]);
    assert.equal(
      watchReducer(
        { ...closedWatch, open: true },
        { type: "sheet", sheet: "mic" },
      ).sheet,
      "mic",
    );
  });

  it("says Mic in a mic's turn and counts its turns into the total", () => {
    const question = watchClock(
      input({ turn: turn({ turnNumber: 8, speakingSide: null }), mic: mic() }),
    );
    assert.equal(question.phase, "running");
    assert.equal(question.mic, true);
    assert.equal(question.total, 12);
    assert.equal(clockTurnText(question), "Mic");
    assert.equal(question.label, "15 seconds left: @zoe asks Léo Tremblay");
    const debater = watchClock(
      input({ turn: turn({ turnNumber: 10, activeSide: "A" }), mic: mic() }),
    );
    assert.equal(debater.mic, false);
    assert.equal(clockTurnText(debater), "10 / 12");
    assert.equal(debater.label, "15 seconds left in turn 10");
    // Without a mic nothing changes.
    assert.equal(clockTurnText(watchClock(input())), "7 / 10");
    assert.equal(clockTurnText(watchClock(input({ total: null }))), "Turn 7");
    assert.equal(clockTurnText(watchClock(input({ turn: null }))), "");
  });

  it("says who is next inside the exchange", () => {
    const next = (kind, overrides = {}) => {
      const turns = [past(8, kind)];
      return watchClock(
        input({
          turn: over({ turnNumber: 8 }),
          mic: mic({ turns, ...overrides }),
        }),
      );
    };
    // After the asker: the debater asked.
    const asked = next("question");
    assert.equal(asked.phase, "between");
    assert.equal(asked.nextSide, "B");
    assert.equal(asked.nextName, "Léo");
    assert.equal(asked.mic, true);
    assert.equal(asked.label, "Between turns. Léo Tremblay speaks next");
    // After the first answer: the asker's follow-up, no debater.
    const follow = next("answer");
    assert.equal(follow.nextSide, null);
    assert.equal(follow.nextName, "@zoe");
    assert.equal(follow.label, "Between turns. @zoe speaks next");
    // After the last answer: the other debater, or the asker if kept on.
    assert.equal(next("answer2").nextSide, "A");
    const kept = next("answer2", {
      fund: { micId: "mic-1", state: "funded" },
    });
    assert.equal(kept.nextSide, null);
    assert.equal(kept.nextName, "@zoe");
    assert.equal(
      next("answer2", { fund: { micId: "other", state: "funded" } }).nextSide,
      "A",
    );
  });

  it("hands over to a fired mic at a debater's turn end, else to the other debater", () => {
    const waiting = watchClock(
      input({
        turn: over({ turnNumber: 7, activeSide: "A" }),
        mic: mic({
          turns: [],
          mics: [{ state: "live", started: false, holder: "arjun" }],
        }),
      }),
    );
    assert.equal(waiting.nextSide, null);
    assert.equal(waiting.nextName, "@arjun");
    assert.equal(waiting.mic, true);
    // The turn bar grows by the turn the mic is about to take.
    assert.equal(
      turnSegments({ ...waiting, turnNumber: 11, total: 10 }).length,
      11,
    );
    const plain = watchClock(
      input({
        turn: over({ turnNumber: 10, activeSide: "B" }),
        mic: mic({
          turns: [...exchange, past(10, "resume")],
          mics: [{ state: "live", started: true, holder: "zoe" }],
        }),
      }),
    );
    // After the turn that hands the floor back: the other debater.
    assert.equal(plain.nextSide, "A");
    assert.equal(plain.mic, false);
    assert.equal(plain.turnNumber, 11);
    assert.equal(plain.total, 13);
  });
});
