// Rules for the queue overlay (docs/queue-overlay.md): the full-screen waiting
// screen and the in-place match countdown. frontend/queue-overlay.ts draws
// them; the server decides every outcome. The countdown's tiles follow the
// debate page's turn clock (frontend/turn-clock-logic.ts).
import { inscribe } from "../src/features/discovery/inscribe.ts";
import {
  clock,
  secondsSince,
  secondsUntil,
  type ClosedReason,
  type QueueState,
} from "./matchmaking-logic.js";
import { WARNING_SECONDS, type ClockState } from "./turn-clock-logic.js";

/** The server's accept window (src/features/matching/timings.ts). */
export const OFFER_SECONDS = 30;
/** "Entering the arena" shows this long before the debate opens. */
export const ENTER_MS = 600;
/** Each quote holds this long, then its words rise out over QUOTE_OUT_MS. */
export const QUOTE_HOLD_MS = 7000;
export const QUOTE_OUT_MS = 450;
/** The ticket whose overlay the player folded into the header pill. */
export const FOLD_KEY = "yaparena.queueOverlay.folded";
/** The device check stays valid on the server for 30 minutes; reuse it a bit less. */
export const DEVICE_CHECK_REUSE_MS = 25 * 60 * 1000;

export type OverlayPhase = "waiting" | "match" | "entering" | "closed";

/**
 * The headline track, top to bottom. `lines` are shown in Dydema Capitals
 * (inscribed, set in capitals by CSS) and break onto two lines on phones;
 * `spoken` is what screen readers hear.
 */
export const HEADLINES = [
  { spoken: "Finding other humans…", lines: ["finding", "other humans"] },
  { spoken: "Match found", lines: ["match found"] },
  { spoken: "Entering the arena", lines: ["entering", "the arena"] },
  { spoken: "Match missed", lines: ["match missed"] },
  { spoken: "Match declined", lines: ["match declined"] },
  { spoken: "Queue closed", lines: ["queue closed"] },
].map(({ spoken, lines }) => ({
  spoken,
  lines: lines.map((line) => inscribe(line)),
}));

export function headlineIndex(
  phase: OverlayPhase,
  reason: ClosedReason | null,
) {
  if (phase === "waiting") return 0;
  if (phase === "match") return 1;
  if (phase === "entering") return 2;
  return reason === "missed" ? 3 : reason === "declined" ? 4 : 5;
}

/** Only a missed or declined match offers "Queue again". */
export const canQueueAgain = (reason: ClosedReason | null) =>
  reason === "missed" || reason === "declined";

/**
 * Where the player's ticket stands, for the overlay: null without a ticket.
 * An offered ticket whose offer row is gone (a moment between states) still
 * reads as waiting.
 */
export function ticketPhase(state: QueueState | null) {
  const status = state?.ticket?.status;
  if (!status) return null;
  if (status === "offered") return state.offer ? "match" : "waiting";
  if (status === "searching") return "waiting";
  return status;
}

/**
 * Whether the overlay should be showing for this state: on a match, and while
 * waiting unless the player folded this ticket into the header pill.
 */
export function wantsOverlay(state: QueueState | null, folded: string | null) {
  const phase = ticketPhase(state);
  if (phase === "match") return true;
  return phase === "waiting" && folded !== state?.ticket?.id;
}

/** The time in the emblem's hole, its label and its accessible name. */
export function holeView(
  phase: OverlayPhase,
  state: QueueState | null,
  now: number,
) {
  if (phase === "waiting" && state?.ticket) {
    const elapsed = secondsSince(state.ticket.queuedAt, now);
    return {
      number: clock(elapsed),
      label: inscribe("in queue"),
      name: `${elapsed} second${elapsed === 1 ? "" : "s"} in the queue`,
      warm: false,
    };
  }
  if (phase === "match" && state?.offer) {
    const left = secondsUntil(state.offer.deadlineAt, now);
    return {
      number: String(left),
      label: inscribe("seconds to accept"),
      name: `${left} second${left === 1 ? "" : "s"} left to accept`,
      warm: left <= WARNING_SECONDS,
    };
  }
  if (phase === "entering")
    return {
      number: "go",
      label: inscribe("opening the debate"),
      name: "Opening the debate",
      warm: false,
    };
  return { number: "", label: "", name: "", warm: false };
}

