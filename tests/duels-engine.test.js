import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DUEL_RULE,
  DUEL_TERMS,
  settleWindow,
  validateDuelTerms,
} from "../dist/features/duels/engine.js";

const FACE = 10_000n;
// Rooms settled by an independent exact implementation of the rule (Decision 0017).
const vectors = JSON.parse(
  readFileSync(new URL("./fd-v1-vectors.json", import.meta.url), "utf8"),
);
const ticket = (participant, side, limit, quantity) => ({
  participant,
  kind: "human",
  side,
  limit,
  quantity,
});
const random = (seed) => () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
function room(next, n) {
  return Array.from({ length: n }, (_, i) =>
    ticket(
      `p${String(i).padStart(4, "0")}`,
      next() < 0.5 ? "YES" : "NO",
      (Math.floor(next() * 1_000_001) / 1e6).toFixed(6),
      1 + Math.floor(next() * 100),
    ),
  );
}
const flip = (o) => ({ ...o, side: o.side === "YES" ? "NO" : "YES" });

test("matches the independent exact reference on every fixed vector", () => {
  assert.equal(vectors.length, 33);
  for (const vector of vectors) {
    const result = settleWindow(vector.orders, DUEL_TERMS, FACE);
    const got = (pick) => result.outcomes.map(pick);
    assert.deepEqual(
      got((o) => o.payout),
      vector.payouts,
      vector.name,
    );
    assert.deepEqual(
      got((o) => o.status),
      vector.status,
      vector.name,
    );
    assert.deepEqual(
      got((o) => o.duelsWon),
      vector.won,
      vector.name,
    );
    assert.equal(result.dust, vector.dust, vector.name);
  }
});

test("pays out exactly the stakes and never takes more than a stake", () => {
  const next = random(7);
  for (let round = 0; round < 300; round++) {
    const orders = room(next, 5 + Math.floor(next() * 60));
    const { outcomes, dust } = settleWindow(orders, DUEL_TERMS, FACE);
    const staked = outcomes.reduce((a, o) => a + BigInt(o.stake), 0n);
    const paid = outcomes.reduce((a, o) => a + BigInt(o.payout), 0n);
    assert.equal(paid + BigInt(dust), staked);
    assert.ok(BigInt(dust) >= 0n && BigInt(dust) < BigInt(orders.length));
    for (const o of outcomes) {
      assert.ok(BigInt(o.payout) >= 0n);
      // A read result is always smaller than the stake, as a gain too.
      assert.ok(BigInt(o.payout) < 2n * BigInt(o.stake));
      assert.equal(BigInt(o.net), BigInt(o.payout) - BigInt(o.stake));
    }
  }
});

test("a ticket's own side never changes its own result", () => {
  const next = random(13);
  for (let round = 0; round < 200; round++) {
    const orders = room(next, 5 + Math.floor(next() * 30));
    const before = settleWindow(orders, DUEL_TERMS, FACE).outcomes[0];
    const after = settleWindow(
      [flip(orders[0]), ...orders.slice(1)],
      DUEL_TERMS,
      FACE,
    ).outcomes[0];
    assert.deepEqual(after.readExact, before.readExact);
    assert.equal(after.payout, before.payout);
    assert.equal(after.duelsWon, before.duelsWon);
  }
});

test("read results sum to exactly zero before rounding", () => {
  const next = random(19);
  for (let round = 0; round < 100; round++) {
    const orders = room(next, 5 + Math.floor(next() * 40));
    let n = 0n,
      d = 1n;
    for (const o of settleWindow(orders, DUEL_TERMS, FACE).outcomes) {
      n = n * BigInt(o.readExact.d) + BigInt(o.readExact.n) * d;
      d *= BigInt(o.readExact.d);
    }
    assert.equal(n, 0n);
  }
});

test("does not depend on the order of the tickets", () => {
  const next = random(11);
  for (let round = 0; round < 60; round++) {
    const orders = room(next, 5 + Math.floor(next() * 40));
    const forward = new Map(
      settleWindow(orders, DUEL_TERMS, FACE).outcomes.map((o) => [
        o.participant,
        o.payout,
      ]),
    );
    for (const o of settleWindow([...orders].reverse(), DUEL_TERMS, FACE)
      .outcomes)
      assert.equal(o.payout, forward.get(o.participant));
  }
});

