import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ceilingCents,
  ceilingText,
  clock,
  coins,
  lastPosition,
  liveWindow,
  parseCeiling,
  parseDefaults,
  parseSize,
  percent,
  positionStatus,
  readFromLimit,
  reasonText,
  repeatLabel,
  replayRound,
  replayWindow,
  resultLine,
  resultsHeading,
  resultsSummary,
  secondsLeft,
  signedCoins,
  speakerLine,
  ticketTerms,
} from "../public/stake-model.js";

const at = (seconds) => new Date(Date.UTC(2026, 9, 26, 18, 0, seconds));
const iso = (seconds) => at(seconds).toISOString();
const window = (turnNumber, opens, closes, state = "open") => ({
  id: `w${turnNumber}`,
  turnNumber,
  side: turnNumber % 2 ? "A" : "B",
  opensAt: iso(opens),
  closesAt: iso(closes),
  state,
  voidReason: null,
  revealMode: "five_day",
  revealAt: null,
});
const round = (overrides = {}) => ({
  id: "r1",
  kind: "turn",
  turnNumber: 2,
  side: "B",
  state: "open",
  voidReason: null,
  opensAt: iso(0),
  closesAt: iso(60),
  revealMode: "five_day",
  revealAt: null,
  participants: 3,
  eligibility: { canTakePosition: true, reason: null, via: "live" },
  recording: null,
  own: null,
  ...overrides,
});

