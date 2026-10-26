import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ceilingCents,
  ceilingText,
  clock,
  coins,
  liveWindow,
  parseCeiling,
  parseSize,
  percent,
  positionStatus,
  reasonText,
  replayRound,
  replayWindow,
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
