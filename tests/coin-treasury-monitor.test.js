import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMetrics } from "../dist/platform/metrics.js";
import {
  createTreasuryMonitor,
  treasuryStatus,
} from "../dist/features/account-wallet/treasury-monitor.js";

// Founder D1: the operator seeds the valueless center and promotional
// treasuries; the worker warns and /metrics flags one that runs low.
const seeded = "1000000000000"; // 1,000,000 USDC-equivalent
describe("Yap Coins treasury monitoring", () => {
  it("reports each treasury's whole USDC-equivalent and whether it is low", () => {
    assert.deepEqual(
      treasuryStatus(
        { centerAvailable: seeded, promotionalAvailable: "199999999999" },
        200_000,
      ),
      [
        { account: "center", availableUsdc: 1_000_000, low: false },
        { account: "promotional", availableUsdc: 199_999, low: true },
      ],
    );
    assert.deepEqual(
      treasuryStatus({ centerAvailable: "0", promotionalAvailable: "0" }, 0),
      [
        { account: "center", availableUsdc: 0, low: false },
        { account: "promotional", availableUsdc: 0, low: false },
      ],
    );
  });

  it("warns once per low treasury per check, with no identifiers", async () => {
    const warnings = [];
    const monitor = createTreasuryMonitor({
      read: async () => ({
        centerAvailable: "5",
        promotionalAvailable: seeded,
      }),
      thresholdUsdc: 200_000,
      logger: { warn: (details, message) => warnings.push([details, message]) },
    });
    await monitor.check();
    assert.deepEqual(warnings, [
      [
        { account: "center", availableUsdc: 0, thresholdUsdc: 200_000 },
        "coin treasury low",
      ],
    ]);
  });

  it("exports the balances and low flags on /metrics, and nothing stale after a failed read", async () => {
    const metrics = createMetrics();
    let fail = false;
    metrics.setCoinTreasuryProvider(async () => {
      if (fail) throw new Error("database unavailable");
      return treasuryStatus(
        { centerAvailable: "100000000000", promotionalAvailable: seeded },
        200_000,
      );
    });
    const scrape = async () => {
      let body = "";
      await metrics.handler(
        {},
        {
          type() {
            return this;
          },
          send(value) {
            body = value;
          },
        },
      );
      return body;
    };
    const output = await scrape();
    assert.match(
      output,
      /yaparena_coin_treasury_available_usdc\{account="center"\} 100000/,
    );
    assert.match(output, /yaparena_coin_treasury_low\{account="center"\} 1/);
    assert.match(
      output,
      /yaparena_coin_treasury_low\{account="promotional"\} 0/,
    );
    // A new provider refreshes at once; a failed read clears the gauges.
    fail = true;
    metrics.setCoinTreasuryProvider(async () => {
      throw new Error("database unavailable");
    });
    assert.doesNotMatch(await scrape(), /account="center"/);
  });
});
