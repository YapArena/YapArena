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
