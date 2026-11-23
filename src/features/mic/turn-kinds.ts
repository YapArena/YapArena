import type { Side } from "./rules.ts";

// Decision 0018: the kinds of turn a mic runs (E1, E4, E8), with the
// extension question and answer that keeping the asker on adds (X4, X8).
export type MicTurnKind =
  "question" | "answer" | "followup" | "answer2" | "extq" | "exta" | "resume";

/** The asker's own turns: no debater's microphone is open in them. */
export const askerKind = (kind: MicTurnKind) =>
  kind === "question" || kind === "followup" || kind === "extq";

/** The side that holds the floor in a mic turn (E8, E11). */
export function micTurnSide(kind: MicTurnKind, camp: Side, target: Side) {
  // The asker speaks for their camp (E11); after the answers, the debater
  // who was not asked resumes (E8).
  return askerKind(kind) || kind === "resume" ? camp : target;
}