describe("betting panel terms (Decision 0013)", () => {
  it("maps the read of the yes share to each side's maximum price", () => {
    assert.equal(ceilingCents("YES", 62), 62);
    assert.equal(ceilingCents("NO", 62), 38);
    // The read stays inside 1–99 %, so no price is free or certain.
    assert.equal(ceilingCents("YES", 0), 1);
    assert.equal(ceilingCents("NO", 100), 1);
    assert.equal(ceilingCents("YES", 61.6), 62);
    assert.equal(ceilingText(62), "0.62");
    assert.equal(ceilingText(5), "0.05");
  });

  it("shows the reserved amount and the most a position can lose", () => {
    assert.deepEqual(ticketTerms(10, 62), {
      reserved: "10.00 YC",
      mostYouCanLose: "6.20 YC",
    });
    assert.deepEqual(ticketTerms(100, 99), {
      reserved: "100.00 YC",
      mostYouCanLose: "99.00 YC",
    });
    assert.equal(coins(5), "0.05 YC");
  });

  it("accepts only whole sizes from 1 to 100 and prices from 1 to 99 cents", () => {
    assert.equal(parseSize("25"), 25);
    assert.equal(parseSize(" 100 "), 100);
    for (const text of ["0", "101", "2.5", "-3", "", "1e2", "ten"])
      assert.equal(parseSize(text), null, text);
    assert.equal(parseCeiling("62"), 62);
    assert.equal(parseCeiling("62¢"), 62);
    assert.equal(parseCeiling("0.62"), 62);
    assert.equal(parseCeiling(".6"), 60);
    for (const text of ["0", "100", "1.5", "abc", "", "0.001"])
      assert.equal(parseCeiling(text), null, text);
  });

  it("formats signed results from atomic units, 10,000 per Yap Coin", () => {
    assert.equal(signedCoins("10000"), "+1.00 YC");
    assert.equal(signedCoins("-20000"), "−2.00 YC");
    assert.equal(signedCoins("0"), "0.00 YC");
    assert.equal(signedCoins(12_345n), "+1.23 YC");
    assert.equal(percent({ n: "61", d: "100" }), 61);
    assert.equal(percent({ n: "2", d: "3" }), 67);
    assert.equal(percent(null), null);
  });

  it("names the speaker by side label, never as a yes or no side", () => {
    const speakers = { A: "Maya", B: "Jonah" };
    const labels = { A: "People first", B: "Markets first" };
    assert.equal(
      speakerLine("A", speakers, labels),
      "Maya speaking (People first)",
    );
    assert.equal(
      speakerLine("B", speakers, labels),
      "Jonah speaking (Markets first)",
    );
    assert.equal(speakerLine(null, speakers, labels), "Between turns");
    assert.doesNotMatch(speakerLine("A", speakers, labels), /yes|no/i);
  });

  it("finds the live window only between its opening and its cutoff", () => {
    const windows = [
      window(1, 0, 60, "settled"),
      window(2, 61, 121),
      window(3, 122, 182, "void"),
    ];
    assert.equal(liveWindow(windows, at(30).getTime()), null);
    assert.equal(liveWindow(windows, at(61).getTime())?.id, "w2");
    assert.equal(liveWindow(windows, at(120).getTime())?.id, "w2");
    // The cutoff itself is closed, as on the server.
    assert.equal(liveWindow(windows, at(121).getTime()), null);
    assert.equal(liveWindow(windows, at(150).getTime()), null);
  });

  it("targets the replay window whose recording span holds the position", () => {
    const rounds = [
      round({ id: "a", recording: { startSeconds: 0, endSeconds: 60 } }),
      round({ id: "b", recording: { startSeconds: 60, endSeconds: 120 } }),
      round({ id: "c", recording: null }),
      round({ id: "m", kind: "manual", turnNumber: null, side: null }),
    ];
    assert.equal(replayRound(rounds, 12)?.id, "a");
    assert.equal(replayRound(rounds, 60)?.id, "b");
    assert.equal(replayRound(rounds, 120), null);
  });

  it("answers a five-day replay's playing turn only before its close", () => {
    const span = (turnNumber, start, end, overrides = {}) => ({
      ...window(turnNumber, start, end),
      recording: { startSeconds: start, endSeconds: end },
      ...overrides,
    });
    const before = at(0).getTime();
    const windows = [span(1, 0, 60), span(2, 60, 120), span(3, 120, 180)];
    assert.equal(replayWindow(windows, 75, before)?.id, "w2");
    assert.equal(replayWindow(windows, 180, before), null);
    // After the 120-hour close nobody joins from the replay.
    const closed = windows.map((item) => ({ ...item, revealAt: iso(0) }));
    assert.equal(replayWindow(closed, 75, at(1).getTime()), null);
    // Per-round debates take live positions only.
    const perRound = windows.map((item) => ({
      ...item,
      revealMode: "per_round",
    }));
    assert.equal(replayWindow(perRound, 75, before), null);
    // A window not yet timed against the recording can't be targeted.
    assert.equal(
      replayWindow([span(2, 60, 120, { recording: null })], 75, before),
      null,
    );
  });

  it("counts down from the server-adjusted clock", () => {
    assert.equal(secondsLeft(iso(60), at(17).getTime() + 400), 43);
    assert.equal(secondsLeft(iso(60), at(75).getTime()), 0);
    assert.equal(clock(42), "0:42");
    assert.equal(clock(61), "1:01");
  });

  it("explains every reason a viewer can't take a position", () => {
    for (const reason of [
      "debater",
      "committed",
      "debate_unavailable",
      "closed",
      "paused",
      "full",
      "later_window",
    ])
      assert.ok(reasonText(reason).length > 10, reason);
    assert.match(reasonText("debater"), /in this debate/);
    assert.equal(reasonText(null), "");
  });

  it("describes locked, settled, unfilled and voided positions", () => {
    const when = () => "Oct 31, 7:12 PM EDT";
    assert.equal(
      positionStatus(round(), when),
      "Locked · results 5 days after the debate ends",
    );
    assert.equal(
      positionStatus(round({ revealAt: iso(0) }), when),
      "Locked · results Oct 31, 7:12 PM EDT",
    );
    const settled = (executed, net) =>
      round({
        state: "settled",
        outcome: { executed, premium: "0", fee: "0", payout: "0", net },
      });
    assert.equal(
      positionStatus(settled(true, "7000"), when),
      "Settled +0.70 YC",
    );
    assert.equal(
      positionStatus(settled(false, "0"), when),
      "Not filled · refunded",
    );
    assert.match(
      positionStatus(
        round({ state: "void", voidReason: "debate_unavailable" }),
        when,
      ),
      /^Voided · refunded/,
    );
  });
});

