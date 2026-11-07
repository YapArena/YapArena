// Pure rules for "Results by turn" and the replay's turn timeline (direction
// BC1's replay board, Decision 0013's 2026-11-02 amendment). Each turn is a
// column: once its window is revealed, a bar rises above a 50% line for a yes
// majority and drops below it for a no majority. Results stay hidden until
// revealed. No DOM access, so tests import the built module.
import type { OutlineTimeline } from "../src/features/outline/public-types.ts";
import { sharePercent } from "./arena-chart.js";
import { firstName } from "./debate-layout-model.js";
import type {
  PublicWindow,
  RecordingSpan,
  SpeakingSide,
} from "./stake-model.js";
import { turnLabel, type RevealedWindow } from "./window-chart-model.js";

export type TurnState =
  /** Revealed, with the share who said yes. */
  | "revealed"
  /** Revealed, but nobody answered: no share to show. */
  | "empty"
  /** Open, or closed and waiting for its reveal. */
  | "hidden"
  /** The window was cancelled. */
  | "void"
  /** A live debate's turn that hasn't started. */
  | "upcoming";

export interface TurnColumn {
  turnNumber: number;
  side: SpeakingSide | null;
  state: TurnState;
  /** The share who said yes, in percent; only once revealed. */
  yes: number | null;
  /** The turn's final AI outline labels, joined; null without them. */
  label: string | null;
  /** Where the turn plays in the recording, once the recording is timed. */
  recording: RecordingSpan | null;
  /** The revealed window's id, which the price inspector uses. */
  windowId: string | null;
}

export type Names = Record<SpeakingSide, string>;

// The betting panel shares its whole public window list; the chart's event
// type names only the fields the chart reads.
export const isTurnWindow = (window: RevealedWindow): window is PublicWindow =>
  "opensAt" in window && "side" in window;

/**
 * One column per turn window, in turn order. A live or upcoming debate also
 * gets columns for the turns still to come, up to its total, so the chart
 * shows the whole debate; a replay shows the turns that took place.
 */
export function turnColumns(
  windows: readonly PublicWindow[],
  timeline: Pick<OutlineTimeline, "turns"> | null,
  total: number | null,
  withUpcoming: boolean,
): TurnColumn[] {
  const byTurn = new Map(windows.map((window) => [window.turnNumber, window]));
  const numbers = [...byTurn.keys()];
  if (withUpcoming && total)
    for (let turn = 1; turn <= total; turn++)
      if (!byTurn.has(turn)) numbers.push(turn);
  return numbers
    .sort((a, b) => a - b)
    .map((turnNumber) => {
      const window = byTurn.get(turnNumber);
      if (!window)
        return {
          turnNumber,
          side: null,
          state: "upcoming",
          yes: null,
          label: null,
          recording: null,
          windowId: null,
        };
      const revealed = window.state === "settled" && window.pricing != null;
      const yes = revealed ? sharePercent(window.pricing!.share) : null;
      return {
        turnNumber,
        side: window.side,
        state:
          window.state === "void"
            ? "void"
            : !revealed
              ? "hidden"
              : yes === null
                ? "empty"
                : "revealed",
        yes,
        label: revealed ? turnLabel(timeline, turnNumber) : null,
        recording: window.recording ?? null,
        windowId: revealed ? window.id : null,
      };
    });
}

/**
 * The line above the bars before any turn is revealed: when results come,
 * in Eastern time like the debate's start, if a window says.
 */
export function revealNote(windows: readonly PublicWindow[], now: number) {
  const next = windows
    .filter((window) => window.state !== "void" && window.pricing == null)
    .map((window) => Date.parse(window.revealAt ?? ""))
    .filter((at) => Number.isFinite(at) && at > now)
    .sort((a, b) => a - b)[0];
  if (next === undefined)
    return "Results appear here once a turn's results are revealed.";
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
    timeZoneName: "short",
  }).formatToParts(next);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `Results are revealed on ${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}.`;
}

/** The latest revealed turn: what the chart shows until a viewer picks one. */
export function latestRevealed(columns: readonly TurnColumn[]) {
  return (
    columns.findLast(
      (column) => column.state === "revealed" || column.state === "empty",
    )?.turnNumber ?? null
  );
}

/** The bars' room above and below the 50% line, in pixels. */
export const BAR_ROOM = 56;
/** The board's scale: four pixels per percentage point. */
export const BAR_SCALE = 4;

/**
 * Pixels per percentage point: the board's scale, or less when a turn's
 * share is far enough from 50% that its bar would leave the chart.
 */
