// Pure rules for the debate page's scoreboard (direction BC1,
// docs/debate-page-design.md): who has the floor, what each card and the
// centre of the scoreboard say. frontend/debate-layout.ts applies them.
import type { PublicWindow } from "./stake-model.js";

export type Side = "A" | "B";
export type CardState = "speaking" | "listening" | "next" | "";

/** The media snapshot's turn, sent by media-entry.ts as `yap:turn`. */
export interface TurnDetail {
  debateId: string;
  eventStatus: string;
  state: "idle" | "running" | "paused" | "ended" | null;
  activeSide: Side | null;
  turnNumber: number | null;
  turnDeadlineAt: string | null;
  /** Server time minus this browser's time, in milliseconds. */
  serverOffset: number;
}

declare global {
  interface WindowEventMap {
    "yap:turn": CustomEvent<TurnDetail>;
  }
}

export interface TurnView {
  /** The side with the floor: its card and video get the white ring. */
  activeSide: Side | null;
  states: Record<Side, CardState>;
  /** Shown in the clock's place when no live clock runs. */
  hole: string;
  /** Under the clock: "Turn 3 of 10". */
  label: string;
  /** The live stage's line before the viewer joins. */
  summary: string;
}

// One card's state for the given side and the other card's state.
const cards = (
  side: Side,
  mine: CardState,
  theirs: CardState,
): Record<Side, CardState> =>
  side === "A" ? { A: mine, B: theirs } : { A: theirs, B: mine };

export function turnLabel(turnNumber: number | null, total: number | null) {
  if (!turnNumber) return "";
  return total ? `Turn ${turnNumber} of ${total}` : `Turn ${turnNumber}`;
}

/** "0:42" for a number of seconds. */
export function clockText(seconds: number) {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

function speaking(side: Side): TurnView {
  return {
    activeSide: side,
    states: cards(side, "speaking", "listening"),
    hole: "",
    label: "",
    summary: "",
  };
}

/**
 * The live scoreboard from the media snapshot, or from the open turn window
 * when the snapshot has no turn number. Null when the debate isn't live and
 * the server's text stands.
 */
export function liveTurnView(
  turn: TurnDetail | null,
  window: Pick<PublicWindow, "turnNumber" | "side"> | null,
  names: Record<Side, string>,
  total: number | null,
): TurnView | null {
  if (turn && turn.eventStatus !== "live") {
    if (turn.eventStatus === "ended" || turn.state === "ended")
      return {
        activeSide: null,
        states: { A: "", B: "" },
        hole: "Closed",
        label: "",
        summary: "",
      };
    return null;
  }
  const running =
    turn?.state === "running" && turn.activeSide
      ? { side: turn.activeSide, turnNumber: turn.turnNumber }
      : !turn && window
        ? { side: window.side, turnNumber: window.turnNumber }
        : null;
  if (running) {
    const label = turnLabel(
      running.turnNumber ?? window?.turnNumber ?? null,
      total,
    );
    return {
      ...speaking(running.side),
      label,
      summary: `${label ? `${label} · ` : ""}${names[running.side]} is speaking`,
    };
  }
  if (turn?.state === "paused") {
    const side = turn.activeSide;
    return {
      activeSide: null,
      states: side ? cards(side, "next", "") : { A: "", B: "" },
      hole: "Paused",
      label: turnLabel(turn.turnNumber, total),
      summary: "The debate is paused.",
    };
  }
  if (!turn) return null;
  // Live, before the first turn starts: side A opens.
  return {
    activeSide: null,
    states: { A: "next", B: "" },
    hole: `Next · ${firstName(names.A)}`,
    label: "",
    summary: `${names.A} speaks first.`,
  };
}

/**
 * The replay's playing turn: the turn window whose span in the recording
 * holds the position, and the time left in it.
 */
export function playingTurn(
  windows: readonly PublicWindow[],
  positionSeconds: number,
) {
  const playing = windows.find(
    (window) =>
      window.recording != null &&
      window.recording.startSeconds <= positionSeconds &&
      positionSeconds < window.recording.endSeconds,
  );
  return playing?.recording
    ? {
        turnNumber: playing.turnNumber,
        side: playing.side,
        left: playing.recording.endSeconds - positionSeconds,
      }
    : null;
}

export function replayTurnView(
  playing: ReturnType<typeof playingTurn>,
  total: number | null,
): TurnView | null {
  if (!playing) return null;
  return {
    ...speaking(playing.side),
    hole: clockText(playing.left),
    label: turnLabel(playing.turnNumber, total),
  };
}

/** The open turn window at a time, if any. */
export function openWindow(windows: readonly PublicWindow[], at: number) {
  return (
    windows.find(
      (window) =>
        window.state === "open" &&
        Date.parse(window.opensAt) <= at &&
        at < Date.parse(window.closesAt),
    ) ?? null
  );
}

/** A stable 0–4 index into the visit's five colours for a chat author. */
export function authorTint(name: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 5;
}
