// Pure logic for the debate betting panel (Decision 0013): terms, formatting
// and which turn window a viewer can join. No DOM access, so tests can import
// the built module directly.

export type StakeSide = "YES" | "NO";
export type SpeakingSide = "A" | "B";
export type EligibilityReason =
  | "debater"
  | "committed"
  | "debate_unavailable"
  | "closed"
  | "paused"
  | "full"
  | "later_window";
export interface Fraction {
  n: string;
  d: string;
}
export interface RecordingSpan {
  startSeconds: number;
  endSeconds: number;
}

/** One turn window in the anonymous list (timing and state only). */
export interface PublicWindow {
  id: string;
  turnNumber: number;
  side: SpeakingSide;
  opensAt: string;
  closesAt: string;
  state: "open" | "settled" | "void";
  voidReason: "debate_unavailable" | "operator_cancelled" | null;
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
  recording?: RecordingSpan | null;
}
export interface PublicWindows {
  debateId: string;
  eventStatus: string;
  serverNow: string;
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
  windows: PublicWindow[];
}

/** One round in the signed-in view, with this viewer's own order. */
export interface StakeRound {
  id: string;
  kind: "turn" | "manual";
  turnNumber: number | null;
  side: SpeakingSide | null;
  state: "open" | "settled" | "void";
  voidReason: "debate_unavailable" | "operator_cancelled" | null;
  opensAt: string;
  closesAt: string;
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
  participants: number;
  eligibility: {
    canTakePosition: boolean;
    reason: EligibilityReason | null;
    via: "live" | "replay" | null;
  };
  recording?: RecordingSpan | null;
  own: {
    side: StakeSide;
    limit: string;
    quantity: number;
    requestId: string;
    replayPositionMs?: number | null;
  } | null;
  pricing?: { price: Fraction | null; share: Fraction | null };
  outcome?: {
    executed: boolean;
    premium: string;
    fee: string;
    payout: string;
    net: string;
  };
}

export const sizeChoices = [5, 10, 25, 50, 100] as const;
export const maximumSize = 100;

/** Whole cents per contract (1–99) for a read of the yes share (1–99 %). */
export function ceilingCents(side: StakeSide, readPercent: number) {
  const read = Math.min(99, Math.max(1, Math.round(readPercent)));
  return side === "YES" ? read : 100 - read;
}

/** The submit body's ceiling, a decimal from 0 to 1 with two places. */
export function ceilingText(cents: number) {
  return `0.${String(cents).padStart(2, "0")}`;
}

/** A whole size from 1 to 100, or null when the text isn't one. */
export function parseSize(text: string) {
  if (!/^[1-9][0-9]{0,2}$/.test(text.trim())) return null;
  const size = Number(text.trim());
  return size <= maximumSize ? size : null;
}

/** Cents per contract (1–99) from a typed maximum price, or null. */
export function parseCeiling(text: string) {
  const match = /^0?\.([0-9]{1,2})$|^([0-9]{1,2})¢?$/.exec(text.trim());
  if (!match) return null;
  const cents = match[1]
    ? Number(match[1].padEnd(2, "0"))
    : Number(match[2] ?? "0");
  return cents >= 1 && cents <= 99 ? cents : null;
}

/** Yap Coins with two decimals, from hundredths of a coin. */
export function coins(hundredths: number) {
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")} YC`;
}

/** The terms a ticket shows before the viewer confirms. */
export function ticketTerms(size: number, cents: number) {
  return {
    reserved: coins(size * 100),
    mostYouCanLose: coins(size * cents),
  };
}

// 10,000 atomic units are one Yap Coin, for cash and grant principal alike.
const atomsPerCoin = 10_000n;

/** Signed Yap Coins with two decimals, from atomic units. */
export function signedCoins(atoms: string | bigint) {
  const value = BigInt(atoms);
  const magnitude = value < 0n ? -value : value;
  const hundredths = (magnitude * 100n) / atomsPerCoin;
  const text = `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}`;
  return `${value < 0n ? "−" : value > 0n ? "+" : ""}${text} YC`;
}

/** A fraction as whole percent, or null when it is missing. */
export function percent(value: Fraction | null | undefined) {
  if (!value) return null;
  const d = Number(value.d);
  return d ? Math.round((Number(value.n) / d) * 100) : null;
}

/** "Maya speaking (People first)", never a Yes or No side. */
export function speakerLine(
  side: SpeakingSide | null,
  speakers: { A: string; B: string },
  labels: { A: string; B: string },
) {
  if (!side) return "Between turns";
  return `${speakers[side]} speaking (${labels[side]})`;
}

/** The window taking live orders at the server-adjusted time, if any. */
export function liveWindow(
  windows: readonly PublicWindow[],
  serverNow: number,
) {
  return (
    windows.find(
      (window) =>
        window.state === "open" &&
        Date.parse(window.opensAt) <= serverNow &&
        serverNow < Date.parse(window.closesAt),
    ) ?? null
  );
}

/** The turn window whose recording span holds a replay position, if any. */
export function replayRound(
  rounds: readonly StakeRound[],
  positionSeconds: number,
) {
  return (
    rounds.find(
      (round) =>
        round.kind === "turn" &&
        round.recording != null &&
        round.recording.startSeconds <= positionSeconds &&
        positionSeconds < round.recording.endSeconds,
    ) ?? null
  );
}

/**
 * The window of the turn playing in a five-day replay, before its 120-hour
 * close (F10). Per-round debates take live positions only.
 */
export function replayWindow(
  windows: readonly PublicWindow[],
  positionSeconds: number,
  serverNow: number,
) {
  return (
    windows.find(
      (window) =>
        window.revealMode === "five_day" &&
        (window.revealAt === null || serverNow < Date.parse(window.revealAt)) &&
        window.recording != null &&
        window.recording.startSeconds <= positionSeconds &&
        positionSeconds < window.recording.endSeconds,
    ) ?? null
  );
}

