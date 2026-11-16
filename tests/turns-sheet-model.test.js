// Decision 0016, point 6: what the phone full screen's Turns sheet says
// (frontend/turns-sheet-model.ts), under Decision 0015's reveal rules.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  TURNS_HEADING,
  beforeClose,
  shownThrough,
  turnSlots,
  turnStarts,
  turnsSheetView,
} = await import("../public/turns-sheet-model.js");
const { turnColumns } = await import("../public/turn-results-model.js");

const names = { A: "Maya Chen", B: "Léo Tremblay" };
const labels = {
  sideA: "Free for everyone",
  sideB: "Fix service first",
  sideAIsYes: true,
};
const now = Date.parse("2026-11-16T12:00:00Z");
const share = (yes) => ({ n: String(yes), d: "100" });
const span = (turn) => ({
  startSeconds: 2 + (turn - 1) * 61,
  endSeconds: 62 + (turn - 1) * 61,
});
const window = (turnNumber, yes, overrides = {}) => ({
  id: `w${turnNumber}`,
  turnNumber,
  side: turnNumber % 2 ? "A" : "B",
  opensAt: "2026-11-16T11:00:00.000Z",
  closesAt: "2026-11-16T11:01:00.000Z",
  state: yes === undefined ? "open" : "settled",
  voidReason: null,
  revealMode: "per_round",
  revealAt: null,
  recording: null,
  pricing:
    yes === undefined
      ? null
      : { share: yes === null ? null : share(yes), a: null, b: null },
  ...overrides,
});
const figure = (throughTurn, yes, accounts, previous = null) => ({
  throughTurn,
  yes,
  accounts,
  previous,
  switched: { toYes: 20, toNo: 10, cameBack: 5 },
  multiAnswerAccounts: 35,
});
const turn1 = figure(1, 140, 230);
const turn2 = figure(2, 300, 590, { throughTurn: 1, yes: 140, accounts: 230 });
const turn3 = figure(3, 330, 600, { throughTurn: 2, yes: 300, accounts: 590 });
const reveal = (overrides = {}) => ({
  endorsement: turn3,
  turns: [turn1, turn2, turn3],
  revealMode: "per_round",
  revealAt: null,
  ...overrides,
});
const liveWindows = [
  window(1, 61),
  window(2, 42),
  window(3, 55),
  window(4, undefined),
];
const input = (overrides = {}) => ({
  figure: reveal(),
  labels,
  windows: liveWindows,
  total: 10,
  names,
  position: null,
  now,
  ...overrides,
});

describe("the figure", () => {
  it("shows both shares with the side labels, the counts, the change and the switching", () => {
    const view = turnsSheetView(input());
    assert.equal(view.heading, "Last answers in this debate");
    assert.deepEqual(view.shares, [
      { answer: "Yes", label: "Free for everyone · Yes", percent: 55 },
      { answer: "No", label: "No · Fix service first", percent: 45 },
    ]);
    assert.equal(view.yesPercent, 55);
    assert.equal(
      view.counts,
      "330 Yes · 270 No · 600 accounts · through turn 3",
    );
    assert.equal(view.change, "Since turn 2: +4 pts Yes");
    assert.equal(
      view.switches,
      "35 accounts changed answer: 20 to Yes, 10 to No, 5 changed back",
    );
    assert.equal(view.status, null);
    // No "Not a vote…" line: the sheet has no footer at all.
    assert.equal("footer" in view, false);
    assert.equal(JSON.stringify(view).includes("Not a vote"), false);
  });

  it("names the answers alone when side A does not answer yes", () => {
    const view = turnsSheetView(
      input({ labels: { ...labels, sideAIsYes: false } }),
    );
    assert.deepEqual(
      view.shares.map((item) => item.label),
      ["Yes", "No"],
    );
  });

  it("says the first revealed turn and a turn with no change", () => {
    assert.equal(
      turnsSheetView(input({ figure: reveal({ endorsement: turn1 }) })).change,
      "First revealed turn",
    );
    const flat = figure(3, 300, 590, {
      throughTurn: 2,
      yes: 300,
      accounts: 590,
    });
    assert.equal(
      turnsSheetView(input({ figure: reveal({ endorsement: flat }) })).change,
      "No change since turn 2",
    );
  });
});

