// Decision 0016 point 7: the turn result plate on the phone's full screen.
// Pure rules for which of the viewer's own turn positions were just revealed,
// what the plate says about each and how its pixel bits fly. No DOM access,
// so tests import the built module.
import { formatFixedHundredths } from "./lib/coin-format.js";
import type { StakeRound } from "./stake-model.js";

export type TurnResultTone = "win" | "loss" | "even";

/** What one plate shows and announces. */
export interface TurnResult {
  roundId: string;
  turnNumber: number;
  tone: TurnResultTone;
  /** "YOU WON", "YOU LOST" or "BROKE EVEN". */
  word: string;
  /** The result's size in whole hundredths of a Yap Coin, cut, never rounded up. */
  hundredths: number;
  /** The final figure: "+1.00", "−0.50" (a real minus sign) or "0.00". */
  amountText: string;
  /** Wins in a row through this turn (see winStreak). */
  streak: number;
  /** "3 WINS IN A ROW" from the second win in a row; null otherwise. */
  streakText: string | null;
  /** The one polite announcement: "Turn 4: you won 1.00 Yap Coins." */
  announcement: string;
}

/** A filled turn position whose result is revealed: the only kind that pops. */
type FilledRound = StakeRound & {
  kind: "turn";
  turnNumber: number;
  own: NonNullable<StakeRound["own"]>;
  outcome: NonNullable<StakeRound["outcome"]>;
};

/**
 * True for the viewer's own turn position once it is settled with an
 * executed order. A void window or an unfilled order is refunded, so it
 * shows nothing.
 */
export function isFilledResult(round: StakeRound): round is FilledRound {
  return (
    round.kind === "turn" &&
    round.turnNumber !== null &&
    round.own !== null &&
    round.state === "settled" &&
    round.outcome?.executed === true
  );
}

const atomsPerHundredth = 100n;

/** The result's size in whole hundredths, cut like every coin figure. */
function hundredthsOf(net: string) {
  const value = BigInt(net);
  return Number((value < 0n ? -value : value) / atomsPerHundredth);
}

/**
 * Win, loss or even. A result under 0.01 YC either way shows "0.00", so it
 * counts as breaking even, as the prototype's half-hundredth threshold did.
 */
export function resultTone(net: string): TurnResultTone {
  if (hundredthsOf(net) === 0) return "even";
  return BigInt(net) > 0n ? "win" : "loss";
}

/**
 * The plate's figure for a tone and a number of hundredths: "+1.00",
 * "−0.50" or "0.00". The count-up shows each frame through this, so the sign
 * is there from the first frame.
 */
export function amountText(tone: TurnResultTone, hundredths: number) {
  const sign = tone === "win" ? "+" : tone === "loss" ? "−" : "";
  return `${sign}${formatFixedHundredths(hundredths)}`;
}

const words: Record<TurnResultTone, string> = {
  win: "YOU WON",
  loss: "YOU LOST",
  even: "BROKE EVEN",
};

/**
 * Wins in a row through a turn: the viewer's filled, revealed turn positions
 * in this debate, counted back from that turn (inclusive) while they win.
 * - A loss ends the run, so a loss's own streak is 0.
 * - Breaking even neither adds to the run nor ends it.
 * - A turn the viewer didn't answer, a void window, an unfilled order and a
 *   turn still waiting for its reveal are skipped: they don't end the run.
 */
export function winStreak(rounds: readonly StakeRound[], throughTurn: number) {
  const filled = rounds
    .filter(isFilledResult)
    .filter((round) => round.turnNumber <= throughTurn)
    .sort((a, b) => b.turnNumber - a.turnNumber);
  let streak = 0;
  for (const round of filled) {
    const tone = resultTone(round.outcome.net);
    if (tone === "loss") break;
    if (tone === "win") streak += 1;
  }
  return streak;
}

