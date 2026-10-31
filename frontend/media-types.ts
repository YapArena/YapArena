import type Hls from "hls.js";

// Wire shapes from the existing media endpoints; JSON dates remain strings.
export type Side = "A" | "B";
export type MediaRole = "speaker" | "viewer";
export type MediaKind = "audio" | "video";
export type PlaybackMode = "live" | "speaker" | "replay";
export interface MediaState {
  state: "idle" | "running" | "paused" | "ended";
  activeSide: Side | null;
  turnDeadlineAt: string | null;
  /** The running turn's number; older servers omit it. */
  turnNumber?: number;
  revision: number;
  incident?: string | null;
  recordingStatus: "pending" | "recording" | "processing" | "ready" | "failed";
}
export interface MediaSnapshot {
  state: MediaState | null;
  eventStatus: string;
  automaticReplayPublication: boolean;
  streamRevision?: string;
  serverNow: string;
  preparationUrl: string;
}
export interface MediaGrant {
  token: string;
  url: string;
}
export interface ReplayGrant {
  type: "hls" | "mp4";
  url: string;
  captionsUrl?: string;
  expiresAt: string;
  expiresIn: number;
}
export interface MediaResponses {
  "": MediaSnapshot;
  "/viewer-token": MediaGrant;
  "/speaker-token": MediaGrant & { side: Side };
  "/speaker-seat": { side: Side; userId: string };
  "/replay": ReplayGrant;
  "/device-check": unknown;
  "/playback": unknown;
  "/captions": unknown;
}
export type MediaResponse<Path extends string> =
  Path extends keyof MediaResponses ? MediaResponses[Path] : unknown;
export interface MediaRequest {
  <Path extends string>(
    path: Path,
    options?: RequestInit,
  ): Promise<MediaResponse<Path>>;
}
export interface MediaError extends Error {
  status?: number;
  code?: string;
}
export type DeviceChoices = Partial<
  Record<"audioinput" | "videoinput", string>
>;
export type DiagnosticValues = Record<
  string,
  string | number | boolean | undefined
>;
export interface DiagnosticRow extends DiagnosticValues {
  version: number;
  at: number;
  event: string;
  attempt?: number;
  mode?: PlaybackMode;
  prepared?: boolean;
}
export interface PlaybackDiagnostics {
  start(mode: PlaybackMode, prepared: boolean): void;
  record(event: string, values?: DiagnosticValues): void;
  finish(outcome: string): void;
}
export type ReplayLibrary = typeof Hls;
// Audio elements lack frame callbacks; existing playback observation probes them.
export type PlaybackElement = HTMLMediaElement &
  Partial<
    Pick<
      HTMLVideoElement,
      "requestVideoFrameCallback" | "cancelVideoFrameCallback"
    >
  >;