describe("the turn bars", () => {
  it("draws one bar per revealed turn, with empty slots up to the debate's turns", () => {
    const view = turnsSheetView(input());
    assert.equal(view.turnsHeading, TURNS_HEADING);
    assert.equal(view.turnsHeading, "Share who said yes, each turn");
    assert.equal(view.slots.length, 10);
    assert.deepEqual(view.slots.slice(0, 4), [
      {
        turnNumber: 1,
        who: "MC",
        state: "bar",
        direction: "up",
        size: 44,
        value: "61%",
        current: false,
      },
      {
        turnNumber: 2,
        who: "LT",
        state: "bar",
        direction: "down",
        size: 32,
        value: "42%",
        current: false,
      },
      {
        turnNumber: 3,
        who: "MC",
        state: "bar",
        direction: "up",
        size: 20,
        value: "55%",
        current: true,
      },
      // The open turn shows nothing, not even that it is live.
      {
        turnNumber: 4,
        who: "LT",
        state: "later",
        direction: null,
        size: 0,
        value: "",
        current: false,
      },
    ]);
    assert.deepEqual(
      view.slots.slice(4).map((slot) => [slot.state, slot.who]),
      Array.from({ length: 6 }, () => ["later", ""]),
    );
    assert.equal(
      view.turnsLabel,
      "Share who said yes in each revealed turn: turn 1 61%, turn 2 42%, turn 3 55%",
    );
  });

  it("keeps a revealed turn without answers and a cancelled one, with no share", () => {
    const view = turnsSheetView(
      input({
        windows: [
          window(1, 61),
          window(2, null),
          window(3, undefined, { state: "void" }),
        ],
        total: 3,
      }),
    );
    assert.deepEqual(
      view.slots.map(({ state, value, current }) => [state, value, current]),
      [
        ["bar", "61%", false],
        ["none", "—", false],
        ["none", "—", true],
      ],
    );
    assert.equal(
      view.turnsLabel,
      "Share who said yes in each revealed turn: turn 1 61%, turn 2 no answers, turn 3 cancelled",
    );
  });

  it("scales the bars down when a share is far from 50%", () => {
    const slots = turnSlots(
      turnColumns([window(1, 95), window(2, 40)], null, 2, false),
      names,
      2,
    );
    // 56 px of room over 45 points.
    assert.deepEqual(
      slots.map((slot) => slot.size),
      [56, 12],
    );
  });

  it("goes past the debate's turn count rather than dropping a revealed turn", () => {
    const view = turnsSheetView(input({ total: 2 }));
    assert.equal(view.slots.length, 3);
    assert.equal(turnsSheetView(input({ total: null })).slots.length, 3);
  });
});

