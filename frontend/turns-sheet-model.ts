// Decision 0016, point 6: what the phone full screen's Turns sheet says. The
// debate's last-answer figure (Decision 0015) with both shares, its counts,
// the change since the previous counted turn and the switching line, then one
// bar per revealed turn for the share who said yes in it. It follows Decision
// 0015's rules: empty before the first reveal, a five-day debate hidden until
// its close, and on a replay only the turns through the one playing. Pure, so
// tests import the built module; frontend/turns-sheet.ts puts it on the page.
import {
  BAR_HEADING,
  barView,
  emptyStatus,
  shownEndorsement,
  type BarLabels,
  type TurnStart,
} from "./endorsement-bar-model.js";
import type { PublicWindow } from "./stake-model.js";
import type { DebateEndorsementView } from "./stake-windows.js";
import type { MicPastTurn } from "./mic-model.js";
import {
  barScale,
  barShape,
  columnInitials,
  columnTitle,
  percents,
  phoneColumns,
  turnColumns,
  type Names,
  type TurnColumn,
} from "./turn-results-model.js";

export const TURNS_HEADING = "Share who said yes, each turn";

export interface TurnsSheetInput {
  /** The latest window read's figure and reveal timing; null before one. */
  figure: DebateEndorsementView | null;
  /**
   * The topic's side labels, or null when the debate isn't counted (its
   * question isn't the topic's), which shows only the turn bars.
   */
  labels: BarLabels | null;
  windows: readonly PublicWindow[];
  /** The debate's number of turns, for the empty slots after the last bar. */
  total: number | null;
  names: Names;
  /** A replay's position in seconds; null live. */
  position: number | null;
  now: number;
  /** Decision 0018: the debate's mic turns, named by their kind. */
  micTurns?: readonly MicPastTurn[];
}

export interface SheetShare {
  answer: "Yes" | "No";
  /** "People first · Yes" and "No · Markets first", or Yes and No alone. */
  label: string;
  percent: number;
}

export interface TurnSlot {
  turnNumber: number;
  /** The speaker's initials, or "MIC" for a viewer's own turn. */
  who: string;
  /** A share to draw, a revealed turn without one, or a turn not shown yet. */
  state: "bar" | "none" | "later";
  direction: "up" | "down" | "even" | null;
  /** The bar's length in pixels. */
  size: number;
  /** "61%", "—" for a revealed turn with no share, "" otherwise. */
  value: string;
  /** The playing turn on a replay, else the newest revealed turn. */
  current: boolean;
}

export interface TurnsSheetView {
  heading: string;
  /** Yes then No; empty when there is no figure to show. */
  shares: SheetShare[];
  yesPercent: number;
  counts: string | null;
  change: string | null;
  switches: string | null;
  /** Why there is nothing to show yet, when there isn't. */
  status: string | null;
  turnsHeading: string;
  /** One slot per turn up to the debate's total; empty with no revealed turn. */
  slots: TurnSlot[];
  /** The bars' accessible name, which carries every revealed share. */
  turnsLabel: string;
}

/** Where each turn starts in the replay's recording, when it is timed. */
export function turnStarts(windows: readonly PublicWindow[]): TurnStart[] {
  return windows.flatMap((window) =>
    window.recording
      ? [
          {
            turnNumber: window.turnNumber,
            startSeconds: window.recording.startSeconds,
          },
        ]
      : [],
  );
}

/**
 * The last turn a replay shows: the latest one whose start the position has
 * reached (the endorsement bar's rule). Undefined when every turn shows:
 * live, or a replay whose turns have no place in the recording.
 */
export function shownThrough(
  starts: readonly TurnStart[],
  position: number | null,
): number | null | undefined {
  if (position === null || !starts.length) return undefined;
  let playing: number | null = null;
  for (const start of starts)
    if (
      start.startSeconds <= position &&
      (playing === null || start.turnNumber > playing)
    )
      playing = start.turnNumber;
  return playing;
}

/** A five-day debate keeps every answer hidden until its close. */
export function beforeClose(
  figure: Pick<DebateEndorsementView, "revealMode" | "revealAt">,
  now: number,
) {
  if (figure.revealMode !== "five_day") return false;
  const at =
    figure.revealAt === null ? Number.NaN : Date.parse(figure.revealAt);
  return !Number.isFinite(at) || at > now;
}

