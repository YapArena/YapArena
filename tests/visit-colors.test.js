// The visit's colours (frontend/lib/visit-colors.ts): one set per page load,
// written to the root and shared by every script copy on the page.
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

const properties = new Map();
globalThis.document = {
  documentElement: {
    style: { setProperty: (name, value) => properties.set(name, value) },
  },
};
globalThis.window = globalThis;

const { visitColors } = await import("../public/lib/visit-colors.js");
const { COLORED_WORDS } = await import("../public/landing-colors.js");

afterEach(() => {
  delete globalThis.yapVisitColors;
  properties.clear();
});

it("writes the five colours and the Yappers colour to the root once", () => {
  const colors = visitColors();
  assert.deepEqual(
    [...properties.keys()],
    [
      "--visit-0",
      "--visit-1",
      "--visit-2",
      "--visit-3",
      "--visit-4",
      "--visit-yappers",
    ],
  );
  COLORED_WORDS.forEach((word, index) =>
    assert.equal(properties.get(`--visit-${index}`), colors[word].css),
  );
  assert.equal(properties.get("--visit-yappers"), colors.yappers.css);
  for (const value of properties.values())
    assert.match(value, /^rgb\(\d+ \d+ \d+\)$/);
});

it("returns the same set to every caller on the page, without rewriting it", () => {
  const first = visitColors();
  properties.clear();
  assert.equal(visitColors(), first);
  assert.equal(properties.size, 0);
});

it("shares the set with another copy of the module (bundled page scripts)", () => {
  const first = visitColors();
  // A bundled copy reads the same window property.
  assert.equal(globalThis.yapVisitColors, first);
});