test("closer reads win, and identical tickets get identical payouts", () => {
  // Three YES and three NO, so every ticket's duels are scored on a share near one half.
  const reads = ["0.5", "0.9", "0.5", "0.1", "0.5", "0.5"];
  const orders = reads.map((read, i) =>
    ticket(`p${i}`, i % 2 ? "NO" : "YES", read, 10),
  );
  const { outcomes } = settleWindow(orders, DUEL_TERMS, FACE);
  assert.ok(BigInt(outcomes[1].net) < 0n && BigInt(outcomes[3].net) < 0n);
  assert.ok(BigInt(outcomes[0].net) > 0n);
  assert.equal(outcomes[0].payout, outcomes[2].payout); // same side, same read, same size
  assert.equal(outcomes[3].duelsWon, 0); // the read of 10% is further in every one of its duels
  // Equally close reads tie their duel: neither counts a win or a loss for it.
  // Ticket 0 ties the three other reads of 50% and beats the two far ones.
  assert.equal(outcomes[0].duelsWon, 2);
  assert.equal(outcomes[0].duelsLost, 0);
});

test("settles the worked example of the decision record", () => {
  const orders = [
    ticket("A", "YES", "0.60", 10),
    ticket("B", "YES", "0.70", 20),
    ticket("C", "YES", "0.55", 10),
    ticket("D", "NO", "0.66", 10),
    ticket("E", "NO", "0.50", 40),
    ticket("F", "YES", "0.75", 10),
  ];
  const { summary, outcomes, dust } = settleWindow(orders, DUEL_TERMS, FACE);
  assert.deepEqual(
    outcomes.map((o) => o.net),
    ["31325", "50150", "25075", "43375", "-162500", "12575"],
  );
  assert.deepEqual(
    outcomes.map((o) => [o.duelsWon, o.duelsLost]),
    [
      [3, 2],
      [3, 2],
      [4, 1],
      [3, 2],
      [0, 5],
      [2, 3],
    ],
  );
  assert.equal(dust, "0");
  assert.deepEqual(summary, {
    rule: DUEL_RULE,
    tickets: 6,
    share: { n: "2", d: "3" },
    crowd: { n: "63", d: "100" },
    verdict: "YES",
    status: "settled",
  });
  // Each ticket's view of the others: a YES ticket sees 3 of 5, a NO ticket 4 of 5.
  assert.deepEqual(outcomes[0].othersShare, { n: "3", d: "5" });
  assert.deepEqual(outcomes[3].othersShare, { n: "4", d: "5" });
});

test("the verdict compares the share with the median read and names no winner", () => {
  const five = (side, read) =>
    Array.from({ length: 5 }, (_, i) =>
      ticket(`p${i}`, i < 2 ? side : flip({ side }).side, read, 10),
    );
  // Two YES of five: a share of 40%.
  assert.equal(
    settleWindow(five("YES", "0.6"), DUEL_TERMS, FACE).summary.verdict,
    "NO",
  );
  assert.equal(
    settleWindow(five("YES", "0.4"), DUEL_TERMS, FACE).summary.verdict,
    "EVEN",
  );
  assert.equal(
    settleWindow(five("YES", "0.2"), DUEL_TERMS, FACE).summary.verdict,
    "YES",
  );
});

test("returns every stake below the minimum room", () => {
  const orders = [
    ticket("a", "YES", "0.6", 10),
    ticket("b", "NO", "0.4", 20),
    ticket("c", "YES", "0.7", 5),
    ticket("d", "NO", "0.2", 1),
  ];
  const { outcomes, summary, dust } = settleWindow(orders, DUEL_TERMS, FACE);
  assert.equal(summary.status, "returned_small_room");
  assert.equal(dust, "0");
  for (const o of outcomes) {
    assert.equal(o.status, "returned_small_room");
    assert.equal(o.net, "0");
    assert.equal(o.payout, o.stake);
    assert.equal(o.duelsWon + o.duelsLost, 0);
  }
  // The minimum is a term of the round: a larger one returns a larger room.
  const nine = room(random(37), 9);
  const stricter = settleWindow(nine, { ...DUEL_TERMS, minTickets: 10 }, FACE);
  assert.equal(stricter.summary.status, "returned_small_room");
  assert.equal(settleWindow(nine, DUEL_TERMS, FACE).summary.status, "settled");
});