describe("results, repeat and get-ready defaults (Decision 0013)", () => {
  const own = (side, limit, quantity) => ({
    side,
    limit,
    quantity,
    requestId: "q",
  });
  const fraction = (n, d = 100) => ({ n: String(n), d: String(d) });
  const settled = (turnNumber, side, executed, net, price = 54, share = 58) =>
    round({
      id: `r${turnNumber}`,
      turnNumber,
      state: "settled",
      own: own(side, "0.62", 10),
      pricing: { price: fraction(price), share: fraction(share) },
      outcome: { executed, premium: "0", fee: "0", payout: "0", net },
    });

  it("recovers the read from a position's yes-scale limit on both sides", () => {
    // A Yes at read 62 sends 0.62; a No at read 62 sends 0.38, limit 0.62.
    assert.equal(readFromLimit("0.62"), 62);
    assert.equal(readFromLimit("0.620000"), 62);
    assert.equal(readFromLimit("0"), 1);
    assert.equal(readFromLimit("1"), 99);
  });

  it("offers the latest earlier position as the next turn's repeat", () => {
    const rounds = [
      round({ id: "a", turnNumber: 1, own: own("YES", "0.40", 5) }),
      round({ id: "b", turnNumber: 3, own: own("NO", "0.62", 25) }),
      round({ id: "c", turnNumber: 2, own: null }),
      round({ id: "d", turnNumber: 4, own: own("YES", "0.50", 10) }),
      round({
        id: "m",
        kind: "manual",
        turnNumber: null,
        own: own("YES", "0.9", 1),
      }),
    ];
    assert.equal(lastPosition(rounds, 4)?.id, "b");
    assert.equal(lastPosition(rounds, 2)?.id, "a");
    assert.equal(lastPosition(rounds, 1), null);
    assert.equal(
      repeatLabel(own("NO", "0.62", 25)),
      "Same as last turn · No · 25 · read 62%",
    );
  });

  it("accepts only whole saved defaults within the ticket's ranges", () => {
    assert.deepEqual(parseDefaults('{"size":25,"read":60}'), {
      size: 25,
      read: 60,
    });
    for (const text of [
      null,
      "",
      "not json",
      "[]",
      '{"size":25}',
      '{"size":0,"read":60}',
      '{"size":101,"read":60}',
      '{"size":2.5,"read":60}',
      '{"size":25,"read":100}',
      '{"size":"25","read":60}',
    ])
      assert.equal(parseDefaults(text), null, String(text));
  });

  it("totals revealed positions and keeps locked ones apart", () => {
    const summary = resultsSummary([
      settled(3, "YES", true, "4000"),
      round({ id: "r1", turnNumber: 1, own: own("YES", "0.5", 5) }),
      settled(2, "NO", true, "-600"),
      round({
        id: "r4",
        turnNumber: 4,
        state: "void",
        voidReason: "debate_unavailable",
        own: own("YES", "0.5", 5),
      }),
      settled(5, "YES", false, "0"),
      round({ id: "r6", turnNumber: 6, own: null, state: "settled" }),
    ]);
    assert.deepEqual(
      summary.revealed.map((item) => item.turnNumber),
      [2, 3, 4, 5],
    );
    assert.deepEqual(
      summary.locked.map((item) => item.turnNumber),
      [1],
    );
    assert.equal(summary.net, 3400n);
    assert.equal(
      resultsHeading(summary),
      "Results so far · +0.34 YC across 4 turns",
    );
    assert.equal(
      resultsHeading({ ...summary, locked: [] }),
      "Results are in · +0.34 YC across 4 turns",
    );
    assert.equal(
      resultsHeading({ revealed: [summary.revealed[0]], locked: [], net: 0n }),
      "Results are in · 0.00 YC across 1 turn",
    );
  });

  it("describes each revealed position from its own side", () => {
    assert.equal(
      resultLine(settled(3, "YES", true, "4000")),
      "Turn 3 · Yes · 10 · paid 54¢ each · 58% said yes · +0.40 YC",
    );
    assert.equal(
      resultLine(settled(2, "NO", true, "-600")),
      "Turn 2 · No · 10 · paid 46¢ each · 58% said yes · −0.06 YC",
    );
    assert.equal(
      resultLine(settled(5, "YES", false, "0", 70)),
      "Turn 5 · Yes · 10 · not filled at 70¢ · 58% said yes · refunded",
    );
    assert.equal(
      resultLine(
        round({
          turnNumber: 4,
          state: "void",
          own: own("NO", "0.5", 5),
        }),
      ),
      "Turn 4 · No · 5 · voided · refunded",
    );
    assert.equal(
      resultLine(
        round({
          turnNumber: 7,
          state: "settled",
          own: own("YES", "0.5", 5),
          pricing: { price: null, share: null },
          outcome: {
            executed: false,
            premium: "0",
            fee: "0",
            payout: "0",
            net: "0",
          },
        }),
      ),
      "Turn 7 · Yes · 5 · not filled · refunded",
    );
    assert.equal(resultLine(round()), "");
  });
});
