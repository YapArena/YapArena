import { AutoSubscribe } from "@livekit/agents";
import { AudioStream, RoomEvent, TrackSource, } from "@livekit/rtc-node";
import { hintFromSession, parseTurnHint, turnFromHint } from "./turns.js";
import { createIngestClient } from "./ingest-client.js";
import { createSpeechEngine } from "./providers.js";
import { createTurnTranscriber } from "./transcriber.js";
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
function speakerSide(participant) {
    if (!participant.identity.startsWith("speaker-"))
        return null;
    try {
        const side = JSON.parse(participant.metadata || "{}").side;
        return side === "A" || side === "B" ? side : null;
    }
    catch {
        return null;
    }
}
// Structured logs never carry transcript text or secrets.
function createLog(debateId) {
    return (message, detail = {}) => {
        const fields = Object.fromEntries(Object.entries(detail).map(([key, value]) => [
            key,
            value instanceof Error ? value.message : value,
        ]));
        console.log(JSON.stringify({ message, debateId, ...fields }));
    };
}
export async function runDebateTranscriber(ctx, config) {
    let debateId;
    try {
        debateId = JSON.parse(ctx.job.metadata || "{}")
            .debateId;
    }
    catch {
        debateId = undefined;
    }
    if (typeof debateId !== "string" || !uuid.test(debateId)) {
        ctx.shutdown("dispatch without a debate");
        return;
    }
    const log = createLog(debateId);
    const jobId = ctx.job.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "job";
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
    let followed = null;
    const audio = new Map();
    const resubscribe = () => {
        for (const participant of room.remoteParticipants.values()) {
            const side = speakerSide(participant);
            for (const publication of participant.trackPublications.values()) {
                if (publication.source !== TrackSource.SOURCE_MICROPHONE)
                    continue;
                const wanted = side !== null && side === followed;
                if (publication.subscribed !== wanted)
                    publication.setSubscribed(wanted);
            }
        }
    };
    async function caption(update) {
        const local = room.localParticipant;
        if (!room.isConnected || !local)
            return;
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
    const transcriber = createTurnTranscriber({
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
    });
    transcriber.setSpeakers(initial.speakers);
    let ending;
    const end = (reason) => (ending ??= (async () => {
        log("transcriber stopping", { reason });
        await transcriber.stop();
        ctx.shutdown(reason);
    })());
    const apply = (hint) => {
        if (!hint)
            return;
        if (!waitingStatuses.has(hint.debateStatus) ||
            hint.mediaState === "ended") {
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
        if (publication.source !== TrackSource.SOURCE_MICROPHONE || !side)
            return;
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
        if (stream && !stream.locked)
            void stream.cancel().catch(() => { });
        const side = speakerSide(participant);
        if (side)
            transcriber.setAudio(side, null);
    });
    room.on(RoomEvent.RoomMetadataChanged, (metadata) => apply(parseTurnHint(metadata)));
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
        if (refreshing || ending)
            return;
        refreshing = true;
        void ingest
            .session(jobId)
            .then((state) => {
            if (!state)
                return void end("debate unavailable");
            transcriber.setSpeakers(state.speakers);
            if (state.debateStatus !== "live" &&
                Date.now() - joinedAt > MAX_WAIT_MS)
                return void end("debate did not start");
            apply(hintFromSession(state));
        })
            .catch((error) => log("session refresh failed", { error }))
            .finally(() => {
            refreshing = false;
        });
    }, REFRESH_MS);
    ctx.addShutdownCallback(async () => {
        clearInterval(refresh);
        for (const stream of audio.values())
            if (!stream.locked)
                await stream.cancel().catch(() => { });
    });
}
