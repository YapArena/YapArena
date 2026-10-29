import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COLORED_WORDS,
  MIN_CONTRAST,
  MIN_HUE_DISTANCE,
  contrastWithBlack,
  fitToGamut,
  hueDistance,
  inGamut,
  oklchToLinearRgb,
  pickHeadlineColors,
  toRgb8,
} from "../public/landing-colors.js";

// A small seeded generator, so a failing run can be replayed.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function assertValidSet(colors) {
  assert.deepEqual(Object.keys(colors), [...COLORED_WORDS]);
  const list = Object.values(colors);
  for (const [index, color] of list.entries()) {
    assert.ok(
      inGamut(oklchToLinearRgb(color.lightness, color.chroma, color.hue)),
    );
    assert.ok(contrastWithBlack(color.rgb) >= MIN_CONTRAST);
    assert.ok(color.chroma >= 0.1, `${color.css} is too close to grey`);
    assert.equal(
      color.css,
      `rgb(${color.rgb[0]} ${color.rgb[1]} ${color.rgb[2]})`,
    );
    if (color.hue >= 80 && color.hue <= 130) assert.ok(color.lightness >= 0.8);
    for (const other of list.slice(index + 1))
      assert.ok(
        hueDistance(color.hue, other.hue) >= MIN_HUE_DISTANCE,
        `${color.css} and ${other.css} are the same family`,
      );
  }
}

describe("landing headline colors", () => {
  it("converts OKLCH to sRGB", () => {
    const close = (actual, expected) =>
      actual.forEach((channel, index) =>
        assert.ok(Math.abs(channel - expected[index]) <= 1, `${actual}`),
      );
    close(toRgb8(oklchToLinearRgb(0.62796, 0.25768, 29.2339)), [255, 0, 0]);
    close(toRgb8(oklchToLinearRgb(0.86644, 0.29483, 142.4953)), [0, 255, 0]);
    close(toRgb8(oklchToLinearRgb(0.45201, 0.31321, 264.052)), [0, 0, 255]);
    assert.deepEqual(toRgb8(oklchToLinearRgb(1, 0, 0)), [255, 255, 255]);
    assert.deepEqual(toRgb8(oklchToLinearRgb(0, 0, 0)), [0, 0, 0]);
    assert.equal(inGamut(oklchToLinearRgb(0.86, 0.16, 260)), false);
  });

  it("measures contrast on black and distance around the hue circle", () => {
    assert.equal(contrastWithBlack([255, 255, 255]), 21);
    assert.equal(contrastWithBlack([0, 0, 0]), 1);
    assert.equal(hueDistance(350, 10), 20);
    assert.equal(hueDistance(0, 180), 180);
    assert.equal(hueDistance(30, 30), 0);
  });

  it("darkens a color before giving up chroma to fit sRGB", () => {
    assert.deepEqual(fitToGamut(0.7, 0.05, 30), {
      lightness: 0.7,
      chroma: 0.05,
    });
    // A light blue cannot be vivid in sRGB; it becomes darker, not grey.
    const blue = fitToGamut(0.86, 0.16, 260);
    assert.ok(blue.lightness < 0.86 && blue.lightness >= 0.7);
    assert.ok(blue.chroma >= 0.1);
    assert.ok(inGamut(oklchToLinearRgb(blue.lightness, blue.chroma, 260)));
    // Only below the lightness floor does chroma drop.
    const cyan = fitToGamut(0.86, 0.16, 193);
    assert.equal(cyan.lightness, 0.7);
    assert.ok(cyan.chroma < 0.16 && cyan.chroma >= 0.1);
  });

  it("picks five readable colors from five different families", () => {
    for (let seed = 1; seed <= 200; seed++)
      assertValidSet(pickHeadlineColors(seeded(seed)));
    for (let run = 0; run < 1000; run++) assertValidSet(pickHeadlineColors());
    assertValidSet(pickHeadlineColors(() => 0));
    assertValidSet(pickHeadlineColors(() => 0.999999));
  });

  it("is new on every visit and shuffles which word gets which color", () => {
    assert.deepEqual(
      pickHeadlineColors(seeded(7)),
      pickHeadlineColors(seeded(7)),
    );
    const sets = Array.from({ length: 50 }, (_, seed) =>
      pickHeadlineColors(seeded(seed + 1)),
    );
    assert.equal(new Set(sets.map((set) => set.opinions.css)).size, 50);
    // The word holding the lowest hue changes from visit to visit.
    const lowest = sets.map((set) =>
      COLORED_WORDS.reduce((low, word) =>
        set[word].hue < set[low].hue ? word : low,
      ),
    );
    assert.equal(new Set(lowest).size, COLORED_WORDS.length);
  });
});
