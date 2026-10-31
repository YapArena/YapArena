import { AutoSubscribe, type JobContext } from "@livekit/agents";
import {
  AudioStream,
  RoomEvent,
  TrackSource,
  type AudioFrame,
  type Participant,
} from "@livekit/rtc-node";
import Anthropic from "@anthropic-ai/sdk";
import {
  OUTLINE_TOPIC,
  type OutlineAnswer,
  type OutlineMessage,
  type Side,
  type TurnHint,
} from "../protocol.ts";
import type { FinalMessage } from "../../outline/public-types.ts";
import { createLiveOutliner } from "./claude.ts";
import { createWindowCleaner } from "./cleanup.ts";
import { createOutlineLoop, type OutlineLoop } from "./outline-loop.ts";
import { hintFromSession, parseTurnHint, turnFromHint } from "./turns.ts";
import type { AgentConfig } from "./config.ts";
import { createIngestClient } from "./ingest-client.ts";
import { createSpeechEngine } from "./providers.ts";
import { createTurnTranscriber, type CaptionUpdate } from "./transcriber.ts";

// Decision 0012: one job per debate room. The agent joins hidden, subscribes
// to nothing by default, and follows only the active speaker's microphone.
// The server's room-metadata turn hint drives it; the server's session state
// (fetched at start and refreshed) is the authority for languages, consent,
// and whether the debate is still on.

export const TRANSCRIPTION_TOPIC = "lk.transcription";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const waitingStatuses = new Set(["scheduled", "ready", "live"]);
/** Gives up on a debate that never starts. */
export const MAX_WAIT_MS = 15 * 60_000;
export const REFRESH_MS = 15_000;

function speakerSide(participant: Participant): Side | null {
  if (!participant.identity.startsWith("speaker-")) return null;
  try {
    const side = (
      JSON.parse(participant.metadata || "{}") as { side?: unknown }
    ).side;
    return side === "A" || side === "B" ? side : null;
  } catch {
    return null;
  }
}

// Structured logs never carry transcript text or secrets.
function createLog(debateId: string) {
  return (message: string, detail: Record<string, unknown> = {}) => {
    const fields = Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [
        key,
        value instanceof Error ? value.message : value,
      ]),
    );
    console.log(JSON.stringify({ message, debateId, ...fields }));
  };
}

