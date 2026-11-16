// Decision 0016 (engineering notes, "Replays"): where each side's camera sits
// in the one replay recording, and how it is cut to fill a phone's camera
// box (frontend/replay-split-model.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  BACKING_LIMITS,
  REPLAY_COMPOSITE,
  backingSize,
  cameraInTile,
  compositeTiles,
  coverCrop,
  drawCall,
  sideSources,
} = await import("../public/replay-split-model.js");

function near(actual, expected, message) {
  for (const key of Object.keys(expected))
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-6,
      `${message ?? ""} ${key}: ${actual[key]} ≠ ${expected[key]}`,
    );
}

describe("the recording's grid", () => {
  it("matches LiveKit's 1280 × 720 grid: 8 px padding and gap, 4 px trimmed", () => {
    assert.deepEqual(REPLAY_COMPOSITE, {
      width: 1280,
      height: 720,
      gap: 8,
      inset: 4,
      leftSide: "A",
    });
    const [left, right] = compositeTiles();
    // Each tile is (1280 − 3 × 8) / 2 = 628 by 720 − 2 × 8 = 704.
    assert.deepEqual(left, { x: 12, y: 12, width: 620, height: 696 });
    assert.deepEqual(right, { x: 648, y: 12, width: 620, height: 696 });
  });

  it("works for a 1080p composite too", () => {
    const [left, right] = compositeTiles({
      ...REPLAY_COMPOSITE,
      width: 1920,
      height: 1080,
    });
    assert.deepEqual(left, { x: 12, y: 12, width: 940, height: 1056 });
    assert.deepEqual(right, { x: 968, y: 12, width: 940, height: 1056 });
  });

  it("keeps a tile empty rather than negative", () => {
    const [left] = compositeTiles({ ...REPLAY_COMPOSITE, width: 30, inset: 9 });
    assert.equal(left.width, 0);
  });
});

describe("each side's camera in the video", () => {
  it("is the composite's tile at the recording's own size", () => {
    const sources = sideSources({ width: 1280, height: 720 });
    assert.deepEqual(sources.A, { x: 12, y: 12, width: 620, height: 696 });
    assert.deepEqual(sources.B, { x: 648, y: 12, width: 620, height: 696 });
  });

  it("scales with a 1920 × 1080 video", () => {
    const sources = sideSources({ width: 1920, height: 1080 });
    near(sources.A, { x: 18, y: 18, width: 930, height: 1044 });
    near(sources.B, { x: 972, y: 18, width: 930, height: 1044 });
  });

  it("scales with the packaged renditions, whose widths round", () => {
    for (const [width, height] of [
      [854, 480],
      [426, 240],
    ]) {
      const { A, B } = sideSources({ width, height });
      near(A, {
        x: (12 * width) / 1280,
        y: (12 * height) / 720,
        width: (620 * width) / 1280,
        height: (696 * height) / 720,
      });
      near(B, { x: (648 * width) / 1280, y: (12 * height) / 720 });
    }
  });

  it("puts side A on the right when the layout says so", () => {
    const sources = sideSources(
      { width: 1280, height: 720 },
      { ...REPLAY_COMPOSITE, leftSide: "B" },
    );
    assert.equal(sources.A.x, 648);
    assert.equal(sources.B.x, 12);
  });

  it("uses only a portrait camera's picture, not the bars beside it", () => {
    const sources = sideSources(
      { width: 1280, height: 720 },
      { ...REPLAY_COMPOSITE, cameras: { B: 9 / 16 } },
    );
    assert.deepEqual(sources.A, { x: 12, y: 12, width: 620, height: 696 });
    near(sources.B, { x: 648 + (620 - 391.5) / 2, y: 12, width: 391.5 });
    assert.equal(sources.B.height, 696);
  });

  it("is unknown until the video has a size", () => {
    assert.equal(sideSources({ width: 0, height: 0 }), null);
    assert.equal(sideSources({ width: Number.NaN, height: 720 }), null);
  });
});

