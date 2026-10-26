import {
  OUTLINE_LIMITS,
  argumentId,
  clampText,
  pointId,
  type OutlineArgument,
  type OutlineSide,
  type Span,
  type TurnOutline,
} from "./reducer.ts";

// Decision 0012: the window cleanup. After a turn ends, Claude Sonnet 5.5
// rewrites its outline cleanly and maps it onto the debate's earlier
// arguments. Only the server resolves the rewrite into the window's final
// outline: it keeps live IDs and spans where the rewrite names them, numbers
// new items above every live one, and links only to earlier arguments.
// Browser-safe.

/** One argument as the cleanup model returns it. */
export interface CleanupArgument {
  /** The live argument it rewrites, or null for a new one. */
  id: string | null;
  label: string;
  points: string[];
  /** An earlier argument (either side) it answers. */
  rebuts: string | null;
  /** An earlier argument of the same side it continues. */
  continues: string | null;
}
export interface EarlierArgument {
  id: string;
  turnNumber: number;
  side: OutlineSide;
}

/** Validates the cleanup's argument list, as the model or the agent sends it. */
export function parseCleanupArguments(
  value: unknown,
): CleanupArgument[] | null {
  if (!Array.isArray(value) || value.length > OUTLINE_LIMITS.arguments)
    return null;
  const nullable = (field: unknown) =>
    field === null ? null : typeof field === "string" ? field : undefined;
  const items: CleanupArgument[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const item = entry as Record<string, unknown>;
    const id = nullable(item.id),
      rebuts = nullable(item.rebuts),
      continues = nullable(item.continues);
    if (
      id === undefined ||
      rebuts === undefined ||
      continues === undefined ||
      typeof item.label !== "string" ||
      item.label.length > 1000 ||
      !Array.isArray(item.points) ||
      item.points.length > OUTLINE_LIMITS.points ||
      !item.points.every(
        (point): point is string =>
          typeof point === "string" && point.length <= 1000,
      )
    )
      return null;
    items.push({
      id,
      label: item.label,
      points: item.points,
      rebuts,
      continues,
    });
  }
  return items;
}

const argumentIndex = (id: string) => Number(/a(\d+)$/.exec(id)![1]);
const wholeTurn = (live: TurnOutline): Span =>
  live.arguments.length
    ? {
        startMs: Math.min(...live.arguments.map((item) => item.span.startMs)),
        endMs: Math.max(...live.arguments.map((item) => item.span.endMs)),
      }
    : { startMs: 0, endMs: 0 };

/**
 * The window's final outline from the cleanup's rewrite of its live outline.
 * `accept` rejects text (the slur filter): such a label drops its argument and
 * such a point drops alone. Returns null when nothing usable remains.
 */
export function resolveCleanup(
  live: TurnOutline,
  rewrite: readonly CleanupArgument[],
  earlier: readonly EarlierArgument[],
  accept: (text: string) => boolean = () => true,
): { outline: TurnOutline; dropped: number } | null {
  const byId = new Map(live.arguments.map((item) => [item.id, item]));
  const earlierById = new Map(earlier.map((item) => [item.id, item]));
  let next = Math.max(
    0,
    ...live.arguments.map((item) => argumentIndex(item.id)),
  );
  const used = new Set<string>();
  const span = wholeTurn(live);
  const result: OutlineArgument[] = [];
  let dropped = 0;
  for (const item of rewrite.slice(0, OUTLINE_LIMITS.arguments)) {
    const label = clampText(item.label, OUTLINE_LIMITS.label);
    if (!label || !accept(label)) {
      dropped++;
      continue;
    }
    const kept =
      item.id !== null && !used.has(item.id) ? byId.get(item.id) : undefined;
    const id = kept?.id ?? argumentId(live.turnNumber, ++next);
    used.add(id);
    const livePoints = new Map(
      (kept?.points ?? []).map((point) => [point.text, point]),
    );
    let lastPoint = kept?.lastPoint ?? 0;
    const points = [];
    for (const raw of item.points.slice(0, OUTLINE_LIMITS.points)) {
      const text = clampText(raw, OUTLINE_LIMITS.point);
      if (!text || !accept(text)) {
        dropped++;
        continue;
      }
      const same = livePoints.get(text);
      livePoints.delete(text);
      points.push(
        same ?? {
          id: pointId(id, ++lastPoint),
          text,
          span: kept?.span ?? span,
        },
      );
    }
    const rebuts =
      item.rebuts !== null && earlierById.has(item.rebuts) ? item.rebuts : null;
    const continued =
      item.continues === null ? undefined : earlierById.get(item.continues);
    result.push({
      id,
      label,
      span: kept?.span ?? span,
      points,
      lastPoint,
      rebuts,
      continues: continued?.side === live.side ? continued.id : null,
    });
  }
  if (!result.length) return null;
  return { outline: { ...live, arguments: result }, dropped };
}
