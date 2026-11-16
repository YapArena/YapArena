// Decision 0016 (engineering notes, "Replays"): the rules of the page LiveKit
// egress records (recording-template.ts), in plain values so Node tests can
// check them. The page itself only connects and attaches tracks.
import { sideFromMetadata, type TrackSide } from "./media-tracks.js";

export type Side = TrackSide;

/** The layout this page draws, as stored with each recording. */
export const RECORDING_LAYOUT = "sides-v1";

/** Side A fills the left half, side B the right half. */
export const SIDES: readonly Side[] = ["A", "B"];

/** One remote participant, as the page sees it. */
export interface SeatCandidate {
  identity: string;
  /** Participant metadata; a speaker's token carries `{"side":"A"}`. */
  metadata: string | undefined;
  /** When LiveKit says the participant joined, in milliseconds; 0 unknown. */
  joinedAt: number;
  /** Whether the participant's camera is subscribed and not muted. */
  camera: boolean;
}

export type Seats = Record<Side, string | null>;

/**
 * Who fills each half. Only a speaker (identity `speaker-…`) whose token names
 * a side takes that side's half, so the order people join, speak or reconnect
 * never moves a camera. A speaker without a side is never guessed into one;
 * that half stays black.
 *
 * When a speaker reconnects with a fresh token, LiveKit can list the old and
 * the new participant for a few seconds. The one with a camera wins, then the
 * one that joined last, then the identity in order, so the choice is stable.
 */
export function assignSides(candidates: readonly SeatCandidate[]): Seats {
  const seats: Seats = { A: null, B: null };
  const chosen: Partial<Record<Side, SeatCandidate>> = {};
  for (const candidate of candidates) {
    if (!candidate.identity.startsWith("speaker-")) continue;
    const side = sideFromMetadata(candidate.metadata);
    if (!side) continue;
    const current = chosen[side];
    if (!current || before(candidate, current)) chosen[side] = candidate;
  }
  for (const side of SIDES) seats[side] = chosen[side]?.identity ?? null;
  return seats;
}

function before(next: SeatCandidate, current: SeatCandidate) {
  if (next.camera !== current.camera) return next.camera;
  if (next.joinedAt !== current.joinedAt)
    return next.joinedAt > current.joinedAt;
  return next.identity < current.identity;
}

/** What the page knows while it waits to start the recording. */
export interface StartProbe {
  elapsedMs: number;
  hasVideoTracks: boolean;
  hasSubscribedTracks: boolean;
  hasDecodedFrames: boolean;
}

/** How long the page waits for a decoded camera frame. */
export const FRAME_DECODE_TIMEOUT_MS = 5000;

/**
 * When to tell egress to start, as LiveKit's own page decides: once a camera
 * frame is decoded; or, when nobody publishes video, half a second after the
 * first subscribed track; or after five seconds with any subscribed track.
 */
export function shouldStartRecording(probe: StartProbe) {
  if (probe.hasDecodedFrames) return true;
  if (
    !probe.hasVideoTracks &&
    probe.hasSubscribedTracks &&
    probe.elapsedMs > 500
  )
    return true;
  return probe.elapsedMs > FRAME_DECODE_TIMEOUT_MS && probe.hasSubscribedTracks;
}

/** Whether one WebRTC stats entry shows a decoded inbound video frame. */
export function hasDecodedFrame(stat: unknown) {
  return (
    typeof stat === "object" &&
    stat !== null &&
    "type" in stat &&
    stat.type === "inbound-rtp" &&
    "framesDecoded" in stat &&
    typeof stat.framesDecoded === "number" &&
    stat.framesDecoded > 0
  );
}

export type TemplateParams =
  { url: string; token: string; layout: string } | { error: string };

/**
 * The query string egress opens the page with: `url` (the LiveKit server),
 * `token` (the recorder's access token) and `layout`. Without the first two
 * the page shows LiveKit's error box, which egress reports as a template error.
 */
export function templateParams(search: string): TemplateParams {
  const query = new URLSearchParams(search);
  const url = query.get("url");
  const token = query.get("token");
  if (!url || !token) return { error: "missing required params url and token" };
  return { url, token, layout: query.get("layout") ?? "" };
}
