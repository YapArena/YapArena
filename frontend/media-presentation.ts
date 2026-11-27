import type { MediaState } from "./media-types.js";

export function mediaPresentation(
  eventStatus: string,
  state: MediaState | null | undefined,
  automaticReplayPublication = false,
) {
  const live = eventStatus === "live";
  const readyRecording = state?.recordingStatus === "ready";
  let message: string;
  if (live && state?.state === "paused")
    message = `Debate paused: ${state.incident || "operator review"}`;
  else if (live && state?.state === "running")
    message =
      state.speakingSide === null
        ? `Live. A viewer has the mic. Recording ${state.recordingStatus}.`
        : `Live. Speaker ${state.activeSide} has the floor. Recording ${state.recordingStatus}.`;
  else if (eventStatus === "ended" && state?.recordingStatus === "failed")
    message =
      "Recording failed. Replay is unavailable. Operator review required.";
  else if (eventStatus === "ended" && readyRecording)
    message = automaticReplayPublication
      ? "Recording is ready. Replay is being prepared and will be published automatically."
      : "Recording is ready. An operator can publish the replay.";
  else if (eventStatus === "ended")
    message = "Debate ended. Recording is being prepared.";
  else if (["replay", "finalized"].includes(eventStatus))
    message = readyRecording
      ? "Replay is available."
      : "No replay video is available for this listing.";
  else if (["scheduled", "ready"].includes(eventStatus))
    message = "This debate has not started yet.";
  else message = "Live media is unavailable for this debate.";

  return {
    message,
    replayVisible:
      ["replay", "finalized"].includes(eventStatus) && readyRecording,
    actions: {
      start: eventStatus === "ready" && !state,
      pause: live && state?.state === "running",
      resume:
        live &&
        state?.state === "paused" &&
        state.recordingStatus === "recording",
      end:
        live &&
        (["running", "paused"] as readonly (string | undefined)[]).includes(
          state?.state,
        ),
      replay:
        eventStatus === "ended" &&
        state?.state === "ended" &&
        readyRecording &&
        !automaticReplayPublication,
    },
  };
}
