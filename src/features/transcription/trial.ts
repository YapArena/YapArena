import type { DebaterLanguage, TranscriptionProvider } from "./protocol.ts";

// Decision 0012: the staging trial comparing Deepgram and ElevenLabs on the
// same audio (docs/transcription-provider-trial.md). Pure functions; the
// report script reads the stored segments and a hand-corrected reference.

/** Words for scoring: lowercase, punctuation removed, elisions split. */
export function trialWords(text: string) {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/(\p{L})'(?=\p{L})/gu, "$1' ")
    .split(/\s+/)
    .map((word) => word.replace(/^[-']+|-+$/g, ""))
    .filter(Boolean);
}

/** Word-level edit distance between a reference and a hypothesis. */
export function wordErrors(
  reference: readonly string[],
  hypothesis: readonly string[],
) {
  // Two rows of [cost, substitutions, deletions, insertions].
  type Cell = [number, number, number, number];
  let previous: Cell[] = Array.from(
    { length: hypothesis.length + 1 },
    (_, j): Cell => [j, 0, 0, j],
  );
  for (let i = 1; i <= reference.length; i++) {
    const row: Cell[] = [[i, 0, i, 0]];
    for (let j = 1; j <= hypothesis.length; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      const diagonal = previous[j - 1]!,
        up = previous[j]!,
        left = row[j - 1]!;
      const options: Cell[] = [
        same
          ? diagonal
          : [diagonal[0] + 1, diagonal[1] + 1, diagonal[2], diagonal[3]],
        [up[0] + 1, up[1], up[2] + 1, up[3]],
        [left[0] + 1, left[1], left[2], left[3] + 1],
      ];
      row.push(
        options.reduce((best, next) => (next[0] < best[0] ? next : best)),
      );
    }
    previous = row;
  }
  const [errors, substitutions, deletions, insertions] = previous.at(-1)!;
  return {
    words: reference.length,
    errors,
    substitutions,
    deletions,
    insertions,
    wer: reference.length ? errors / reference.length : null,
  };
}

/** The p-th percentile (0–100) by nearest rank, or null when empty. */
export function percentile(values: readonly number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    )
  ]!;
}

export interface TrialSegment {
  provider: TranscriptionProvider;
  role: "primary" | "shadow";
  language: DebaterLanguage;
  turnNumber: number;
  spokenStartAt: number;
  text: string;
  latencyMs: number | null;
  audioMs: number;
}
export interface TrialReference {
  /** Hand-corrected text of each scored turn. */
  turns: { turnNumber: number; language: DebaterLanguage; text: string }[];
}

/**
 * One row per provider, role and language: word error rate on the scored
 * turns, speech-end-to-final latency, audio minutes and the estimated cost
 * at the given hourly prices.
 */
export function summarizeTrial(
  segments: readonly TrialSegment[],
  reference: TrialReference,
  pricePerHour: Readonly<Record<TranscriptionProvider, number>>,
) {
  const scored = new Map(
    reference.turns.map((turn) => [turn.turnNumber, turn]),
  );
  const groups = new Map<string, TrialSegment[]>();
  for (const segment of segments) {
    if (!scored.has(segment.turnNumber)) continue;
    const key = `${segment.provider}:${segment.role}:${segment.language}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const { provider, role, language } = group[0]!;
      const ordered = [...group].sort(
        (a, b) =>
          a.turnNumber - b.turnNumber || a.spokenStartAt - b.spokenStartAt,
      );
      const turns = new Set(ordered.map((segment) => segment.turnNumber));
      const expected = reference.turns
        .filter(
          (turn) => turn.language === language && turns.has(turn.turnNumber),
        )
        .map((turn) => turn.text)
        .join(" ");
      const score = wordErrors(
        trialWords(expected),
        trialWords(ordered.map((segment) => segment.text).join(" ")),
      );
      const latencies = ordered.flatMap((segment) =>
        segment.latencyMs === null ? [] : [segment.latencyMs],
      );
      const audioMinutes =
        ordered.reduce((sum, segment) => sum + segment.audioMs, 0) / 60_000;
      return {
        provider,
        role,
        language,
        turns: turns.size,
        ...score,
        latencyP50Ms: percentile(latencies, 50),
        latencyP95Ms: percentile(latencies, 95),
        audioMinutes,
        costPerMinute: pricePerHour[provider] / 60,
        estimatedCost: (audioMinutes * pricePerHour[provider]) / 60,
      };
    });
}