function slotText(column: TurnColumn, names: Names) {
  const turn = column.mic
    ? columnTitle(column, names).replaceAll(" · ", ", ")
    : `turn ${column.turnNumber}`;
  if (column.state === "revealed")
    return `${turn} ${percents(column.yes!).yes}%`;
  if (column.state === "empty")
    return `${turn} ${column.returned ? "stakes returned" : "no answers"}`;
  return `${turn} ${column.voidReason === "turn_cut" ? "cut short" : "cancelled"}`;
}

/** The revealed turns as bars, with empty slots for the turns after them. */
export function turnSlots(
  columns: readonly TurnColumn[],
  names: Names,
  total: number | null,
  micTurns: readonly MicPastTurn[] = [],
): TurnSlot[] {
  const revealed = phoneColumns(columns);
  const last = revealed.at(-1);
  if (!last) return [];
  const scale = barScale(revealed);
  // A mic's turns take slots without counting toward the debate's total.
  const count = Math.max(total ? total + micTurns.length : 0, last.turnNumber);
  const byTurn = new Map(columns.map((column) => [column.turnNumber, column]));
  const shown = new Set(revealed.map((column) => column.turnNumber));
  return Array.from({ length: count }, (_, index) => {
    const turnNumber = index + 1;
    const column = byTurn.get(turnNumber);
    const who = column ? columnInitials(column, names) : "";
    if (!column || !shown.has(turnNumber))
      return {
        turnNumber,
        who,
        state: "later",
        direction: null,
        size: 0,
        value: "",
        current: false,
      };
    const shape = barShape(column, scale);
    return {
      turnNumber,
      who,
      state: shape ? "bar" : "none",
      direction: shape?.direction ?? null,
      size: shape?.size ?? 0,
      value: shape?.value ?? "—",
      current: turnNumber === last.turnNumber,
    };
  });
}

export function turnsSheetView(input: TurnsSheetInput): TurnsSheetView {
  const reveal = input.figure ?? {
    endorsement: null,
    turns: [],
    revealMode: "per_round" as const,
    revealAt: null,
  };
  const hidden = beforeClose(reveal, input.now);
  const starts = turnStarts(input.windows);
  const through = shownThrough(starts, input.position);
  const waiting = through === null;
  // A replay shows the figure through the turn playing.
  const shown = hidden
    ? { endorsement: null, waiting: false }
    : shownEndorsement({
        latest: reveal.endorsement,
        turns: reveal.turns,
        starts,
        position: input.position,
      });
  const status = emptyStatus({
    revealMode: reveal.revealMode,
    revealAt: reveal.revealAt,
    now: input.now,
    waiting: shown.waiting || waiting,
  });
  const columns =
    hidden || waiting
      ? []
      : turnColumns(
          input.windows,
          null,
          input.total,
          false,
          input.micTurns,
        ).filter(
          (column) => through === undefined || column.turnNumber <= through,
        );
  const slots = turnSlots(columns, input.names, input.total, input.micTurns);
  const turnsLabel = `Share who said yes in each revealed turn: ${phoneColumns(
    columns,
  )
    .map((column) => slotText(column, input.names))
    .join(", ")}`;
  const base = {
    heading: BAR_HEADING,
    turnsHeading: TURNS_HEADING,
    slots,
    turnsLabel,
  };
  if (!input.labels)
    return {
      ...base,
      shares: [],
      yesPercent: 0,
      counts: null,
      change: null,
      switches: null,
      status: slots.length ? null : status,
    };
  const bar = barView(
    {
      endorsement: shown.endorsement,
      revealMode: reveal.revealMode,
      revealAt: reveal.revealAt,
      now: input.now,
      waiting: shown.waiting || waiting,
    },
    input.labels,
  );
  const sideAIsYes = input.labels.sideAIsYes;
  return {
    ...base,
    shares: bar.card.shares.map((share) => ({
      answer: share.answer,
      label: !sideAIsYes
        ? share.answer
        : share.answer === "Yes"
          ? `${share.label} · Yes`
          : `No · ${share.label}`,
      percent: share.percent,
    })),
    yesPercent: bar.yesPercent,
    counts: bar.card.counts,
    change: bar.card.change,
    switches: bar.card.switches,
    status: bar.card.status,
  };
}
