import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatTime,
  mySide,
  opponent,
  opponentHandle,
  proposedTimes,
  requestActions,
  requestSummary,
} from "../public/challenge-logic.js";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const hours = (count) => new Date(now + count * 3600_000).toISOString();
const format = (instant) => `<${instant.slice(11, 16)}>`;
const challenger = "1";
const target = "2";
const request = (overrides = {}) => ({
  id: "request-1",
  kind: "direct",
  status: "open",
  initiatorUserId: challenger,
  targetUserId: target,
  requestedSide: "A",
  sideALabel: "For",
  sideBLabel: "Against",
  proposition: "Canada should expand nuclear power",
  scheduledAt: hours(3),
  expiresAt: hours(24 * 7),
  debateSlug: null,
  topicSlug: "nuclear-power",
  mode: "scheduled",
  respondBy: null,
  proposals: [],
  initiatorHandle: "alex",
  initiatorName: "Alex Chen",
  targetHandle: "riley",
  targetName: "Riley Ortiz",
  ...overrides,
});
const proposal = (id, by, inHours) => ({
  id,
  proposedBy: by,
  startsAt: hours(inHours),
});

describe("challenge screens", () => {
  it("shows times in the viewer's time zone with the zone named", () => {
    const instant = "2026-10-27T23:30:00.000Z";
    assert.match(
      formatTime(instant, { locale: "en-US", timeZone: "America/Toronto" }),
      /Tue, Oct 27, 7:30\sPM EDT/,
    );
    assert.match(
      formatTime(instant, { locale: "en-US", timeZone: "Europe/Paris" }),
      /Wed, Oct 28, 12:30\sAM GMT\+1/,
    );
  });

  it("reads a typed or picked opponent handle", () => {
    assert.equal(opponentHandle(" @Riley-Ortiz "), "riley-ortiz");
    assert.equal(opponentHandle("riley"), "riley");
    assert.equal(opponentHandle("Riley Ortiz"), null);
    assert.equal(opponentHandle("ab"), null);
    assert.equal(opponentHandle(""), null);
  });

  it("checks one to three distinct times, 1 hour to 90 days ahead", () => {
    const local = (inHours) => hours(inHours).slice(0, 16) + "Z";
    assert.deepEqual(proposedTimes([local(5), "", local(2)], now), {
      times: [hours(2), hours(5)],
    });
    assert.deepEqual(proposedTimes(["", " "], now), {
      error: "Propose at least one time.",
    });
    assert.match(proposedTimes([local(0.5)], now).error, /at least 1 hour/);
    assert.match(proposedTimes([local(24 * 91)], now).error, /within 90 days/);
    assert.match(proposedTimes([local(3), local(3)], now).error, /different/);
    assert.match(proposedTimes(["not a time"], now).error, /valid date/);
    assert.match(
      proposedTimes([local(2), local(3), local(4), local(5)], now).error,
      /at most three/,
    );
  });

  it("describes each challenge from the viewer's side", () => {
    assert.deepEqual(mySide(request(), challenger), {
      side: "A",
      label: "For",
    });
    assert.deepEqual(mySide(request(), target), {
      side: "B",
      label: "Against",
    });
    assert.deepEqual(opponent(request(), target), {
      incoming: true,
      handle: "alex",
      name: "Alex Chen",
    });
    assert.equal(
      requestSummary(request(), challenger, now, format),
      "To @riley · Canada should expand nuclear power · you argue For · waiting for an answer · expires <12:00>",
    );
    assert.equal(
      requestSummary(
        request({ mode: "now", scheduledAt: null, respondBy: hours(0.02) }),
        target,
        now,
        format,
      ),
      "From @alex · Canada should expand nuclear power · you argue Against · waiting for an answer · now · answering · expires <12:00>",
    );
    assert.match(
      requestSummary(
        request({ mode: "now", scheduledAt: null }),
        target,
        now,
        format,
      ),
      /now, when you're both online/,
    );
    assert.equal(
      requestSummary(
        request({ status: "accepted", debateSlug: "booked" }),
        target,
        now,
        format,
      ),
      "From @alex · Canada should expand nuclear power · you argue Against · booked · <15:00>",
    );
    assert.equal(
      requestSummary(
        request({ status: "accepted", debateStatus: "cancelled" }),
        target,
        now,
        format,
      ),
      "From @alex · Canada should expand nuclear power · you argue Against · cancelled: a speaker didn't join",
    );
    assert.match(
      requestSummary(
        request({ status: "accepted", debateStatus: "live" }),
        target,
        now,
        format,
      ),
      /live now$/,
    );
    assert.match(
      requestSummary(
        request({ status: "accepted", debateStatus: "finalized" }),
        target,
        now,
        format,
      ),
      /debated$/,
    );
    assert.equal(
      requestSummary(
        request({ targetHandle: null, status: "conflicted" }),
        challenger,
        now,
        format,
      ),
      "To a player · Canada should expand nuclear power · you argue For · closed: a speaker was booked at that time",
    );
    assert.equal(
      requestSummary(
        request({ kind: "queue", targetUserId: null }),
        challenger,
        now,
        format,
      ),
      "Queue: Canada should expand nuclear power · you argue For · waiting for an answer · <15:00>",
    );
  });

  it("offers each player the other's times and their own answers", () => {
    const times = request({
      proposals: [proposal("p1", challenger, 3), proposal("p2", challenger, 5)],
    });
    const forTarget = requestActions(times, target);
    assert.deepEqual(
      forTarget.theirTimes.map((entry) => entry.id),
      ["p1", "p2"],
    );
    assert.deepEqual(forTarget.myTimes, []);
    assert.equal(forTarget.decline, true);
    assert.equal(forTarget.withdraw, false);
    assert.equal(forTarget.acceptOriginal, false);
    const forChallenger = requestActions(times, challenger);
    assert.deepEqual(forChallenger.theirTimes, []);
    assert.equal(forChallenger.myTimes.length, 2);
    assert.equal(forChallenger.withdraw, true);
    assert.equal(forChallenger.decline, false);
    assert.equal(forChallenger.propose, true);
  });

  it("lets the target accept a now challenge, and an older request at its time", () => {
    const immediate = request({ mode: "now", scheduledAt: null });
    assert.equal(requestActions(immediate, target).acceptNow, true);
    assert.equal(requestActions(immediate, challenger).acceptNow, false);
    const countered = request({
      mode: "now",
      scheduledAt: hours(4),
      proposals: [proposal("p3", target, 4)],
    });
    assert.equal(requestActions(countered, target).acceptNow, false);
    assert.equal(requestActions(countered, challenger).theirTimes.length, 1);
    assert.equal(requestActions(request(), target).acceptOriginal, true);
    assert.equal(requestActions(request(), challenger).acceptOriginal, false);
  });

  it("offers nothing on a closed request", () => {
    const closed = requestActions(
      request({
        status: "accepted",
        proposals: [proposal("p1", challenger, 3)],
      }),
      target,
    );
    assert.deepEqual(closed, {
      acceptNow: false,
      acceptOriginal: false,
      theirTimes: [],
      myTimes: [],
      propose: false,
      decline: false,
      withdraw: false,
    });
    const queue = requestActions(
      request({ kind: "queue", targetUserId: null }),
      challenger,
    );
    assert.equal(queue.propose, false);
    assert.equal(queue.withdraw, true);
  });
});
