import assert from "node:assert/strict";
import { it } from "node:test";
import {
  renderHome,
  renderLive,
  renderAbout,
  renderAccount,
  renderCoins,
  renderMatchmaking,
  renderDebates,
  renderTopics,
  renderTopic,
  renderDebate,
} from "../dist/features/discovery/web.js";
import { debate, topic, empty } from "./page-fixtures.js";
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
      /href="\/live"(?: aria-current="page")?>Live<\/a><a href="\/debates"(?: aria-current="page")?>Explore<\/a><a href="\/match"(?: aria-current="page")?>Create<\/a>/,
    );
    // The landing's logo, and below 1000 px a search icon that falls back
    // to the debates search without JavaScript.
    assert.match(
      html,
      /<a class="site-logo" href="\/home"><img src="\/assets\/landing\/yaparena-logo\.png\?v=[0-9a-f]{12}"[^>]* alt="YAP Arena home">/,
    );
    assert.match(
      html,
      /<a class="header-search-toggle" href="\/debates#debate-search" data-header-search-toggle aria-label="Search debates">/,
    );
    // The account button holds the 36 px avatar slot.
    assert.match(
      html,
      /data-header-account[^>]*><span class="header-avatar" data-header-avatar>/,
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
  // The current section is marked on its own page only (in the header; the
  // phone bottom tabs mark theirs too, tested below).
  const current = (html) =>
    [
      ...html
        .match(/<header class="site-header"[\s\S]*?<\/header>/)[0]
        .matchAll(/<a href="([^"]+)" aria-current="page">/g),
    ].map(([, href]) => href);
  assert.deepEqual(current(pages[1]), ["/live"]);
  assert.deepEqual(current(pages[5]), ["/match"]);
  assert.deepEqual(current(pages[2]), []);
  const home = pages[0];
  // With no ideas, /home is its empty state, under the same header and footer.
  assert.match(home, /No public ideas yet/);
  assert.match(home, /<footer class="site-footer">/);
  assert.doesNotMatch(home, /<script[^>]+account-auth[.]bundle/);
});

it("names the three destinations' pages in the phone top row and keeps the logo elsewhere", () => {
  const origin = "https://arena.example";
  const empty = {
    items: [],
    pagination: { limit: 12, offset: 0, hasMore: false },
  };
  const title = (html) => {
    const header = html.match(
      /<header class="site-header"[\s\S]*?<\/header>/,
    )[0];
    const found = header.match(
      /<p class="site-page-title ins" aria-hidden="true">([^<]*)<\/p>/,
    );
    // The attribute that swaps the logo for the name on phones comes with it.
    assert.equal(/data-page-title/.test(header), Boolean(found));
    return found ? found[1] : null;
  };
  // Visible capitals follow the inscription rule: U is shown as V.
  assert.equal(title(renderLive(origin, [], { items: [] })), "live");
  assert.equal(title(renderDebates(origin, empty, "", "all")), "explore");
  assert.equal(title(renderDebates(origin, empty, "city", "ended")), "explore");
  assert.equal(title(renderTopics(origin, empty, "")), "explore");
  assert.equal(title(renderMatchmaking(origin)), "create");
  for (const page of [
    renderHome(origin),
    renderAbout(origin),
    renderAccount(origin),
    renderCoins(origin),
  ])
    assert.equal(title(page), null);
  // The logo stays in the markup on every page; CSS hides it on phones only.
  assert.match(
    renderLive(origin, [], { items: [] }),
    /<a class="site-logo" href="\/home">/,
  );
});

it("ends every layout page but the debate page with the phone bottom tabs", () => {
  const origin = "https://arena.example";
  const tabBar = (html) =>
    html.match(
      /<nav class="site-tabbar" aria-label="Main navigation">[\s\S]*?<\/nav>/,
    )?.[0] ?? null;
  const current = (html) =>
    [...tabBar(html).matchAll(/<a href="([^"]+)" aria-current="page">/g)].map(
      ([, href]) => href,
    );
  const pages = {
    home: renderHome(origin),
    live: renderLive(origin, [], { items: [] }),
    explore: renderDebates(origin, empty, "", "all"),
    topics: renderTopics(origin, empty, ""),
    topic: renderTopic(origin, topic, empty),
    create: renderMatchmaking(origin),
    about: renderAbout(origin),
  };
  for (const html of Object.values(pages)) {
    const tabs = tabBar(html);
    assert.ok(tabs);
    // Home, Live, Explore and Create, each an icon and its name.
    assert.deepEqual(
      [
        ...tabs.matchAll(
          /<a href="([^"]+)"[^>]*><svg[^>]*aria-hidden="true">[\s\S]*?<\/svg><span>([^<]+)<\/span><\/a>/g,
        ),
      ].map(([, href, label]) => [href, label]),
      [
        ["/home", "Home"],
        ["/live", "Live"],
        ["/debates", "Explore"],
        ["/match", "Create"],
      ],
    );
    // The tabs come last in the body, after the footer.
    assert.match(
      html,
      /<\/footer><nav class="site-tabbar"[\s\S]*<\/nav><\/body>/,
    );
    // The header keeps its own navigation for wider screens.
    assert.match(html, /<nav class="site-nav" aria-label="Main navigation">/);
  }
  assert.deepEqual(current(pages.home), ["/home"]);
  assert.deepEqual(current(pages.live), ["/live"]);
  assert.deepEqual(current(pages.explore), ["/debates"]);
  assert.deepEqual(current(pages.topics), ["/debates"]);
  assert.deepEqual(current(pages.topic), ["/debates"]);
  assert.deepEqual(current(pages.create), ["/match"]);
  assert.deepEqual(current(pages.about), []);
  // The debate page keeps its own phone layout: no bottom tabs.
  assert.equal(tabBar(renderDebate(origin, debate)), null);
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
      // The headline font preloads at the unversioned URL site.css resolves,
      // so it downloads once (as on the debate page).
      if (url === "/assets/landing/fonts/headline.woff2") continue;
      const match = /^\/assets\/[^?"]+\?v=([0-9a-f]{12})$/.exec(url);
      assert.ok(match, `unversioned asset reference ${url}`);
      revisions.add(match[1]);
    }
  }
  assert.equal(revisions.size, 1);
});

it("ends pages with the landing's footer: one row of links and the play-money note", () => {
  const html = renderAbout("https://arena.example");
  const footer = html.match(
    /<footer class="site-footer">[\s\S]*?<\/footer>/,
  )[0];
  assert.match(
    footer,
    /<nav class="container footer-inner" aria-label="Site"><a href="\/topics">Topics<\/a><a href="\/coins">Yap Coins<\/a><a href="\/about">About<\/a><a href="\/privacy">Privacy<\/a><a href="\/terms">Terms<\/a><a href="\/cookies">Cookies<\/a><\/nav>/,
  );
  assert.match(
    footer,
    /<p class="footer-note">Play money · no cash value<\/p>/,
  );
  assert.doesNotMatch(footer, /Ideas under pressure/);
  assert.match(html, /<meta name="theme-color" content="#000000">/);
  assert.match(html, /viewport-fit=cover/);
});