export function barScale(columns: readonly TurnColumn[]) {
  const furthest = Math.max(
    0,
    ...columns.map((column) =>
      column.yes === null ? 0 : Math.abs(column.yes - 50),
    ),
  );
  return furthest ? Math.min(BAR_SCALE, BAR_ROOM / furthest) : BAR_SCALE;
}

/** Whole percents that add up to 100. */
export function percents(yes: number) {
  const rounded = Math.round(yes);
  return { yes: rounded, no: 100 - rounded };
}

/**
 * A column's bar: up for a yes majority, down for a no majority, a thin
 * mark on the line for an even split. At least 2 px, so a narrow majority
 * still shows.
 */
export function barShape(column: TurnColumn, scale: number) {
  if (column.yes === null) return null;
  const lead = column.yes - 50;
  return {
    direction: lead > 0 ? "up" : lead < 0 ? "down" : "even",
    size: Math.max(2, Math.round(Math.abs(lead) * scale)),
    value: `${percents(column.yes).yes}%`,
  } as const;
}

/** What a column's result says in words. */
export function resultText(column: TurnColumn) {
  switch (column.state) {
    case "revealed": {
      const { yes, no } = percents(column.yes!);
      return `${yes}% yes, ${no}% no`;
    }
    case "empty":
      return "No answers in this turn";
    case "void":
      return "No result: this turn's window was cancelled";
    case "hidden":
      return "Results not revealed yet";
    case "upcoming":
      return "Not started yet";
  }
}

/** The line above the bars: the turn and speaker, its argument, its result. */
export function captionParts(column: TurnColumn, names: Names) {
  return {
    lead: [`Turn ${column.turnNumber}`, column.side ? names[column.side] : null]
      .filter(Boolean)
      .join(" · "),
    label: column.label,
    result: resultText(column),
  };
}

/**
 * Phones list one row per turn with a result to show: revealed (with or
 * without answers) or cancelled. Turns still to come or waiting for their
 * reveal stay off the list; the caption says when results come.
 */
export function phoneColumns(columns: readonly TurnColumn[]) {
  return columns.filter((column) =>
    ["revealed", "empty", "void"].includes(column.state),
  );
}

/**
 * A phone row's line under its bar, as the caption says it on wider
 * screens: the speaker's first name, the turn's argument labels, and the
 * result in words when there is no share to draw.
 */
export function rowLine(column: TurnColumn, names: Names) {
  return [
    column.side ? firstName(names[column.side]) : null,
    column.label ? `“${column.label}”` : null,
    column.state === "revealed" ? null : resultText(column),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A bar's accessible name, which carries everything the column shows. */
export function barLabel(column: TurnColumn, names: Names, playing: boolean) {
  const who = column.side ? `, ${names[column.side]}` : "";
  return `Turn ${column.turnNumber}${who}: ${resultText(column)}.${column.label ? ` ${column.label}.` : ""}${playing ? " Playing now." : ""}`;
}

/** "3:05" for a place in the recording. */
export function timestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The turn whose span in the recording holds a replay position. */
export function playingAt(
  columns: readonly TurnColumn[],
  position: number | null,
) {
  if (position === null) return null;
  return (
    columns.find(
      ({ recording }) =>
        recording !== null &&
        recording.startSeconds <= position &&
        position < recording.endSeconds,
    )?.turnNumber ?? null
  );
}

/**
 * The timeline's segments: how much of each turn has played (0 to 1), and
 * which one is playing. Turns without a place in the recording can't be
 * played from the timeline.
 */
export function timelineSegments(
  columns: readonly TurnColumn[],
  position: number | null,
) {
  const playing = playingAt(columns, position);
  return columns.map((column) => {
    const span = column.recording;
    const progress =
      !span || position === null || position <= span.startSeconds
        ? 0
        : position >= span.endSeconds
          ? 1
          : (position - span.startSeconds) /
            (span.endSeconds - span.startSeconds);
    return {
      turnNumber: column.turnNumber,
      progress,
      playing: column.turnNumber === playing,
      playable: span !== null,
    };
  });
}

/** A timeline segment's accessible name. */
export function segmentLabel(column: TurnColumn, names: Names) {
  const who = column.side ? `, ${names[column.side]}` : "";
  const span = column.recording;
  return `Turn ${column.turnNumber}${who}${span ? `, ${timestamp(span.startSeconds)} to ${timestamp(span.endSeconds)}` : ""}`;
}
