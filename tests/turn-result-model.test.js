// Decision 0016 point 7: which of the viewer's own turn positions pop as a
// result plate on the phone's full screen, and what each plate says
// (frontend/turn-result-model.ts).
import assert from "node:assert/strict";
import { it } from "node:test";

const {
  COUNT_DELAY_MS,
  COUNT_MS,
  PLATE_MS,
  amountText,
  burstBits,
  countedHundredths,
  isFilledResult,
  resultTone,
  revealedTurnResults,
  turnResult,
  winStreak,
} = await import("../public/turn-result-model.js");
const { formatFixedHundredths } = await import("../public/lib/coin-format.js");

// 10,000 atomic units are one Yap Coin.
const coins = (value) => String(Math.round(value * 10_000));
const own = { side: "YES", limit: "0.60", quantity: 10, requestId: "r" };
/** A turn window; `net` in Yap Coins makes it a revealed, filled position. */
function round(turnNumber, overrides = {}) {
  const { net, ...rest } = overrides;
  return {
    id: `w${turnNumber}`,
    kind: "turn",
    turnNumber,
    side: turnNumber % 2 ? "A" : "B",
    state: net === undefined ? "open" : "settled",
    voidReason: null,
    opensAt: "2026-11-16T10:00:00Z",
    closesAt: "2026-11-16T10:01:00Z",
    revealMode: "per_round",
    revealAt: null,
    participants: 4,
    eligibility: { canTakePosition: false, reason: "closed", via: null },
    own,
    ...(net === undefined
      ? {}
      : {
          outcome: {
            executed: true,
            premium: coins(5.4),
            fee: "0",
            payout: coins(5.4 + net),
            net: coins(net),
          },
        }),
    ...rest,
  };
}

it("pops nothing on the first read, so old results never replay", () => {
  const rounds = [round(1, { net: 1 }), round(2, { net: -0.5 }), round(3)];
  const first = revealedTurnResults(null, rounds);
  assert.deepEqual(first.results, []);
  assert.deepEqual([...first.seen].sort(), ["w1", "w2"]);
  // The same read again pops nothing either.
  assert.deepEqual(revealedTurnResults(first.seen, rounds).results, []);
});

it("pops a position the first time a read shows it revealed, once", () => {
  const before = revealedTurnResults(null, [round(1, { net: 1 }), round(2)]);
  const after = revealedTurnResults(before.seen, [
    round(1, { net: 1 }),
    round(2, { net: 2.5 }),
  ]);
  assert.deepEqual(
    after.results.map((result) => result.roundId),
    ["w2"],
  );
  // A later read that loses the reveal, then shows it again, doesn't repeat it.
  const lost = revealedTurnResults(after.seen, [
    round(1, { net: 1 }),
    round(2),
  ]);
  assert.deepEqual(lost.results, []);
  assert.deepEqual(
    revealedTurnResults(lost.seen, [
      round(1, { net: 1 }),
      round(2, { net: 2.5 }),
    ]).results,
    [],
  );
});

it("pops a window an earlier read missed", () => {
  const before = revealedTurnResults(null, [round(1)]);
  const after = revealedTurnResults(before.seen, [
    round(1),
    round(2, { net: 1 }),
  ]);
  assert.deepEqual(
    after.results.map((result) => result.turnNumber),
    [2],
  );
});

it("orders two results revealed together by turn", () => {
  const before = revealedTurnResults(null, [round(3), round(4)]);
  const after = revealedTurnResults(before.seen, [
    round(4, { net: 2 }),
    round(3, { net: 1 }),
  ]);
  assert.deepEqual(
    after.results.map((result) => [result.turnNumber, result.streak]),
    [
      [3, 1],
      [4, 2],
    ],
  );
  assert.equal(after.results[0].streakText, null);
  assert.equal(after.results[1].streakText, "2 WINS IN A ROW");
});

it("shows nothing for unfilled orders, void windows, others' turns or manual rounds", () => {
  const unfilled = round(1, { net: 0 });
  unfilled.outcome = { ...unfilled.outcome, executed: false };
  const voided = round(2, { state: "void", voidReason: "operator_cancelled" });
  const notMine = round(3, { net: 1, own: null });
  const manual = round(4, { net: 1, kind: "manual", turnNumber: null });
  const awaiting = round(5, { state: "settled" });
  for (const item of [unfilled, voided, notMine, manual, awaiting])
    assert.equal(isFilledResult(item), false);
  const before = revealedTurnResults(null, []);
  assert.deepEqual(
    revealedTurnResults(before.seen, [
      unfilled,
      voided,
      notMine,
      manual,
      awaiting,
    ]).results,
    [],
  );
});

