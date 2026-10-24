import assert from "node:assert/strict";
import { it } from "node:test";
import {
  renderHome,
  renderLive,
  renderAbout,
  renderAccount,
  renderCoins,
  renderMatchmaking,
} from "../dist/features/discovery/web.js";
import {
  renderMyModeration,
  renderModeration,
  renderOverlay,
} from "../dist/features/community/web.js";
import { renderMeasurementDashboard } from "../dist/features/measurement/web.js";

it("uses one navigation and session-aware account header across normal pages", () => {
  const origin = "https://arena.example";
  const pages = [
    renderHome(origin),
    renderLive(origin, [], { items: [] }),
    renderAbout(origin),
    renderAccount(origin),
    renderCoins(origin),
    renderMatchmaking(origin),
    renderMyModeration(true),
    renderModeration(true),
    renderMeasurementDashboard(
      { windowDays: 28, events: [], watch: [] },
      [],
      true,
    ),
  ];
  for (const html of pages) {
    assert.equal((html.match(/data-site-header/g) ?? []).length, 1);
    assert.match(
      html,
      /href="\/live">Live<\/a><a href="\/debates">Explore<\/a><a href="\/match">Create<\/a>/,
    );
    assert.match(html, /data-header-member hidden/);
    // One Sign in button opens the account page, which offers both methods.
    assert.match(
      html,
      /<a class="header-signup" href="\/account" data-header-sign-in>Sign in<\/a>/,
    );
    const header = html.match(
      /<header class="site-header"[\s\S]*?<\/header>/,
    )[0];
    assert.doesNotMatch(
      header,
      /data-sign-in="(?:google|email)">Continue with/,
    );
    assert.match(
      html,
      /<noscript><div class="header-auth-actions"><a class="header-login" href="\/api\/auth\/login\?connection=google">Continue with Google</,
    );
    assert.doesNotMatch(html, /data-auth-(?:open|script|style)/);
    // Deposits are not open, so the header offers no deposit action.
    assert.doesNotMatch(html, /data-deposit-open|>Deposit</);
    assert.match(html, /data-header-identity/);
    assert.match(html, /data-header-logout>Sign out /);
    assert.match(html, /site-header\.js/);
    assert.doesNotMatch(html, /class="ya-top"/);
  }
  const home = pages[0];
  assert.match(home, /data-nav="following"/);
  assert.match(home, /id="ya-search"/);
  assert.doesNotMatch(home, /<script[^>]+account-auth[.]bundle/);
});

it("keeps the broadcast overlay free of navigation and account controls", () => {
  const html = renderOverlay({
    proposition: "A public fixture",
    status: "live",
    topicTitle: "Topic",
    sideALabel: "For",
    sideBLabel: "Against",
  });
  assert.match(html, /broadcast-overlay/);
  assert.doesNotMatch(html, /data-site-header|data-auth-open/);
});

it("versions every server-rendered asset reference with the process revision", () => {
  const origin = "https://arena.example";
  const pages = [
    renderHome(origin),
    renderAccount(origin),
    renderCoins(origin),
    renderMatchmaking(origin),
    renderMyModeration(false),
    renderModeration(true),
    renderMeasurementDashboard(
      { windowDays: 28, events: [], watch: [] },
      [],
      false,
    ),
    renderOverlay({
      proposition: "A public fixture",
      status: "live",
      topicTitle: "Topic",
      sideALabel: "For",
      sideBLabel: "Against",
    }),
  ];
  const revisions = new Set();
  for (const html of pages) {
    const references = [...html.matchAll(/="(\/assets\/[^"]*)"/g)].map(
      ([, url]) => url,
    );
    assert.ok(references.length > 0);
    for (const url of references) {
      const match = /^\/assets\/[^?"]+\?v=([0-9a-f]{12})$/.exec(url);
      assert.ok(match, `unversioned asset reference ${url}`);
      revisions.add(match[1]);
    }
  }
  assert.equal(revisions.size, 1);
});
