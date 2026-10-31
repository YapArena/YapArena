// Pure rules for the debate page's turn clock: the landing emblem counting
// down the speaker's turn (direction BC1, docs/debate-page-design.md). The
// same rules as the queue overlay's countdown: one clockwise drain from 12
// o'clock, an ember in the visit's Yappers colour behind the sweep, coral and
// a pulse in the last 10 seconds. frontend/turn-clock.ts draws them.

/** Where the emblem's hole is, as fractions of its box. */
export const HOLE = { x: 0.5, y: 0.5942 } as const;
/** Tiles within this fraction of a turn behind the sweep glow. */
export const EMBER = 0.03;
/** The tiles light clockwise over this many seconds as a turn starts. */
export const REFILL_SECONDS = 0.6;
/** The last seconds of a turn turn coral and pulse. */
export const WARNING_SECONDS = 10;
export const REST_OPACITY = 0.13;
export const SPENT_OPACITY = 0.06;
export const LIT_OPACITY = 0.96;
/** The pulse's lowest opacity, once a second in the last 10 seconds. */
export const PULSE_LOW = 0.62;

export type ClockPhase =
  /** A turn is running (live, or the replay's playing turn). */
  | "running"
  /** No turn runs: upcoming, between turns, paused, replay before Play,
      closed. The ring rests and the hole shows a word. */
  | "rest";

export interface ClockState {
  phase: ClockPhase;
  /** Seconds left in the turn. */
  left: number;
  /** The turn's length in seconds. */
  total: number;
  reduced: boolean;
}

export type TileKind = "lit" | "warn" | "spent" | "ember" | "rest";
export interface TileLook {
  kind: TileKind;
  opacity: number;
}

/**
 * A tile's clockwise angle from 12 o'clock around the hole, as a fraction of
 * a turn (0 at the top, 0.25 at 3 o'clock).
 */
export function tileAngle(
  x: number,
  y: number,
  hole: { x: number; y: number } = HOLE,
) {
  let angle = Math.atan2(x - hole.x, hole.y - y);
  if (angle < 0) angle += 2 * Math.PI;
  return angle / (2 * Math.PI);
}

/** The clock's state at a moment: what the whole ring shows. */
export function clockFrame(state: ClockState) {
  if (state.phase === "rest")
    return { spent: 0, refill: 1, warn: false, pulse: 1, rest: true };
  const total = Math.max(1, state.total);
  // Reduced motion: whole-second steps, no refill, no pulse.
  const left = state.reduced
    ? Math.ceil(Math.max(0, state.left))
    : Math.max(0, state.left);
  const elapsed = total - left;
  const warn = left <= WARNING_SECONDS;
  // A deadline further away than a turn (clock skew) waits unlit.
  const refill =
    state.reduced || elapsed >= REFILL_SECONDS
      ? 1
      : Math.max(0, elapsed) / REFILL_SECONDS;
  // Opacity 1 → 0.62 → 1 once a second, lowest at the half second.
  const fraction = left - Math.floor(left);
  const pulse =
    warn && !state.reduced && left > 0
      ? PULSE_LOW +
        (1 - PULSE_LOW) * (0.5 + 0.5 * Math.cos(2 * Math.PI * fraction))
      : 1;
  return {
    spent: Math.min(1, Math.max(0, 1 - left / total)),
    refill,
    warn,
    pulse,
    rest: false,
  };
}

/** One tile's look in a frame, from its clockwise angle. */
export function tileLook(
  angle: number,
  frame: ReturnType<typeof clockFrame>,
  reduced: boolean,
): TileLook {
  if (frame.rest) return { kind: "rest", opacity: REST_OPACITY };
  if (angle > frame.refill) return { kind: "rest", opacity: REST_OPACITY };
  const ember = reduced ? 0 : EMBER;
  if (frame.spent >= 1 || angle < frame.spent - ember)
    return { kind: "spent", opacity: SPENT_OPACITY };
  if (angle < frame.spent)
    return {
      kind: "ember",
      opacity: 0.1 + ((angle - (frame.spent - ember)) / ember) * 0.75,
    };
  return { kind: frame.warn ? "warn" : "lit", opacity: LIT_OPACITY };
}

/**
 * A key that changes only when the drawn tiles would: the sweep moves about
 * one tile at a time, so redraw on each 1/720 of a turn (or each second
 * under reduced motion).
 */
export function frameKey(frame: ReturnType<typeof clockFrame>) {
  return frame.rest
    ? "rest"
    : `${Math.floor(frame.spent * 720)}:${Math.floor(frame.refill * 60)}:${frame.warn ? 1 : 0}`;
}

/** The timer's accessible name: "42 seconds left in turn 3". */
export function timerLabel(left: number, turnNumber: number | null) {
  const seconds = Math.max(0, Math.ceil(left));
  return `${seconds} second${seconds === 1 ? "" : "s"} left${turnNumber ? ` in turn ${turnNumber}` : ""}`;
}