/** The plate for one filled, revealed position, among all the viewer's rounds. */
export function turnResult(
  round: FilledRound,
  rounds: readonly StakeRound[],
): TurnResult {
  const tone = resultTone(round.outcome.net);
  const hundredths = hundredthsOf(round.outcome.net);
  const streak = tone === "win" ? winStreak(rounds, round.turnNumber) : 0;
  const streakText = streak >= 2 ? `${streak} WINS IN A ROW` : null;
  const coins = `${formatFixedHundredths(hundredths)} Yap Coins`;
  const said =
    tone === "win"
      ? `you won ${coins}${streakText ? `, ${streak} wins in a row` : ""}`
      : tone === "loss"
        ? `you lost ${coins}`
        : "you broke even";
  return {
    roundId: round.id,
    turnNumber: round.turnNumber,
    tone,
    word: words[tone],
    hundredths,
    amountText: amountText(tone, hundredths),
    streak,
    streakText,
    announcement: `Turn ${round.turnNumber}: ${said}.`,
  };
}

/**
 * The plates for a new read of the viewer's rounds, oldest turn first, and
 * the ids already accounted for. `seen` is null on the first read the plate
 * watches: every result in it is taken as already seen, so opening the page
 * or the full screen never replays old results. After that, a filled
 * position pops once, the first time a read shows it revealed, even if an
 * earlier read missed its window or a later read loses it again.
 */
export function revealedTurnResults(
  seen: ReadonlySet<string> | null,
  rounds: readonly StakeRound[],
) {
  const filled = rounds.filter(isFilledResult);
  const next = new Set(seen ?? []);
  for (const round of filled) next.add(round.id);
  if (seen === null) return { seen: next, results: [] as TurnResult[] };
  const results = filled
    .filter((round) => !seen.has(round.id))
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((round) => turnResult(round, rounds));
  return { seen: next, results };
}

/** One pixel bit of the burst, on a ray from the plate's centre. */
export interface BurstBit {
  /** The ray's angle in degrees, clockwise from straight up. */
  angle: number;
  /** Flies the near distance; otherwise the far one. */
  near: boolean;
  /** A loss shard, which falls instead of flying out. */
  drop: boolean;
  /** 6 px instead of 8 px. */
  small: boolean;
  /** White on a win, grey on a loss, instead of the tone's colour. */
  alt: boolean;
  delayMs: number;
}

/**
 * The prototype's burst: a win sends 16 bits out at 22.5° steps, jittered
 * +7° and −5° in turn; a loss drops 7 shards between 150° and 210°; breaking
 * even stays still.
 */
export function burstBits(tone: TurnResultTone): BurstBit[] {
  if (tone === "win")
    return Array.from({ length: 16 }, (_, i) => ({
      angle: i * 22.5 + (i % 2 ? 7 : -5),
      near: i % 2 === 1,
      drop: false,
      small: i % 3 === 0,
      alt: i % 3 === 1,
      delayMs: 100 + (i % 3) * 40,
    }));
  if (tone === "loss")
    return Array.from({ length: 7 }, (_, i) => ({
      angle: 150 + i * 10,
      near: false,
      drop: true,
      small: i % 2 === 1,
      alt: i % 2 === 1,
      delayMs: 380 + i * 30,
    }));
  return [];
}

/** How long a plate stays, matching its 3.6 s pop-and-fade animation. */
export const PLATE_MS = 3600;
/** The count-up waits for the pop, then runs for this long. */
export const COUNT_DELAY_MS = 280;
export const COUNT_MS = 720;

/** The count-up's hundredths at a time since the plate appeared (ease-out cubic). */
export function countedHundredths(hundredths: number, elapsedMs: number) {
  const progress = Math.min(
    1,
    Math.max(0, (elapsedMs - COUNT_DELAY_MS) / COUNT_MS),
  );
  return Math.round(hundredths * (1 - Math.pow(1 - progress, 3)));
}
