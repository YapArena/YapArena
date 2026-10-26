import {
  applyEdits,
  emptyTurn,
  type OutlineEdit,
  type OutlineLanguage,
  type OutlineSide,
  type TurnOutline,
} from "../src/features/outline/reducer.ts";
import type {
  OutlineCatchUp,
  OutlineSnapshot,
  OutlineTimeline,
  TurnSummary,
} from "../src/features/outline/public-types.ts";
export { OUTLINE_TOPIC } from "../src/features/outline/public-types.ts";

// Decision 0012: the page's copy of the debate's AI outline. Pure: the panel
// renders it, and every change goes through the same reducer the server used,
// so a gap or a mismatch is detected and repaired with one catch-up request.

export interface OutlineView {
  version: number;
  current: TurnOutline | null;
  turns: TurnSummary[];
  flags: ReadonlySet<string>;
}
export interface OutlineVersion {
  version: number;
  turnNumber: number;
  side: OutlineSide;
  language: OutlineLanguage;
  edits: OutlineEdit[];
}
export type Applied =
  | { kind: "applied"; view: OutlineView; added: string[] }
  | { kind: "ignored" }
  | { kind: "gap" };

export const emptyView: OutlineView = Object.freeze({
  version: 0,
  current: null,
  turns: [],
  flags: new Set<string>(),
});

export function fromSnapshot(snapshot: OutlineSnapshot): OutlineView {
  return {
    version: snapshot.version,
    current: snapshot.current,
    turns: snapshot.turns,
    flags: new Set(snapshot.flags.map((flag) => flag.itemId)),
  };
}

const summarize = (outline: TurnOutline): TurnSummary => ({
  turnNumber: outline.turnNumber,
  side: outline.side,
  language: outline.language,
  arguments: outline.arguments.map(({ id, label, rebuts }) => ({
    id,
    label,
    rebuts,
    continues: null,
  })),
  final: false,
});

/**
 * Applies one live version. Only the next version applies; an older one is
 * ignored and a later one (or one the reducer refuses) is a gap to repair.
 */
export function applyVersion(view: OutlineView, next: OutlineVersion): Applied {
  if (next.version <= view.version) return { kind: "ignored" };
  if (next.version !== view.version + 1) return { kind: "gap" };
  let turns = view.turns;
  let base = view.current;
  if (!base || base.turnNumber !== next.turnNumber) {
    if (base && base.turnNumber > next.turnNumber) return { kind: "gap" };
    if (base && base.arguments.length) turns = [...turns, summarize(base)];
    base = emptyTurn(next.turnNumber, next.side, next.language);
  }
  try {
    const current = applyEdits(base, next.edits);
    const before = new Set(base.arguments.map((item) => item.id));
    return {
      kind: "applied",
      view: { ...view, version: next.version, current, turns },
      added: current.arguments
        .filter((item) => !before.has(item.id))
        .map((item) => item.label),
    };
  } catch {
    return { kind: "gap" };
  }
}

/** Applies a catch-up answer: a run of versions, or a whole snapshot. */
export function applyCatchUp(
  view: OutlineView,
  answer: OutlineCatchUp | OutlineSnapshot,
): { view: OutlineView; added: string[] } {
  if (answer.kind === "snapshot")
    return { view: fromSnapshot(answer), added: [] };
  let current = view;
  const added: string[] = [];
  for (const next of answer.versions) {
    const result = applyVersion(current, next);
    if (result.kind === "gap") break;
    if (result.kind === "applied") {
      current = result.view;
      added.push(...result.added);
    }
  }
  return { view: current, added };
}

