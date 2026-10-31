import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCoins,
  formatHundredths,
  formatPrice,
  formatSignedCoins,
} from "../public/lib/coin-format.js";

// One Yap Coins formatter for the header, /coins, the debate panel and the
// results notice: 10,000 atomic units per coin, up to two decimals,
// thousands separators and the "−" minus sign.
describe("Yap Coins formatting", () => {
  it("formats balances with separators and at most two decimals", () => {
    assert.equal(formatCoins("0"), "0 YC");
    assert.equal(formatCoins("25000000"), "2,500 YC");
    assert.equal(formatCoins(5400n), "0.54 YC");
    assert.equal(formatCoins("12345000"), "1,234.50 YC");
    assert.equal(formatCoins("1000000000000"), "100,000,000 YC");
    assert.equal(formatCoins("-30000"), "−3 YC");
    // Cut, never rounded up: a balance never shows more than it holds.
    assert.equal(formatCoins("9999"), "0.99 YC");
    assert.equal(formatCoins("25009999"), "2,500.99 YC");
  });
  it("says so when an amount is under 0.01 YC", () => {
    assert.equal(formatCoins("1"), "under 0.01 YC");
    assert.equal(formatCoins("99"), "under 0.01 YC");
    assert.equal(formatCoins("100"), "0.01 YC");
  });
  it("signs results and names results that round to zero", () => {
    assert.equal(formatSignedCoins("34000"), "+3.40 YC");
    assert.equal(formatSignedCoins("-4000"), "−0.40 YC");
    assert.equal(formatSignedCoins("-25000000"), "−2,500 YC");
    assert.equal(formatSignedCoins("0"), "no gain or loss");
    assert.equal(formatSignedCoins("50"), "a gain under 0.01 YC");
    assert.equal(formatSignedCoins(-50n), "a loss under 0.01 YC");
  });
  it("shows prices per contract as Yap Coins, never cents", () => {
    assert.equal(formatPrice(54), "0.54 YC");
    assert.equal(formatPrice(5), "0.05 YC");
    assert.equal(formatPrice(100), "1.00 YC");
    assert.equal(formatHundredths(540), "5.40 YC");
    assert.equal(formatHundredths(1000), "10 YC");
  });
});
