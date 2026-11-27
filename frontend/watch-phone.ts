// Decision 0016: watching a debate on a phone, full screen only. Pure rules
// for the full screen (frontend/watch-screen.ts puts them on the page): when a
// viewport is a phone, its orientation, the open/close and tap state, the turn
// clock on the seam and the turn bar, and the viewer's position on the turn
// that's running. No DOM access, so tests import the built module, and other
// page modules can import PHONE_WATCH_QUERY without starting the full screen.
import { clockFrame, timerLabel, WARNING_SECONDS } from "./turn-clock-logic.js";
import {
  clockText,
  firstName,
  type Side,
  type TurnDetail,
} from "./debate-layout-model.js";
import {
  askerName,
  micTurnAt,
  micTurnSentence,
  nextAfterMicTurn,
  totalTurns,
  type MicPastTurn,
  type MicPublic,
} from "./mic-model.js";
import {
  liveWindow,
  replayWindow,
  type PublicWindow,
  type StakeSide,
} from "./stake-model.js";

/**
 * A phone: under 600 px wide, or a landscape viewport under 500 px tall. The
 * same query is in public/arena.css.
 */
export const PHONE_WATCH_QUERY =
  "(max-width: 599px), (orientation: landscape) and (max-height: 499px)";

export type WatchOrientation = "vertical" | "horizontal";

/** Side by side when the screen is wider than it is tall. */
export function watchOrientation(
  width: number,
  height: number,
): WatchOrientation {
  return width > height ? "horizontal" : "vertical";
}

/** Decision 0018 adds the mic's list as a third sheet. */
export type WatchSheet = "turns" | "more" | "mic";
export const watchSheets: readonly WatchSheet[] = ["turns", "more", "mic"];

export interface WatchState {
  open: boolean;
  /** Back, ···, the question and the name tags (D4: they start hidden). */
  controls: boolean;
  sheet: WatchSheet | null;
  chat: boolean;
}

export const closedWatch: WatchState = {
  open: false,
  controls: false,
  sheet: null,
  chat: false,
};

export type WatchAction =
  | { type: "open" }
  | { type: "close" }
  /** A tap on the picture. */
  | { type: "tap" }
  | { type: "sheet"; sheet: WatchSheet }
  | { type: "close-sheet" }
  | { type: "chat" };

/** The full screen's state after an action. */
export function watchReducer(
  state: WatchState,
  action: WatchAction,
): WatchState {
  if (action.type === "open")
    return state.open ? state : { ...closedWatch, open: true };
  if (action.type === "close") return closedWatch;
  if (!state.open) return state;
  switch (action.type) {
    // A tap shows or hides the controls and puts any sheet away; an open
    // chat stays open through taps.
    case "tap":
      return { ...state, controls: !state.controls, sheet: null };
    case "sheet":
      return { ...state, sheet: action.sheet };
    case "close-sheet":
      return state.sheet ? { ...state, sheet: null } : state;
    case "chat":
      return { ...state, chat: !state.chat };
  }
}

const other = (side: Side): Side => (side === "A" ? "B" : "A");

export interface WatchClock {
  /** A turn is counting down, the next speaker is about to start, or no turn runs. */
  phase: "running" | "between" | "rest";
  /** "0:42" while running. */
  text: string;
  /** The last 10 seconds of a turn. */
  warn: boolean;
  /** How much of the turn has gone, 0–1. */
  spent: number;
  /** The turn shown under the clock: the running one, or the next one. */
  turnNumber: number | null;
  /**
   * The debate's turns; each mic turn so far makes it one longer, as a mic's
   * turns don't count toward the debate's length (Decision 0018).
   */
  total: number | null;
  /** A mic's turn is running or about to: the clock says "Mic". */
  mic: boolean;
  /** Between turns: who speaks next, and their first name. */
  nextSide: Side | null;
  nextName: string;
  /** The word shown when no turn runs ("Paused", "Closed"), or "". */
  word: string;
  /** The timer's accessible name. */
  label: string;
}

