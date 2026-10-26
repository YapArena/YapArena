import { createHmac, timingSafeEqual } from "node:crypto";
import { parseCleanupArguments, } from "../outline/cleanup.js";
import { OUTLINE_LIMITS, proposedOps, } from "../outline/reducer.js";
// Decision 0012: the private protocol between the transcriber agent (LiveKit
// Cloud) and the YapArena server, which stays the authority. Shared by both
// sides, so neither can drift from the other's limits.
export const INGEST_MAX_BYTES = 32 * 1024;
export const INGEST_MAX_SKEW_MS = 30_000;
export const SEGMENT_TEXT_MAX = 1000;
export const SEGMENTS_PER_UPDATE_MAX = 20;
export const WORDS_PER_SEGMENT_MAX = 300;
export const transcriptionProviders = ["deepgram", "elevenlabs"];
export const debaterLanguages = ["fr", "en"];
export { OUTLINE_TOPIC } from "../outline/public-types.js";
export const CLEANUP_ACCEPT_MS = 60_000;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const integer = (value, min, max) => typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max;
const jobId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const epoch = (value) => integer(value, 1_700_000_000_000, 4_102_444_800_000);
function word(value) {
    if (!isObject(value) || !exactKeys(value, ["w", "s", "e"], ["c"]))
        return null;
    if (typeof value.w !== "string" ||
        !value.w.length ||
        value.w.length > 100 ||
        !integer(value.s, 0, 600_000) ||
        !integer(value.e, value.s, 600_000) ||
        (value.c !== undefined &&
            (typeof value.c !== "number" || !(value.c >= 0 && value.c <= 1))))
        return null;
    return {
        w: value.w,
        s: value.s,
        e: value.e,
        ...(value.c === undefined ? {} : { c: value.c }),
    };
}
function segment(value) {
    if (!isObject(value) ||
        !exactKeys(value, [
            "provider",
            "role",
            "language",
            "side",
            "startAt",
            "endAt",
            "text",
            "words",
            "latencyMs",
            "audioMs",
        ]))
        return null;
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (!transcriptionProviders.includes(value.provider) ||
        (value.role !== "primary" && value.role !== "shadow") ||
        !debaterLanguages.includes(value.language) ||
        (value.side !== "A" && value.side !== "B") ||
        !epoch(value.startAt) ||
        !epoch(value.endAt) ||
        value.endAt < value.startAt ||
        value.endAt - value.startAt > 600_000 ||
        !text.length ||
        text.length > SEGMENT_TEXT_MAX ||
        !Array.isArray(value.words) ||
        value.words.length > WORDS_PER_SEGMENT_MAX ||
        (value.latencyMs !== null && !integer(value.latencyMs, 0, 600_000)) ||
        !integer(value.audioMs, 0, 600_000))
        return null;
    const words = value.words.map(word);
    if (words.some((item) => item === null))
        return null;
    return {
        provider: value.provider,
        role: value.role,
        language: value.language,
        side: value.side,
        startAt: value.startAt,
        endAt: value.endAt,
        text,
        words: words,
        latencyMs: value.latencyMs,
        audioMs: value.audioMs,
    };
}
const nullableText = (value) => value === null || (typeof value === "string" && value.length <= 500);
function proposal(value) {
    if (!isObject(value) ||
        !exactKeys(value, ["baseVersion", "span", "edits", "model"]) ||
        !integer(value.baseVersion, 0, 10_000_000) ||
        !isObject(value.span) ||
        !exactKeys(value.span, ["startMs", "endMs"]) ||
        !integer(value.span.startMs, 0, 3_600_000) ||
        !integer(value.span.endMs, value.span.startMs, 3_600_000) ||
        typeof value.model !== "string" ||
        !/^[a-z0-9.-]{1,100}$/.test(value.model) ||
        !Array.isArray(value.edits) ||
        value.edits.length > OUTLINE_LIMITS.edits)
        return null;
    const edits = [];
    for (const edit of value.edits) {
        if (!isObject(edit) ||
            !exactKeys(edit, ["op", "argument", "point", "key", "text", "target"]) ||
            !proposedOps.includes(edit.op) ||
            !["argument", "point", "key", "text", "target"].every((field) => nullableText(edit[field])))
            return null;
        edits.push(edit);
    }
    return {
        baseVersion: value.baseVersion,
        span: {
            startMs: value.span.startMs,
            endMs: value.span.endMs,
        },
        edits,
        model: value.model,
    };
}
/** Strict parse: unknown fields, bad types or exceeded limits give null. */
export function parseTranscriptUpdate(value) {
    if (!isObject(value) ||
        !exactKeys(value, ["jobId", "sequence", "turnNumber", "sentAt", "segments"], ["outline"]))
        return null;
    const outline = value.outline === undefined ? undefined : proposal(value.outline);
    if (outline === null)
        return null;
    if (!jobId(value.jobId) ||
        !integer(value.sequence, 0, 10_000_000) ||
        !integer(value.turnNumber, 1, 10_000) ||
        !epoch(value.sentAt) ||
        !Array.isArray(value.segments) ||
        value.segments.length > SEGMENTS_PER_UPDATE_MAX)
        return null;
    const segments = value.segments.map(segment);
    if (segments.some((item) => item === null))
        return null;
    return {
        jobId: value.jobId,
        sequence: value.sequence,
        turnNumber: value.turnNumber,
        sentAt: value.sentAt,
        segments: segments,
        ...(outline ? { outline } : {}),
    };
}
export function parseOutlineCleanup(value) {
    if (!isObject(value) ||
        !exactKeys(value, ["jobId", "turnNumber", "model", "arguments"]) ||
        !jobId(value.jobId) ||
        !Number.isSafeInteger(value.turnNumber) ||
        value.turnNumber < 1 ||
        typeof value.model !== "string" ||
        !/^[a-z0-9.-]{1,100}$/.test(value.model))
        return null;
    const items = parseCleanupArguments(value.arguments);
    return items
        ? {
            jobId: value.jobId,
            turnNumber: value.turnNumber,
            model: value.model,
            arguments: items,
        }
        : null;
}
export function parseSessionRequest(value) {
    return isObject(value) && exactKeys(value, ["jobId"]) && jobId(value.jobId)
        ? { jobId: value.jobId }
        : null;
}
/** HMAC-SHA256 over "<timestamp>.<body>", hex. */
export function signIngest(secret, timestamp, body) {
    return createHmac("sha256", secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
}
/**
 * Checks the signature headers against the raw body. The timestamp is epoch
 * milliseconds and may differ from `now` by at most INGEST_MAX_SKEW_MS.
 */
export function verifyIngest(secret, timestamp, signature, body, now = Date.now()) {
    if (!timestamp ||
        !/^\d{13}$/.test(timestamp) ||
        Math.abs(now - Number(timestamp)) > INGEST_MAX_SKEW_MS ||
        !signature ||
        !/^[a-f0-9]{64}$/.test(signature))
        return false;
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signIngest(secret, timestamp, body), "hex"));
}
export const ingestHeaders = {
    timestamp: "X-Yap-Timestamp",
    signature: "X-Yap-Signature",
};
