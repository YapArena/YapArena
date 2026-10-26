// Pure logic for the debate chart's Yap Coins mode (Decision 0013, item d):
// revealed turn windows become chart points, labelled from each turn's final
// AI outline through S's windowArgumentLabel contract (Decision 0012). No DOM
// access, so tests can import the built module.
import type { OutlineTimeline } from "../src/features/outline/public-types.ts";
import type { Fraction, RoundPoint } from "./arena-types.js";
import { windowArgumentLabel } from "./arena-chart.js";

/**
 * A turn window from the public window list with the aggregate pricing its
 * reveal made public. Pricing is null until the window is revealed (founder:
 * every revealed window shows its results, whatever its size).
 */
export interface RevealedWindow {
  id: string;
  turnNumber: number | null;
  state: "open" | "settled" | "void";
  pricing?: {
    share: Fraction | null;
    price: Fraction | null;
    a?: Fraction | null;
    b?: Fraction | null;
    branch?: string | null;
  } | null;
}

declare global {
  interface WindowEventMap {
    // The betting panel shares the windows it read, so the chart needs no
    // second read of the same view.
    "yap:stake-windows": CustomEvent<{
      debateId: string;
      windows: RevealedWindow[];
    }>;
  }
}

/** The final outline labels of a turn, joined; null when it has none yet. */
export function turnLabel(
  timeline: Pick<OutlineTimeline, "turns"> | null,
  turnNumber: number,
) {
  const turn = timeline?.turns.find(
    (item) => item.turnNumber === turnNumber && item.final,
  );
  return turn
    ? windowArgumentLabel(turn.arguments.map((item) => item.label))
    : null;
}

/**
 * Revealed turn windows in turn order. Locked, open and voided windows, and
 * any without pricing, never become points. A window nobody answered has no
 * share, so it breaks the line rather than showing an invented percentage.
 */
export function windowPoints(
  windows: readonly RevealedWindow[],
  timeline: Pick<OutlineTimeline, "turns"> | null,
): RoundPoint[] {
  const points: RoundPoint[] = [];
  for (const window of [...windows].sort(
    (a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0),
  )) {
    const pricing = window.pricing;
    if (window.state !== "settled" || window.turnNumber === null || !pricing)
      continue;
    points.push({
      id: window.id,
      runId: null,
      number: window.turnNumber,
      argumentLabel: turnLabel(timeline, window.turnNumber),
      share: pricing.share,
      offer: pricing.price ?? null,
      medianNo: pricing.a ?? null,
      medianYes: pricing.b ?? null,
      ownLimit: null,
      branch: pricing.branch ?? null,
      state: "settled",
      revealed: true,
    });
  }
  return points;
}

/** A revision that changes whenever a point or its label changes. */
export function pointsRevision(points: readonly RoundPoint[]) {
  return JSON.stringify(
    points.map((point) => [
      point.id,
      point.share?.n,
      point.share?.d,
      point.offer?.n,
      point.offer?.d,
      point.argumentLabel,
    ]),
  );
}
