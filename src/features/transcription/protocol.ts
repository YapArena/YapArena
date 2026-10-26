import { createHmac, timingSafeEqual } from "node:crypto";
import {
  OUTLINE_LIMITS,
  proposedOps,
  type ProposedEdit,
  type Span,
  type TurnOutline,
} from "../outline/reducer.ts";

// Decision 0012: the private protocol between the transcriber agent (LiveKit
// Cloud) and the YapArena server, which stays the authority. Shared by both
// sides, so neither can drift from the other's limits.

export const INGEST_MAX_BYTES = 32 * 1024;
export const INGEST_MAX_SKEW_MS = 30_000;
export const SEGMENT_TEXT_MAX = 1000;
export const SEGMENTS_PER_UPDATE_MAX = 20;
export const WORDS_PER_SEGMENT_MAX = 300;
export const transcriptionProviders = ["deepgram", "elevenlabs"] as const;
export type TranscriptionProvider = (typeof transcriptionProviders)[number];
export const debaterLanguages = ["fr", "en"] as const;
export type DebaterLanguage = (typeof debaterLanguages)[number];
export type Side = "A" | "B";

/** One word: offsets in milliseconds from its segment's start. */
export interface TranscriptWord {
  w: string;
  s: number;
  e: number;
  /** Provider confidence from 0 to 1, when the provider reports one. */
  c?: number;
}
export interface TranscriptSegment {
  provider: TranscriptionProvider;
  /** A shadow provider's segments are stored for comparison only. */
  role: "primary" | "shadow";
  language: DebaterLanguage;
  side: Side;
  /** Spoken start and end, epoch milliseconds on the agent's clock. */
  startAt: number;
  endAt: number;
  text: string;
  words: TranscriptWord[];
  /** Speech end to final transcript, as the agent measured it. */
  latencyMs: number | null;
  /** Audio the provider received for this segment. */
  audioMs: number;
}
/** The live loop's proposal: the model's edits to the turn's outline. */
export interface OutlineProposal {
  /** The outline version the proposal was made against. */
  baseVersion: number;
  /** The summarized transcript, in milliseconds from the turn's start. */
  span: Span;
  edits: ProposedEdit[];
  model: string;
}
export interface TranscriptUpdate {
  jobId: string;
  /** Monotonic per job, from 0. A retry repeats its sequence and body. */
  sequence: number;
  turnNumber: number;
  /** The agent's clock when it sent the update, epoch milliseconds. */
  sentAt: number;
  segments: TranscriptSegment[];
  outline?: OutlineProposal;
}
/** The server's answer to an outline proposal. */
export type OutlineAnswer =
  | {
      accepted: true;
      version: number;
      turnNumber: number;
      side: Side;
      language: DebaterLanguage;
      edits: import("../outline/reducer.ts").OutlineEdit[];
      rejected: number;
    }
  | {
      accepted: false;
      reason: "stale" | "unchanged";
      version: number;
      turn: TurnOutline | null;
    };
export { OUTLINE_TOPIC } from "../outline/public-types.ts";
/** The reliable LiveKit data message for each accepted outline version. */
export interface OutlineMessage {
  v: 1;
  type: "edits";
  debateId: string;
  version: number;
  turnNumber: number;
  side: Side;
  language: DebaterLanguage;
  edits: import("../outline/reducer.ts").OutlineEdit[];
}
export interface SessionRequest {
  jobId: string;
}

/** The room-metadata hint the server writes on every turn change. */
export interface TurnHint {
  v: 1;
  debateStatus: string;
  mediaState: "idle" | "running" | "paused" | "ended" | null;
  turnNumber: number | null;
  activeSide: Side | null;
  turnDeadlineAt: string | null;
}

type Record_ = Record<string, unknown>;
const isObject = (value: unknown): value is Record_ =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (
  value: Record_,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => key in value) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const jobId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const epoch = (value: unknown) =>
  integer(value, 1_700_000_000_000, 4_102_444_800_000);

function word(value: unknown): TranscriptWord | null {
  if (!isObject(value) || !exactKeys(value, ["w", "s", "e"], ["c"]))
    return null;
  if (
    typeof value.w !== "string" ||
    !value.w.length ||
    value.w.length > 100 ||
    !integer(value.s, 0, 600_000) ||
    !integer(value.e, value.s as number, 600_000) ||
    (value.c !== undefined &&
      (typeof value.c !== "number" || !(value.c >= 0 && value.c <= 1)))
  )
    return null;
  return {
    w: value.w,
    s: value.s as number,
    e: value.e as number,
    ...(value.c === undefined ? {} : { c: value.c as number }),
  };
}

