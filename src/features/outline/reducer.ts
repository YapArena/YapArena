// Decision 0012: the AI outline of one speaking turn (one trading window) and
// the edits that change it. Browser-safe: no Node or DOM APIs. The server,
// the transcriber agent and every browser apply the same canonical edits with
// applyEdits, so they all compute the identical outline. resolveEdits turns
// the model's proposal (temporary keys, no timings) into canonical edits; only
// the server resolves, so it alone assigns IDs.

export const OUTLINE_LIMITS = Object.freeze({
  label: 80,
  point: 120,
  arguments: 4,
  points: 6,
  edits: 8,
});

export type OutlineSide = "A" | "B";
export type OutlineLanguage = "fr" | "en";
/** Milliseconds from the start of the turn. */
export interface Span {
  startMs: number;
  endMs: number;
}
export interface OutlinePoint {
  id: string;
  text: string;
  span: Span;
}
export interface OutlineArgument {
  id: string;
  label: string;
  span: Span;
  points: OutlinePoint[];
  /** Highest point index ever assigned, so a removed point's ID is never reused. */
  lastPoint: number;
  /** An earlier argument (either side) this one rebuts, or null. */
  rebuts: string | null;
  /**
   * In a window's final outline only: the earlier argument of the same side
   * this one continues, so they count as one argument across windows.
   */
  continues?: string | null;
}
export interface TurnOutline {
  turnNumber: number;
  side: OutlineSide;
  language: OutlineLanguage;
  arguments: OutlineArgument[];
}

/** Canonical edits: what the server accepts and every client applies. */
export type OutlineEdit =
  | { op: "add_argument"; id: string; label: string; span: Span }
  | { op: "update_argument"; id: string; label: string; span: Span }
  | { op: "add_point"; argument: string; id: string; text: string; span: Span }
  | { op: "update_point"; id: string; text: string; span: Span }
  | { op: "remove_point"; id: string }
  | { op: "link_rebuttal"; id: string; target: string };

export const proposedOps = [
  "add_argument",
  "update_argument",
  "add_point",
  "update_point",
  "remove_point",
  "link_rebuttal",
] as const;
/**
 * One edit as the model proposes it. `argument` names an existing argument
 * or the `key` of one added earlier in the same proposal; `point` names an
 * existing point; `target` names the rebutted argument.
 */
export interface ProposedEdit {
  op: (typeof proposedOps)[number];
  argument: string | null;
  point: string | null;
  key: string | null;
  text: string | null;
  target: string | null;
}

export class OutlineEditError extends Error {}

export const argumentId = (turnNumber: number, index: number) =>
  `t${turnNumber}a${index}`;
export const pointId = (argument: string, index: number) =>
  `${argument}p${index}`;
const argumentPattern = /^t([1-9][0-9]{0,4})a([1-9][0-9]{0,2})$/;
const pointPattern = /^(t[1-9][0-9]{0,4}a[1-9][0-9]{0,2})p([1-9][0-9]{0,2})$/;

export function emptyTurn(
  turnNumber: number,
  side: OutlineSide,
  language: OutlineLanguage,
): TurnOutline {
  return { turnNumber, side, language, arguments: [] };
}

