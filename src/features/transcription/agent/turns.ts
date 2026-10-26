import type { TurnHint } from "../protocol.ts";
import type { SessionState } from "./ingest-client.ts";
import type { TurnState } from "./transcriber.ts";

// The server's turn hint (room metadata, or its session state) as the
// transcriber's turn. Running means live and not paused.
export function parseTurnHint(metadata: string | undefined): TurnHint | null {
  if (!metadata) return null;
  try {
    const value = JSON.parse(metadata) as Partial<TurnHint>;
    return value && value.v === 1 && typeof value.debateStatus === "string"
      ? (value as TurnHint)
      : null;
  } catch {
    return null;
  }
}

export function turnFromHint(hint: TurnHint): TurnState | null {
  if (
    hint.turnNumber === null ||
    hint.activeSide === null ||
    (hint.mediaState !== "running" && hint.mediaState !== "paused")
  )
    return null;
  const deadline = hint.turnDeadlineAt ? Date.parse(hint.turnDeadlineAt) : NaN;
  return {
    turnNumber: hint.turnNumber,
    side: hint.activeSide,
    deadlineAt: Number.isFinite(deadline) ? deadline : null,
    running: hint.mediaState === "running" && hint.debateStatus === "live",
  };
}

export function hintFromSession(state: SessionState): TurnHint {
  return {
    v: 1,
    debateStatus: state.debateStatus,
    mediaState: (state.media?.state ?? null) as TurnHint["mediaState"],
    turnNumber: state.media?.turnNumber ?? null,
    activeSide: state.media?.activeSide ?? null,
    turnDeadlineAt: state.media?.turnDeadlineAt ?? null,
  };
}
