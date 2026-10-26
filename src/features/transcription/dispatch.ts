import type { Logger } from "pino";
import type { createTranscriptionRepository } from "./repository.ts";

// Decision 0012: the transcriber agent joins a debate room only when the
// server dispatches it explicitly; it never auto-joins rooms. A dispatch is
// claimed in the database first, so the warm-up at readiness and the call at
// start never dispatch twice. Failures retry with backoff, five times at most.

export interface AgentDispatcher {
  createDispatch(
    roomName: string,
    agentName: string,
    options: { metadata: string },
  ): Promise<{ id: string }>;
}

export function createTranscriberDispatcher({
  repository,
  client,
  agentName,
  roomName,
  logger,
}: {
  repository: Pick<
    ReturnType<typeof createTranscriptionRepository>,
    "claimDispatch" | "dispatchSettled" | "dispatchCandidates"
  >;
  client: AgentDispatcher;
  agentName: string;
  roomName: (debateId: string) => string;
  logger: Pick<Logger, "warn">;
}) {
  async function dispatch(debateId: string) {
    try {
      const attempt = await repository.claimDispatch(debateId);
      if (attempt === null) return false;
      let dispatchId: string | null = null;
      try {
        dispatchId = (
          await client.createDispatch(roomName(debateId), agentName, {
            metadata: JSON.stringify({ debateId }),
          })
        ).id;
      } finally {
        await repository.dispatchSettled(debateId, dispatchId);
      }
      return true;
    } catch (error) {
      logger.warn({ error, debateId }, "transcriber dispatch failed");
      return false;
    }
  }
  return Object.freeze({
    /** Never throws: transcription must not hold back or fail a start. */
    dispatch,
    /** One second step: warm a transcriber for ready and live debates. */
    async tick() {
      let dispatched = 0;
      for (const debateId of await repository.dispatchCandidates())
        if (await dispatch(debateId)) dispatched++;
      return { dispatched };
    },
  });
}