it("says a win, a loss and breaking even with two decimals and a real minus sign", () => {
  const rounds = [
    round(1, { net: 1 }),
    round(2, { net: -0.5 }),
    round(3, { net: 0 }),
  ];
  const [win, loss, even] = rounds.map((item) => turnResult(item, rounds));
  assert.deepEqual(
    [win.tone, win.word, win.amountText, win.hundredths],
    ["win", "YOU WON", "+1.00", 100],
  );
  assert.deepEqual(
    [loss.tone, loss.word, loss.amountText, loss.hundredths],
    ["loss", "YOU LOST", "−0.50", 50],
  );
  assert.equal(loss.amountText.codePointAt(0), 0x2212);
  assert.deepEqual(
    [even.tone, even.word, even.amountText],
    ["even", "BROKE EVEN", "0.00"],
  );
  assert.equal(win.announcement, "Turn 1: you won 1.00 Yap Coins.");
  assert.equal(loss.announcement, "Turn 2: you lost 0.50 Yap Coins.");
  assert.equal(even.announcement, "Turn 3: you broke even.");
});

it("cuts results to the hundredth and treats less than 0.01 YC as even", () => {
  assert.equal(resultTone("99"), "even");
  assert.equal(resultTone("-99"), "even");
  assert.equal(resultTone("0"), "even");
  assert.equal(resultTone("100"), "win");
  assert.equal(resultTone("-100"), "loss");
  // 1.2399 YC shows 1.23, never rounded up.
  const rounds = [round(1, { net: 1.2399 })];
  assert.equal(turnResult(rounds[0], rounds).amountText, "+1.23");
  assert.equal(amountText("loss", 123_456), "−1,234.56");
  assert.equal(formatFixedHundredths(5), "0.05");
  assert.equal(formatFixedHundredths(-3), "0.00");
});

it("counts wins in a row back from a turn; a loss ends the run, the rest don't", () => {
  const unfilled = round(4, { net: 0 });
  unfilled.outcome = { ...unfilled.outcome, executed: false };
  const rounds = [
    round(1, { net: 1 }),
    round(2, { net: -1 }),
    round(3, { net: 1 }),
    unfilled, // an unfilled order is skipped
    round(5, { net: 0 }), // breaking even neither adds nor ends
    round(6, { state: "void" }), // a void window is skipped
    round(7, { own: null }), // a turn the viewer didn't answer is skipped
    round(8, { net: 2 }),
    round(9), // still locked
    round(10, { net: 0.5 }),
  ];
  assert.equal(winStreak(rounds, 1), 1);
  assert.equal(winStreak(rounds, 2), 0);
  assert.equal(winStreak(rounds, 3), 1);
  assert.equal(winStreak(rounds, 5), 1);
  assert.equal(winStreak(rounds, 8), 2);
  assert.equal(winStreak(rounds, 10), 3);
  const last = turnResult(rounds[9], rounds);
  assert.equal(last.streakText, "3 WINS IN A ROW");
  assert.equal(
    last.announcement,
    "Turn 10: you won 0.50 Yap Coins, 3 wins in a row.",
  );
  // A loss or an even result has no run of its own.
  assert.equal(turnResult(rounds[1], rounds).streak, 0);
  assert.equal(turnResult(rounds[4], rounds).streak, 0);
  assert.equal(turnResult(rounds[4], rounds).streakText, null);
});

it("bursts 16 bits for a win, drops 7 shards for a loss and stays still when even", () => {
  const win = burstBits("win");
  assert.equal(win.length, 16);
  assert.deepEqual(
    win.slice(0, 4).map((bit) => bit.angle),
    [-5, 29.5, 40, 74.5],
  );
  assert.deepEqual(win[1], {
    angle: 29.5,
    near: true,
    drop: false,
    small: false,
    alt: true,
    delayMs: 140,
  });
  assert.equal(win.filter((bit) => bit.small).length, 6);
  const loss = burstBits("loss");
  assert.deepEqual(
    loss.map((bit) => bit.angle),
    [150, 160, 170, 180, 190, 200, 210],
  );
  assert.ok(loss.every((bit) => bit.drop && !bit.near));
  assert.deepEqual(
    loss.map((bit) => bit.delayMs),
    [380, 410, 440, 470, 500, 530, 560],
  );
  assert.deepEqual(burstBits("even"), []);
});

it("counts up after the pop with an ease-out cubic and stops on the figure", () => {
  assert.equal(PLATE_MS, 3600);
  assert.equal(countedHundredths(100, 0), 0);
  assert.equal(countedHundredths(100, COUNT_DELAY_MS), 0);
  // Halfway through, an ease-out cubic is seven eighths of the way.
  assert.equal(countedHundredths(100, COUNT_DELAY_MS + COUNT_MS / 2), 88);
  assert.equal(countedHundredths(100, COUNT_DELAY_MS + COUNT_MS), 100);
  assert.equal(countedHundredths(100, 10_000), 100);
});
