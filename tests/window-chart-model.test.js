import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pointsRevision,
  turnLabel,
  windowPoints,
} from "../public/window-chart-model.js";

const f = (n, d = 100) => ({ n: String(n), d: String(d) });
const window = (turnNumber, overrides = {}) => ({
  id: `w${turnNumber}`,
  turnNumber,
  state: "settled",
  pricing: {
    share: f(58),
    price: f(54),
    a: f(40),
    b: f(66),
    branch: "targeted",
  },
  ...overrides,
});
const turn = (turnNumber, final, labels) => ({
  turnNumber,
  side: "A",
  language: "en",
  final,
  arguments: labels.map((label, i) => ({ id: `a${turnNumber}${i}`, label })),
});

describe("chart from revealed Yap Coins windows (Decision 0013, item d)", () => {
  it("labels a window only from its turn's final outline", () => {
    const timeline = {
      turns: [
        turn(1, true, ["  Costs fall  ", "", "Jobs"]),
        turn(2, false, ["Live, not final"]),
        turn(3, true, [" "]),
      ],
    };
    assert.equal(turnLabel(timeline, 1), "Costs fall · Jobs");
    assert.equal(turnLabel(timeline, 2), null);
    assert.equal(turnLabel(timeline, 3), null);
    assert.equal(turnLabel(timeline, 4), null);
    assert.equal(turnLabel(null, 1), null);
  });

  it("maps settled windows to chart points in turn order", () => {
    const points = windowPoints(
      [
        window(3),
        window(1),
        window(2, { state: "open", pricing: undefined }),
        window(4, { state: "void", pricing: null }),
        window(5, { pricing: { share: null, price: null } }),
        window(6, { turnNumber: null }),
      ],
      { turns: [turn(1, true, ["Costs fall"])] },
    );
    assert.deepEqual(
      points.map((point) => point.number),
      [1, 3],
    );
    assert.deepEqual(points[0], {
      id: "w1",
      runId: null,
      number: 1,
      argumentLabel: "Costs fall",
      share: f(58),
      offer: f(54),
      medianNo: f(40),
      medianYes: f(66),
      ownLimit: null,
      branch: "targeted",
      state: "settled",
      revealed: true,
    });
    assert.equal(points[1].argumentLabel, null);
  });

  it("changes the revision when a share or label changes", () => {
    const base = windowPoints([window(1)], null);
    const labelled = windowPoints([window(1)], {
      turns: [turn(1, true, ["Costs fall"])],
    });
    const moved = windowPoints(
      [window(1, { pricing: { ...window(1).pricing, share: f(61) } })],
      null,
    );
    assert.notEqual(pointsRevision(base), pointsRevision(labelled));
    assert.notEqual(pointsRevision(base), pointsRevision(moved));
    assert.equal(
      pointsRevision(base),
      pointsRevision(windowPoints([window(1)], null)),
    );
  });
});
