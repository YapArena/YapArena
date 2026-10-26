// Rules for the live queue and challenge screens (Decision 0011). frontend/matchmaking.ts draws
// them; the server decides every outcome, and these only describe its state to the player.

export type Side = "A" | "B";
export type ClosedReason =
  | "left"
  | "declined"
  | "missed"
  | "stale"
  | "unavailable"
  | "topic_closed"
  | "booking";

export interface QueueState {
  serverNow: string;
  ticket: {
    id: string;
    topicSlug: string;
    topicTitle: string;
    side: Side;
    sideLabel: string;
    status: "searching" | "offered" | "matched" | "closed";
    closedReason: ClosedReason | null;
    queuedAt: string;
  } | null;
  offer: {
    id: string;
    deadlineAt: string;
    acceptedByMe: boolean;
    acceptedByOpponent: boolean;
  } | null;
  debate: {
    id: string;
    slug: string;
    status: string;
    joinDeadlineAt: string;
  } | null;
  // A "now" challenge being answered: incoming for the target, outgoing for the challenger.
  challenge: {
    id: string;
    direction: "incoming" | "outgoing";
    handle: string;
    displayName: string;
    topicTitle: string;
    sideLabel: string;
    respondBy: string;
  } | null;
  // The player's next booked debate, from a day ahead until its join window closes.
  upcoming: {
    id: string;
    slug: string;
    status: string;
    proposition: string;
    startsAt: string;
    joinDeadlineAt: string;
  } | null;
}

/** Both speakers see a reminder this long before a booked debate starts (Decision 0011). */
export const REMINDER_MS = 5 * 60 * 1000;

export interface Waiting {
  sideA: number;
  sideB: number;
}

/** Milliseconds to add to this device's clock to read the server's. */
export const clockOffset = (state: QueueState, receivedAt: number) =>
  new Date(state.serverNow).getTime() - receivedAt;

export const secondsUntil = (instant: string, now: number) =>
  Math.max(0, Math.ceil((new Date(instant).getTime() - now) / 1000));

export const secondsSince = (instant: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(instant).getTime()) / 1000));

export function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export const isQueued = (state: QueueState | null) =>
  state?.ticket?.status === "searching" || state?.ticket?.status === "offered";

/** A matched debate that has not started yet and is still inside its join window. */
export const isJoining = (state: QueueState | null) =>
  Boolean(
    state?.debate &&
    (state.debate.status === "scheduled" || state.debate.status === "ready"),
  );

export const needsLiveUpdates = (state: QueueState | null) =>
  isQueued(state) || isJoining(state);

/** A "now" challenge still inside its answer window. */
export const isAnswering = (state: QueueState | null, now: number) =>
  Boolean(state?.challenge && secondsUntil(state.challenge.respondBy, now));

/**
 * The booked debate to remind the player of: from five minutes before its start until its join
 * window closes, or null.
 */
export function dueDebate(state: QueueState | null, now: number) {
  const upcoming = state?.upcoming;
  if (!upcoming) return null;
  const start = new Date(upcoming.startsAt).getTime();
  const deadline = new Date(upcoming.joinDeadlineAt).getTime();
  return now >= start - REMINDER_MS && now < deadline ? upcoming : null;
}

/** Milliseconds until the booked debate's reminder opens, or null if it is open or none. */
export function untilReminder(state: QueueState | null, now: number) {
  const upcoming = state?.upcoming;
  if (!upcoming) return null;
  const opens = new Date(upcoming.startsAt).getTime() - REMINDER_MS;
  return opens > now ? opens - now : null;
}

/**
 * The header pill, kept short to fit the header: null when the player is not queued or joining,
 * or is already on the matched debate's page.
 */
export function pillText(state: QueueState | null, now: number, pageSlug = "") {
  if (state?.offer)
    return `Match found · ${clock(secondsUntil(state.offer.deadlineAt, now))}`;
  if (state?.ticket && isQueued(state))
    return `In queue · ${clock(secondsSince(state.ticket.queuedAt, now))}`;
  if (state?.debate && isJoining(state) && state.debate.slug !== pageSlug)
    return "Join your debate";
  const challenge = state?.challenge;
  if (challenge && isAnswering(state, now))
    return `${challenge.direction === "incoming" ? "Challenged" : "Challenge sent"} · ${clock(secondsUntil(challenge.respondBy, now))}`;
  const due = dueDebate(state, now);
  if (due && due.slug !== pageSlug)
    return new Date(due.startsAt).getTime() > now
      ? `Debate in ${clock(secondsUntil(due.startsAt, now))}`
      : "Join your debate";
  return null;
}

/** Where the header pill leads: the queue's topic, the debate, or the challenge list. */
export function pillHref(state: QueueState | null, now: number) {
  if (state?.ticket && isQueued(state))
    return `/topics/${encodeURIComponent(state.ticket.topicSlug)}`;
  if (state?.debate && isJoining(state))
    return `/debates/${encodeURIComponent(state.debate.slug)}`;
  if (isAnswering(state, now)) return "/match";
  const due = dueDebate(state, now);
  return due ? `/debates/${encodeURIComponent(due.slug)}` : "/match";
}

