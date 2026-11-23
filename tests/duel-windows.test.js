import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COIN_DEBATE_FACE,
  COIN_DEBATE_TERMS,
  COIN_DUEL_TERMS,
  settleDuelWindow,
} from "../dist/features/account-wallet/debate-sandbox.js";
import { DUEL_TERMS } from "../dist/features/duels/engine.js";

// Decision 0017: how a live duel window settles before the ledger posts it.
const ticket = (participant, side, limit, quantity) => ({
  participant,
  kind: "human",
  side,
  limit,
  quantity,
});
const example = [
  ticket("A", "YES", "0.60", 10),
  ticket("B", "YES", "0.70", 20),
  ticket("C", "YES", "0.55", 10),
  ticket("D", "NO", "0.66", 10),
  ticket("E", "NO", "0.50", 40),
  ticket("F", "YES", "0.75", 10),
];
const stake = (o) => String(BigInt(o.quantity) * COIN_DEBATE_FACE);

describe("forecast duel windows", () => {
  it("use the duel rule with ten viewers and the A4 face value", () => {
    assert.deepEqual(COIN_DUEL_TERMS, { ...DUEL_TERMS, minViewers: 10 });
    assert.equal(COIN_DUEL_TERMS.rule, "fd-v1");
    assert.equal(COIN_DEBATE_TERMS.rule, "a4-v1");
    assert.ok(Object.isFrozen(COIN_DUEL_TERMS));
  });

  it("settle every ticket by duels with enough viewers present", () => {
    const { outcomes, duels, pricing } = settleDuelWindow(
      example,
      [],
      COIN_DUEL_TERMS,
      10,
    );
    assert.deepEqual(
      outcomes.map((o) => o.net),
      ["31325", "50150", "25075", "43375", "-162500", "12575"],
    );
    // The whole stake is committed; nothing is charged as a fee.
    for (const [i, o] of outcomes.entries()) {
      assert.equal(o.premium, stake(example[i]));
      assert.equal(o.fee, "0");
      assert.equal(o.status, "settled");
      assert.equal(o.executed, true);
      assert.equal(BigInt(o.payout), BigInt(o.premium) + BigInt(o.net));
    }
    assert.deepEqual(
      outcomes.map((o) => o.duelsWon),
      [3, 3, 4, 3, 0, 2],
    );
    assert.deepEqual(duels, {
      rule: "fd-v1",
      status: "settled",
      viewers: 10,
      tickets: 6,
      share: { n: "2", d: "3" },
      crowd: { n: "63", d: "100" },
      verdict: "YES",
    });
    // The share also travels where the turn bars and lists read it.
    assert.deepEqual(pricing, {
      a: null,
      b: null,
      share: { n: "2", d: "3" },
      price: null,
      branch: "duels",
      reason: "settled",
    });
  });

  it("return every stake and publish no share with too few viewers", () => {
    const { outcomes, duels, pricing } = settleDuelWindow(
      example,
      [],
      COIN_DUEL_TERMS,
      9,
    );
    for (const [i, o] of outcomes.entries()) {
      assert.equal(o.status, "returned_few_viewers");
      assert.equal(o.premium, "0");
      assert.equal(o.net, "0");
      assert.equal(o.payout, stake(example[i]));
    }
    assert.equal(duels.status, "returned_few_viewers");
    assert.equal(duels.viewers, 9);
    assert.equal(duels.share, null);
    assert.equal(duels.crowd, null);
    assert.equal(duels.verdict, null);
    assert.equal(pricing.share, null);
    assert.equal(pricing.reason, "returned_few_viewers");
  });

  it("return every stake below the rule's minimum room, however many watch", () => {
    const { outcomes, duels } = settleDuelWindow(
      example.slice(0, 4),
      [],
      COIN_DUEL_TERMS,
      500,
    );
    assert.equal(duels.status, "returned_small_room");
    assert.equal(duels.tickets, 4);
    for (const o of outcomes) {
      assert.equal(o.status, "returned_small_room");
      assert.equal(o.premium, "0");
      assert.equal(o.net, "0");
    }
  });

  it("refund orders past capacity without changing anyone else's result", () => {
    const late = [ticket("G", "NO", "0.10", 100)];
    const { outcomes } = settleDuelWindow(example, late, COIN_DUEL_TERMS, 12);
    assert.equal(outcomes.length, 7);
    assert.deepEqual(outcomes[6], {
      participant: "G",
      status: "returned_over_capacity",
      executed: false,
      premium: "0",
      fee: "0",
      payout: "1000000",
      net: "0",
      duelsWon: 0,
      duelsLost: 0,
    });
    assert.deepEqual(
      outcomes.slice(0, 6).map((o) => o.net),
      settleDuelWindow(example, [], COIN_DUEL_TERMS, 12).outcomes.map(
        (o) => o.net,
      ),
    );
  });
});