/** Validates a LiveKit outline message before it reaches the reducer. */
export function parseOutlineMessage(
  payload: Uint8Array,
  debateId: string,
): OutlineVersion | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
    if (
      value.v !== 1 ||
      value.type !== "edits" ||
      value.debateId !== debateId ||
      !Number.isSafeInteger(value.version) ||
      !Number.isSafeInteger(value.turnNumber) ||
      (value.side !== "A" && value.side !== "B") ||
      (value.language !== "fr" && value.language !== "en") ||
      !Array.isArray(value.edits)
    )
      return null;
    return {
      version: value.version as number,
      turnNumber: value.turnNumber as number,
      side: value.side,
      language: value.language,
      edits: value.edits as OutlineEdit[],
    };
  } catch {
    return null;
  }
}

const argumentRef = /^t[1-9][0-9]{0,4}a[1-9][0-9]{0,2}$/;
const reference = (value: unknown) =>
  value === null || (typeof value === "string" && argumentRef.test(value));

/** Validates a LiveKit final-outline message for this debate. */
export function parseFinalMessage(
  payload: Uint8Array,
  debateId: string,
): TurnSummary | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
    const turn = value.turn as Record<string, unknown> | null;
    if (
      value.v !== 1 ||
      value.type !== "final" ||
      value.debateId !== debateId ||
      !turn ||
      typeof turn !== "object" ||
      !Number.isSafeInteger(turn.turnNumber) ||
      (turn.side !== "A" && turn.side !== "B") ||
      (turn.language !== "fr" && turn.language !== "en") ||
      !Array.isArray(turn.arguments) ||
      turn.arguments.length > 4
    )
      return null;
    const items = turn.arguments as unknown[];
    if (
      !items.every((item) => {
        const entry = item as Record<string, unknown> | null;
        return (
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          argumentRef.test(entry.id) &&
          typeof entry.label === "string" &&
          entry.label.length <= 80 &&
          reference(entry.rebuts) &&
          reference(entry.continues)
        );
      })
    )
      return null;
    return {
      turnNumber: turn.turnNumber as number,
      side: turn.side,
      language: turn.language,
      arguments: (items as Record<string, string | null>[]).map((entry) => ({
        id: entry.id!,
        label: entry.label!,
        rebuts: entry.rebuts ?? null,
        continues: entry.continues ?? null,
      })),
      final: true,
    };
  } catch {
    return null;
  }
}

/**
 * Replaces an earlier turn's summary with its final outline. The current
 * turn keeps its live outline; a turn this copy has not seen is ignored.
 */
export function applyFinal(view: OutlineView, turn: TurnSummary): OutlineView {
  const index = view.turns.findIndex(
    (item) => item.turnNumber === turn.turnNumber,
  );
  if (index < 0) return view;
  const turns = [...view.turns];
  turns[index] = turn;
  return { ...view, turns };
}

/**
 * Replay sync: the outline as it was at a position in the recording. Finds
 * the last version shown by then with a binary search and replays versions
 * from the previous answer when playback moves forward, so normal playback
 * does constant work per update. Earlier turns show their final outline.
 */
export function createReplayIndex(timeline: OutlineTimeline) {
  const versions = timeline.versions.filter(
    (version): version is typeof version & { at: number } =>
      version.at !== null,
  );
  let cached: { index: number; view: OutlineView } = {
    index: -1,
    view: emptyView,
  };
  function lastAt(positionMs: number) {
    let low = 0,
      high = versions.length - 1,
      found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (versions[middle]!.at <= positionMs) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  }
  return Object.freeze({
    /** Whether the recording is timed, so positions can be matched. */
    timed: timeline.timed && versions.length > 0,
    at(positionMs: number): OutlineView {
      const index = lastAt(positionMs);
      if (index < cached.index) cached = { index: -1, view: emptyView };
      let view = cached.view;
      for (let next = cached.index + 1; next <= index; next++) {
        const result = applyVersion(view, {
          ...versions[next]!,
          version: view.version + 1,
        });
        if (result.kind === "applied") view = result.view;
      }
      cached = { index, view };
      const current = view.current;
      return {
        ...view,
        turns: current
          ? timeline.turns.filter(
              (turn) => turn.turnNumber < current.turnNumber,
            )
          : [],
      };
    },
  });
}
