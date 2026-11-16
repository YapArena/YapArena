import { Router } from "express";
import { html } from "../../platform/html.ts";
import { asset } from "../discovery/assets.ts";

// Decision 0016 (engineering notes, "Replays"): every recording is LiveKit
// room-composite egress, which opens a web page in headless Chrome and records
// what it shows and plays. LiveKit's own page orders cameras by who spoke and
// joined first, so side A is not reliably on the left. This is YapArena's own
// page for it: side A's camera fills the left half, side B's the right half,
// for the whole recording (frontend/recording-template.ts).

/** Where each camera sits in a recording, stored per recording. */
export type CompositeLayout = "sides-v1" | "livekit-grid";

/** The layout this page draws; egress passes it back as `layout`. */
export const SIDES_LAYOUT = "sides-v1" satisfies CompositeLayout;
/** LiveKit's default page, used when no template URL is configured. */
export const GRID_LAYOUT = "livekit-grid" satisfies CompositeLayout;

export const RECORDING_TEMPLATE_PATH = "/recording-template/";

/**
 * The connect-src sources that let the page reach LiveKit: each configured
 * LiveKit host over both WebSocket and HTTP (the client checks the server over
 * HTTP after a failed connection), and on LiveKit Cloud any project host, since
 * egress passes the page a URL of its own choosing.
 */
export function livekitConnectSources(urls: readonly string[]) {
  const sources = new Set<string>();
  for (const value of urls) {
    const url = new URL(value);
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    sources.add(`${secure ? "wss" : "ws"}://${url.host}`);
    sources.add(`${secure ? "https" : "http"}://${url.host}`);
    if (url.hostname.endsWith(".livekit.cloud")) {
      sources.add("wss://*.livekit.cloud");
      sources.add("https://*.livekit.cloud");
    }
  }
  return [...sources];
}

/** The page's own policy: its script and style, LiveKit, nothing else. */
export function recordingTemplatePolicy(connectSources: readonly string[]) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${["'self'", ...connectSources].join(" ")}`,
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Video elements are muted: each speaker's sound plays from its own audio
// element, which the script adds as tracks arrive.
export function renderRecordingTemplate() {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>YAP Arena recording</title><link rel="stylesheet" href="${asset("recording-template.css")}"></head><body><main class="recording" data-recording="${SIDES_LAYOUT}"><div class="recording-side" data-recording-side="A"><video muted autoplay playsinline hidden></video></div><div class="recording-side" data-recording-side="B"><video muted autoplay playsinline hidden></video></div></main><div data-recording-audio hidden></div><script defer src="${asset("recording.bundle.js")}"></script></body></html>`.toString();
}

/**
 * Serves the recording page. It is public, because LiveKit's egress workers
 * load it without a session, and holds no secret: egress passes the room URL
 * and a recorder token in the query string. It is never indexed or cached.
 */
export function createRecordingTemplateRouter({
  connectSources,
}: {
  connectSources: readonly string[];
}) {
  const router = Router();
  const page = renderRecordingTemplate();
  const policy = recordingTemplatePolicy(connectSources);
  router.get(RECORDING_TEMPLATE_PATH, (_request, response) => {
    response
      .set("Content-Security-Policy", policy)
      .set("X-Robots-Tag", "noindex, nofollow")
      .set("Cache-Control", "no-store")
      .set("Referrer-Policy", "no-referrer")
      .type("html")
      .send(page);
  });
  return router;
}
