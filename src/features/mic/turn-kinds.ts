import type { Side } from "./rules.ts";

// Decision 0018, PR 2b: the kinds of turn a mic runs (E1, E4, E8). Keeping
// the asker on (extq, exta) is a later pull request.
export type MicTurnKind =
  "question" | "answer" | "followup" | "answer2" | "resume";

/** The asker's own turns: no debater's microphone is open in them. */
export const askerKind = (kind: MicTurnKind) =>
  kind === "question" || kind === "followup";

/** The side that holds the floor in a mic turn (E8, E11). */
export function micTurnSide(kind: MicTurnKind, camp: Side, target: Side) {
  // The asker speaks for their camp (E11); after the answers, the debater
  // who was not asked resumes (E8).
  return askerKind(kind) || kind === "resume" ? camp : target;
}
