import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { MINIMUM_AGE, TERMS_VERSION } from "../dist/features/identity/terms.js";
import { DEBATER_CONSENT_VERSION } from "../dist/features/transcription/debater-settings.js";

const empty = async () => ({
  items: [],
  pagination: { limit: 12, offset: 0, hasMore: false },
});
const app = createApp({
  discovery: { listTopics: empty, listDebates: empty },
  messages: { isReady: async () => {} },
  sessions: { findUserByTokenHash: async () => null },
  logger: createLogger({ enabled: false }),
  applicationOrigin: "https://arena.example",
});

describe("privacy and terms pages", () => {
  it("serves both pages in the landing theme without scripts", async () => {
    for (const [path, title] of [
      ["/privacy", "Privacy policy"],
      ["/terms", "Terms of use"],
      ["/cookies", "Cookie policy"],
    ]) {
      const page = await request(app).get(path);
      assert.equal(page.status, 200);
      assert.match(page.headers["content-type"], /^text\/html/);
      assert.match(
        page.text,
        new RegExp(`<title>${title} · YAP Arena</title>`),
      );
      assert.match(
        page.text,
        new RegExp(
          `<link rel="canonical" href="https://arena.example${path}">`,
        ),
      );
      // landing.css carries the theme; legal.css only the long-form layout.
      assert.match(
        page.text,
        /<link rel="stylesheet" href="\/assets\/landing\.css\?v=[0-9a-f]{12}"><link rel="stylesheet" href="\/assets\/legal\.css\?v=[0-9a-f]{12}">/,
      );
      assert.match(page.text, /<body class="landing legal">/);
      assert.doesNotMatch(page.text, /<script/);
      assert.match(
        page.text,
        new RegExp(`<a href="${path}" aria-current="page">`),
      );
      assert.match(page.text, new RegExp(`<dd>${TERMS_VERSION}</dd>`));
      // Every contents link reaches a section on the page.
      const targets = [...page.text.matchAll(/<li><a href="#([a-z-]+)">/g)].map(
        ([, id]) => id,
      );
      assert.ok(targets.length >= 8);
      for (const id of targets)
        assert.match(page.text, new RegExp(`<section id="${id}"`));
    }
    for (const name of ["legal.css", "landing.css"]) {
      const css = await request(app).get(`/assets/${name}`);
      assert.equal(css.status, 200);
      assert.match(css.headers["content-type"], /^text\/css/);
    }
  });

  it("names every provider, the data region and the Québec privacy contacts", async () => {
    const { text } = await request(app).get("/privacy");
    for (const provider of [
      "Supabase",
      "Render",
      "Auth0",
      "Google",
      "Resend",
      "LiveKit",
      "Deepgram",
      "ElevenLabs",
      "Anthropic",
      "Cloudflare",
    ])
      assert.match(text, new RegExp(`<th scope="row">${provider}`));
    assert.match(text, /United States \(Ohio\)/);
    assert.match(text, /outside Québec and Canada/);
    assert.match(
      text,
      /person in charge of the protection of personal information/,
    );
    assert.match(text, /Commission d’accès à l’information du Québec/);
    assert.match(text, new RegExp(`for people ${MINIMUM_AGE} and older`));
    // Retention periods the code enforces.
    for (const period of [
      "7 days at most",
      "90 days.",
      "365 days.",
      "Events and watch sessions 90 days; an unused consent 180 days",
    ])
      assert.ok(text.includes(period), period);
    // Québec's governance summary, the tracking-technology notice and the
    // play-money statement.
    assert.match(text, /<section id="governance"/);
    assert.match(text, /answer in writing within 30 days/);
    assert.match(text, /off by default/);
    assert.match(text, /Global Privacy Control signal as a refusal/);
    assert.match(text, /<section id="coins"/);
    assert.match(text, /we collect no payment information/);
    assert.equal(text.match(/<li><strong>/g).length > 8, true);
    // Decisions only the founder can make stay visible until they are made.
    assert.match(
      text,
      /<mark class="legal-todo">\[Founder decision: retention period for recordings and replays\]<\/mark>/,
    );
  });

  it("sets the age, play-money and public recording rules", async () => {
    const { text } = await request(app).get("/terms");
    assert.match(text, new RegExp(`<strong>${MINIMUM_AGE} or older</strong>`));
    assert.match(text, /Yap Coins are play money\./);
    assert.match(
      text,
      /can’t be bought, sold, withdrawn, transferred to another account or exchanged/,
    );
    assert.match(text, /recorded on video and audio/);
    assert.match(text, /href="\/account\/moderation"/);
    // The visible headline uses the landing's inscriptional "v".
    assert.match(text, /<span aria-hidden="true">Terms of vse<\/span>/);
    assert.match(text, /<span class="sr-only">Terms of use<\/span>/);
  });

  it("lists every cookie and keeps analytics off until accepted", async () => {
    const { text } = await request(app).get("/cookies");
    for (const name of [
      "__Host-session",
      "__Host-sign-in",
      "yap_media_guard",
      "__Host-measurement",
    ])
      assert.match(text, new RegExp(`<th scope="row">${name}</th>`));
    assert.match(text, /Off until you accept/);
    assert.match(
      text,
      /We don’t use advertising or cross-site tracking cookies/,
    );
    assert.match(text, /href="\/home#cookie-settings"/);
    // The privacy policy points to it instead of repeating the list.
    const privacy = await request(app).get("/privacy");
    assert.match(privacy.text, /<a href="\/cookies">Cookie Policy<\/a>/);
  });

  it("links the legal pages from every page footer", async () => {
    const links =
      /<a href="\/privacy"[^>]*>Privacy<\/a>[^<]*<a href="\/terms"[^>]*>Terms<\/a>[^<]*<a href="\/cookies"[^>]*>Cookies<\/a>/;
    for (const path of [
      "/",
      "/home",
      "/about",
      "/topics",
      "/privacy",
      "/terms",
      "/cookies",
    ]) {
      const page = await request(app).get(path);
      assert.equal(page.status, 200, path);
      assert.match(page.text, links, path);
    }
  });

  it("asks debaters again for consent that covers recording and replay", () => {
    assert.equal(DEBATER_CONSENT_VERSION, "2026-10-30");
  });
});
