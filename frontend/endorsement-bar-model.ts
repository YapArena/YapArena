// Decision 0015: what the debate's last-answer bar on the video and its card
// say, from the window list's endorsement block. Pure, so tests import the
// built module; frontend/endorsement-bar.ts puts it on the page.
import type { DebateEndorsement } from "../src/features/endorsement/types.ts";

/** The topic's side labels, and whether side A answers yes (D4). */
export interface BarLabels {
  sideA: string;
  sideB: string;
  sideAIsYes: boolean;
}

/** The figure and when this debate's answers are revealed. */
export interface BarInput {
  endorsement: DebateEndorsement | null;
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
  now: number;
  /** A replay that has not reached its first counted turn yet. */
  waiting?: boolean;
}

export interface BarShare {
  answer: "Yes" | "No";
  label: string;
  percent: number;
}

export interface BarCard {
  heading: string;
  /** Yes then No; empty before the first reveal. */
  shares: BarShare[];
  counts: string | null;
  change: string | null;
  switches: string | null;
  /** Why the bar is empty, when it is. */
  status: string | null;
  footer: string;
}

export interface BarView {
  empty: boolean;
  /** The white share, a whole percentage; 0 while empty. */
  yesPercent: number;
  valueText: string;
  card: BarCard;
}

export const BAR_HEADING = "Last answers in this debate";
export const BAR_FOOTER = "Not a vote, a price or a forecast.";

/** A whole percentage, rounded like the answer panel's shares. */
export function yesPercent(yes: number, accounts: number) {
  return accounts > 0 ? Math.round((yes / accounts) * 100) : 0;
}

const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, word: string) =>
  `${count(value)} ${word}${value === 1 ? "" : "s"}`;

/** "Nov 18 at 3:00 PM EST", in Eastern time like the rest of the page. */
export function revealTime(at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
}

/** The label printed beside each answer: the side's, unless reviewed (D4). */
export function answerLabels(labels: BarLabels) {
  return labels.sideAIsYes
    ? { Yes: labels.sideA, No: labels.sideB }
    : { Yes: "Yes", No: "No" };
}

/** "Since turn 5: +2 pts Yes", "No change since turn 5" or "First revealed turn". */
export function changeText(endorsement: DebateEndorsement) {
  const previous = endorsement.previous;
  if (!previous) return "First revealed turn";
  const delta =
    yesPercent(endorsement.yes, endorsement.accounts) -
    yesPercent(previous.yes, previous.accounts);
  if (delta === 0) return `No change since turn ${previous.throughTurn}`;
  const points = Math.abs(delta);
  return `Since turn ${previous.throughTurn}: ${delta > 0 ? "+" : "−"}${points} ${points === 1 ? "pt" : "pts"} Yes`;
}

/** "120 accounts changed answer: 70 to Yes, 38 to No, 12 changed back". */
export function switchText(endorsement: DebateEndorsement) {
  const { toYes, toNo, cameBack } = endorsement.switched;
  const changed = toYes + toNo + cameBack;
  if (!changed) return "No one changed answer";
  return `${plural(changed, "account")} changed answer: ${count(toYes)} to Yes, ${count(toNo)} to No, ${count(cameBack)} changed back`;
}

/** Why the bar is empty: before a reveal, or a closed debate nobody answered. */
export function emptyStatus(input: Omit<BarInput, "endorsement">) {
  if (input.waiting) return "Fills as each turn plays.";
  if (input.revealMode === "per_round")
    return "Fills after each turn's answers are revealed.";
  const at = input.revealAt === null ? Number.NaN : Date.parse(input.revealAt);
  if (!Number.isFinite(at))
    return "Answers stay hidden until 5 days after the debate.";
  if (at <= input.now) return "No answers were counted in this debate.";
  return `Answers stay hidden until ${revealTime(at)}, 5 days after the debate.`;
}

export function barView(input: BarInput, labels: BarLabels): BarView {
  const endorsement = input.endorsement;
  if (!endorsement || endorsement.accounts <= 0)
    return {
      empty: true,
      yesPercent: 0,
      valueText: "No results revealed yet",
      card: {
        heading: BAR_HEADING,
        shares: [],
        counts: null,
        change: null,
        switches: null,
        status: emptyStatus(input),
        footer: BAR_FOOTER,
      },
    };
  const yes = yesPercent(endorsement.yes, endorsement.accounts);
  const no = 100 - yes;
  const names = answerLabels(labels);
  const named = (percent: number, answer: "Yes" | "No") =>
    labels.sideAIsYes
      ? `${percent}% ${answer}, ${names[answer]}`
      : `${percent}% ${answer}`;
  const accounts = plural(endorsement.accounts, "account");
  return {
    empty: false,
    yesPercent: yes,
    valueText: `${named(yes, "Yes")}; ${named(no, "No")}; ${accounts}`,
    card: {
      heading: BAR_HEADING,
      shares: [
        { answer: "Yes", label: names.Yes, percent: yes },
        { answer: "No", label: names.No, percent: no },
      ],
      counts: `${count(endorsement.yes)} Yes · ${count(endorsement.accounts - endorsement.yes)} No · ${accounts} · through turn ${endorsement.throughTurn}`,
      change: changeText(endorsement),
      switches: switchText(endorsement),
      status: null,
      footer: BAR_FOOTER,
    },
  };
}

/**
 * The card's left edge inside the surface: centred on the share's boundary,
 * flipped back inside near either edge (the chart tooltip's rule).
 */
export function cardLeft(
  surfaceWidth: number,
  cardWidth: number,
  yesShare: number,
  margin = 8,
) {
  const centre = (surfaceWidth * yesShare) / 100;
  const largest = Math.max(margin, surfaceWidth - cardWidth - margin);
  return Math.min(largest, Math.max(margin, centre - cardWidth / 2));
}

/** Where a turn starts in the replay's recording. */
export interface TurnStart {
  turnNumber: number;
  startSeconds: number;
}

/**
 * What the bar shows. Live, and on a replay whose turns have no place in
 * the recording, the latest figure. On a replay, the figure through the turn
 * playing (the last one whose start the position has reached), so a seek or
 * a new turn changes the bar at once; before the first counted turn it waits.
 */
export function shownEndorsement(input: {
  latest: DebateEndorsement | null;
  turns: readonly DebateEndorsement[];
  starts: readonly TurnStart[];
  position: number | null;
}): { endorsement: DebateEndorsement | null; waiting: boolean } {
  const { latest, turns, starts, position } = input;
  if (position === null || !starts.length || !turns.length)
    return { endorsement: latest, waiting: false };
  let playing: number | null = null;
  for (const start of starts)
    if (
      start.startSeconds <= position &&
      (playing === null || start.turnNumber > playing)
    )
      playing = start.turnNumber;
  let shown: DebateEndorsement | null = null;
  if (playing !== null)
    for (const turn of turns) if (turn.throughTurn <= playing) shown = turn;
  return { endorsement: shown, waiting: shown === null };
}