export interface WatchClockInput {
  /** The live media snapshot (yap:turn), if one arrived. */
  turn: TurnDetail | null;
  /** The open turn window when there is no snapshot. */
  window: Pick<PublicWindow, "turnNumber" | "side" | "closesAt"> | null;
  /** A replay's playing turn (debate-layout-model's playingTurn). */
  playing: { turnNumber: number; side: Side; left: number } | null;
  replay: boolean;
  /** This browser's time in milliseconds. */
  now: number;
  turnSeconds: number;
  total: number | null;
  names: Record<Side, string>;
  reduced?: boolean;
  /** Decision 0018: the debate's mic, when the page read one. */
  mic?: Pick<MicPublic, "turns" | "mics" | "fund"> | null;
}

const micTurns = (input: WatchClockInput): readonly MicPastTurn[] | undefined =>
  input.mic?.turns;

function rest(input: WatchClockInput, word: string): WatchClock {
  return {
    phase: "rest",
    text: "",
    warn: false,
    spent: 0,
    turnNumber: null,
    total: totalTurns(input.total, micTurns(input)),
    mic: false,
    nextSide: null,
    nextName: "",
    word,
    label: word,
  };
}

function running(
  input: WatchClockInput,
  turnNumber: number | null,
  left: number,
): WatchClock {
  const frame = clockFrame({
    phase: "running",
    left,
    total: input.turnSeconds,
    reduced: Boolean(input.reduced),
  });
  const mic = micTurnAt(micTurns(input), turnNumber);
  return {
    phase: "running",
    text: clockText(left),
    warn: left <= WARNING_SECONDS,
    spent: frame.spent,
    turnNumber,
    total: totalTurns(input.total, micTurns(input)),
    mic: mic !== null,
    nextSide: null,
    nextName: "",
    word: "",
    label: mic
      ? `${timerLabel(left, null)}: ${micTurnSentence(mic, input.names)}`
      : timerLabel(left, turnNumber),
  };
}

function between(
  input: WatchClockInput,
  next: { side: Side | null; name: string; full: string; mic: boolean },
  turnNumber: number | null,
): WatchClock {
  // The next turn may be a mic's, which the list doesn't hold yet.
  const total = totalTurns(input.total, micTurns(input));
  const shown =
    turnNumber === null
      ? null
      : total && !next.mic
        ? Math.min(total, turnNumber)
        : turnNumber;
  return {
    phase: "between",
    text: "",
    warn: false,
    spent: 1,
    turnNumber: shown,
    total,
    mic: next.mic,
    nextSide: next.side,
    nextName: next.name,
    word: "",
    label: `Between turns. ${next.full} speaks next`,
  };
}
const debater = (input: WatchClockInput, side: Side) => ({
  side,
  name: firstName(input.names[side]),
  full: input.names[side],
  mic: false,
});

/**
 * Who speaks after the turn that just ended. A debater's turn hands over to
 * the other debater, unless a mic has fired and waits for this boundary;
 * inside a mic's exchange the asker and the debater asked take turns
 * (Decision 0018).
 */
function nextSpeaker(input: WatchClockInput, turn: TurnDetail) {
  const mic = micTurnAt(micTurns(input), turn.turnNumber);
  if (mic) {
    const funded =
      input.mic?.fund?.micId === mic.micId && input.mic.fund.state === "funded";
    const next = nextAfterMicTurn(mic, funded, input.names);
    if (next)
      return {
        ...next,
        full: next.side ? input.names[next.side] : next.name,
        // Every turn of the exchange, and the turn that hands the floor
        // back, is the mic's.
        mic: true,
      };
  }
  const waiting = input.mic?.mics?.find(
    (entry) => entry.state === "live" && !entry.started,
  );
  if (waiting) {
    const name = askerName(waiting.holder);
    return { side: null, name, full: name, mic: true };
  }
  return debater(input, other(turn.activeSide!));
}

/**
 * The clock on the seam. Live, it follows the media snapshot's deadline;
 * once the deadline passes and until the next turn starts it says who's
 * next. On a replay it follows the turn that's playing.
 */