describe("a camera in its tile", () => {
  const tile = { x: 12, y: 12, width: 620, height: 696 };
  it("fills the tile when landscape or unknown", () => {
    assert.deepEqual(cameraInTile(tile), tile);
    assert.deepEqual(cameraInTile(tile, 16 / 9), tile);
    assert.deepEqual(cameraInTile(tile, 0), tile);
    assert.notEqual(cameraInTile(tile), tile, "a copy");
  });
  it("is fitted whole when portrait or square", () => {
    near(cameraInTile(tile, 9 / 16), {
      x: 12 + (620 - 391.5) / 2,
      y: 12,
      width: 391.5,
      height: 696,
    });
    near(cameraInTile(tile, 1), { x: 12, y: 50, width: 620, height: 620 });
  });
  it("keeps an empty tile as it is", () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    assert.deepEqual(cameraInTile(empty, 0.5), empty);
  });
});

describe("cover crop", () => {
  const source = { x: 12, y: 12, width: 620, height: 696 };
  it("cuts the top and bottom for a wide box (a vertical phone's camera)", () => {
    const box = { width: 390, height: 346 };
    const height = 620 / (390 / 346);
    near(coverCrop(source, box), {
      x: 12,
      y: 12 + (696 - height) / 2,
      width: 620,
      height,
    });
  });
  it("cuts the sides for a tall box", () => {
    near(coverCrop(source, { width: 200, height: 400 }), {
      x: 12 + (620 - 348) / 2,
      y: 12,
      width: 348,
      height: 696,
    });
  });
  it("keeps the whole source for a box of its shape or no box", () => {
    near(coverCrop(source, { width: 310, height: 348 }), source);
    assert.deepEqual(coverCrop(source, { width: 0, height: 10 }), source);
  });
});

describe("drawImage arguments", () => {
  it("fill the canvas from the side's centre crop", () => {
    const call = drawCall({ width: 1280, height: 720 }, "B", {
      width: 780,
      height: 692,
    });
    const height = 620 / (780 / 692);
    near(call, {
      sx: 648,
      sy: 12 + (696 - height) / 2,
      sw: 620,
      sh: height,
      dx: 0,
      dy: 0,
      dw: 780,
      dh: 692,
    });
    assert.ok(Math.abs(call.sw / call.sh - call.dw / call.dh) < 1e-9);
  });
  it("are missing before the video or the canvas has a size", () => {
    assert.equal(
      drawCall({ width: 0, height: 0 }, "A", { width: 10, height: 10 }),
      null,
    );
    assert.equal(
      drawCall({ width: 1280, height: 720 }, "A", { width: 0, height: 10 }),
      null,
    );
  });
});

describe("canvas backing size", () => {
  const box = { width: 390, height: 346 };
  it("follows the pixel ratio up to twice", () => {
    assert.deepEqual(backingSize(box, 1), { width: 390, height: 346 });
    assert.deepEqual(backingSize(box, 1.5), { width: 585, height: 519 });
    assert.deepEqual(backingSize(box, 3), { width: 780, height: 692 });
  });
  it("never goes under one pixel per CSS pixel", () => {
    assert.deepEqual(backingSize(box, 0.5), { width: 390, height: 346 });
    assert.deepEqual(backingSize(box, Number.NaN), {
      width: 390,
      height: 346,
    });
  });
  it("shrinks to the pixel budget, keeping the shape", () => {
    const size = backingSize({ width: 1000, height: 800 }, 2);
    assert.ok(size.width * size.height <= BACKING_LIMITS.maxPixels);
    assert.deepEqual(size, { width: 1224, height: 979 });
  });
  it("takes other limits", () => {
    assert.deepEqual(
      backingSize(box, 3, { maxRatio: 3, maxPixels: 10_000_000 }),
      { width: 1170, height: 1038 },
    );
  });
  it("is empty for an empty box", () => {
    assert.deepEqual(backingSize({ width: 0, height: 300 }, 2), {
      width: 0,
      height: 0,
    });
  });
});