/** Seconds left until a deadline, never negative. */
export function secondsLeft(deadline: string, serverNow: number) {
  return Math.max(0, Math.ceil((Date.parse(deadline) - serverNow) / 1000));
}

/** "0:42" for a countdown. */
export function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Why the viewer can't take a position, in the panel's words. */
export function reasonText(reason: EligibilityReason | null) {
  switch (reason) {
    case "debater":
      return "You're in this debate, so you can't answer here.";
    case "committed":
      return "You already answered this turn.";
    case "debate_unavailable":
      return "This debate isn't taking answers.";
    case "closed":
      return "This turn's window is closed.";
    case "paused":
      return "Your Yap Coins are paused for a correction review.";
    case "full":
      return "This turn's window is full.";
    case "later_window":
      return "You already answered a later turn, so you can't go back to this one.";
    default:
      return "";
  }
}

/**
 * The read (1–99 %) behind a position's yes-scale limit. A Yes ceiling is the
 * read and a No ceiling is 100 minus it, so the limit is the read either way.
 */
export function readFromLimit(limit: string) {
  return Math.min(99, Math.max(1, Math.round(Number(limit) * 100)));
}

/** The viewer's latest turn position before a turn, for "Same as last turn". */
export function lastPosition(
  rounds: readonly StakeRound[],
  beforeTurn: number,
) {
  let last: StakeRound | null = null;
  for (const round of rounds)
    if (
      round.kind === "turn" &&
      round.own &&
      round.turnNumber !== null &&
      round.turnNumber < beforeTurn &&
      (last === null || round.turnNumber > (last.turnNumber ?? 0))
    )
      last = round;
  return last;
}

/** "Same as last turn · Yes · 10 · read 62%". */
export function repeatLabel(own: NonNullable<StakeRound["own"]>) {
  return `Same as last turn · ${own.side === "YES" ? "Yes" : "No"} · ${own.quantity} · read ${readFromLimit(own.limit)}%`;
}

/** A size and read saved on this device with "Get ready". */
export interface StakeDefaults {
  size: number;
  read: number;
}

/** Saved "Get ready" defaults from device storage, or null when unusable. */
export function parseDefaults(text: string | null): StakeDefaults | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("size" in value) ||
    !("read" in value)
  )
    return null;
  const { size, read } = value;
  return typeof size === "number" &&
    typeof read === "number" &&
    Number.isInteger(size) &&
    Number.isInteger(read) &&
    size >= 1 &&
    size <= maximumSize &&
    read >= 1 &&
    read <= 99
    ? { size, read }
    : null;
}

const byTurn = (a: StakeRound, b: StakeRound) =>
  (a.turnNumber ?? 0) - (b.turnNumber ?? 0);

/** The viewer's turn positions split into revealed and still locked. */
export function resultsSummary(rounds: readonly StakeRound[]) {
  const mine = rounds
    .filter((round) => round.kind === "turn" && round.own)
    .sort(byTurn);
  const revealed = mine.filter(
    (round) =>
      round.state === "void" ||
      (round.state === "settled" && round.outcome !== undefined),
  );
  const locked = mine.filter((round) => !revealed.includes(round));
  const net = revealed.reduce(
    (sum, round) =>
      round.state === "settled" && round.outcome
        ? sum + BigInt(round.outcome.net)
        : sum,
    0n,
  );
  return { revealed, locked, net };
}

/** "Results are in · +3.40 YC across 4 turns". */
export function resultsHeading(
  summary: Pick<
    ReturnType<typeof resultsSummary>,
    "revealed" | "locked" | "net"
  >,
) {
  const count = summary.revealed.length;
  return `${summary.locked.length ? "Results so far" : "Results are in"} · ${signedCoins(summary.net)} across ${count} ${count === 1 ? "turn" : "turns"}`;
}

/**
 * One revealed position: "Turn 3 · Yes · 10 · paid 54¢ each · 58% said yes ·
 * +0.40 YC". Prices are from the position's side: a No pays 100 minus the
 * drawn yes price.
 */
export function resultLine(round: StakeRound) {
  const own = round.own;
  if (!own) return "";
  const head = `Turn ${round.turnNumber} · ${own.side === "YES" ? "Yes" : "No"} · ${own.quantity}`;
  if (round.state === "void") return `${head} · voided · refunded`;
  const yes = percent(round.pricing?.price);
  const sidePrice = yes === null ? null : own.side === "YES" ? yes : 100 - yes;
  const share = percent(round.pricing?.share);
  const executed = round.outcome?.executed === true;
  const parts = [head];
  if (executed) {
    if (sidePrice !== null) parts.push(`paid ${sidePrice}¢ each`);
  } else
    parts.push(
      sidePrice === null ? "not filled" : `not filled at ${sidePrice}¢`,
    );
  if (share !== null) parts.push(`${share}% said yes`);
  parts.push(
    executed && round.outcome ? signedCoins(round.outcome.net) : "refunded",
  );
  return parts.join(" · ");
}

/** A position's status line in the "Your positions" list. */
export function positionStatus(
  round: StakeRound,
  when: (iso: string) => string,
) {
  if (round.state === "void")
    return round.voidReason === "debate_unavailable"
      ? "Voided · refunded (debate cancelled or under review)"
      : "Voided · refunded";
  if (round.state === "settled" && round.outcome)
    return round.outcome.executed
      ? `Settled ${signedCoins(round.outcome.net)}`
      : "Not filled · refunded";
  return round.revealAt
    ? `Locked · results ${when(round.revealAt)}`
    : "Locked · results 5 days after the debate ends";
}
