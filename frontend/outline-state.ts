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
