import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canAnswer,
  ceilingCents,
  ceilingText,
  clock,
  coins,
  confirmText,
  debatesHere,
  decimalShare,
  duelsText,
  isDuel,
  liveWindow,
  percent,
  placementError,
  presenceDue,
  PRESENCE_MS,
  returnedText,
  waitText,
  positionStatus,
  price,
  reasonText,
  replayRound,
  replayWindow,
  resultLine,
  resultsHeading,
  reservedAtoms,
  resultsSummary,
  secondsLeft,
  signedCoins,
  sizeChoices,
  speakerLine,
  ticketTerms,
  turnHeading,
  watchSheetName,
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
      reserved: "10 YC",
      mostYouCanLose: "6.20 YC",
    });
    assert.deepEqual(ticketTerms(100, 99), {
      reserved: "100 YC",
      mostYouCanLose: "99 YC",
    });
    assert.equal(coins(5), "0.05 YC");
    // A price per contract in Yap Coins, never cents.
    assert.equal(price(54), "0.54 YC");
    assert.equal(price(5), "0.05 YC");
    assert.equal(price(100), "1.00 YC");
    assert.equal(reservedAtoms(10), 100_000n);
  });

  // Decision 0016, amended 2026-11-16: one ticket wherever a viewer answers.
  it("offers the same five sizes everywhere, with no typed size", () => {
    assert.deepEqual([...sizeChoices], [10, 25, 50, 75, 100]);
  });

  it("names a phone's answer sheet for its side, not the question", () => {
    assert.equal(watchSheetName("YES"), "Your answer: Yes");
    assert.equal(watchSheetName("NO"), "Your answer: No");
    // After placing, the side is cleared while the sheet closes.
    assert.equal(watchSheetName(null), "Your answer");
  });

  it("names the exact terms on the confirm button as the size or read changes", () => {
    const ticket = (overrides) => ({
      side: "YES",
      size: 25,
      cents: 58,
      turnNumber: 7,
      closedTurn: null,
      ...overrides,
    });
    assert.equal(confirmText(ticket()), "Place Yes · 25 · max 14.50 YC");
    assert.equal(
      confirmText(ticket({ size: 75 })),
      "Place Yes · 75 · max 43.50 YC",
    );
    // A No read of 58% yes pays at most 42 hundredths per contract.
    assert.equal(
      confirmText(ticket({ side: "NO", cents: 42 })),
      "Place No · 25 · max 10.50 YC",
    );
    assert.equal(
      confirmText(ticket({ size: 100, cents: 99 })),
      "Place Yes · 100 · max 99 YC",
    );
    // After the turn it was opened for closed, it says which turn it joins.
    assert.equal(
      confirmText(ticket({ closedTurn: 6 })),
      "Use for turn 7 · Yes · 25 · max 14.50 YC",
    );
    assert.equal(
      confirmText(ticket({ closedTurn: 7 })),
      "Place Yes · 25 · max 14.50 YC",
    );
  });

  it("formats signed results from atomic units, 10,000 per Yap Coin", () => {
    assert.equal(signedCoins("10000"), "+1 YC");
    assert.equal(signedCoins("-20000"), "−2 YC");
    assert.equal(signedCoins(12_345n), "+1.23 YC");
    assert.equal(signedCoins("-4000"), "−0.40 YC");
    assert.equal(signedCoins(12_345_670_000n), "+1,234,567 YC");
    // Results that round to zero say so.
    assert.equal(signedCoins("0"), "no gain or loss");
    assert.equal(signedCoins("40"), "a gain under 0.01 YC");
    assert.equal(signedCoins("-99"), "a loss under 0.01 YC");
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
    // A turn that ended early keeps its window open until its cutoff; only
    // the running (newest) turn's window takes orders, so it is shown.
    const early = [window(4, 0, 60), window(5, 20, 80), window(6, 90, 150)];
    assert.equal(liveWindow(early, at(10).getTime())?.id, "w4");
    assert.equal(liveWindow(early, at(30).getTime())?.id, "w5");
    assert.equal(liveWindow([...early].reverse(), at(30).getTime())?.id, "w5");
    assert.equal(liveWindow(early, at(70).getTime())?.id, "w5");
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

  it("keeps a debater's answer buttons off on every turn, even one not yet read", () => {
    const eligible = { eligibility: { canTakePosition: true, reason: null } };
    const debating = {
      eligibility: { canTakePosition: false, reason: "debater" },
    };
    const viewer = (overrides) => ({
      signedIn: true,
      coins: true,
      debater: false,
      round: eligible,
      ...overrides,
    });
    assert.equal(canAnswer(viewer()), true);
    // A signed-out viewer's tap asks them to sign in.
    assert.equal(canAnswer(viewer({ signedIn: false, coins: false })), true);
    assert.equal(canAnswer(viewer({ signedIn: null })), true);
    assert.equal(
      canAnswer(viewer({ signedIn: null, coins: false, round: null })),
      false,
    );
    assert.equal(canAnswer(viewer({ coins: false })), false);
    assert.equal(canAnswer(viewer({ round: debating })), false);
    // The operator in the 2026-11-09 test: the new turn's eligibility hadn't
    // arrived, so the panel offered Yes and No and the server refused.
    assert.equal(canAnswer(viewer({ round: null })), false);
    assert.equal(canAnswer(viewer({ debater: true })), false);
    // One round naming the viewer a debater covers the whole debate.
    assert.equal(debatesHere([]), false);
    assert.equal(debatesHere([eligible, eligible]), false);
    assert.equal(debatesHere([eligible, debating]), true);
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
      "Settled: +0.70 YC",
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

describe("results (Decision 0013)", () => {
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
      "Results are in · no gain or loss across 1 turn",
    );
  });

  it("describes each revealed position from its own side", () => {
    assert.equal(
      resultLine(settled(3, "YES", true, "4000")),
      "Turn 3 · Yes · 10 · paid 0.54 YC each · 58% said yes · +0.40 YC",
    );
    assert.equal(
      resultLine(settled(2, "NO", true, "-600")),
      "Turn 2 · No · 10 · paid 0.46 YC each · 58% said yes · −0.06 YC",
    );
    assert.equal(
      resultLine(settled(5, "YES", false, "0", 70)),
      "Turn 5 · Yes · 10 · not filled at 0.70 YC · 58% said yes · refunded",
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

describe("placement refusals in the panel's words", () => {
  const failure = (status, code, message = "server text") =>
    Object.assign(new Error(message), { status, code });
  const context = { turnNumber: 4, available: "123450000" };
  it("maps every known refusal to plain text, never the server's", () => {
    const cases = [
      [
        failure(409, "window_closed"),
        /^Turn 4's window closed before you confirmed\. Nothing was reserved\.$/,
        true,
      ],
      [
        failure(409, "insufficient_balance"),
        /^You don't have enough Yap Coins: 12,345 YC available\. Lower the size\. Nothing was reserved\.$/,
      ],
      [failure(409, "already_answered"), /^You already answered this turn\.$/],
      [
        failure(403, "debater"),
        /^You're in this debate, so you can't answer here\.$/,
      ],
      [
        failure(409, "window_full"),
        /^This turn's window is full\. Nothing was reserved\.$/,
      ],
      [
        failure(503, "answers_paused"),
        /^Answers are paused for a moment\. Nothing was reserved; try again soon\.$/,
      ],
      [
        failure(503, "busy"),
        /^Yap Coins are busy\. Nothing was reserved; try again\.$/,
      ],
      [
        failure(409, "replay_untimed"),
        /^This replay isn't taking answers yet\. Nothing was reserved\.$/,
      ],
      [
        failure(409, "debate_unavailable"),
        /^This debate isn't taking answers\.$/,
      ],
      [failure(403, "financial_review"), /correction review/],
      [failure(409, "later_window"), /already answered a later turn/],
      [
        failure(409, "replay_position"),
        /isn't in this turn's window\. Nothing was reserved\.$/,
      ],
      [failure(409, "session_changed"), /another tab/],
      [
        failure(401, "signed_out"),
        /^You're signed out\. Sign in again to answer\.$/,
      ],
      [failure(401, undefined), /^You're signed out/],
      [
        failure(429, undefined),
        /^Too many requests\. Nothing was reserved; wait a moment, then try again\.$/,
      ],
      [
        Object.assign(failure(429, undefined), { retryAfterSeconds: 42 }),
        /^Too many requests\. Nothing was reserved; try again in 42 seconds\.$/,
      ],
      [
        failure(409, "idempotency_conflict"),
        /^Couldn't place your answer\. Nothing was reserved; try again\.$/,
      ],
      [
        failure(500, undefined, "internal server error"),
        /^Couldn't place your answer\. Nothing was reserved; try again\.$/,
      ],
      // No HTTP status: the request never got an answer.
      [
        new TypeError("Failed to fetch"),
        /^Connection lost\. Nothing was reserved; try again\.$/,
      ],
      [
        Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
        /^Connection lost/,
      ],
      [new Error("window changed"), /^Turn 4's window closed/, true],
    ];
    for (const [error, text, closed = false] of cases) {
      const result = placementError(error, context);
      assert.match(result.text, text, String(error.code ?? error.message));
      assert.equal(result.closed, closed, String(error.code ?? error.message));
      assert.doesNotMatch(
        result.text,
        /server text|internal server|Failed to fetch|signal timed out/,
      );
    }
  });
  it("says how long the server asked to wait", () => {
    assert.deepEqual([0.2, 1, 59, 60, 61, 300, 900].map(waitText), [
      "1 second",
      "1 second",
      "59 seconds",
      "1 minute",
      "2 minutes",
      "5 minutes",
      "15 minutes",
    ]);
  });
  it("leaves the balance out when the panel doesn't know it", () => {
    assert.equal(
      placementError(failure(409, "insufficient_balance"), {
        turnNumber: 1,
        available: null,
      }).text,
      "You don't have enough Yap Coins for this size. Nothing was reserved.",
    );
  });
});

describe("forecast duel windows (Decision 0017)", () => {
  const duelRound = (overrides = {}) =>
    round({
      terms: { rule: "fd-v1" },
      own: { side: "YES", limit: "0.600000", quantity: 10, requestId: "q" },
      ...overrides,
    });
  const settled = (duels, outcome) =>
    duelRound({
      state: "settled",
      pricing: {
        share: duels.share,
        a: null,
        b: null,
        price: null,
        branch: "duels",
        reason: duels.status,
      },
      duels,
      outcome,
    });
  const summary = (status, share = { n: "2", d: "3" }) => ({
    rule: "fd-v1",
    status,
    viewers: status === "returned_few_viewers" ? 7 : 12,
    tickets: 6,
    share: status === "settled" ? share : null,
    crowd: status === "settled" ? { n: "63", d: "100" } : null,
    verdict: status === "settled" ? "YES" : null,
  });

  it("knows a duel window by its rule", () => {
    assert.equal(isDuel({ rule: "fd-v1" }), true);
    assert.equal(isDuel({ terms: { rule: "fd-v1" } }), true);
    assert.equal(isDuel({ rule: "a4-v1" }), false);
    assert.equal(isDuel({}), false);
    assert.equal(isDuel(null), false);
  });

  it("names the whole size at stake on the ticket, whatever the read", () => {
    const ticket = {
      side: "NO",
      size: 25,
      cents: 42,
      turnNumber: 7,
      closedTurn: null,
    };
    assert.equal(confirmText(ticket), "Place No · 25 · max 10.50 YC");
    assert.equal(
      confirmText({ ...ticket, duel: true }),
      "Place No · 25 · max 25 YC",
    );
    assert.equal(
      confirmText({ ...ticket, duel: true, closedTurn: 6 }),
      "Use for turn 7 · No · 25 · max 25 YC",
    );
  });

  it("words a settled duel result by the read, not the side", () => {
    assert.equal(decimalShare("0.540000").n, "540000");
    const won = settled(summary("settled"), {
      executed: true,
      premium: "100000",
      fee: "0",
      payout: "131325",
      net: "31325",
      duelsWon: 3,
      duelsLost: 2,
    });
    assert.equal(
      resultLine(won),
      "Turn 2 · Yes · 10 · read 60% · 67% said yes · your read beat 3 of 5 · +3.13 YC",
    );
    assert.equal(
      positionStatus(won, () => ""),
      "Settled: +3.13 YC",
    );
    assert.equal(duelsText({}), "your read beat 0 of 0");
  });

  it("says why a duel window returned every stake", () => {
    const outcome = {
      executed: false,
      premium: "0",
      fee: "0",
      payout: "100000",
      net: "0",
    };
    const few = settled(summary("returned_few_viewers"), outcome);
    assert.equal(
      resultLine(few),
      "Turn 2 · Yes · 10 · read 60% · stakes returned",
    );
    assert.equal(
      positionStatus(few, () => ""),
      "Stakes returned",
    );
    const small = settled(summary("returned_small_room"), outcome);
    assert.equal(
      positionStatus(small, () => ""),
      "Returned: fewer than 5 answers",
    );
    assert.equal(returnedText(summary("settled")), null);
    assert.equal(returnedText(null), null);
    assert.equal(
      positionStatus(
        round({ state: "void", voidReason: "turn_cut" }),
        () => "",
      ),
      "Voided · refunded (the turn was cut short)",
    );
  });

  it("sends the presence heartbeat only for a live duel window", () => {
    const state = (overrides = {}) => ({
      eventStatus: "live",
      signedIn: true,
      session: true,
      debater: false,
      hidden: false,
      window: { id: "w3", rule: "fd-v1" },
      last: null,
      now: 100_000,
      ...overrides,
    });
    assert.equal(PRESENCE_MS, 20_000);
    assert.equal(presenceDue(state()), true);
    // Every 20 seconds, and at once when a new window opens.
    const sent = { at: 90_000, windowId: "w3" };
    assert.equal(presenceDue(state({ last: sent })), false);
    assert.equal(presenceDue(state({ last: sent, now: 110_000 })), true);
    assert.equal(
      presenceDue(state({ last: { at: 99_000, windowId: "w2" } })),
      true,
    );
    // Never signed out, before the balance loads, for a debater, from a
    // hidden page, between windows, for an A4 window or once not live.
    for (const overrides of [
      { signedIn: false },
      { signedIn: null },
      { session: false },
      { debater: true },
      { hidden: true },
      { window: null },
      { window: { id: "w3", rule: "a4-v1" } },
      { window: { id: "w3" } },
      { eventStatus: "ended" },
      { eventStatus: undefined },
    ])
      assert.equal(
        presenceDue(state(overrides)),
        false,
        JSON.stringify(overrides),
      );
    // Decision 0018: with the mic on, a viewer is counted present all
    // through the live debate, between windows and in A4 windows too.
    const mic = (overrides = {}) => state({ mic: true, ...overrides });
    assert.equal(presenceDue(mic({ window: null })), true);
    assert.equal(
      presenceDue(mic({ window: { id: "w3", rule: "a4-v1" } })),
      true,
    );
    const between = { at: 90_000, windowId: null };
    assert.equal(presenceDue(mic({ window: null, last: between })), false);
    assert.equal(
      presenceDue(mic({ window: null, last: between, now: 110_000 })),
      true,
    );
    // A new duel window still says so at once.
    assert.equal(presenceDue(mic({ last: between })), true);
    for (const overrides of [
      { signedIn: false },
      { debater: true },
      { hidden: true },
      { eventStatus: "ended" },
    ])
      assert.equal(presenceDue(mic(overrides)), false);
  });

  it("heads the panel with the turn, or a mic's turn by its kind", () => {
    const speakers = { A: "Maya Chen", B: "Léo Tremblay" };
    const labels = { A: "People first", B: "Markets first" };
    const heading = (overrides = {}) =>
      turnHeading({
        turnNumber: 8,
        side: "A",
        replay: false,
        speakers,
        labels,
        ...overrides,
      });
    assert.equal(heading(), "Turn 8 · Maya Chen speaking (People first)");
    assert.equal(
      heading({ replay: true }),
      "Replay · turn 8 · Maya Chen speaking (People first)",
    );
    // The question's window is on the asker's camp, side A; nobody on that
    // side is speaking.
    const micTurns = [
      {
        turnNumber: 8,
        micId: "mic-1",
        kind: "question",
        asker: "zoe",
        target: "B",
        text: null,
      },
    ];
    assert.equal(heading({ micTurns }), "Question · @zoe");
    assert.equal(
      heading({ micTurns, replay: true }),
      "Replay · Question · @zoe",
    );
    assert.equal(
      heading({ micTurns, turnNumber: 9, side: "B" }),
      "Turn 9 · Léo Tremblay speaking (Markets first)",
    );
  });
});