/** Collapses whitespace and trims. */
export function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts text to `limit` characters at a word boundary, with an ellipsis. */
export function clampText(text: string, limit: number) {
  const clean = normalizeText(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const merge = (a: Span, b: Span): Span => ({
  startMs: Math.min(a.startMs, b.startMs),
  endMs: Math.max(a.endMs, b.endMs),
});
const validSpan = (span: Span) =>
  Number.isSafeInteger(span.startMs) &&
  Number.isSafeInteger(span.endMs) &&
  span.startMs >= 0 &&
  span.endMs >= span.startMs &&
  span.endMs <= 3_600_000;
const validText = (text: string, limit: number) =>
  text.length > 0 && text.length <= limit && text === normalizeText(text);

function fail(message: string): never {
  throw new OutlineEditError(message);
}

/**
 * Applies canonical edits in order and returns a new outline; the input is
 * never changed. Throws OutlineEditError on any invalid edit, so a client
 * whose state differs from the server's notices and resynchronizes.
 */
export function applyEdits(
  outline: TurnOutline,
  edits: readonly OutlineEdit[],
): TurnOutline {
  if (edits.length > OUTLINE_LIMITS.edits) fail("too many edits");
  const result: TurnOutline = {
    ...outline,
    arguments: outline.arguments.map((item) => ({
      ...item,
      span: { ...item.span },
      points: item.points.map((point) => ({
        ...point,
        span: { ...point.span },
      })),
    })),
  };
  const find = (id: string) => result.arguments.find((item) => item.id === id);
  const findPoint = (id: string) => {
    for (const item of result.arguments) {
      const point = item.points.find((candidate) => candidate.id === id);
      if (point) return { argument: item, point };
    }
    return undefined;
  };
  for (const edit of edits) {
    switch (edit.op) {
      case "add_argument": {
        const match = argumentPattern.exec(edit.id);
        if (!match || Number(match[1]) !== result.turnNumber || find(edit.id))
          fail("invalid argument id");
        if (result.arguments.length >= OUTLINE_LIMITS.arguments)
          fail("too many arguments");
        if (
          !validText(edit.label, OUTLINE_LIMITS.label) ||
          !validSpan(edit.span)
        )
          fail("invalid argument");
        result.arguments.push({
          id: edit.id,
          label: edit.label,
          span: { ...edit.span },
          points: [],
          lastPoint: 0,
          rebuts: null,
        });
        break;
      }
      case "update_argument": {
        const item = find(edit.id);
        if (!item) fail("unknown argument");
        if (
          !validText(edit.label, OUTLINE_LIMITS.label) ||
          !validSpan(edit.span)
        )
          fail("invalid argument");
        item.label = edit.label;
        item.span = merge(item.span, edit.span);
        break;
      }
      case "add_point": {
        const item = find(edit.argument);
        const match = pointPattern.exec(edit.id);
        if (
          !item ||
          !match ||
          match[1] !== item.id ||
          Number(match[2]) <= item.lastPoint
        )
          fail("invalid point id");
        if (item.points.length >= OUTLINE_LIMITS.points)
          fail("too many points");
        if (
          !validText(edit.text, OUTLINE_LIMITS.point) ||
          !validSpan(edit.span)
        )
          fail("invalid point");
        item.points.push({
          id: edit.id,
          text: edit.text,
          span: { ...edit.span },
        });
        item.lastPoint = Number(match[2]);
        item.span = merge(item.span, edit.span);
        break;
      }
      case "update_point": {
        const found = findPoint(edit.id);
        if (!found) fail("unknown point");
        if (
          !validText(edit.text, OUTLINE_LIMITS.point) ||
          !validSpan(edit.span)
        )
          fail("invalid point");
        found.point.text = edit.text;
        found.point.span = merge(found.point.span, edit.span);
        found.argument.span = merge(found.argument.span, edit.span);
        break;
      }
      case "remove_point": {
        const found = findPoint(edit.id);
        if (!found) fail("unknown point");
        found.argument.points = found.argument.points.filter(
          (point) => point.id !== edit.id,
        );
        break;
      }
      case "link_rebuttal": {
        const item = find(edit.id);
        if (
          !item ||
          !argumentPattern.test(edit.target) ||
          edit.target === item.id
        )
          fail("invalid rebuttal");
        item.rebuts = edit.target;
        break;
      }
      default:
        fail("unknown edit");
    }
  }
  return result;
}

function nextIndex(ids: readonly string[], pattern: RegExp, group: number) {
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number(match[group]));
  }
  return highest + 1;
}

/**
 * Turns the model's proposal into canonical edits for this outline: assigns
 * IDs (never reusing one), resolves temporary keys, normalizes and clamps
 * text, attaches the span of the transcript the proposal summarized, and
 * drops what cannot apply (unknown IDs, limits, refused text, rebuttal
 * targets outside `known`). Deterministic for the same inputs.
 */
