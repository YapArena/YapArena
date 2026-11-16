// Decision 0016 (engineering notes, "Replays"): on a vertical phone the one
// replay recording is drawn into two canvases, side A's camera in one and
// side B's in the other. The video element stays the single source of truth:
// it plays the sound, keeps the time, seeks, and media-replay.ts announces
// yap:playback from it. This module only reads frames from it.
//
// The canvases are display only. Nothing reads their pixels back, so a
// recording served without CORS (the signed MP4 fallback) can taint them
// without breaking anything.
import {
  BACKING_LIMITS,
  backingSize,
  compositeFor,
  drawCall,
  type BackingLimits,
  type CompositeLayout,
  type Side,
  type Size,
} from "./replay-split-model.js";

// HTMLMediaElement.HAVE_CURRENT_DATA: a frame can be drawn.
const HAVE_CURRENT_DATA = 2;

export interface ReplaySplitOptions {
  video: HTMLVideoElement;
  canvasA: HTMLCanvasElement;
  canvasB: HTMLCanvasElement;
  /**
   * Where each camera sits in the recording (replay-split-model.ts), or a
   * function read at every draw, for a layout that is known only once the
   * replay grant arrives. The video's data-replay-layout by default.
   */
  layout?: CompositeLayout | (() => CompositeLayout);
  limits?: BackingLimits;
  /** The current device pixel ratio; window.devicePixelRatio by default. */
  pixelRatio?: () => number;
}

interface Target {
  side: Side;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
}

/**
 * Starts drawing side A's and side B's cameras into their canvases and
 * returns the function that stops it. While mounted the video carries
 * `data-replay-split`, which arena.css uses to keep it playing unseen.
 */
export function mountReplaySplit({
  video,
  canvasA,
  canvasB,
  layout = () => compositeFor(video.dataset.replayLayout),
  limits = BACKING_LIMITS,
  pixelRatio = () => window.devicePixelRatio,
}: ReplaySplitOptions): () => void {
  const sides: [Side, HTMLCanvasElement][] = [
    ["A", canvasA],
    ["B", canvasB],
  ];
  const targets: Target[] = sides.map(([side, canvas]) => ({
    side,
    canvas,
    context: canvas.getContext("2d", { alpha: false }),
  }));
  let stopped = false;
  let pending: { kind: "video" | "animation"; handle: number } | undefined;

  function measure() {
    const ratio = pixelRatio();
    for (const { canvas } of targets) {
      const box: Size = {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      const next = backingSize(box, ratio, limits);
      // Setting a canvas size clears it, so only a real change does.
      if (canvas.width !== next.width) canvas.width = next.width;
      if (canvas.height !== next.height) canvas.height = next.height;
    }
  }

  function draw() {
    if (
      stopped ||
      video.readyState < HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    )
      return;
    const frame: Size = { width: video.videoWidth, height: video.videoHeight };
    const composite = typeof layout === "function" ? layout() : layout;
    for (const { side, canvas, context } of targets) {
      if (!context) continue;
      const call = drawCall(
        frame,
        side,
        { width: canvas.width, height: canvas.height },
        composite,
      );
      if (!call) continue;
      context.drawImage(
        video,
        call.sx,
        call.sy,
        call.sw,
        call.sh,
        call.dx,
        call.dy,
        call.dw,
        call.dh,
      );
    }
  }

  const playing = () => !video.paused && !video.ended;

  function cancel() {
    if (!pending) return;
    if (pending.kind === "video")
      video.cancelVideoFrameCallback(pending.handle);
    else cancelAnimationFrame(pending.handle);
    pending = undefined;
  }

  function tick() {
    pending = undefined;
    draw();
    schedule();
  }

  // One draw per decoded frame where the browser can say when one is ready
  // (requestVideoFrameCallback), otherwise one per display frame.
  function schedule() {
    if (stopped || pending || !playing()) return;
    pending =
      typeof video.requestVideoFrameCallback === "function"
        ? { kind: "video", handle: video.requestVideoFrameCallback(tick) }
        : { kind: "animation", handle: requestAnimationFrame(tick) };
  }

  function still() {
    cancel();
    draw();
  }

  function resize() {
    measure();
    draw();
  }

  const listeners: [string, () => void][] = [
    ["play", schedule],
    ["playing", schedule],
    ["pause", still],
    ["ended", still],
    ["seeked", draw],
    ["loadeddata", draw],
    // The video's own size changes when HLS switches rendition.
    ["resize", draw],
  ];
  for (const [type, listener] of listeners)
    video.addEventListener(type, listener);
  // A zoom or rotation can change the pixel ratio without resizing a box.
  window.addEventListener("resize", resize);
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  for (const { canvas } of targets) observer?.observe(canvas);

  video.dataset.replaySplit = "";
  measure();
  draw();
  schedule();

  return function stop() {
    if (stopped) return;
    stopped = true;
    cancel();
    for (const [type, listener] of listeners)
      video.removeEventListener(type, listener);
    window.removeEventListener("resize", resize);
    observer?.disconnect();
    delete video.dataset.replaySplit;
  };
}