function segment(value: unknown): TranscriptSegment | null {
  if (
    !isObject(value) ||
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
    ])
  )
    return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (
    !transcriptionProviders.includes(value.provider as TranscriptionProvider) ||
    (value.role !== "primary" && value.role !== "shadow") ||
    !debaterLanguages.includes(value.language as DebaterLanguage) ||
    (value.side !== "A" && value.side !== "B") ||
    !epoch(value.startAt) ||
    !epoch(value.endAt) ||
    (value.endAt as number) < (value.startAt as number) ||
    (value.endAt as number) - (value.startAt as number) > 600_000 ||
    !text.length ||
    text.length > SEGMENT_TEXT_MAX ||
    !Array.isArray(value.words) ||
    value.words.length > WORDS_PER_SEGMENT_MAX ||
    (value.latencyMs !== null && !integer(value.latencyMs, 0, 600_000)) ||
    !integer(value.audioMs, 0, 600_000)
  )
    return null;
  const words = value.words.map(word);
  if (words.some((item) => item === null)) return null;
  return {
    provider: value.provider as TranscriptionProvider,
    role: value.role,
    language: value.language as DebaterLanguage,
    side: value.side,
    startAt: value.startAt as number,
    endAt: value.endAt as number,
    text,
    words: words as TranscriptWord[],
    latencyMs: value.latencyMs as number | null,
    audioMs: value.audioMs as number,
  };
}

const nullableText = (value: unknown) =>
  value === null || (typeof value === "string" && value.length <= 500);
function proposal(value: unknown): OutlineProposal | null {
  if (
    !isObject(value) ||
    !exactKeys(value, ["baseVersion", "span", "edits", "model"]) ||
    !integer(value.baseVersion, 0, 10_000_000) ||
    !isObject(value.span) ||
    !exactKeys(value.span, ["startMs", "endMs"]) ||
    !integer(value.span.startMs, 0, 3_600_000) ||
    !integer(value.span.endMs, value.span.startMs as number, 3_600_000) ||
    typeof value.model !== "string" ||
    !/^[a-z0-9.-]{1,100}$/.test(value.model) ||
    !Array.isArray(value.edits) ||
    value.edits.length > OUTLINE_LIMITS.edits
  )
    return null;
  const edits: ProposedEdit[] = [];
  for (const edit of value.edits) {
    if (
      !isObject(edit) ||
      !exactKeys(edit, ["op", "argument", "point", "key", "text", "target"]) ||
      !proposedOps.includes(edit.op as ProposedEdit["op"]) ||
      !["argument", "point", "key", "text", "target"].every((field) =>
        nullableText(edit[field]),
      )
    )
      return null;
    edits.push(edit as unknown as ProposedEdit);
  }
  return {
    baseVersion: value.baseVersion as number,
    span: {
      startMs: value.span.startMs as number,
      endMs: value.span.endMs as number,
    },
    edits,
    model: value.model,
  };
}

/** Strict parse: unknown fields, bad types or exceeded limits give null. */
export function parseTranscriptUpdate(value: unknown): TranscriptUpdate | null {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      ["jobId", "sequence", "turnNumber", "sentAt", "segments"],
      ["outline"],
    )
  )
    return null;
  const outline =
    value.outline === undefined ? undefined : proposal(value.outline);
  if (outline === null) return null;
  if (
    !jobId(value.jobId) ||
    !integer(value.sequence, 0, 10_000_000) ||
    !integer(value.turnNumber, 1, 10_000) ||
    !epoch(value.sentAt) ||
    !Array.isArray(value.segments) ||
    value.segments.length > SEGMENTS_PER_UPDATE_MAX
  )
    return null;
  const segments = value.segments.map(segment);
  if (segments.some((item) => item === null)) return null;
  return {
    jobId: value.jobId,
    sequence: value.sequence as number,
    turnNumber: value.turnNumber as number,
    sentAt: value.sentAt as number,
    segments: segments as TranscriptSegment[],
    ...(outline ? { outline } : {}),
  };
}

export function parseSessionRequest(value: unknown): SessionRequest | null {
  return isObject(value) && exactKeys(value, ["jobId"]) && jobId(value.jobId)
    ? { jobId: value.jobId }
    : null;
}

/** HMAC-SHA256 over "<timestamp>.<body>", hex. */
export function signIngest(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/**
 * Checks the signature headers against the raw body. The timestamp is epoch
 * milliseconds and may differ from `now` by at most INGEST_MAX_SKEW_MS.
 */
export function verifyIngest(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
  now = Date.now(),
) {
  if (
    !timestamp ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > INGEST_MAX_SKEW_MS ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(signIngest(secret, timestamp, body), "hex"),
  );
}

export const ingestHeaders = {
  timestamp: "X-Yap-Timestamp",
  signature: "X-Yap-Signature",
} as const;