describe("before anything is revealed", () => {
  it("is empty before the first reveal, and says when it fills", () => {
    const view = turnsSheetView(
      input({
        figure: reveal({ endorsement: null, turns: [] }),
        windows: [window(1, undefined)],
      }),
    );
    assert.deepEqual(view.shares, []);
    assert.equal(view.counts, null);
    assert.equal(view.change, null);
    assert.equal(view.switches, null);
    assert.equal(view.status, "Fills after each turn's answers are revealed.");
    assert.deepEqual(view.slots, []);
  });

  it("says the same before the first window read", () => {
    const view = turnsSheetView(input({ figure: null, windows: [] }));
    assert.deepEqual(view.shares, []);
    assert.equal(view.status, "Fills after each turn's answers are revealed.");
    assert.deepEqual(view.slots, []);
  });

  it("keeps a five-day debate hidden until its close, whatever the read holds", () => {
    const fiveDay = {
      revealMode: "five_day",
      revealAt: "2026-11-18T20:00:00.000Z",
    };
    const view = turnsSheetView(input({ figure: reveal(fiveDay) }));
    assert.deepEqual(view.shares, []);
    assert.deepEqual(view.slots, []);
    assert.equal(
      view.status,
      "Answers stay hidden until Nov 18 at 3:00 PM EST, 5 days after the debate.",
    );
    const closed = turnsSheetView(
      input({
        figure: reveal(fiveDay),
        now: Date.parse("2026-11-18T20:00:00Z"),
      }),
    );
    assert.equal(closed.shares.length, 2);
    assert.equal(closed.slots.length, 10);
    assert.equal(beforeClose(reveal(fiveDay), now), true);
    assert.equal(
      beforeClose({ revealMode: "five_day", revealAt: null }, now),
      true,
    );
    assert.equal(beforeClose(reveal(), now), false);
  });
});

describe("a replay", () => {
  const timed = [
    window(1, 61, { recording: span(1) }),
    window(2, 42, { recording: span(2) }),
    window(3, 55, { recording: span(3) }),
  ];

  it("shows the turns through the one playing, and that turn's figure", () => {
    const view = turnsSheetView(
      input({ windows: timed, total: 3, position: span(2).startSeconds + 5 }),
    );
    assert.deepEqual(
      view.slots.map(({ state, current }) => [state, current]),
      [
        ["bar", false],
        ["bar", true],
        ["later", false],
      ],
    );
    assert.equal(view.yesPercent, 51);
    assert.equal(
      view.counts,
      "300 Yes · 290 No · 590 accounts · through turn 2",
    );
    // A seek back moves both at once.
    const back = turnsSheetView(
      input({ windows: timed, total: 3, position: span(1).startSeconds }),
    );
    assert.equal(back.yesPercent, 61);
    assert.deepEqual(
      back.slots.map((slot) => slot.state),
      ["bar", "later", "later"],
    );
  });

  it("waits before the first turn starts", () => {
    const view = turnsSheetView(
      input({ windows: timed, total: 3, position: 0 }),
    );
    assert.deepEqual(view.shares, []);
    assert.deepEqual(view.slots, []);
    assert.equal(view.status, "Fills as each turn plays.");
  });

  it("shows every revealed turn when its turns have no place in the recording", () => {
    const view = turnsSheetView(input({ total: 3, position: 30 }));
    assert.equal(view.slots.filter((slot) => slot.state === "bar").length, 3);
    assert.equal(view.yesPercent, 55);
  });

  it("finds where each turn starts and the last one reached", () => {
    const starts = turnStarts(timed);
    assert.deepEqual(starts, [
      { turnNumber: 1, startSeconds: 2 },
      { turnNumber: 2, startSeconds: 63 },
      { turnNumber: 3, startSeconds: 124 },
    ]);
    assert.equal(shownThrough(starts, null), undefined);
    assert.equal(shownThrough([], 40), undefined);
    assert.equal(shownThrough(starts, 1), null);
    assert.equal(shownThrough(starts, 63), 2);
    assert.equal(shownThrough(starts, 500), 3);
  });
});

describe("a debate whose figure isn't counted", () => {
  it("shows only the turn bars", () => {
    const view = turnsSheetView(input({ labels: null }));
    assert.deepEqual(view.shares, []);
    assert.equal(view.counts, null);
    assert.equal(view.change, null);
    assert.equal(view.switches, null);
    assert.equal(view.status, null);
    assert.equal(view.slots.length, 10);
  });

  it("says why the bars are empty", () => {
    const view = turnsSheetView(
      input({ labels: null, windows: [window(1, undefined)] }),
    );
    assert.deepEqual(view.slots, []);
    assert.equal(view.status, "Fills after each turn's answers are revealed.");
  });
});