export function resolveEdits(
  outline: TurnOutline,
  proposed: readonly ProposedEdit[],
  {
    span,
    known,
    accept = () => true,
  }: {
    span: Span;
    /** Argument IDs a rebuttal may target: earlier turns and this one. */
    known: ReadonlySet<string>;
    /** Returns false for text that must not appear (slurs, insults). */
    accept?: (text: string) => boolean;
  },
) {
  const edits: OutlineEdit[] = [];
  let rejected = 0;
  let state = outline;
  const keys = new Map<string, string>();
  const reject = () => {
    rejected++;
  };
  const tryApply = (edit: OutlineEdit) => {
    try {
      state = applyEdits(state, [edit]);
      edits.push(edit);
      return true;
    } catch {
      reject();
      return false;
    }
  };
  for (const item of proposed.slice(0, OUTLINE_LIMITS.edits)) {
    const reference = (value: string | null) =>
      value === null ? undefined : (keys.get(value) ?? value);
    const text = (limit: number) => {
      const value = item.text === null ? "" : clampText(item.text, limit);
      return value && accept(value) ? value : null;
    };
    switch (item.op) {
      case "add_argument": {
        const label = text(OUTLINE_LIMITS.label);
        if (!label) {
          reject();
          break;
        }
        const id = argumentId(
          state.turnNumber,
          nextIndex(
            state.arguments.map((a) => a.id),
            argumentPattern,
            2,
          ),
        );
        if (tryApply({ op: "add_argument", id, label, span }) && item.key)
          keys.set(item.key, id);
        break;
      }
      case "update_argument": {
        const id = reference(item.argument),
          label = text(OUTLINE_LIMITS.label);
        if (!id || !label) reject();
        else tryApply({ op: "update_argument", id, label, span });
        break;
      }
      case "add_point": {
        const argument = reference(item.argument),
          value = text(OUTLINE_LIMITS.point);
        const owner = state.arguments.find((a) => a.id === argument);
        if (!owner || !value) {
          reject();
          break;
        }
        const id = pointId(owner.id, owner.lastPoint + 1);
        tryApply({
          op: "add_point",
          argument: owner.id,
          id,
          text: value,
          span,
        });
        break;
      }
      case "update_point": {
        const value = text(OUTLINE_LIMITS.point);
        if (!item.point || !value) reject();
        else
          tryApply({ op: "update_point", id: item.point, text: value, span });
        break;
      }
      case "remove_point":
        if (!item.point) reject();
        else tryApply({ op: "remove_point", id: item.point });
        break;
      case "link_rebuttal": {
        const id = reference(item.argument),
          target = reference(item.target);
        const sameTurn = state.arguments.some((a) => a.id === target);
        if (!id || !target || (!known.has(target) && !sameTurn)) reject();
        else tryApply({ op: "link_rebuttal", id, target });
        break;
      }
      default:
        reject();
    }
  }
  return { edits, rejected, outline: state };
}

/** The outline's argument IDs, for rebuttal targets. */
export function outlineIds(outline: TurnOutline) {
  return outline.arguments.map((item) => item.id);
}

/** Serialized size in bytes (UTF-8), for the 8 KB snapshot limit. */
export function outlineBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Strict check of an outline's shape, e.g. one read back from storage. */
export function isTurnOutline(value: unknown): value is TurnOutline {
  if (!value || typeof value !== "object") return false;
  const outline = value as Partial<TurnOutline>;
  return (
    Number.isSafeInteger(outline.turnNumber) &&
    (outline.side === "A" || outline.side === "B") &&
    (outline.language === "fr" || outline.language === "en") &&
    Array.isArray(outline.arguments) &&
    outline.arguments.length <= OUTLINE_LIMITS.arguments &&
    outline.arguments.every(
      (item) =>
        argumentPattern.test(item.id) &&
        validText(item.label, OUTLINE_LIMITS.label) &&
        validSpan(item.span) &&
        (item.rebuts === null || argumentPattern.test(item.rebuts)) &&
        Number.isSafeInteger(item.lastPoint) &&
        Array.isArray(item.points) &&
        item.points.length <= OUTLINE_LIMITS.points &&
        item.points.every(
          (point) =>
            pointPattern.exec(point.id)?.[1] === item.id &&
            Number(pointPattern.exec(point.id)?.[2]) <= item.lastPoint &&
            validText(point.text, OUTLINE_LIMITS.point) &&
            validSpan(point.span),
        ),
    )
  );
}
