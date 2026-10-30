import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatCoins } from "../public/lib/coin-format.js";
import {
  claimWelcome,
  features,
  held,
  readCoins,
  spendable,
} from "../public/lib/coins.js";

// One source for an account's Yap Coins balance (frontend/lib/coins.ts). The
// header button, its pop-up, the /coins card and the debate panel all show
// spendable() and held() of the same coin sandbox summary.
const balances = (overrides = {}) => ({
  cashAvailable: "0",
  reserved: "0",
  pending: "0",
  promotionalPrincipal: "0",
  promotionalReserved: "0",
  ...overrides,
});
const summary = (overrides = {}) => ({
  sessionId: "41",
  initialized: false,
  financialReviewRequired: false,
  balances: balances(),
  ...overrides,
});

describe("the Yap Coins balance", () => {
  it("counts cash and grant principal, and what open positions hold", () => {
    // After a 10-contract stake funded by the welcome grant.
    const value = balances({
      promotionalPrincipal: "24000000",
      promotionalReserved: "1000000",
    });
    assert.equal(formatCoins(spendable(value)), "2,400 YC");
    assert.equal(formatCoins(held(value)), "100 YC");
    // After a reveal that paid 0.40 YC of profit as cash.
    const revealed = balances({
      cashAvailable: "4000",
      promotionalPrincipal: "25000000",
    });
    assert.equal(formatCoins(spendable(revealed)), "2,500.40 YC");
    assert.equal(formatCoins(held(revealed)), "0 YC");
  });

  it("treats servers without a feature report as offering every flow", () => {
    assert.deepEqual(features(summary()), {
      transfers: true,
      manualRounds: true,
    });
    assert.deepEqual(
      features(
        summary({ features: { transfers: false, manualRounds: false } }),
      ),
      { transfers: false, manualRounds: false },
    );
  });
});

describe("the welcome grant claim", () => {
  let requests, events, responses;
  beforeEach(() => {
    requests = [];
    events = [];
    responses = [];
    globalThis.location = { origin: "https://arena.example" };
    globalThis.window = {
      dispatchEvent: (event) => events.push(event.type),
    };
    globalThis.fetch = async (path, init) => {
      requests.push({
        path,
        method: init.method ?? "GET",
        session: new Headers(init.headers).get("X-YapArena-Session"),
      });
      const [status, body] = responses.shift();
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  });
  afterEach(() => {
    delete globalThis.fetch;
    delete globalThis.window;
    delete globalThis.location;
  });

  it("claims 2,500 YC for a new account, so the header never shows 0", async () => {
    const after = summary({
      initialized: true,
      balances: balances({ promotionalPrincipal: "25000000" }),
    });
    responses.push([200, { created: true }], [200, after]);
    const next = await claimWelcome(summary());
    assert.deepEqual(
      requests.map(({ path, method, session }) => [path, method, session]),
      [
        ["/api/coin-sandbox/initialize", "POST", "41"],
        ["/api/coin-sandbox/summary", "GET", null],
      ],
    );
    assert.equal(formatCoins(spendable(next.balances)), "2,500 YC");
    assert.deepEqual(events, ["yap:coins-changed"]);
  });

  it("asks nothing once claimed or while a correction review pauses coins", async () => {
    for (const value of [
      summary({ initialized: true }),
      summary({ financialReviewRequired: true }),
    ])
      assert.equal(await claimWelcome(value), value);
    assert.deepEqual(requests, []);
    assert.deepEqual(events, []);
  });

  it("reads signed-out and Yap-Coins-off sites apart from failures", async () => {
    responses.push(
      [401, { error: "sign in again" }],
      [404, { error: "resource not found" }],
      [200, summary()],
      [500, { error: "internal server error" }],
    );
    assert.deepEqual(await readCoins(), { state: "signed-out" });
    assert.deepEqual(await readCoins(), { state: "absent" });
    assert.equal((await readCoins()).state, "ready");
    await assert.rejects(readCoins(), { status: 500 });
  });
});
