import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BAR_ROOM,
  BAR_SCALE,
  barLabel,
  barScale,
  barShape,
  captionParts,
  isTurnWindow,
  latestRevealed,
  percents,
  phoneColumns,
  playingAt,
  resultText,
  rowLine,
  revealNote,
  segmentLabel,
  timelineSegments,
  timestamp,
  turnColumns,
} from "../public/turn-results-model.js";

// Results by turn and the replay's turn timeline (direction BC1's replay
// board, Decision 0013's 2026-11-02 amendment).

const names = { A: "Maya Chen", B: "Léo Tremblay" };
const share = (yes, n = 100) => ({ n: String(yes), d: String(n) });
const span = (turn) => ({
  startSeconds: 2 + (turn - 1) * 61,
  endSeconds: 62 + (turn - 1) * 61,
});
const window = (turnNumber, overrides = {}) => ({
  id: `w${turnNumber}`,
  turnNumber,
  side: turnNumber % 2 ? "A" : "B",
  opensAt: "2026-10-29T00:00:00.000Z",
  closesAt: "2026-10-29T00:01:00.000Z",
  state: "settled",
  voidReason: null,
  revealMode: "five_day",
  revealAt: "2026-11-03T00:10:00.000Z",
  recording: span(turnNumber),
  pricing: { share: share(50 + turnNumber), a: null, b: null, price: null },
  ...overrides,
});
const timeline = {
  turns: [
    {
      turnNumber: 1,
      final: true,
      arguments: [{ label: "Fares cost money" }, { label: " Riders first " }],
    },
    { turnNumber: 2, final: false, arguments: [{ label: "Draft" }] },
  ],
};

describe("turn columns", () => {
  it("makes a column per window in turn order, with labels once revealed", () => {
    const columns = turnColumns(
      [
        window(2, { state: "open", pricing: null }),
        window(1),
        window(3, { pricing: { share: null } }),
        window(4, { state: "void", pricing: null }),
        window(5, { state: "settled", pricing: null }),
      ],
      timeline,
      10,
      false,
    );
    assert.deepEqual(
      columns.map(({ turnNumber, side, state, yes, label, windowId }) => ({
        turnNumber,
        side,
        state,
        yes,
        label,
        windowId,
      })),
      [
        {
          turnNumber: 1,
          side: "A",
          state: "revealed",
          yes: 51,
          label: "Fares cost money · Riders first",
          windowId: "w1",
        },
        {
          turnNumber: 2,
          side: "B",
          state: "hidden",
          yes: null,
          label: null,
          windowId: null,
        },
        {
          turnNumber: 3,
          side: "A",
          state: "empty",
          yes: null,
          label: null,
          windowId: "w3",
        },
        {
          turnNumber: 4,
          side: "B",
          state: "void",
          yes: null,
          label: null,
          windowId: null,
        },
        {
          turnNumber: 5,
          side: "A",
          state: "hidden",
          yes: null,
          label: null,
          windowId: null,
        },
      ],
    );
    assert.deepEqual(columns[0].recording, span(1));
  });

  it("adds a live debate's turns still to come, up to its total", () => {
    const columns = turnColumns(
      [window(2, { state: "open", pricing: null, recording: undefined })],
      null,
      4,
      true,
    );
    assert.deepEqual(
      columns.map((column) => [column.turnNumber, column.state, column.side]),
      [
        [1, "upcoming", null],
        [2, "hidden", "B"],
        [3, "upcoming", null],
        [4, "upcoming", null],
      ],
    );
    assert.equal(columns[1].recording, null);
    // Without a total, only the windows.
    assert.equal(turnColumns([window(2)], null, null, true).length, 1);
    assert.deepEqual(turnColumns([], null, null, false), []);
  });

  it("tells the panel's turn windows from the chart's revealed shape", () => {
    assert.equal(isTurnWindow(window(1)), true);
    assert.equal(
      isTurnWindow({ id: "x", turnNumber: 1, state: "open" }),
      false,
    );
  });

  it("defaults to the latest revealed turn, answered or not", () => {
    const columns = turnColumns(
      [
        window(1),
        window(2, { pricing: { share: null } }),
        window(3, { pricing: null }),
      ],
      null,
      null,
      false,
    );
    assert.equal(latestRevealed(columns), 2);
    assert.equal(
      latestRevealed(
        turnColumns([window(1, { pricing: null })], null, null, false),
      ),
      null,
    );
  });
});

