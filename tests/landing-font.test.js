import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  LANDING_FONT_PATH,
  readLandingFont,
} from "../dist/features/discovery/landing-font.js";
import { loadConfig } from "../dist/platform/config.js";
import { createLogger } from "../dist/platform/logger.js";
import { createWebServer } from "../dist/web.js";

// A stand-in font: the OpenType "OTTO" signature and recognisable bytes, so a
// response can only match if it came from the configured file.
const font = Buffer.concat([
  Buffer.from("OTTO"),
  Buffer.from("synthetic landing font bytes"),
]);
const empty = async () => ({
  items: [],
  pagination: { limit: 12, offset: 0, hasMore: false },
});

let directory;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "landing-font-"));
});
after(() => rm(directory, { recursive: true, force: true }));

async function file(name, contents) {
  const target = path.join(directory, name);
  await writeFile(target, contents);
  return target;
}

describe("licensed landing font", () => {
  it("reads the font raw or as the base64 text a Render secret file holds", async () => {
    assert.deepEqual(readLandingFont(await file("raw.otf", font)), font);
    const wrapped = font
      .toString("base64")
      .replace(/(.{8})/g, "$1\n")
      .concat("\n");
    assert.deepEqual(readLandingFont(await file("font.b64", wrapped)), font);
    const trueType = Buffer.concat([Buffer.from([0, 1, 0, 0]), font]);
    assert.deepEqual(readLandingFont(await file("tt.ttf", trueType)), trueType);
    assert.throws(
      () => readLandingFont(path.join(directory, "missing.otf")),
      /ENOENT/,
    );
    for (const [name, contents] of [
      ["text.otf", "not a font at all"],
      ["short.otf", Buffer.from("OTTO")],
    ]) {
      const bad = await file(name, contents);
      assert.throws(
        () => readLandingFont(bad),
        /neither an OpenType font nor its base64 encoding/,
      );
    }
  });

  it("is an optional absolute path in the configuration", () => {
    const base = { DATABASE_URL: "postgresql://localhost/test" };
    assert.equal(loadConfig(base).landingFontFile, undefined);
    assert.equal(
      loadConfig({ ...base, LANDING_FONT_FILE: "" }).landingFontFile,
      undefined,
    );
    assert.equal(
      loadConfig({
        ...base,
        LANDING_FONT_FILE: "/etc/secrets/perpetua-titling-light.otf.b64",
      }).landingFontFile,
      "/etc/secrets/perpetua-titling-light.otf.b64",
    );
    assert.throws(
      () => loadConfig({ ...base, LANDING_FONT_FILE: "fonts/font.otf" }),
      /LANDING_FONT_FILE must be an absolute path/,
    );
  });

  it("serves the supplied font at the URL the landing page preloads", async () => {
    const app = createApp({
      discovery: { listTopics: empty, listDebates: empty },
      messages: { isReady: async () => {} },
      sessions: { findUserByTokenHash: async () => null },
      logger: createLogger({ enabled: false }),
      applicationOrigin: "https://arena.example",
      landingFont: font,
    });
    assert.equal(
      LANDING_FONT_PATH,
      "/assets/landing/fonts/perpetua-titling-light.otf",
    );
    assert.match(
      (await request(app).get("/")).text,
      /perpetua-titling-light\.otf/,
    );
    const response = await request(app).get(LANDING_FONT_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "font/otf");
    assert.equal(response.headers["cache-control"], "public, max-age=0");
    assert.equal(Number(response.headers["content-length"]), font.length);
    assert.deepEqual(Buffer.from(response.body), font);
    const revalidated = await request(app)
      .get(LANDING_FONT_PATH)
      .set("If-None-Match", response.headers.etag);
    assert.equal(revalidated.status, 304);
    // Other landing assets are untouched.
    assert.equal(
      (await request(app).get("/assets/landing/fonts/OFL.txt")).status,
      200,
    );
  });

  it("loads LANDING_FONT_FILE at startup and keeps running without a valid file", async () => {
    const environment = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/unused",
      LOG_LEVEL: "silent",
    };
    const start = async (fontFile) => {
      let app;
      const server = createWebServer(
        { ...environment, LANDING_FONT_FILE: fontFile },
        { wrap: (captured) => (app = captured) },
      );
      const response = await request(app).get(LANDING_FONT_PATH);
      await server.stop();
      return response;
    };
    const supplied = await start(
      await file("secret.b64", font.toString("base64")),
    );
    assert.equal(supplied.status, 200);
    assert.deepEqual(Buffer.from(supplied.body), font);
    // A bad or missing file only logs a warning; the headline falls back to
    // Forum and the route never serves the bad contents.
    for (const fontFile of [
      await file("broken.b64", "not a font"),
      path.join(directory, "absent.b64"),
    ]) {
      const fallback = await start(fontFile);
      assert.notDeepEqual(Buffer.from(fallback.body ?? ""), font);
      assert.notEqual(String(fallback.body), "not a font");
    }
  });
});
