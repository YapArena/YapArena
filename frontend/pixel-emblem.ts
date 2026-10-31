// The landing emblem's tiles on one canvas (docs/debate-page-design.md).
// Countdown mode draws each tile lit, spent, glowing or at rest; there is no
// element per tile. The tiles come from the emblem image itself, found once
// per page with the landing's own detection (frontend/pixel-life.ts).
//
// The queue overlay adds the landing's "living" mode to this module when it
// moves startEmblem out of frontend/landing.ts; until then the landing keeps
// its own copy.
import { PixelLife } from "./pixel-life.js";
import { HOLE, tileAngle, type TileLook } from "./turn-clock-logic.js";

/** A tile as fractions of the emblem box, and its clockwise angle. */
export interface EmblemTile {
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
}

let found: Promise<EmblemTile[]> | null = null;
/** The emblem's tiles, detected once per page from its image. */
export function emblemTiles(src: string) {
  found ??= (async () => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const source = document.createElement("canvas");
    source.width = width;
    source.height = height;
    const context = source.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height);
    source.width = 0;
    return PixelLife.detectTiles(pixels.data, width, height).map((tile) => ({
      left: tile.left / width,
      top: tile.top / height,
      width: tile.width / width,
      height: tile.height / height,
      angle: tileAngle(tile.x, tile.y, {
        x: HOLE.x * width,
        y: HOLE.y * height,
      }),
    }));
  })();
  return found;
}

export interface EmblemColors {
  lit: string;
  warn: string;
  ember: string;
  spent: string;
  rest: string;
}

export function createEmblem(
  stage: HTMLCanvasElement,
  { tiles }: { mode: "countdown"; tiles: readonly EmblemTile[] },
) {
  const context = stage.getContext("2d")!;
  let width = 0;
  let height = 0;
  function resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = Math.round(stage.clientWidth * ratio);
    height = Math.round(stage.clientHeight * ratio);
    if (stage.width !== width || stage.height !== height) {
      stage.width = width;
      stage.height = height;
      return true;
    }
    return false;
  }
  resize();
  return {
    resize,
    /** Draws every tile with its look. */
    draw(look: (tile: EmblemTile) => TileLook, colors: EmblemColors) {
      context.clearRect(0, 0, width, height);
      for (const tile of tiles) {
        const { kind, opacity } = look(tile);
        context.globalAlpha = opacity;
        context.fillStyle = colors[kind === "lit" ? "lit" : kind];
        const left = Math.round(tile.left * width);
        const top = Math.round(tile.top * height);
        context.fillRect(
          left,
          top,
          Math.max(1, Math.round((tile.left + tile.width) * width) - left),
          Math.max(1, Math.round((tile.top + tile.height) * height) - top),
        );
      }
      context.globalAlpha = 1;
    },
  };
}