describe("bars", () => {
  const column = (yes, state = "revealed") => ({
    turnNumber: 1,
    side: "A",
    state,
    yes,
    label: null,
    recording: null,
    windowId: null,
  });

  it("uses the board's scale unless a share would leave the chart", () => {
    assert.equal(barScale([]), BAR_SCALE);
    assert.equal(barScale([column(null, "hidden"), column(50)]), BAR_SCALE);
    assert.equal(barScale([column(58), column(42)]), BAR_SCALE);
    assert.equal(barScale([column(90), column(55)]), BAR_ROOM / 40);
    assert.equal(barScale([column(5)]), BAR_ROOM / 45);
  });

  it("rises for a yes majority, drops for a no majority, marks an even split", () => {
    assert.deepEqual(barShape(column(58), 4), {
      direction: "up",
      size: 32,
      value: "58%",
    });
    assert.deepEqual(barShape(column(47), 4), {
      direction: "down",
      size: 12,
      value: "47%",
    });
    assert.deepEqual(barShape(column(50), 4), {
      direction: "even",
      size: 2,
      value: "50%",
    });
    // A narrow majority still shows.
    assert.equal(barShape(column(50.2), 4).size, 2);
    assert.equal(barShape(column(null, "hidden"), 4), null);
  });

  it("rounds yes and no to whole percents that add up to 100", () => {
    assert.deepEqual(percents(58.5), { yes: 59, no: 41 });
    assert.deepEqual(percents(41.5), { yes: 42, no: 58 });
  });

  it("says each state's result in words", () => {
    assert.equal(resultText(column(58)), "58% yes, 42% no");
    assert.equal(resultText(column(null, "empty")), "No answers in this turn");
    assert.equal(
      resultText(column(null, "void")),
      "No result: this turn's window was cancelled",
    );
    assert.equal(
      resultText(column(null, "hidden")),
      "Results not revealed yet",
    );
    assert.equal(resultText(column(null, "upcoming")), "Not started yet");
  });

  it("captions a turn with its speaker, argument and result", () => {
    assert.deepEqual(
      captionParts(
        { ...column(58), turnNumber: 3, label: "Fares cost" },
        names,
      ),
      {
        lead: "Turn 3 · Maya Chen",
        label: "Fares cost",
        result: "58% yes, 42% no",
      },
    );
    assert.deepEqual(
      captionParts({ ...column(null, "upcoming"), side: null }, names),
      {
        lead: "Turn 1",
        label: null,
        result: "Not started yet",
      },
    );
  });

  it("names a bar with everything it shows", () => {
    assert.equal(
      barLabel(
        { ...column(58), side: "B", label: "Fix service first" },
        names,
        true,
      ),
      "Turn 1, Léo Tremblay: 58% yes, 42% no. Fix service first. Playing now.",
    );
    assert.equal(
      barLabel({ ...column(null, "hidden"), side: null }, names, false),
      "Turn 1: Results not revealed yet.",
    );
  });
});

describe("phone rows", () => {
  const column = (turnNumber, state, overrides = {}) => ({
    turnNumber,
    side: turnNumber % 2 ? "A" : "B",
    state,
    yes: state === "revealed" ? 58 : null,
    label: null,
    recording: null,
    windowId: null,
    ...overrides,
  });

  it("list only the turns with a result to show", () => {
    const columns = [
      column(1, "revealed"),
      column(2, "empty"),
      column(3, "void"),
      column(4, "hidden"),
      column(5, "upcoming"),
    ];
    assert.deepEqual(
      phoneColumns(columns).map((item) => item.turnNumber),
      [1, 2, 3],
    );
    assert.deepEqual(phoneColumns([column(1, "hidden")]), []);
  });

  it("carry the speaker and the turn's arguments, as the caption does", () => {
    assert.equal(
      rowLine(
        column(1, "revealed", { label: "Fares cost · Riders first" }),
        names,
      ),
      "Maya · “Fares cost · Riders first”",
    );
    assert.equal(rowLine(column(2, "revealed"), names), "Léo");
    assert.equal(
      rowLine(column(2, "empty", { label: "Service first" }), names),
      "Léo · “Service first” · No answers in this turn",
    );
    assert.equal(
      rowLine(column(3, "void", { side: null }), names),
      "No result: this turn's window was cancelled",
    );
  });
});

describe("the reveal note", () => {
  const now = Date.parse("2026-10-30T23:30:00.000Z");
  it("names the next reveal in Eastern time", () => {
    assert.equal(
      revealNote(
        [
          window(1, { pricing: null, revealAt: "2026-11-04T00:10:00.000Z" }),
          window(2, { pricing: null }),
          // Revealed and voided windows don't count.
          window(3, { revealAt: "2026-11-01T00:00:00.000Z" }),
          window(4, {
            state: "void",
            pricing: null,
            revealAt: "2026-11-01T00:00:00.000Z",
          }),
        ],
        now,
      ),
      "Results are revealed on Nov 2 at 7:10 PM EST.",
    );
  });
  it("falls back to a general line without a future reveal", () => {
    const general = "Results appear here once a turn's results are revealed.";
    assert.equal(revealNote([], now), general);
    assert.equal(
      revealNote([window(1, { pricing: null, revealAt: null })], now),
      general,
    );
    assert.equal(
      revealNote(
        [window(1, { pricing: null, revealAt: "2026-10-01T00:00:00.000Z" })],
        now,
      ),
      general,
    );
  });
});

describe("the replay timeline", () => {
  const columns = turnColumns(
    [window(1), window(2), window(3, { recording: null })],
    null,
    null,
    false,
  );

  it("finds the turn playing at a position", () => {
    assert.equal(playingAt(columns, null), null);
    assert.equal(playingAt(columns, 0), null);
    assert.equal(playingAt(columns, 2), 1);
    assert.equal(playingAt(columns, 62), null);
    assert.equal(playingAt(columns, 63), 2);
  });

  it("fills played turns, part of the playing one, and nothing later", () => {
    assert.deepEqual(timelineSegments(columns, 93), [
      { turnNumber: 1, progress: 1, playing: false, playable: true },
      { turnNumber: 2, progress: 0.5, playing: true, playable: true },
      { turnNumber: 3, progress: 0, playing: false, playable: false },
    ]);
    assert.deepEqual(
      timelineSegments(columns, null).map((segment) => segment.progress),
      [0, 0, 0],
    );
  });

  it("names each segment by its turn, speaker and place", () => {
    assert.equal(
      segmentLabel(columns[1], names),
      "Turn 2, Léo Tremblay, 1:03 to 2:03",
    );
    assert.equal(segmentLabel({ ...columns[2], side: null }, names), "Turn 3");
  });

  it("writes places in the recording as minutes and seconds", () => {
    assert.equal(timestamp(0), "0:00");
    assert.equal(timestamp(-3), "0:00");
    assert.equal(timestamp(124.9), "2:04");
    assert.equal(timestamp(600), "10:00");
  });
});
