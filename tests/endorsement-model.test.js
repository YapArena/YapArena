import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareAnswers,
  debateFigure,
  debateFigures,
  emptySwitching,
  foldAnswers,
  latestDebateFigure,
  orderAnswers,
} from "../dist/features/endorsement/model.js";

// Decision 0015: each account's last revealed answer, counted once.
let sequence = 0;
function answer(userId, side, overrides = {}) {
  sequence++;
  return {
    userId,
    side,
    createdAt: `2026-11-13T12:00:${String(sequence).padStart(2, "0")}.000000Z`,
    revealedAt: "2026-11-13T13:00:00.000000Z",
    debateId: "debate-1",
    turnNumber: 1,
    roundId: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe("last-answer fold", () => {
  it("counts the founder's example: Alice and Bob end on No, Chloé on Yes", () => {
    const answers = [
      answer("alice", "YES", { turnNumber: 1 }),
      answer("bob", "YES", { turnNumber: 1 }),
      answer("chloe", "NO", { turnNumber: 1 }),
      answer("alice", "NO", { turnNumber: 2 }),
      answer("bob", "NO", { turnNumber: 3 }),
      answer("chloe", "YES", { turnNumber: 3 }),
    ];
    const fold = foldAnswers(answers);
    assert.equal(fold.yes, 1);
    assert.equal(fold.accounts, 3);
    assert.equal(fold.switching.multiAnswerAccounts, 3);
    assert.equal(fold.switching.switchers, 3);
    assert.equal(fold.switching.stayed, 3);
    assert.equal(fold.switching.cameBack, 0);
    assert.equal(fold.switching.toYes, 1);
    assert.equal(fold.switching.toNo, 2);
  });

  it("returns zeros for no answers", () => {
    assert.deepEqual(foldAnswers([]), {
      yes: 0,
      accounts: 0,
      switching: emptySwitching(),
    });
    assert.equal(latestDebateFigure([]), null);
    assert.equal(debateFigure([], 3), null);
  });

  it("breaks order-time ties by reveal time, then turn, then round", () => {
    const at = "2026-11-13T12:00:00.000001Z";
    const base = { userId: "a", createdAt: at, debateId: "d" };
    const byReveal = [
      {
        ...base,
        side: "YES",
        revealedAt: "2026-11-13T13:00:02.000000Z",
        turnNumber: 1,
        roundId: "1",
      },
      {
        ...base,
        side: "NO",
        revealedAt: "2026-11-13T13:00:01.000000Z",
        turnNumber: 2,
        roundId: "2",
      },
    ];
    assert.equal(foldAnswers(byReveal).yes, 1);
    const reveal = "2026-11-13T13:00:00.000000Z";
    const byTurn = [
      { ...base, side: "YES", revealedAt: reveal, turnNumber: 4, roundId: "1" },
      { ...base, side: "NO", revealedAt: reveal, turnNumber: 3, roundId: "2" },
    ];
    assert.equal(foldAnswers(byTurn).yes, 1);
    const byRound = [
      { ...base, side: "NO", revealedAt: reveal, turnNumber: 3, roundId: "b" },
      { ...base, side: "YES", revealedAt: reveal, turnNumber: 3, roundId: "a" },
    ];
    assert.equal(foldAnswers(byRound).yes, 0);
    assert.equal(compareAnswers(byRound[0], byRound[0]), 0);
    assert.deepEqual(
      orderAnswers(byRound).map((a) => a.roundId),
      ["a", "b"],
    );
  });

  it("orders by microseconds as text", () => {
    const answers = [
      answer("a", "NO", { createdAt: "2026-11-13T12:00:00.000002Z" }),
      answer("a", "YES", { createdAt: "2026-11-13T12:00:00.000001Z" }),
    ];
    assert.equal(foldAnswers(answers).yes, 0);
  });

  it("counts one account once across debates", () => {
    const answers = [
      answer("a", "YES", { debateId: "d1" }),
      answer("a", "YES", { debateId: "d2" }),
      answer("b", "NO", { debateId: "d2" }),
    ];
    const fold = foldAnswers(answers);
    assert.equal(fold.accounts, 2);
    assert.equal(fold.yes, 1);
    assert.deepEqual(fold.switching.pairs, { within: 0, between: 1 });
    assert.equal(fold.switching.switchers, 0);
  });

  it("keeps a newer answer when an older one is revealed later", () => {
    const answers = [
      answer("a", "YES", {
        createdAt: "2026-11-13T12:00:00.000000Z",
        revealedAt: "2026-11-18T12:00:00.000000Z",
        debateId: "five-day",
      }),
      answer("a", "NO", {
        createdAt: "2026-11-14T12:00:00.000000Z",
        revealedAt: "2026-11-14T12:01:00.000000Z",
        debateId: "per-round",
      }),
    ];
    assert.equal(foldAnswers(answers).yes, 0);
  });

  it("separates switches within and between debates, and who came back", () => {
    const answers = [
      answer("a", "YES", { debateId: "d1", turnNumber: 1 }),
      answer("a", "NO", { debateId: "d1", turnNumber: 2 }),
      answer("a", "YES", { debateId: "d2", turnNumber: 1 }),
      answer("b", "NO", { debateId: "d1", turnNumber: 1 }),
      answer("b", "NO", { debateId: "d1", turnNumber: 2 }),
      answer("c", "NO", { debateId: "d1", turnNumber: 1 }),
      answer("c", "YES", { debateId: "d2", turnNumber: 1 }),
    ];
    const { switching, yes, accounts } = foldAnswers(answers);
    assert.equal(accounts, 3);
    assert.equal(yes, 2);
    assert.deepEqual(switching, {
      multiAnswerAccounts: 3,
      switchers: 2,
      stayed: 1,
      cameBack: 1,
      pairs: { within: 2, between: 2 },
      switches: { within: 1, between: 2 },
      toYes: 2,
      toNo: 1,
    });
  });
});

describe("debate figure", () => {
  const turns = [
    answer("a", "YES", { turnNumber: 1 }),
    answer("b", "NO", { turnNumber: 1 }),
    answer("a", "NO", { turnNumber: 2 }),
    answer("c", "YES", { turnNumber: 4 }),
    answer("b", "YES", { turnNumber: 4 }),
    answer("a", "YES", { turnNumber: 4 }),
  ];

  it("counts through a turn and compares with the previous counted turn", () => {
    const figure = latestDebateFigure(turns);
    assert.deepEqual(figure, {
      throughTurn: 4,
      yes: 3,
      accounts: 3,
      previous: { throughTurn: 2, yes: 0, accounts: 2 },
      switched: { toYes: 1, toNo: 0, cameBack: 1 },
      multiAnswerAccounts: 2,
    });
  });

  it("has no previous figure on the first counted turn", () => {
    const figure = debateFigure(turns, 1);
    assert.equal(figure.previous, null);
    assert.equal(figure.yes, 1);
    assert.equal(figure.accounts, 2);
    assert.deepEqual(figure.switched, { toYes: 0, toNo: 0, cameBack: 0 });
  });

  it("gives the figure through each counted turn, oldest first", () => {
    const figures = debateFigures(turns);
    assert.deepEqual(
      figures.map((figure) => figure.throughTurn),
      [1, 2, 4],
    );
    assert.deepEqual(figures[0], debateFigure(turns, 1));
    assert.deepEqual(figures[1], debateFigure(turns, 2));
    assert.deepEqual(figures.at(-1), latestDebateFigure(turns));
    assert.deepEqual(debateFigures([]), []);
  });

  it("ignores turns after the one it counts through", () => {
    const figure = debateFigure(turns, 2);
    assert.deepEqual(figure.previous, { throughTurn: 1, yes: 1, accounts: 2 });
    assert.deepEqual(figure.switched, { toYes: 0, toNo: 1, cameBack: 0 });
    assert.equal(figure.multiAnswerAccounts, 1);
  });
});
