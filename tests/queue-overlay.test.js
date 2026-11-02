import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTER_MS,
  HEADLINES,
  OFFER_SECONDS,
  canQueueAgain,
  cardsView,
  firstName,
  headlineIndex,
  holeView,
  initials,
  matchClock,
  matchStatus,
  motionPlan,
  pickQuote,
  quoteAuthor,
  ticketPhase,
  topicSide,
  wantsOverlay,
} from "../public/queue-overlay-logic.js";
import { QUOTES } from "../public/queue-quotes.js";
import { clockFrame } from "../public/turn-clock-logic.js";

// The queue overlay (docs/queue-overlay.md): the full-screen waiting screen and the in-place
// 30-second match countdown.

const now = Date.parse("2026-10-25T12:00:00.000Z");
const at = (seconds) => new Date(now + seconds * 1000).toISOString();
const ticket = (status, extra = {}) => ({
  id: "ticket-1",
  topicSlug: "nuclear-power",
  topicTitle: "Canada should expand nuclear power",
  side: "A",
  sideLabel: "For",
  status,
  closedReason: null,
  queuedAt: at(-83),
  ...extra,
});
const offer = (extra = {}) => ({
  id: "offer-1",
  deadlineAt: at(24),
  acceptedByMe: false,
  acceptedByOpponent: false,
  opponent: {
    handle: "maya-chen",
    displayName: "Maya Chen",
    sideLabel: "Against",
  },
  ...extra,
});
const state = (overrides = {}) => ({
  serverNow: at(0),
  ticket: null,
  offer: null,
  debate: null,
  challenge: null,
  upcoming: null,
  ...overrides,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

describe("queue overlay", () => {
  it("maps every ticket state to a phase", () => {
    assert.equal(ticketPhase(null), null);
    assert.equal(ticketPhase(state()), null);
    assert.equal(
      ticketPhase(state({ ticket: ticket("searching") })),
      "waiting",
    );
    assert.equal(
      ticketPhase(state({ ticket: ticket("offered"), offer: offer() })),
      "match",
    );
    // An offered ticket whose offer row is gone, between two states, still waits.
    assert.equal(ticketPhase(state({ ticket: ticket("offered") })), "waiting");
    assert.equal(ticketPhase(state({ ticket: ticket("matched") })), "matched");
    assert.equal(ticketPhase(state({ ticket: ticket("closed") })), "closed");
  });

  it("shows while waiting unless folded, and always on a match", () => {
    const waiting = state({ ticket: ticket("searching") });
    assert.equal(wantsOverlay(waiting, null), true);
    assert.equal(wantsOverlay(waiting, "ticket-1"), false, "folded");
    assert.equal(wantsOverlay(waiting, "ticket-0"), true, "an older ticket");
    const matched = state({ ticket: ticket("offered"), offer: offer() });
    assert.equal(wantsOverlay(matched, "ticket-1"), true);
    for (const status of ["matched", "closed"])
      assert.equal(
        wantsOverlay(state({ ticket: ticket(status) }), null),
        false,
      );
    assert.equal(wantsOverlay(null, null), false);
  });

  it("counts up while waiting and down on a match, in the emblem's hole", () => {
    assert.deepEqual(
      holeView("waiting", state({ ticket: ticket("searching") }), now),
      {
        number: "1:23",
        label: "in qveve",
        name: "83 seconds in the queue",
        warm: false,
      },
    );
    const offered = (seconds) =>
      state({
        ticket: ticket("offered"),
        offer: offer({ deadlineAt: at(seconds) }),
      });
    assert.deepEqual(holeView("match", offered(18), now), {
      number: "18",
      label: "seconds to accept",
      name: "18 seconds left to accept",
      warm: false,
    });
    // The number turns coral with 10 seconds left, as the tiles do.
    assert.equal(holeView("match", offered(10.4), now).warm, false);
    assert.equal(holeView("match", offered(10), now).warm, true);
    assert.equal(
      holeView("match", offered(1), now).name,
      "1 second left to accept",
    );
    assert.equal(holeView("match", offered(-3), now).number, "0");
    assert.equal(holeView("entering", offered(5), now).number, "go");
    assert.equal(holeView("closed", offered(5), now).number, "");
  });

  it("passes the countdown to the turn clock's rules", () => {
    const left = (seconds) => matchClock(at(seconds), now, false, null);
    assert.deepEqual(left(30), {
      phase: "running",
      left: 30,
      total: OFFER_SECONDS,
      reduced: false,
    });
    close(clockFrame(left(18)).spent, 0.4);
    assert.equal(clockFrame(left(18)).warn, false);
    assert.equal(clockFrame(left(10)).warn, true);
    close(clockFrame(left(0)).spent, 1);
    // A page that saw the offer arrive times the sweep from then; a late open has no start.
    assert.equal(matchClock(at(29.6), now, false, 0).sinceStart, 0);
    assert.equal(clockFrame(matchClock(at(29.6), now, false, 0)).refill, 0);
    const late = matchClock(at(12), now, false, null);
    assert.equal("sinceStart" in late, false);
    assert.equal(clockFrame(late).refill, 1);
    assert.equal(matchClock(at(12), now, true, null).reduced, true);
  });

  it("lights each player's card when they accept, in the countdown's colour", () => {
    const fresh = cardsView(offer({ deadlineAt: at(24) }), false, now);
    assert.deepEqual(fresh, {
      me: { lit: false, state: "Your move" },
      them: { lit: false, state: "Deciding" },
      warm: false,
    });
    const mine = cardsView(offer({ acceptedByMe: true }), false, now);
    assert.deepEqual(
      [mine.me.lit, mine.me.state, mine.them.lit],
      [true, "Accepted", false],
    );
    const theirs = cardsView(offer({ acceptedByOpponent: true }), false, now);
    assert.deepEqual(
      [theirs.me.lit, theirs.them.lit, theirs.them.state],
      [false, true, "Accepted"],
    );
    // Coral in the last 10 seconds, following the number.
    assert.equal(
      cardsView(offer({ deadlineAt: at(11) }), false, now).warm,
      false,
    );
    assert.equal(
      cardsView(offer({ deadlineAt: at(10) }), false, now).warm,
      true,
    );
    // Both lit white while the debate opens.
    const entering = cardsView(offer({ deadlineAt: at(4) }), true, now);
    assert.deepEqual(
      [entering.me.lit, entering.them.lit, entering.warm],
      [true, true, false],
    );
  });

  it("names the opponent in the line under the cards", () => {
    assert.equal(matchStatus(offer(), false), "Accept within 30 seconds.");
    assert.equal(
      matchStatus(offer({ acceptedByMe: true }), false),
      "You accepted. Waiting for Maya…",
    );
    assert.equal(
      matchStatus(offer({ acceptedByOpponent: true }), false),
      "Maya accepted.",
    );
    assert.equal(
      matchStatus(offer(), true),
      "Both accepted. Opening your debate…",
    );
    // A hidden profile has no name.
    const hidden = offer({
      acceptedByOpponent: true,
      opponent: { handle: null, displayName: null, sideLabel: "Against" },
    });
    assert.equal(firstName(hidden), null);
    assert.equal(matchStatus(hidden, false), "The other player accepted.");
    assert.equal(
      matchStatus(
        { ...hidden, acceptedByMe: true, acceptedByOpponent: false },
        false,
      ),
      "You accepted. Waiting for the other player…",
    );
    assert.equal(initials("Maya Chen"), "MC");
    assert.equal(initials("plato"), "P");
    assert.equal(initials(null), "?");
  });

  it("flips the headline for each phase and closing reason", () => {
    assert.deepEqual(
      HEADLINES.map(({ lines }) => lines.join(" ")),
      [
        "finding other hvmans",
        "match fovnd",
        "entering the arena",
        "match missed",
        "match declined",
        "qveve closed",
      ],
    );
    assert.equal(HEADLINES[0].spoken, "Finding other humans…");
    assert.equal(headlineIndex("waiting", null), 0);
    assert.equal(headlineIndex("match", null), 1);
    assert.equal(headlineIndex("entering", null), 2);
    assert.equal(headlineIndex("closed", "missed"), 3);
    assert.equal(headlineIndex("closed", "declined"), 4);
    assert.equal(headlineIndex("closed", "topic_closed"), 5);
    assert.equal(canQueueAgain("missed"), true);
    assert.equal(canQueueAgain("declined"), true);
    for (const reason of [
      "left",
      "stale",
      "unavailable",
      "topic_closed",
      "booking",
      null,
    ])
      assert.equal(canQueueAgain(reason), false);
  });

  it("shows the topic's side in Dydema and says it in full", () => {
    assert.deepEqual(topicSide("Against"), {
      shown: "yov argve",
      side: "against",
      spoken: "You argue Against on the topic",
    });
    assert.equal(quoteAuthor("Thomas Paine"), "thomas paine");
    assert.equal(
      quoteAuthor("Aleksandr Solzhenitsyn"),
      "aleksandr solzhenitsyn",
    );
    assert.equal(quoteAuthor("Seneca"), "seneca");
    assert.equal(quoteAuthor("Marcus Aurelius"), "marcvs avrelivs");
  });

  it("rotates quotes at random without repeats until all have shown", () => {
    // A seeded random source, so the order is reproducible.
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    let pick = pickQuote([], -1, QUOTES.length, random);
    const order = [pick.index];
    for (let shown = 1; shown < QUOTES.length * 3; shown++) {
      const previous = pick.index;
      pick = pickQuote(pick.remaining, pick.index, QUOTES.length, random);
      assert.notEqual(pick.index, previous, "never twice in a row");
      order.push(pick.index);
    }
    // The first round shows every quote once.
    assert.equal(new Set(order.slice(0, QUOTES.length)).size, QUOTES.length);
    // Later rounds repeat nothing until the round ends (the round's first may be any but the last).
    const second = order.slice(QUOTES.length, QUOTES.length * 2 - 1);
    assert.equal(new Set(second).size, second.length);
    // The random source picks: the lowest draw takes the first remaining quote.
    assert.equal(pickQuote([4, 9], 1, QUOTES.length, () => 0).index, 4);
    assert.equal(pickQuote([4, 9], 1, QUOTES.length, () => 0.999).index, 9);
    assert.deepEqual(
      pickQuote([4, 9], 1, QUOTES.length, () => 0).remaining,
      [9],
    );
  });

  it("keeps the founder's 16 quotes, each with its work and year", () => {
    assert.equal(QUOTES.length, 16);
    for (const quote of QUOTES) {
      assert.ok(quote.text.length > 20 && quote.text.endsWith("."), quote.text);
      assert.ok(quote.author);
      assert.match(quote.source, /\d{2,4}( (AD|BC))?$/);
    }
    // Misattributed lines stay out.
    const all = QUOTES.map((quote) => quote.text).join(" ");
    for (const line of [
      /educated mind/,
      /disapprove of what you say/,
      /repeatedly do/,
    ])
      assert.doesNotMatch(all, line);
  });

  it("leaves out motion under reduced motion", () => {
    assert.deepEqual(motionPlan(false), {
      bursts: true,
      rotateQuotes: true,
      sweep: true,
      enterDelay: ENTER_MS,
      revealCardsAfter: 400,
    });
    assert.deepEqual(motionPlan(true), {
      bursts: false,
      rotateQuotes: false,
      sweep: false,
      enterDelay: 0,
      revealCardsAfter: 0,
    });
    assert.ok(ENTER_MS <= 600, "the debate opens within 600 ms of the match");
  });
});
