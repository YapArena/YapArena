// Rules for the Match page's challenge form and list (Decision 0011). frontend/matching.ts draws
// them; the server checks every limit again and decides every outcome.
import type { MatchingProposal, MatchingRequest } from "./matching-types.js";

const HOUR_MS = 60 * 60 * 1000;
/** Proposed times must be 1 hour to 90 days ahead (the server's PROPOSAL_MIN_LEAD_MINUTES). */
export const PROPOSAL_MIN_LEAD_MS = HOUR_MS;
export const PROPOSAL_MAX_LEAD_MS = 90 * 24 * HOUR_MS;
const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** A time in the viewer's time zone, with the zone named so both players read it the same. */
export function formatTime(
  instant: string,
  options: { locale?: string; timeZone?: string } = {},
) {
  return new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(new Date(instant));
}

/** The handle typed or picked in the opponent field, or null when it can't be one. */
export function opponentHandle(value: string) {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  return handlePattern.test(handle) ? handle : null;
}

/** One to three distinct times from datetime-local fields, or the reason they can't be sent. */
export function proposedTimes(
  values: readonly string[],
  now: number,
): { times: string[] } | { error: string } {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (!filled.length) return { error: "Propose at least one time." };
  if (filled.length > 3) return { error: "Propose at most three times." };
  const times = filled.map((value) => new Date(value).getTime());
  if (times.some((time) => !Number.isFinite(time)))
    return { error: "Choose a valid date and time." };
  if (times.some((time) => time < now + PROPOSAL_MIN_LEAD_MS))
    return { error: "Proposed times must be at least 1 hour ahead." };
  if (times.some((time) => time > now + PROPOSAL_MAX_LEAD_MS))
    return { error: "Proposed times must be within 90 days." };
  if (new Set(times).size !== times.length)
    return { error: "Propose different times." };
  return {
    times: times
      .sort((left, right) => left - right)
      .map((time) => new Date(time).toISOString()),
  };
}

/** The side this player argues and its label. */
export function mySide(request: MatchingRequest, userId: string) {
  const side =
    request.initiatorUserId === userId
      ? request.requestedSide
      : request.requestedSide === "A"
        ? "B"
        : "A";
  return {
    side,
    label: side === "A" ? request.sideALabel : request.sideBLabel,
  };
}

/** The other player in a direct challenge, by handle and name when their profile is known. */
export function opponent(request: MatchingRequest, userId: string) {
  const incoming = request.initiatorUserId !== userId;
  const handle = incoming ? request.initiatorHandle : request.targetHandle;
  const name = incoming ? request.initiatorName : request.targetName;
  return { incoming, handle: handle ?? null, name: name ?? null };
}

// An accepted request's debate, as the list says it.
const debateLabels: Record<string, string> = {
  live: "live now",
  ended: "debated",
  replay: "debated",
  void_review: "debated",
  finalized: "debated",
  cancelled: "cancelled: a speaker didn't join",
};

const statusLabels: Record<string, string> = {
  open: "waiting for an answer",
  accepted: "booked",
  declined: "declined",
  withdrawn: "withdrawn",
  expired: "expired",
  conflicted: "closed: a speaker was booked at that time",
};

/** The list entry's text, without its buttons. */
export function requestSummary(
  request: MatchingRequest,
  userId: string,
  now: number,
  format: (instant: string) => string = formatTime,
) {
  const { label } = mySide(request, userId);
  const status =
    (request.status === "accepted" && request.debateStatus
      ? debateLabels[request.debateStatus]
      : undefined) ??
    statusLabels[request.status] ??
    request.status;
  if (request.kind !== "direct")
    return `Queue: ${request.proposition} · you argue ${label} · ${status}${request.scheduledAt ? ` · ${format(request.scheduledAt)}` : ""}`;
  const other = opponent(request, userId);
  const who = other.handle ? `@${other.handle}` : "a player";
  const parts = [
    `${other.incoming ? "From" : "To"} ${who}`,
    request.proposition,
    `you argue ${label}`,
    status,
  ];
  if (status === "booked" && request.scheduledAt)
    parts.push(format(request.scheduledAt));
  else if (request.status === "open") {
    if (request.mode === "now" && !request.proposals?.length) {
      const answering =
        request.respondBy && new Date(request.respondBy).getTime() > now;
      parts.push(
        answering ? "now · answering" : "now, when you're both online",
      );
    }
    parts.push(`expires ${format(request.expiresAt)}`);
  }
  return parts.join(" · ");
}

export interface RequestActions {
  /** Accept a "now" challenge: the target, while the challenge has no proposed times. */
  acceptNow: boolean;
  /** Accept at the original time: a request opened before time proposals, by its target. */
  acceptOriginal: boolean;
  /** The other player's proposed times, each acceptable. */
  theirTimes: MatchingProposal[];
  /** This player's proposed times, waiting for the other player. */
  myTimes: MatchingProposal[];
  propose: boolean;
  decline: boolean;
  withdraw: boolean;
}

/** Which answers this player can give to an open request. */
export function requestActions(
  request: MatchingRequest,
  userId: string,
): RequestActions {
  const open = request.status === "open";
  const direct = request.kind === "direct";
  const target = request.targetUserId === userId;
  const proposals = open && direct ? (request.proposals ?? []) : [];
  return {
    acceptNow:
      open && direct && target && request.mode === "now" && !proposals.length,
    acceptOriginal:
      open &&
      direct &&
      target &&
      request.mode !== "now" &&
      !proposals.length &&
      request.scheduledAt !== null,
    theirTimes: proposals.filter((proposal) => proposal.proposedBy !== userId),
    myTimes: proposals.filter((proposal) => proposal.proposedBy === userId),
    propose: open && direct,
    decline: open && target,
    withdraw: open && request.initiatorUserId === userId,
  };
}
