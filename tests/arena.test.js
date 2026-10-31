import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlaybackPresence } from "../dist/features/community/presence.js";
import { readTimeline } from "../dist/features/a4/timeline.js";
import {
  sharePercent,
  chartPoints,
  nearestRound,
  roundProgress,
  chartBadges,
} from "../public/arena-chart.js";
import { roundPrices, priceText } from "../public/arena-price.js";
import { runConfig } from "../dist/features/a4/repository.js";

describe("settlement dashboard boundaries", () => {
  it("keeps dynamic YES/NO badges readable at crossing, extreme and empty rounds", () => {
    for (const n of [0, 1, 49, 50, 51, 99, 100]) {
      const badges = chartBadges({ n: String(n), d: "100" });
      assert.equal(badges[0].value, n);
      assert.equal(badges[1].value, 100 - n);
      assert.ok(Math.abs(badges[0].y - badges[1].y) >= 32);
      assert.ok(badges.every((b) => b.y >= 30 && b.y <= 266));
      if (n > 50) assert.ok(badges[0].y < badges[1].y);
      if (n < 50) assert.ok(badges[0].y > badges[1].y);
    }
    assert.ok(chartBadges(null).every((b) => b.value === null));
  });
  it("derives the countdown from round timestamps and clamps before opening and after cutoff", () => {
    const opens = "2026-10-16T04:00:00Z",
      closes = "2026-10-16T04:01:00Z";
    assert.deepEqual(
      roundProgress(opens, closes, Date.parse("2026-10-16T04:00:30Z")),
      { percent: 50, seconds: 30 },
    );
    assert.equal(
      roundProgress(opens, closes, Date.parse(opens) - 1000).percent,
      100,
    );
    assert.deepEqual(roundProgress(opens, closes, Date.parse(closes) + 1000), {
      percent: 0,
      seconds: 0,
    });
    assert.deepEqual(roundProgress(closes, opens), { percent: 0, seconds: 0 });
    assert.deepEqual(roundProgress("", ""), { percent: 0, seconds: 0 });
  });
  it("inspects the nearest round and preserves distinct medians, offers, shares and own YES-scale limits", () => {
    const points = chartPoints([
      { share: { n: "1", d: "4" } },
      { share: { n: "3", d: "4" } },
    ]);
    assert.equal(nearestRound(points, 10), points[0]);
    assert.equal(nearestRound(points, 700), points[1]);
    assert.equal(nearestRound(points, NaN), null);
    assert.equal(nearestRound([], 0), null);
    const result = roundPrices({
      medianNo: { n: "1", d: "5" },
      medianYes: { n: "2", d: "5" },
      offer: { n: "3", d: "10" },
      share: { n: "1", d: "4" },
      ownLimit: "0.2905",
    });
    const { ownLimit, ...values } = result;
    assert.ok(Math.abs(ownLimit - 29.05) < 1e-10);
    assert.deepEqual(values, {
      a: 20,
      b: 40,
      offer: 30,
      noOffer: 70,
      share: 25,
      interval: true,
    });
    assert.equal(priceText(result.offer), "0.30 YC");
    assert.equal(priceText(null), "—");
    assert.equal(
      roundPrices({
        medianNo: { n: "4", d: "5" },
        medianYes: { n: "1", d: "5" },
      }).interval,
      false,
    );
    assert.equal(
      roundPrices({
        medianNo: { n: "1", d: "5" },
        medianYes: { n: "1", d: "5" },
      }).interval,
      false,
    );
    const empty = roundPrices(null);
    assert.equal(empty.offer, null);
    assert.equal(empty.ownLimit, null);
    assert.equal(empty.interval, false);
    assert.equal(roundPrices({ ownLimit: "1.5" }).ownLimit, null);
  });
  it("accepts short argument labels as metadata and rejects empty, multiline and oversized labels", () => {
    assert.equal(
      runConfig({ argumentLabel: "  Cost analysis  " }).argumentLabel,
      "Cost analysis",
    );
    assert.equal(runConfig().argumentLabel, undefined);
    for (const argumentLabel of [
      "",
      "  ",
      "x".repeat(81),
      "one\ntwo",
      "a\u0000b",
      1,
      null,
    ])
      assert.throws(() => runConfig({ argumentLabel }), /argument label/);
  });
  it("represents exact shares, empty rounds and a single settled result without fake points", () => {
    assert.equal(sharePercent({ n: "1", d: "4" }), 25);
    assert.equal(sharePercent({ n: "0", d: "3" }), 0);
    assert.equal(sharePercent({ n: "3", d: "3" }), 100);
    for (const invalid of [
      null,
      {},
      { n: "4", d: "3" },
      { n: "1", d: "0" },
      { n: "-1", d: "2" },
    ])
      assert.equal(sharePercent(invalid), null);
    assert.deepEqual(chartPoints([]), []);
    assert.equal(chartPoints([{ share: null }])[0].yes, null);
    assert.equal(chartPoints([{ share: { n: "1", d: "2" } }])[0].x, 349);
    const result = chartPoints([
      { share: { n: "1", d: "4" } },
      { share: null },
      { share: { n: "3", d: "4" } },
    ]);
    assert.deepEqual(
      result.map((p) => p.yes),
      [25, null, 75],
    );
    assert.deepEqual(
      result.map((p) => p.x),
      [46, 349, 652],
    );
  });
  it("rejects unpublished debates and bounds totals to the latest 100 finalized results", async () => {
    await assert.rejects(
      readTimeline(
        { query: async () => ({ rowCount: 0 }) },
        "1",
        "debate",
        "human",
      ),
      /debate not found/,
    );
    const calls = [];
    const client = {
      async query(sql, values) {
        calls.push([sql, values]);
        return calls.length === 1
          ? { rowCount: 1 }
          : {
              rows: Array.from({ length: 101 }, (_, i) => ({
                id: String(i),
                number: 101 - i,
                premium: "1000000",
                humans: 1,
                bots: 2,
                executed: 3,
              })),
            };
      },
    };
    const result = await readTimeline(client, "1", "debate", "sandbox");
    assert.equal(result.items.length, 100);
    assert.equal(result.hasMore, true);
    assert.equal(result.items[0].number, 2);
    assert.equal(result.items.at(-1).number, 101);
    assert.deepEqual(result.totals, {
      premium: "100000000",
      humanCommitments: 100,
      botCommitments: 200,
      executed: 300,
    });
    assert.deepEqual(calls[1][1], ["debate", "1", "sandbox"]);
    assert.match(calls[1][0], /r.state='settled'/);
    assert.match(calls[1][0], /s.reveal_at<=clock_timestamp\(\)/);
    assert.match(calls[1][0], /s.creator_id=\$2/);
  });
  it("returns an empty timeline without inventing participation or volume", async () => {
    let reads = 0;
    const result = await readTimeline(
      {
        async query() {
          return ++reads === 1 ? { rowCount: 1 } : { rows: [] };
        },
      },
      "1",
      "debate",
      "human",
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.hasMore, false);
    assert.equal(result.totals.premium, "0");
  });
});

describe("ephemeral playback presence", () => {
  it("counts active connections per event, deduplicates heartbeats, removes paused tabs and expires abandoned playback", () => {
    let now = 0;
    const presence = createPlaybackPresence({ now: () => now, ttl: 1000 });
    assert.equal(presence.heartbeat("a", "one", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "one", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "two", true).activePlaybackTabs, 2);
    assert.equal(presence.heartbeat("b", "one", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "one", false).activePlaybackTabs, 1);
    now = 1000;
    assert.equal(presence.heartbeat("a", "three", false).activePlaybackTabs, 0);
    assert.equal(presence.heartbeat("b", "three", false).activePlaybackTabs, 0);
  });
  it("bounds memory while refreshing existing connections at capacity", () => {
    const presence = createPlaybackPresence({ maximum: 1 });
    assert.equal(presence.heartbeat("a", "one", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "two", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "one", true).activePlaybackTabs, 1);
    assert.equal(presence.heartbeat("a", "one", false).activePlaybackTabs, 0);
  });
});