/** The countdown's state for the shared turn-clock rules. */
export function matchClock(
  deadlineAt: string,
  now: number,
  reduced: boolean,
  sinceStart: number | null,
): ClockState {
  const state: ClockState = {
    phase: "running",
    left: (new Date(deadlineAt).getTime() - now) / 1000,
    total: OFFER_SECONDS,
    reduced,
  };
  // A page that opened mid-offer has no start to time the sweep from.
  if (sinceStart !== null) state.sinceStart = sinceStart;
  return state;
}

type Offer = NonNullable<QueueState["offer"]>;

/** The opponent's first name, or null when their profile is hidden. */
export function firstName(offer: Offer) {
  return offer.opponent.displayName?.trim().split(/\s+/)[0] || null;
}

/** Up to two initials for a player's card. */
export function initials(name: string | null) {
  const letters = (name ?? "")
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("");
  return letters.slice(0, 2).toUpperCase() || "?";
}

/**
 * The two player cards. A card lights up once that player accepts, in the
 * countdown's colour: coral with the number in the last 10 seconds, white
 * otherwise and while the debate opens.
 */
export function cardsView(offer: Offer, entering: boolean, now: number) {
  const mine = offer.acceptedByMe || entering;
  const theirs = offer.acceptedByOpponent || entering;
  return {
    me: { lit: mine, state: mine ? "Accepted" : "Your move" },
    them: { lit: theirs, state: theirs ? "Accepted" : "Deciding" },
    warm: !entering && secondsUntil(offer.deadlineAt, now) <= WARNING_SECONDS,
  };
}

/** The line under the cards, with the opponent's first name where it has one. */
export function matchStatus(offer: Offer, entering: boolean) {
  const name = firstName(offer);
  if (entering || (offer.acceptedByMe && offer.acceptedByOpponent))
    return "Both accepted. Opening your debate…";
  if (offer.acceptedByMe)
    return `You accepted. Waiting for ${name ?? "the other player"}…`;
  if (offer.acceptedByOpponent)
    return `${name ?? "The other player"} accepted.`;
  return "Accept within 30 seconds.";
}

/** The side line above the topic: shown in Dydema, and as screen readers hear it. */
export function topicSide(sideLabel: string) {
  return {
    shown: inscribe("you argue"),
    side: inscribe(sideLabel.toLowerCase()),
    spoken: `You argue ${sideLabel} on the topic`,
  };
}

/** A quote's name in Dydema (inscribed), set in capitals by CSS. */
export const quoteAuthor = (author: string) => inscribe(author.toLowerCase());

/**
 * The next quote: picked with the random source from those not shown yet this
 * round, so none repeats until all have shown and none shows twice in a row.
 * Start a round with `remaining` empty and `current` -1. `count` is how many
 * quotes there are (frontend/queue-quotes.ts).
 */
export function pickQuote(
  remaining: readonly number[],
  current: number,
  count: number,
  random: () => number,
) {
  const pool = remaining.length
    ? [...remaining]
    : Array.from({ length: count }, (_, index) => index).filter(
        (index) => index !== current,
      );
  const at = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const [index] = pool.splice(at, 1);
  return { index: index ?? 0, remaining: pool };
}

/** Motion the overlay leaves out when the player asks for reduced motion. */
export function motionPlan(reduced: boolean) {
  return {
    bursts: !reduced,
    rotateQuotes: !reduced,
    sweep: !reduced,
    enterDelay: reduced ? 0 : ENTER_MS,
    revealCardsAfter: reduced ? 0 : 400,
  };
}
