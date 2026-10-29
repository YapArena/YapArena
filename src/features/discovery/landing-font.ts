import { readFileSync } from "node:fs";
import type { Request, Response } from "express";

// The licensed landing headline font (docs/landing-page.md). The repository is
// public, so deployments supply the file outside git and the app serves it at
// the URL landing.css and the landing page preload already use.
export const LANDING_FONT_PATH =
  "/assets/landing/fonts/perpetua-titling-light.otf";

// OpenType with CFF outlines ("OTTO") or TrueType outlines (0x00010000).
const signatures = [Buffer.from("OTTO"), Buffer.from([0, 1, 0, 0])];
const isFont = (bytes: Buffer) =>
  bytes.length > 12 &&
  signatures.some((signature) => bytes.subarray(0, 4).equals(signature));

// Render secret files are plain text, so the font may be stored as its base64
// encoding. A raw font file works too.
export function readLandingFont(file: string): Buffer {
  const raw = readFileSync(file);
  if (isFont(raw)) return raw;
  const decoded = Buffer.from(
    raw.toString("utf8").replace(/\s+/g, ""),
    "base64",
  );
  if (isFont(decoded)) return decoded;
  throw new Error(
    "LANDING_FONT_FILE is neither an OpenType font nor its base64 encoding",
  );
}

// Same caching as the other unversioned assets: revalidated with an ETag.
export function serveLandingFont(font: Buffer) {
  return (_request: Request, response: Response) => {
    response
      .type("font/otf")
      .set("Cache-Control", "public, max-age=0")
      .send(font);
  };
}