test("an empty window and a single ticket settle to nothing", () => {
  const empty = settleWindow([], DUEL_TERMS, FACE);
  assert.deepEqual(empty.outcomes, []);
  assert.equal(empty.summary.share, null);
  assert.equal(empty.summary.crowd, null);
  assert.equal(empty.summary.verdict, null);
  assert.equal(empty.summary.status, "returned_small_room");
  const alone = settleWindow([ticket("a", "YES", "0.6", 3)], DUEL_TERMS, FACE);
  assert.equal(alone.outcomes[0].payout, "30000");
  assert.equal(alone.outcomes[0].othersShare, null);
});

test("a room with everyone on one side still settles its reads", () => {
  const orders = ["0.9", "0.8", "0.99", "0.5", "0.95"].map((read, i) =>
    ticket(`p${i}`, "YES", read, 10),
  );
  const { outcomes, summary } = settleWindow(orders, DUEL_TERMS, FACE);
  assert.equal(summary.status, "settled");
  assert.deepEqual(summary.share, { n: "1", d: "1" });
  assert.ok(BigInt(outcomes[2].net) > 0n); // closest read to 100%
  assert.ok(BigInt(outcomes[3].net) < 0n); // furthest read
  assert.equal(outcomes[2].duelsWon, 4);
  assert.equal(outcomes[3].duelsLost, 4);
});

test("a duel's gap counts only up to the cap", () => {
  // Four NO tickets read 10% and one YES ticket reads far too high. Each of
  // its duels is scored on a share of 0% and is beyond the cap, so its loss is
  // the same however far its read is, and stays below its stake.
  const at = (read) =>
    settleWindow(
      [
        ...[0, 1, 2, 3].map((i) => ticket(`p${i}`, "NO", "0.1", 10)),
        ticket("far", "YES", read, 10),
      ],
      DUEL_TERMS,
      FACE,
    ).outcomes[4];
  assert.equal(at("0.99").net, at("0.6").net);
  assert.equal(at("0.99").net, "-80000"); // 12.5 x 10 YC x (40 / 50) x 0.08
  assert.equal(at("0.99").duelsLost, 4);
});

test("settles a full-capacity room quickly", () => {
  const orders = room(random(29), 1001);
  const started = performance.now();
  const { outcomes } = settleWindow(orders, DUEL_TERMS, FACE);
  assert.equal(outcomes.length, 1001);
  assert.ok(performance.now() - started < 5000);
});

test("rejects malformed rooms and terms", () => {
  const ok = room(random(31), 6);
  assert.throws(
    () => settleWindow([...ok, ok[0]], DUEL_TERMS, FACE),
    /invalid locked population/,
  );
  assert.throws(
    () => settleWindow(ok, { ...DUEL_TERMS, capacity: 5 }, FACE),
    /invalid locked population/,
  );
  assert.throws(
    () => settleWindow(ok, DUEL_TERMS, 0n),
    /invalid locked population/,
  );
  for (const bad of [
    { quantity: 101 },
    { quantity: 0 },
    { quantity: 1.5 },
    { side: "MAYBE" },
    { participant: "" },
  ])
    assert.throws(
      () =>
        settleWindow([{ ...ok[0], ...bad }, ...ok.slice(1)], DUEL_TERMS, FACE),
      /invalid submission/,
    );
  assert.throws(
    () =>
      settleWindow(
        [{ ...ok[0], limit: "1.5" }, ...ok.slice(1)],
        DUEL_TERMS,
        FACE,
      ),
    /price must be a decimal/,
  );
  for (const bad of [
    { rule: "a4-v1" },
    { leverageMilli: 500 },
    { leverageMilli: 12.5 },
    { minTickets: 2 },
    { maxQuantity: 101 },
    { capacity: 0 },
  ])
    assert.throws(
      () => validateDuelTerms({ ...DUEL_TERMS, ...bad }),
      /unsupported duel terms/,
    );
  assert.doesNotThrow(() => validateDuelTerms(DUEL_TERMS));
});
