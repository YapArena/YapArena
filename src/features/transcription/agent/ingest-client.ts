import { setTimeout as delay } from "node:timers/promises";
import type { TurnOutline } from "../../outline/reducer.ts";
import {
  ingestHeaders,
  signIngest,
  type DebaterLanguage,
  type OutlineCleanup,
  type Side,
  type TranscriptUpdate,
} from "../protocol.ts";

// Signed calls from the agent to the YapArena server. A network failure or a
// 5xx retries the identical body (ingest is idempotent by sequence); every
// other answer is returned to the caller to act on.

export interface SessionState {
  debateId: string;
  debateStatus: string;
  proposition: string;
  media: {
    state: string;
    turnNumber: number;
    activeSide: Side | null;
    turnDeadlineAt: string | null;
  } | null;
  serverNow: string;
  nextSequence: number;
  speakers: {
    side: Side;
    language: DebaterLanguage | null;
    consented: boolean;
  }[];
  outline: {
    version: number;
    turn: TurnOutline | null;
    map: { id: string; turnNumber: number; side: Side; label: string }[];
  };
}
export interface IngestAnswer {
  status: number;
  body: Record<string, unknown>;
}

export function createIngestClient({
  origin,
  secret,
  debateId,
  fetch: send = fetch,
  now = Date.now,
  wait = (ms: number) => delay(ms),
  attempts = 3,
  timeoutMs = 5000,
}: {
  origin: URL;
  secret: string;
  debateId: string;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  attempts?: number;
  timeoutMs?: number;
}) {
  async function post(path: string, value: unknown): Promise<IngestAnswer> {
    const body = JSON.stringify(value);
    const url = new URL(
      `/api/internal/transcription/debates/${debateId}/${path}`,
      origin,
    );
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await wait(250 * 2 ** attempt);
      const timestamp = String(now());
      try {
        const response = await send(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [ingestHeaders.timestamp]: timestamp,
            [ingestHeaders.signature]: signIngest(secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status >= 500) {
          failure = new Error(`ingest answered ${response.status}`);
          continue;
        }
        let parsed: Record<string, unknown> = {};
        try {
          parsed = (await response.json()) as Record<string, unknown>;
        } catch {
          // An empty or invalid body still reports its status.
        }
        return { status: response.status, body: parsed };
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }
  return Object.freeze({
    async session(jobId: string) {
      const answer = await post("session", { jobId });
      return answer.status === 200
        ? (answer.body as unknown as SessionState)
        : null;
    },
    update(update: TranscriptUpdate) {
      return post("updates", update);
    },
    /** The window cleanup; the server accepts one per window. */
    cleanup(cleanup: OutlineCleanup) {
      return post("cleanup", cleanup);
    },
  });
}
export type IngestClient = ReturnType<typeof createIngestClient>;