export async function runDebateTranscriber(
  ctx: JobContext,
  config: AgentConfig,
) {
  let debateId: unknown;
  try {
    debateId = (JSON.parse(ctx.job.metadata || "{}") as { debateId?: unknown })
      .debateId;
  } catch {
    debateId = undefined;
  }
  if (typeof debateId !== "string" || !uuid.test(debateId)) {
    ctx.shutdown("dispatch without a debate");
    return;
  }
  const log = createLog(debateId);
  const jobId =
    ctx.job.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "job";
  const ingest = createIngestClient({
    origin: config.ingestUrl,
    secret: config.ingestSecret,
    debateId,
  });
  const initial = await ingest.session(jobId);
  if (!initial || !waitingStatuses.has(initial.debateStatus)) {
    log("debate is not awaiting transcription", {
      status: initial?.debateStatus ?? "unknown",
    });
    ctx.shutdown("debate unavailable");
    return;
  }
  const room = ctx.room;
  const primary = createSpeechEngine(config.provider, {
    elevenLabsKey: config.elevenLabsKey,
    log,
  });
  const shadow = config.shadowProvider
    ? createSpeechEngine(config.shadowProvider, {
        elevenLabsKey: config.elevenLabsKey,
        log,
      })
    : undefined;
  let followed: Side | null = null;
  const audio = new Map<string, AudioStream>();
  const resubscribe = () => {
    for (const participant of room.remoteParticipants.values()) {
      const side = speakerSide(participant);
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== TrackSource.SOURCE_MICROPHONE) continue;
        const wanted = side !== null && side === followed;
        if (publication.subscribed !== wanted)
          publication.setSubscribed(wanted);
      }
    }
  };
  async function caption(update: CaptionUpdate) {
    const local = room.localParticipant;
    if (!room.isConnected || !local) return;
    const writer = await local.streamText({
      topic: TRANSCRIPTION_TOPIC,
      senderIdentity: update.speaker,
      attributes: {
        "lk.transcription_final": String(update.final),
        "lk.segment_id": update.segmentId,
        "lk.transcribed_track_id": update.trackId,
        "yap.language": update.language,
      },
    });
    await writer.write(update.text);
    await writer.close();
  }
  // The live AI outline: one model call at a time, through the same ordered
  // sender as the transcript; accepted versions go to viewers over LiveKit.
  async function publishOutline(message: OutlineMessage | FinalMessage) {
    const local = room.localParticipant;
    if (!room.isConnected || !local) return;
    await local.publishData(new TextEncoder().encode(JSON.stringify(message)), {
      reliable: true,
      topic: OUTLINE_TOPIC,
    });
  }
  const outline: OutlineLoop | undefined = config.anthropicKey
    ? createOutlineLoop({
        debateId,
        proposition: initial.proposition,
        call: createLiveOutliner({
          client: new Anthropic({ apiKey: config.anthropicKey }),
          log,
        }),
        clean: createWindowCleaner({
          client: new Anthropic({ apiKey: config.anthropicKey }),
          log,
        }),
        submitCleanup: (turnNumber, model, items) =>
          ingest.cleanup({ jobId, turnNumber, model, arguments: items }),
        submit: (turnNumber, proposal): Promise<OutlineAnswer | null> =>
          transcriber.proposeOutline(turnNumber, proposal),
        publish: publishOutline,
        minIntervalMs: config.outlineMinIntervalMs,
        log,
        resync: async () => (await ingest.session(jobId))?.outline ?? null,
      })
    : undefined;
  outline?.resume(initial.outline);
  const transcriber = createTurnTranscriber<AudioFrame>({
    primary,
    shadow,
    jobId,
    nextSequence: initial.nextSequence,
    send: (update) => ingest.update(update),
    captions: caption,
    follow(side) {
      followed = side;
      resubscribe();
    },
    captionsPerSecond: config.captionsPerSecond,
    log,
    outline,
  });
  transcriber.setSpeakers(initial.speakers);

  let ending: Promise<void> | undefined;
  const end = (reason: string) =>
    (ending ??= (async () => {
      log("transcriber stopping", { reason });
      await transcriber.stop();
      ctx.shutdown(reason);
    })());
  const apply = (hint: TurnHint | null) => {
    if (!hint) return;
    if (
      !waitingStatuses.has(hint.debateStatus) ||
      hint.mediaState === "ended"
    ) {
      void end(`debate ${hint.debateStatus}`);
      return;
    }
    transcriber.setTurn(turnFromHint(hint));
  };

  room.on(RoomEvent.ParticipantConnected, resubscribe);
  room.on(RoomEvent.TrackPublished, resubscribe);
  room.on(RoomEvent.ParticipantMetadataChanged, resubscribe);
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const side = speakerSide(participant);
    if (publication.source !== TrackSource.SOURCE_MICROPHONE || !side) return;
    if (side !== followed) {
      publication.setSubscribed(false);
      return;
    }
    const sid = publication.sid ?? track.sid ?? participant.identity;
    const stream = new AudioStream(track, {
      sampleRate: 16000,
      numChannels: 1,
    });
    audio.set(sid, stream);
    transcriber.setAudio(side, {
      frames: stream,
      trackId: sid,
      identity: participant.identity,
    });
  });
  room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
    const sid = publication.sid ?? participant.identity;
    const stream = audio.get(sid);
    audio.delete(sid);
    if (stream && !stream.locked) void stream.cancel().catch(() => {});
    const side = speakerSide(participant);
    if (side) transcriber.setAudio(side, null);
  });
  room.on(RoomEvent.RoomMetadataChanged, (metadata) =>
    apply(parseTurnHint(metadata)),
  );

  await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_NONE);
  log("transcriber joined", {
    provider: config.provider,
    shadow: config.shadowProvider ?? "none",
  });
  apply(hintFromSession(initial));
  apply(parseTurnHint(room.metadata));

  const joinedAt = Date.now();
  let refreshing = false;
  const refresh = setInterval(() => {
    if (refreshing || ending) return;
    refreshing = true;
    void ingest
      .session(jobId)
      .then((state) => {
        if (!state) return void end("debate unavailable");
        transcriber.setSpeakers(state.speakers);
        if (
          state.debateStatus !== "live" &&
          Date.now() - joinedAt > MAX_WAIT_MS
        )
          return void end("debate did not start");
        apply(hintFromSession(state));
      })
      .catch((error: unknown) => log("session refresh failed", { error }))
      .finally(() => {
        refreshing = false;
      });
  }, REFRESH_MS);
  ctx.addShutdownCallback(async () => {
    clearInterval(refresh);
    // A shutdown that begins while the transcriber is stopping (the room
    // closing, for example) lets it finish the last turn's cleanup, within
    // LiveKit's shutdown timeout.
    await ending;
    for (const stream of audio.values())
      if (!stream.locked) await stream.cancel().catch(() => {});
  });
}