/** The pill's accessible name, with the topic and side the short label leaves out. */
export function pillDescription(state: QueueState | null) {
  const ticket = state?.ticket;
  if (ticket && isQueued(state))
    return `${ticket.topicTitle} · ${ticket.sideLabel}`;
  const challenge = state?.challenge;
  if (challenge)
    return `${challenge.direction === "incoming" ? "From" : "To"} @${challenge.handle} · ${challenge.topicTitle} · ${challenge.sideLabel}`;
  return ticket
    ? `${ticket.topicTitle} · ${ticket.sideLabel}`
    : (state?.upcoming?.proposition ?? "");
}

export function waitingText(waiting: Waiting, sideA: string, sideB: string) {
  if (!waiting.sideA && !waiting.sideB)
    return "Nobody is waiting yet. Queue now and you're first in line.";
  const part = (count: number, label: string) =>
    `${count === 1 ? "1 person" : `${count} people`} waiting for ${label}`;
  return [
    waiting.sideA ? part(waiting.sideA, sideA) : "",
    waiting.sideB ? part(waiting.sideB, sideB) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const closedMessages: Record<ClosedReason, string> = {
  left: "You left the queue.",
  declined: "You declined the match and left the queue.",
  missed: "You didn't accept in time, so you left the queue.",
  stale: "You left the queue because this page was closed or offline.",
  unavailable: "The match was cancelled because you can't debate right now.",
  topic_closed:
    "The match was cancelled because the topic is no longer public.",
  booking: "You left the queue because your scheduled debate starts soon.",
};

/**
 * What changed between two states, worth telling the player once: a match, a return to the
 * queue after a match fell through, or leaving the queue.
 */
export function transitionNotice(
  previous: QueueState | null,
  next: QueueState,
) {
  const before = previous?.ticket;
  const after = next.ticket;
  if (!before || !after) return null;
  if (after.status === "offered" && before.status !== "offered")
    return "Match found. Accept within 30 seconds.";
  if (
    before.status === "offered" &&
    after.status === "searching" &&
    before.id === after.id
  )
    return "The match fell through. You're back in the queue at your place.";
  if (
    before.status === "matched" &&
    after.status === "searching" &&
    before.id !== after.id
  )
    return "Your opponent didn't join in time. You're back in the queue at your place.";
  if (
    after.status === "closed" &&
    before.status !== "closed" &&
    after.closedReason
  )
    return closedMessages[after.closedReason];
  return null;
}

/** The banner above the video on a matched debate's page, or null to hide it. */
export function bannerText(
  state: QueueState | null,
  pageSlug: string,
  now: number,
) {
  const debate = state?.debate;
  if (!debate || debate.slug !== pageSlug) return null;
  if (isJoining(state))
    return `Waiting for both speakers to join · ${clock(secondsUntil(debate.joinDeadlineAt, now))} left`;
  if (debate.status === "cancelled")
    return "This debate was cancelled because a speaker didn't join in time.";
  return null;
}

/** The banner on a booked debate's own page, from five minutes before it starts. */
export function bookedBannerText(
  state: QueueState | null,
  pageSlug: string,
  now: number,
) {
  const due = dueDebate(state, now);
  if (!due || due.slug !== pageSlug) return null;
  return new Date(due.startsAt).getTime() > now
    ? `Your debate starts in ${clock(secondsUntil(due.startsAt, now))}. It begins once both speakers have joined.`
    : `Waiting for both speakers to join · ${clock(secondsUntil(due.joinDeadlineAt, now))} left`;
}

/** What to tell the player once when a "now" challenge stops waiting for an answer. */
export function challengeNotice(
  previous: QueueState | null,
  next: QueueState,
  now: number,
) {
  const before = previous?.challenge;
  if (!before || next.challenge?.id === before.id || next.debate) return null;
  if (!secondsUntil(before.respondBy, now))
    return before.direction === "outgoing"
      ? `@${before.handle} didn't answer in time. Your challenge stays open on the Match page.`
      : "The 2 minutes to answer are over. The challenge stays open on the Match page.";
  return before.direction === "outgoing"
    ? `@${before.handle} declined or the challenge was withdrawn.`
    : "The challenge was withdrawn.";
}

/**
 * Whether to open the matched debate now: only when the match happened while this page was
 * watching, so reopening another page never pulls the player away.
 */
export function shouldOpenDebate(
  previous: QueueState | null,
  next: QueueState,
  currentPath: string,
) {
  const debate = next.debate;
  const matched =
    previous?.ticket?.status === "offered" && next.ticket?.status === "matched";
  // The other player accepted this player's "now" challenge.
  const challengeAccepted = Boolean(previous?.challenge && !next.challenge);
  return (
    debate !== null &&
    (matched || challengeAccepted) &&
    isJoining(next) &&
    currentPath !== `/debates/${debate.slug}`
  );
}
