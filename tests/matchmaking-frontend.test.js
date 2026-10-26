import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bannerText,
  bookedBannerText,
  challengeNotice,
  clock,
  clockOffset,
  dueDebate,
  isAnswering,
  isJoining,
  isQueued,
  needsLiveUpdates,
  pillDescription,
  pillHref,
  pillText,
  secondsSince,
  secondsUntil,
  shouldOpenDebate,
  transitionNotice,
  untilReminder,
  waitingText,
} from "../public/matchmaking-logic.js";

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
const state = (overrides = {}) => ({
  serverNow: at(0),
  ticket: null,
  offer: null,
  debate: null,
  challenge: null,
  upcoming: null,
  ...overrides,
});
const challenge = (direction, respondIn = 102) => ({
  id: "challenge-1",
  direction,
  handle: "riley",
  displayName: "Riley Ortiz",
  topicTitle: "Canada should expand nuclear power",
  sideLabel: "Against",
  respondBy: at(respondIn),
});
// A booked debate starting in `startsIn` seconds, with its 10-minute join window.
const upcoming = (startsIn) => ({
  id: "booked-1",
  slug: "booked-1",
  status: "scheduled",
  proposition: "Canada should expand nuclear power",
  startsAt: at(startsIn),
  joinDeadlineAt: at(startsIn + 600),
});
const offer = {
  id: "offer-1",
  deadlineAt: at(24),
  acceptedByMe: false,
  acceptedByOpponent: false,
};
const debate = (status) => ({
  id: "debate-1",
  slug: "debate-1",
  status,
  joinDeadlineAt: at(45),
});

