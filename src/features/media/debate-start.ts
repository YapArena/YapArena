import type { Logger } from "pino";
import type { createMediaRepository } from "./repository.ts";
import type { createMediaProvider } from "./provider.ts";
import type { createMatchingRepository } from "../matching/repository.ts";
import { MediaConflictError } from "./repository.ts";

// The one sequence that takes a ready debate live: check both speakers are connected, start the
// recording, start the turn clock, record the live transition and give side A the microphone.
// Every start path calls this so they all behave the same (Decision 0011).
export function createDebateStart({
  media,
  provider,
  matching,
}: {
  media: ReturnType<typeof createMediaRepository>;
  provider: ReturnType<typeof createMediaProvider>;
  matching: ReturnType<typeof createMatchingRepository>;
}) {
  return async function startDebate({
    debateId,
    actorUserId,
    reason,
    logger,
  }: {
    debateId: string;
    actorUserId: string;
    reason: string;
    logger: Pick<Logger, "error">;
  }) {
    let recording: { egressId: string; key: string } | undefined;
    try {
      if ((await provider.connectedSpeakers(debateId)) !== 2)
        throw new MediaConflictError(
          "both speakers must be connected before start",
        );
      recording = await provider.beginRecording(debateId);
      await media.start(debateId, recording.egressId, recording.key);
      const event = await matching.operatorTransition(
        actorUserId,
        debateId,
        "start",
        reason,
      );
      try {
        await provider.setTurn(debateId, "A");
      } catch (permissionError) {
        logger.error(
          { permissionError, id: debateId },
          "failed to set initial speaker turn",
        );
        try {
          await media.pause(
            debateId,
            null,
            "Speaker permissions could not be applied.",
          );
        } catch (pauseError) {
          logger.error(
            { pauseError, id: debateId },
            "failed to pause after permission error",
          );
        }
      }
      return { event, state: await media.get(debateId) };
    } catch (error) {
      if (recording) {
        await media.undoFailedStart(debateId);
        try {
          await provider.stopRecording(recording.egressId);
        } catch (stopError) {
          logger.error(
            { stopError, id: debateId },
            "failed to stop orphan recording",
          );
        }
      }
      throw error;
    }
  };
}
