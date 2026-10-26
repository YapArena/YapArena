import { SEGMENTS_PER_UPDATE_MAX } from "../protocol.js";
const realClock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
/** Opens the next speaker's channels this long before the deadline. */
export const PREOPEN_MS = 1500;
/** Spacing between ingest requests, about one a second at most. */
export const SEND_SPACING_MS = 750;
export const QUEUE_MAX = 200;
export function createTurnTranscriber({ primary, shadow, jobId, nextSequence, send, captions, follow, captionsPerSecond = 4, clock = realClock, log = () => { }, outline, }) {
    const speakers = new Map();
    let turn = null;
    let active = null;
    let prepared = null;
    let preopenTimer;
    let sequence = nextSequence;
    const queue = [];
    let sending = null;
    let lastSent = -Infinity;
    // A failed request is retried with exactly the same batch and sequence.
    let retry = null;
    let stopped = false;
    const finishing = new Set();
    let opened = 0;
    const consenting = (side) => {
        const speaker = speakers.get(side);
        return speaker?.consented && speaker.language ? speaker.language : null;
    };
    function open(turnNumber, side) {
        const language = consenting(side);
        if (!language)
            return null;
        const result = {
            id: opened++,
            turnNumber,
            side,
            language,
            channels: [],
            audio: null,
            segment: 0,
            finished: false,
        };
        for (const [engine, role] of [
            [primary, "primary"],
            ...(shadow ? [[shadow, "shadow"]] : []),
        ]) {
            try {
                const speech = engine.open(language);
                const channel = {
                    engine,
                    role,
                    speech,
                    audioStartedAt: null,
                    reading: Promise.resolve(),
                };
                channel.reading = read(result, channel);
                result.channels.push(channel);
            }
            catch (error) {
                log("speech channel failed to open", {
                    provider: engine.provider,
                    role,
                    error,
                });
            }
        }
        return result;
    }
    // Interim captions are throttled per turn; the latest text wins, and a
    // final caption cancels any pending interim.
    const captionTimers = new Map();
    const lastCaption = new Map();
    function caption(owner, text, final) {
        const audio = owner.audio;
        if (!audio)
            return;
        const update = {
            speaker: audio.identity,
            trackId: audio.trackId,
            segmentId: `SG_${owner.turnNumber}_${owner.id}_${owner.segment}`,
            text,
            final,
            language: owner.language,
        };
        const pending = captionTimers.get(owner);
        if (pending !== undefined)
            clock.clearTimeout(pending);
        captionTimers.delete(owner);
        const publish = () => {
            lastCaption.set(owner, clock.now());
            void captions(update).catch((error) => log("caption publish failed", { error }));
        };
        const spacing = 1000 / captionsPerSecond, since = clock.now() - (lastCaption.get(owner) ?? -Infinity);
        if (final || since >= spacing)
            publish();
        else
            captionTimers.set(owner, clock.setTimeout(publish, spacing - since));
    }
    async function read(owner, channel) {
        try {
            for await (const update of channel.speech.updates) {
                if (update.kind === "interim") {
                    if (channel.role === "primary" && update.text.trim())
                        caption(owner, update.text, false);
                    continue;
                }
                const text = update.text.trim();
                if (!text || channel.audioStartedAt === null)
                    continue;
                const startAt = Math.round(channel.audioStartedAt + update.startTime * 1000), endAt = Math.max(startAt, Math.round(channel.audioStartedAt + update.endTime * 1000));
                const words = [];
                for (const word of update.words) {
                    const value = word.text.trim();
                    if (!value ||
                        word.startTime === undefined ||
                        word.endTime === undefined)
                        continue;
                    const s = Math.max(0, Math.round((word.startTime - update.startTime) * 1000));
                    words.push({
                        w: value.slice(0, 100),
                        s,
                        e: Math.max(s, Math.round((word.endTime - update.startTime) * 1000)),
                        ...(word.confidence === undefined
                            ? {}
                            : { c: Math.min(1, Math.max(0, word.confidence)) }),
                    });
                }
                enqueue(owner.turnNumber, {
                    provider: channel.engine.provider,
                    role: channel.role,
                    language: owner.language,
                    side: owner.side,
                    startAt,
                    endAt,
                    text: text.slice(0, 1000),
                    words: words.slice(0, 300),
                    latencyMs: Math.min(600_000, Math.max(0, clock.now() - endAt)),
                    audioMs: Math.min(600_000, endAt - startAt),
                });
                if (channel.role === "primary") {
                    caption(owner, text, true);
                    owner.segment++;
                    outline?.addFinal(owner.turnNumber, { text, startAt, endAt });
                }
            }
        }
        catch (error) {
            log("speech channel failed", {
                provider: channel.engine.provider,
                error,
            });
        }
    }
    async function pump(owner, audio) {
        try {
            for await (const frame of audio.frames) {
                if (owner.finished || owner.audio !== audio)
                    break;
                for (const channel of owner.channels) {
                    channel.audioStartedAt ??= clock.now();
                    channel.speech.push(frame);
                }
            }
        }
        catch (error) {
            log("audio stream failed", { error });
        }
    }
    function finish(owner) {
        if (!owner || owner.finished)
            return Promise.resolve();
        owner.finished = true;
        const work = (async () => {
            await Promise.allSettled(owner.channels.map((c) => c.speech.finish()));
            await Promise.allSettled(owner.channels.map((c) => c.reading));
            const timer = captionTimers.get(owner);
            if (timer !== undefined)
                clock.clearTimeout(timer);
            captionTimers.delete(owner);
            lastCaption.delete(owner);
            kick();
        })().finally(() => finishing.delete(work));
        finishing.add(work);
        return work;
    }
    function schedulePreopen() {
        if (preopenTimer !== undefined)
            clock.clearTimeout(preopenTimer);
        preopenTimer = undefined;
        if (!turn?.running || turn.deadlineAt === null)
            return;
        const next = {
            turnNumber: turn.turnNumber + 1,
            side: (turn.side === "A" ? "B" : "A"),
        };
        preopenTimer = clock.setTimeout(() => {
            preopenTimer = undefined;
            if (stopped || prepared || active?.turnNumber === next.turnNumber)
                return;
            prepared = open(next.turnNumber, next.side);
        }, Math.max(0, turn.deadlineAt - PREOPEN_MS - clock.now()));
    }
    function trim() {
        while (queue.length > QUEUE_MAX) {
            const [removed] = queue.splice(retry ? retry.count : 0, 1);
            if (removed?.kind === "outline")
                removed.resolve(null);
            log("transcript queue full; oldest entry dropped");
        }
    }
    function enqueue(turnNumber, segment) {
        queue.push({ kind: "segment", turnNumber, segment });
        trim();
        kick();
    }
    function kick() {
        if (sending || !queue.length)
            return;
        const wait = Math.max(0, lastSent + SEND_SPACING_MS - clock.now());
        sending = new Promise((resolve) => {
            clock.setTimeout(() => void flushOnce().finally(resolve), wait);
        }).finally(() => {
            sending = null;
            if (queue.length && !stopped)
                kick();
        });
    }
    // One update holds the oldest entries of one turn: its segments (at most
    // twenty) and at most one outline proposal, which then goes with every
    // segment queued before it.
    function nextBatch() {
        const first = queue[0];
        if (!first)
            return null;
        const segments = [];
        let count = 0;
        let proposal;
        for (const item of queue) {
            if (item.turnNumber !== first.turnNumber)
                break;
            if (item.kind === "outline") {
                proposal = item;
                count++;
                break;
            }
            if (segments.length >= SEGMENTS_PER_UPDATE_MAX)
                break;
            segments.push(item.segment);
            count++;
        }
        return {
            count,
            outline: proposal,
            update: {
                jobId,
                sequence,
                turnNumber: first.turnNumber,
                sentAt: clock.now(),
                segments,
                ...(proposal ? { outline: proposal.proposal } : {}),
            },
        };
    }
    async function flushOnce() {
        const batch = retry ?? nextBatch();
        if (!batch)
            return;
        lastSent = clock.now();
        let answer;
        try {
            answer = await send(batch.update);
        }
        catch (error) {
            // Network failure after retries: keep the batch and the sequence, so
            // the identical update is retried next time.
            log("transcript update failed; retrying", { error });
            retry = batch;
            lastSent = clock.now() + 2000;
            return;
        }
        if (answer.status === 429) {
            retry = batch;
            lastSent = clock.now() + 1000;
            return;
        }
        retry = null;
        sequence++;
        queue.splice(0, batch.count);
        batch.outline?.resolve(answer.status === 200
            ? (answer.body.outline ?? null)
            : null);
        if (answer.status === 403) {
            const side = batch.update.segments[0]?.side ?? turn?.side;
            const speaker = side ? speakers.get(side) : undefined;
            if (side && speaker)
                speakers.set(side, { ...speaker, consented: false });
            for (let index = queue.length - 1; index >= 0; index--) {
                const item = queue[index];
                if (item.kind === "segment" && item.segment.side === side)
                    queue.splice(index, 1);
            }
            if (active?.side === side) {
                void finish(active);
                active = null;
                follow(null);
            }
        }
        if (answer.status !== 200)
            log("transcript update refused", {
                status: answer.status,
                body: answer.body,
            });
    }
    return Object.freeze({
        setSpeakers(list) {
            for (const speaker of list)
                speakers.set(speaker.side, speaker);
        },
        /** Applies the latest turn (from room metadata or the server's state). */
        setTurn(next) {
            if (stopped)
                return;
            const previous = turn;
            turn = next;
            const changed = !next ||
                !previous ||
                next.turnNumber !== previous.turnNumber ||
                next.running !== previous.running;
            if (changed) {
                let ending = Promise.resolve();
                if (active &&
                    (!next || !next.running || active.turnNumber !== next.turnNumber)) {
                    ending = finish(active);
                    active = null;
                }
                if (next?.running && !active) {
                    if (prepared?.turnNumber === next.turnNumber &&
                        prepared.side === next.side) {
                        active = prepared;
                        prepared = null;
                    }
                    else {
                        void finish(prepared);
                        prepared = null;
                        active = open(next.turnNumber, next.side);
                    }
                }
                follow(active ? active.side : null);
                // The outline moves on once the ending turn's last finals are in.
                const started = active, startedAt = clock.now();
                void ending
                    .then(() => started && outline
                    ? outline.startTurn({
                        turnNumber: started.turnNumber,
                        side: started.side,
                        language: started.language,
                        startedAt,
                    })
                    : outline?.flush())
                    .catch((error) => log("outline turn change failed", { error }));
            }
            schedulePreopen();
        },
        /** The host's subscription to a side's microphone started or ended. */
        setAudio(side, audio) {
            if (!active || active.side !== side)
                return;
            if (active.audio === audio)
                return;
            active.audio = audio;
            if (audio)
                void pump(active, audio);
        },
        /** Flushes the turn in progress and sends what is queued (bounded). */
        async stop(timeoutMs = 10_000) {
            if (stopped)
                return;
            void finish(active);
            void finish(prepared);
            active = null;
            prepared = null;
            if (preopenTimer !== undefined)
                clock.clearTimeout(preopenTimer);
            follow(null);
            const deadline = clock.now() + timeoutMs;
            await Promise.allSettled([...finishing]);
            await outline?.flush().catch(() => { });
            while (queue.length && clock.now() < deadline) {
                kick();
                await sending;
            }
            stopped = true;
        },
        /** Sends an outline proposal in order with this turn's transcript. */
        proposeOutline(turnNumber, proposal) {
            return new Promise((resolve) => {
                if (stopped)
                    return resolve(null);
                queue.push({ kind: "outline", turnNumber, proposal, resolve });
                trim();
                kick();
            });
        },
        get sequence() {
            return sequence;
        },
        get queued() {
            return queue.length;
        },
    });
}
