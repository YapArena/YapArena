// An idea's own mark (docs/site-design.md): a 5 × 5 mirrored pattern of pixels
// from a hash of its id, in one of the visit's colours, on a square tile.
// People get their chosen avatars instead. Browser-safe.
import { html, raw } from "../../platform/html.ts";

/** FNV-1a, 32 bits. */
export function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// Six units across, so pixels land on whole device pixels at 24 and 48 px.
export function pixelMark(seed: string, size: number) {
  const hash = fnv1a(seed);
  const cells: string[] = [];
  let bits = hash >>> 3;
  for (let row = 0; row < 5; row++)
    for (let column = 0; column < 3; column++, bits >>>= 1) {
      if (!(bits & 1)) continue;
      cells.push(`M${column + 0.5} ${row + 0.5}h1v1h-1z`);
      if (column < 2) cells.push(`M${4.5 - column} ${row + 0.5}h1v1h-1z`);
    }
  if (!cells.length) cells.push("M2.5 2.5h1v1h-1z");
  // The tile's corner: 8 px at small sizes, 12 px from 48 px.
  const radius = ((size >= 48 ? 12 : 8) * 6) / size;
  return html`<svg class="pixel-mark" width="${size}" height="${size}" viewBox="0 0 6 6" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><rect width="6" height="6" rx="${radius}" fill="var(--raised)"></rect><path d="${cells.join("")}" fill="var(--visit-${hash % 5})"></path></svg>`;
}

// The Yap Coins coin: a ring of tiles in the visit's five colours around a
// white Y, on an 11 × 11 grid.
export function pixelCoin(size: number) {
  const y = new Set(["3,3", "7,3", "4,4", "6,4", "5,5", "5,6", "5,7"]);
  const cells: string[] = [];
  for (let row = 0; row < 11; row++)
    for (let column = 0; column < 11; column++) {
      const distance = Math.hypot(column - 5, row - 5);
      if (y.has(`${column},${row}`))
        cells.push(
          `<rect x="${column}" y="${row}" width="1" height="1" fill="var(--text)"></rect>`,
        );
      else if (distance >= 4.1 && distance <= 5.4) {
        const angle =
          (Math.atan2(column - 5, 5 - row) + 2 * Math.PI) % (2 * Math.PI);
        const slot = Math.floor((angle / (2 * Math.PI)) * 5);
        cells.push(
          `<rect x="${column + 0.08}" y="${row + 0.08}" width="0.84" height="0.84" fill="var(--visit-${slot})"></rect>`,
        );
      }
    }
  return raw(
    `<svg class="pixel-coin" width="${size}" height="${size}" viewBox="0 0 11 11" aria-hidden="true" focusable="false" shape-rendering="crispEdges">${cells.join("")}</svg>`,
  );
}
