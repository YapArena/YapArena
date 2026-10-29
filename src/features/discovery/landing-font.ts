import { readFileSync } from "node:fs";
import type { Request, Response } from "express";

// The landing headline font (docs/landing-page.md). The repository is public,
// so deployments supply the file outside git and the app serves it at the URL
// landing.css and the landing page preload already use.
export const LANDING_FONT_PATH = "/assets/landing/fonts/headline.woff2";

// Each accepted format, recognised by its first four bytes.
const formats: [Buffer, string][] = [
  [Buffer.from("wOF2"), "font/woff2"],
  [Buffer.from("wOFF"), "font/woff"],
  [Buffer.from("OTTO"), "font/otf"],
  [Buffer.from([0, 1, 0, 0]), "font/ttf"],
];

export function fontType(bytes: Buffer) {
  if (bytes.length <= 12) return undefined;
  const signature = bytes.subarray(0, 4);
  return formats.find(([magic]) => signature.equals(magic))?.[1];
}

// Render secret files are plain text, so the font may be stored as its base64
// encoding. A raw font file works too.
export function readLandingFont(file: string): Buffer {
  const raw = readFileSync(file);
  if (fontType(raw)) return raw;
  const decoded = Buffer.from(
    raw.toString("utf8").replace(/\s+/g, ""),
    "base64",
  );
  if (fontType(decoded)) return decoded;
  throw new Error(
    "LANDING_FONT_FILE is neither a font file nor its base64 encoding",
  );
}

// Same caching as the other unversioned assets: revalidated with an ETag.
export function serveLandingFont(font: Buffer) {
  const type = fontType(font) ?? "application/octet-stream";
  return (_request: Request, response: Response) => {
    response.type(type).set("Cache-Control", "public, max-age=0").send(font);
  };
}
