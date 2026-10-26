import type {
  OutlineEdit,
  OutlineLanguage,
  OutlineSide,
  TurnOutline,
} from "./reducer.ts";

// Decision 0012: the outline's public shapes, shared by the server and the
// browser. Browser-safe.

/** The reliable LiveKit data topic of live outline versions. */
export const OUTLINE_TOPIC = "yap.outline.v1";

export interface ArgumentSummary {
  id: string;
  label: string;
  rebuts: string | null;
  /** The earlier argument of the same side this one continues (final only). */
  continues: string | null;
}
export interface TurnSummary {
  turnNumber: number;
  side: OutlineSide;
  language: OutlineLanguage;
  arguments: ArgumentSummary[];
  /** True once the window's final outline replaced the live one. */
  final: boolean;
}
export interface OutlineSnapshot {
  kind: "snapshot";
  debateId: string;
  version: number;
  /** The latest turn's live outline. */
  current: TurnOutline | null;
  /** Every earlier turn, by its final, frozen or latest outline. */
  turns: TurnSummary[];
  flags: { turnNumber: number; itemId: string; side: OutlineSide }[];
  /** How many windows have their final outline; part of the ETag. */
  finals: number;
}
export interface OutlineCatchUp {
  kind: "edits";
  debateId: string;
  from: number;
  version: number;
  versions: {
    version: number;
    turnNumber: number;
    side: OutlineSide;
    language: OutlineLanguage;
    edits: OutlineEdit[];
  }[];
}

/**
 * Sent on OUTLINE_TOPIC once a window's cleanup becomes its final outline.
 * Pages replace that earlier turn's summary; live versions are unaffected.
 */
export interface FinalMessage {
  v: 1;
  type: "final";
  debateId: string;
  turn: TurnSummary;
}

/**
 * GET /api/public/debates/:id/outline/timeline: every live version with its
 * place in the recording, and each window's final outline, for replay sync.
 * `at` is milliseconds from the recording's start (null before the recording
 * is timed); replay pages find the version playing with a binary search.
 */
export interface OutlineTimeline {
  debateId: string;
  /** True once the debate ended and every window has its final outline. */
  complete: boolean;
  timed: boolean;
  versions: {
    version: number;
    at: number | null;
    turnNumber: number;
    side: OutlineSide;
    language: OutlineLanguage;
    edits: OutlineEdit[];
  }[];
  turns: TurnSummary[];
}

/**
 * GET /api/public/debates/:id/outline/correlation: how endorsement moved
 * with each argument, from revealed (settled) windows only, aggregated, and
 * only for windows with at least `minimumCount` commitments.
 */
export interface OutlineCorrelation {
  debateId: string;
  minimumCount: number;
  windows: {
    turnNumber: number;
    side: OutlineSide;
    /** Quantity-weighted YES share from 0 to 1, or null below the minimum. */
    yesShare: number | null;
    /** Change from the previous reported window of the debate. */
    change: number | null;
  }[];
  arguments: {
    id: string;
    turnNumber: number;
    side: OutlineSide;
    label: string;
    /** The first argument of its chain of `continues` links. */
    thread: string;
    /** Share of the window's commitments made while it was on screen. */
    onScreenShare: number | null;
  }[];
}