describe("live queue screens", () => {
  it("reads the server clock and formats countdowns", () => {
    assert.equal(clockOffset(state(), now - 1500), 1500);
    assert.equal(secondsUntil(at(24.2), now), 25);
    assert.equal(secondsUntil(at(-3), now), 0);
    assert.equal(secondsSince(at(-83), now), 83);
    assert.equal(secondsSince(at(5), now), 0);
    assert.equal(clock(83), "1:23");
    assert.equal(clock(5), "0:05");
  });

  it("knows when the player needs live updates", () => {
    assert.equal(isQueued(null), false);
    assert.equal(isQueued(state({ ticket: ticket("searching") })), true);
    assert.equal(isQueued(state({ ticket: ticket("offered") })), true);
    assert.equal(isQueued(state({ ticket: ticket("matched") })), false);
    assert.equal(isJoining(state({ debate: debate("ready") })), true);
    assert.equal(isJoining(state({ debate: debate("live") })), false);
    assert.equal(
      needsLiveUpdates(state({ debate: debate("scheduled") })),
      true,
    );
    assert.equal(needsLiveUpdates(state({ ticket: ticket("closed") })), false);
  });

  it("labels the header pill", () => {
    assert.equal(pillText(null, now), null);
    assert.equal(
      pillText(state({ ticket: ticket("searching") }), now),
      "In queue · 1:23",
    );
    assert.equal(
      pillText(state({ ticket: ticket("offered"), offer }), now),
      "Match found · 0:24",
    );
    assert.equal(
      pillText(
        state({ ticket: ticket("matched"), debate: debate("ready") }),
        now,
      ),
      "Join your debate",
    );
    assert.equal(
      pillText(
        state({ ticket: ticket("matched"), debate: debate("live") }),
        now,
      ),
      null,
    );
  });

  it("hides the pill on the matched debate's own page and names the topic and side", () => {
    const joining = state({
      ticket: ticket("matched"),
      debate: debate("ready"),
    });
    assert.equal(pillText(joining, now, "debate-1"), null);
    assert.equal(pillText(joining, now, "another"), "Join your debate");
    assert.equal(
      pillDescription(state({ ticket: ticket("searching") })),
      "Canada should expand nuclear power · For",
    );
    assert.equal(pillDescription(null), "");
  });

  it("describes who is waiting on each side", () => {
    assert.match(
      waitingText({ sideA: 0, sideB: 0 }, "For", "Against"),
      /first in line/,
    );
    assert.equal(
      waitingText({ sideA: 1, sideB: 3 }, "For", "Against"),
      "1 person waiting for For · 3 people waiting for Against",
    );
    assert.equal(
      waitingText({ sideA: 0, sideB: 2 }, "For", "Against"),
      "2 people waiting for Against",
    );
  });

  it("tells the player once what changed", () => {
    const searching = state({ ticket: ticket("searching") });
    const offered = state({ ticket: ticket("offered"), offer });
    assert.equal(transitionNotice(null, searching), null);
    assert.equal(transitionNotice(searching, searching), null);
    assert.match(
      transitionNotice(searching, offered),
      /Accept within 30 seconds/,
    );
    assert.match(
      transitionNotice(offered, searching),
      /back in the queue at your place/,
    );
    const matched = state({
      ticket: ticket("matched"),
      debate: debate("ready"),
    });
    const requeued = state({ ticket: ticket("searching", { id: "ticket-2" }) });
    assert.match(transitionNotice(matched, requeued), /didn't join in time/);
    for (const [reason, pattern] of [
      ["left", /left the queue/],
      ["declined", /declined/],
      ["missed", /didn't accept in time/],
      ["stale", /closed or offline/],
      ["unavailable", /can't debate right now/],
      ["topic_closed", /no longer public/],
      ["booking", /scheduled debate starts soon/],
    ])
      assert.match(
        transitionNotice(
          searching,
          state({ ticket: ticket("closed", { closedReason: reason }) }),
        ),
        pattern,
      );
    assert.equal(
      transitionNotice(
        state({ ticket: ticket("closed", { closedReason: "left" }) }),
        state({ ticket: ticket("closed", { closedReason: "left" }) }),
      ),
      null,
    );
  });

  it("shows the join countdown only on the matched debate's page", () => {
    const joining = state({
      ticket: ticket("matched"),
      debate: debate("ready"),
    });
    assert.equal(
      bannerText(joining, "debate-1", now),
      "Waiting for both speakers to join · 0:45 left",
    );
    assert.equal(bannerText(joining, "another-debate", now), null);
    assert.equal(bannerText(null, "debate-1", now), null);
    assert.match(
      bannerText(state({ debate: debate("cancelled") }), "debate-1", now),
      /cancelled because a speaker didn't join/,
    );
    assert.equal(
      bannerText(state({ debate: debate("live") }), "debate-1", now),
      null,
    );
  });

  it("opens the debate only when the match happens on this page", () => {
    const offered = state({ ticket: ticket("offered"), offer });
    const matched = state({
      ticket: ticket("matched"),
      debate: debate("ready"),
    });
    assert.equal(
      shouldOpenDebate(offered, matched, "/topics/nuclear-power"),
      true,
    );
    assert.equal(
      shouldOpenDebate(offered, matched, "/debates/debate-1"),
      false,
    );
    assert.equal(
      shouldOpenDebate(null, matched, "/topics/nuclear-power"),
      false,
    );
    assert.equal(
      shouldOpenDebate(
        offered,
        state({ ticket: ticket("matched"), debate: debate("live") }),
        "/",
      ),
      false,
    );
    assert.equal(shouldOpenDebate(offered, offered, "/"), false);
  });

  it("shows a now challenge being answered in the pill until its two minutes end", () => {
    const incoming = state({ challenge: challenge("incoming") });
    const outgoing = state({ challenge: challenge("outgoing") });
    assert.equal(isAnswering(incoming, now), true);
    assert.equal(
      isAnswering(state({ challenge: challenge("incoming", -1) }), now),
      false,
    );
    assert.equal(pillText(incoming, now), "Challenged · 1:42");
    assert.equal(pillText(outgoing, now), "Challenge sent · 1:42");
    assert.equal(
      pillText(state({ challenge: challenge("outgoing", -1) }), now),
      null,
    );
    assert.equal(pillHref(outgoing, now), "/match");
    assert.equal(
      pillDescription(outgoing),
      "To @riley · Canada should expand nuclear power · Against",
    );
    assert.equal(
      pillDescription(incoming),
      "From @riley · Canada should expand nuclear power · Against",
    );
    // The queue still comes first.
    assert.equal(
      pillText(
        state({
          ticket: ticket("searching"),
          challenge: challenge("incoming"),
        }),
        now,
      ),
      "In queue · 1:23",
    );
    assert.equal(
      pillHref(state({ ticket: ticket("searching") }), now),
      "/topics/nuclear-power",
    );
    assert.equal(
      pillHref(
        state({ ticket: ticket("matched"), debate: debate("ready") }),
        now,
      ),
      "/debates/debate-1",
    );
  });

  it("reminds the player of a booked debate from five minutes before it starts", () => {
    const later = state({ upcoming: upcoming(400) });
    assert.equal(dueDebate(later, now), null);
    assert.equal(untilReminder(later, now), 100_000);
    assert.equal(pillText(later, now), null);
    const soon = state({ upcoming: upcoming(252) });
    assert.equal(dueDebate(soon, now)?.slug, "booked-1");
    assert.equal(untilReminder(soon, now), null);
    assert.equal(pillText(soon, now), "Debate in 4:12");
    assert.equal(pillHref(soon, now), "/debates/booked-1");
    assert.equal(pillText(soon, now, "booked-1"), null);
    assert.equal(pillDescription(soon), "Canada should expand nuclear power");
    const started = state({ upcoming: upcoming(-60) });
    assert.equal(pillText(started, now), "Join your debate");
    assert.equal(dueDebate(state({ upcoming: upcoming(-600) }), now), null);
    assert.equal(untilReminder(state(), now), null);
    assert.equal(pillHref(state(), now), "/match");
  });

  it("counts down on the booked debate's own page", () => {
    assert.equal(
      bookedBannerText(state({ upcoming: upcoming(252) }), "booked-1", now),
      "Your debate starts in 4:12. It begins once both speakers have joined.",
    );
    assert.equal(
      bookedBannerText(state({ upcoming: upcoming(-60) }), "booked-1", now),
      "Waiting for both speakers to join · 9:00 left",
    );
    assert.equal(
      bookedBannerText(state({ upcoming: upcoming(252) }), "other", now),
      null,
    );
    assert.equal(
      bookedBannerText(state({ upcoming: upcoming(400) }), "booked-1", now),
      null,
    );
  });

  it("says once when a now challenge stops waiting", () => {
    const waiting = state({ challenge: challenge("outgoing") });
    assert.equal(challengeNotice(waiting, waiting, now), null);
    assert.equal(challengeNotice(null, waiting, now), null);
    assert.match(challengeNotice(waiting, state(), now), /@riley declined/);
    assert.match(
      challengeNotice(
        state({ challenge: challenge("outgoing", -1) }),
        state(),
        now,
      ),
      /@riley didn't answer in time/,
    );
    assert.match(
      challengeNotice(
        state({ challenge: challenge("incoming", -1) }),
        state(),
        now,
      ),
      /2 minutes to answer are over/,
    );
    assert.match(
      challengeNotice(
        state({ challenge: challenge("incoming") }),
        state(),
        now,
      ),
      /withdrawn/,
    );
    // An accepted challenge opens its debate instead.
    assert.equal(
      challengeNotice(waiting, state({ debate: debate("scheduled") }), now),
      null,
    );
  });

  it("opens the debate when the other player accepts this player's now challenge", () => {
    const waiting = state({ challenge: challenge("outgoing") });
    const accepted = state({ debate: debate("scheduled") });
    assert.equal(shouldOpenDebate(waiting, accepted, "/match"), true);
    assert.equal(
      shouldOpenDebate(waiting, accepted, "/debates/debate-1"),
      false,
    );
    assert.equal(shouldOpenDebate(waiting, state(), "/match"), false);
    assert.equal(shouldOpenDebate(state(), accepted, "/match"), false);
  });
});
