// Decision 0016 (engineering notes, "Replays"): a replay is one recording of
// LiveKit's room-composite "grid" page. On a vertical phone each camera is cut
// out of that recording and drawn into its own canvas. This module is the
// geometry only, in plain numbers, so Node tests can check it.
//
// How the recording is laid out (src/features/media/provider.ts starts the
// egress with `layout: "grid"` and no encoding options):
// - LiveKit egress renders its default template in a browser window the size
//   of the output, 1280 × 720 when no preset is given.
// - The template's GridLayout picks 2 columns × 1 row for two cameras in a
//   landscape page. The grid has a 0.5rem (8 px) gap and the same padding,
//   so each tile is (1280 − 3 × 8) / 2 = 628 by 720 − 2 × 8 = 704 px.
// - Inside its tile a landscape camera is cropped to fill it (`object-fit:
//   cover`); a portrait camera is fitted whole (`contain`) with bars at its
//   sides. Tiles have 8 px rounded corners and a 2.5 px ring while that
//   person speaks; `inset` trims both off.
// - The left tile is the camera LiveKit sorted first, not a fixed side: see
//   `leftSide`.
// The packaged HLS renditions scale the whole picture without padding
// (replay-packaging.ts), so the tiles keep their place in proportion.

export type Side = "A" | "B";

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface CompositeLayout {
  /** The egress page in CSS pixels, which is the recording's encoded size. */
  width: number;
  height: number;
  /** LiveKit's grid gap: the padding around the grid and between tiles. */
  gap: number;
  /** Trimmed from every tile edge, in composite pixels. */
  inset: number;
  /** Whose camera fills the left tile. */
  leftSide: Side;
  /**
   * Each camera's width ÷ height, when known. LiveKit fills a tile with a
   * landscape camera but fits a portrait (or square) one whole, centred with
   * bars beside it; given a ratio of 1 or less, only the picture is used.
   * Unknown cameras are taken as landscape, filling their tile.
   */
  cameras?: Partial<Record<Side, number>>;
}

// 4 px clears the 2.5 px speaking ring and every pixel of the 8 px rounded
// corners (a corner's curve ends 8 − 8/√2 ≈ 2.3 px in from each edge).
export const REPLAY_COMPOSITE: CompositeLayout = {
  width: 1280,
  height: 720,
  gap: 8,
  inset: 4,
  leftSide: "A",
};

export interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface BackingLimits {
  /** The highest device pixel ratio a canvas is drawn at. */
  maxRatio: number;
  /** The most backing pixels one canvas may hold. */
  maxPixels: number;
}

// A 720p tile has about 620 × 700 source pixels, so twice a phone's CSS size
// is already sharper than the recording; the cap keeps memory flat on 3×
// screens and tablets.
export const BACKING_LIMITS: BackingLimits = {
  maxRatio: 2,
  maxPixels: 1_200_000,
};

const positive = (value: number) => Number.isFinite(value) && value > 0;

/** The left and right camera tiles, in composite pixels, after the inset. */
export function compositeTiles(
  layout: CompositeLayout = REPLAY_COMPOSITE,
): [Rect, Rect] {
  const { gap, inset } = layout;
  const tileWidth = (layout.width - 3 * gap) / 2;
  const tileHeight = layout.height - 2 * gap;
  const width = Math.max(0, tileWidth - 2 * inset);
  const height = Math.max(0, tileHeight - 2 * inset);
  const y = gap + inset;
  return [
    { x: gap + inset, y, width, height },
    { x: 2 * gap + tileWidth + inset, y, width, height },
  ];
}

/** Each side's camera in the video's own pixels, or null before it has a size. */
export function sideSources(
  video: Size,
  layout: CompositeLayout = REPLAY_COMPOSITE,
): Record<Side, Rect> | null {
  if (![video.width, video.height, layout.width, layout.height].every(positive))
    return null;
  const scaleX = video.width / layout.width;
  const scaleY = video.height / layout.height;
  const [left, right] = compositeTiles(layout);
  const tiles: Record<Side, Rect> =
    layout.leftSide === "A" ? { A: left, B: right } : { A: right, B: left };
  const place = (side: Side): Rect => {
    const picture = cameraInTile(tiles[side], layout.cameras?.[side]);
    return {
      x: picture.x * scaleX,
      y: picture.y * scaleY,
      width: picture.width * scaleX,
      height: picture.height * scaleY,
    };
  };
  return { A: place("A"), B: place("B") };
}

/**
 * Where a camera's picture sits in its tile: the whole tile for a landscape
 * or unknown camera (`object-fit: cover`), the centred fitted picture for a
 * portrait or square one (`object-fit: contain`).
 */
export function cameraInTile(tile: Rect, cameraRatio?: number): Rect {
  if (
    cameraRatio === undefined ||
    !positive(cameraRatio) ||
    cameraRatio > 1 ||
    !positive(tile.width) ||
    !positive(tile.height)
  )
    return { ...tile };
  if (cameraRatio < tile.width / tile.height) {
    const width = tile.height * cameraRatio;
    return { ...tile, x: tile.x + (tile.width - width) / 2, width };
  }
  const height = tile.width / cameraRatio;
  return { ...tile, y: tile.y + (tile.height - height) / 2, height };
}

/**
 * The part of `source` that fills `box` like `object-fit: cover`: the
 * centre, cut to the box's shape. An empty box keeps the whole source.
 */
export function coverCrop(source: Rect, box: Size): Rect {
  if (!positive(box.width) || !positive(box.height)) return { ...source };
  const boxRatio = box.width / box.height;
  if (source.width / source.height > boxRatio) {
    const width = source.height * boxRatio;
    return {
      x: source.x + (source.width - width) / 2,
      y: source.y,
      width,
      height: source.height,
    };
  }
  const height = source.width / boxRatio;
  return {
    x: source.x,
    y: source.y + (source.height - height) / 2,
    width: source.width,
    height,
  };
}

/**
 * The `drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)` arguments that fill
 * a canvas of `canvas` backing pixels with one side's camera, or null when
 * the video or the canvas has no size yet.
 */
export function drawCall(
  video: Size,
  side: Side,
  canvas: Size,
  layout: CompositeLayout = REPLAY_COMPOSITE,
): DrawCall | null {
  if (!positive(canvas.width) || !positive(canvas.height)) return null;
  const sources = sideSources(video, layout);
  if (!sources) return null;
  const crop = coverCrop(sources[side], canvas);
  return {
    sx: crop.x,
    sy: crop.y,
    sw: crop.width,
    sh: crop.height,
    dx: 0,
    dy: 0,
    dw: canvas.width,
    dh: canvas.height,
  };
}

/**
 * The canvas backing size for a box of CSS pixels: the device pixel ratio,
 * at least 1 and at most `maxRatio`, then scaled down to `maxPixels`. An
 * empty box gets an empty canvas.
 */
export function backingSize(
  box: Size,
  devicePixelRatio: number,
  limits: BackingLimits = BACKING_LIMITS,
): Size {
  if (!positive(box.width) || !positive(box.height))
    return { width: 0, height: 0 };
  const ratio = Math.min(
    limits.maxRatio,
    Math.max(1, positive(devicePixelRatio) ? devicePixelRatio : 1),
  );
  let width = box.width * ratio;
  let height = box.height * ratio;
  if (width * height > limits.maxPixels) {
    const shrink = Math.sqrt(limits.maxPixels / (width * height));
    width *= shrink;
    height *= shrink;
  }
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}