export function watchClock(input: WatchClockInput): WatchClock {
  if (input.replay)
    return input.playing
      ? running(input, input.playing.turnNumber, input.playing.left)
      : rest(input, "Replay");
  const turn = input.turn;
  if (turn && turn.eventStatus !== "live")
    return turn.eventStatus === "ended" || turn.state === "ended"
      ? rest(input, "Closed")
      : rest(input, "");
  if (turn?.state === "running" && turn.activeSide && turn.turnDeadlineAt) {
    const left =
      (Date.parse(turn.turnDeadlineAt) - (input.now + turn.serverOffset)) /
      1000;
    return left > 0
      ? running(input, turn.turnNumber, left)
      : between(
          input,
          nextSpeaker(input, turn),
          turn.turnNumber === null ? null : turn.turnNumber + 1,
        );
  }
  if (turn?.state === "paused") return rest(input, "Paused");
  if (!turn && input.window) {
    const left = (Date.parse(input.window.closesAt) - input.now) / 1000;
    if (left > 0) return running(input, input.window.turnNumber, left);
  }
  // Live, before the first turn: side A opens.
  if (turn) return between(input, debater(input, "A"), turn.turnNumber ?? 1);
  return rest(input, "");
}

export interface TurnSegment {
  /** The segment's track is lit: the turn is over. */
  done: boolean;
  /** How much of it is filled, 0–1. */
  fill: number;
}

/** The turn bar at the top: one segment per turn, the running one filling. */
export function turnSegments(clock: WatchClock): TurnSegment[] {
  // Between turns the next turn may be a mic's, one more than the total.
  const total = Math.max(
    clock.total ?? 0,
    clock.total && clock.turnNumber ? clock.turnNumber : 0,
  );
  if (!total) return [];
  // Between turns, the shown number is the next turn; the one before it is over.
  const current =
    clock.turnNumber === null
      ? 0
      : clock.phase === "between"
        ? clock.turnNumber - 1
        : clock.turnNumber;
  return Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    if (number < current) return { done: true, fill: 1 };
    if (number === current)
      return clock.phase === "running"
        ? { done: false, fill: clock.spent }
        : { done: true, fill: 1 };
    return { done: false, fill: 0 };
  });
}

/** Under the clock: "7 / 10", "Turn 7", or "Mic" in a mic's turn. */
export function clockTurnText(clock: WatchClock) {
  if (clock.mic) return "Mic";
  if (clock.turnNumber === null) return "";
  return clock.total
    ? `${clock.turnNumber} / ${clock.total}`
    : `Turn ${clock.turnNumber}`;
}

export interface OwnPosition {
  side: StakeSide;
  quantity: number;
}

/**
 * The viewer's position on the turn they can answer now: the live turn's
 * window, or on a replay the window of the turn that's playing.
 */
export function currentPosition(input: {
  windows: readonly PublicWindow[];
  positions: Readonly<Record<string, OwnPosition>>;
  eventStatus: string;
  /** Server time in milliseconds. */
  now: number;
  positionSeconds: number | null;
}): OwnPosition | null {
  const window =
    liveWindow(input.windows, input.now, input.eventStatus) ??
    (input.eventStatus !== "live" && input.positionSeconds !== null
      ? replayWindow(input.windows, input.positionSeconds, input.now)
      : null);
  return window ? (input.positions[window.id] ?? null) : null;
}

/** An answer key's words: "Yes", or "Yes · 25" once placed. */
export function keyText(side: StakeSide, placed: OwnPosition | null) {
  const word = side === "YES" ? "Yes" : "No";
  return placed?.side === side ? `${word} · ${placed.quantity}` : word;
}

/** An answer key's look: open, placed, or off (between turns, or the other key). */
export function keyLook(
  side: StakeSide,
  placed: OwnPosition | null,
  disabled: boolean,
): "open" | "placed" | "off" {
  if (placed) return placed.side === side ? "placed" : "off";
  return disabled ? "off" : "open";
}
