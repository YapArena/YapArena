import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";
import express from "express";

import { createApp } from "../dist/app.js";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";
import {
  renderDebate,
  renderDebates,
  renderHome,
  renderLive,
  renderProfile,
  renderTopic,
  renderTopics,
} from "../dist/features/discovery/web.js";
import { createLogger } from "../dist/platform/logger.js";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";

const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "public-topic",
  title: "Public topic",
  summary: "A question worth debating.",
  sideALabel: "For",
  sideBLabel: "Against",
  isDemo: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};
const profile = {
  id: "22222222-2222-4222-8222-222222222222",
  handle: "alex-public",
  displayName: "Alex Public",
  bio: "Public speaker",
  isDemo: false,
};
const debate = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "public-debate",
  proposition: "Should we debate this?",
  status: "scheduled",
  rulesVersion: "preview-1",
  scheduledAt: new Date("2026-10-01T17:00:00Z"),
  liveStartedAt: null,
  liveEndedAt: null,
  isDemo: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  topic: {
    slug: topic.slug,
    title: topic.title,
    sideALabel: topic.sideALabel,
    sideBLabel: topic.sideBLabel,
  },
  speakerA: { handle: profile.handle, displayName: profile.displayName },
  speakerB: null,
  sponsor: null,
};

function appWith(discovery) {
  return createApp({
    discovery,
    messages: { isReady: async () => {} },
    users: { create: async () => ({}), findByEmail: async () => null },
    sessions: {
      create: async () => ({}),
      findUserByTokenHash: async () => null,
      deleteByTokenHash: async () => false,
    },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "https://arena.example",
  });
}

const discovery = {
  listTopics: async () => ({
    items: [topic],
    pagination: { limit: 12, offset: 0, hasMore: false },
  }),
  getTopic: async (slug) => (slug === topic.slug ? topic : null),
  getProfile: async (handle) => (handle === profile.handle ? profile : null),
  listDebates: async ({ status, topicSlug, profileHandle } = {}) => ({
    items:
      (!status || status === debate.status) &&
      (!topicSlug || topicSlug === topic.slug) &&
      (!profileHandle || profileHandle === profile.handle)
        ? [debate]
        : [],
    pagination: { limit: 12, offset: 0, hasMore: false },
  }),
  getDebate: async (slug) => (slug === debate.slug ? debate : null),
};

describe("public discovery", () => {
  const app = appWith(discovery);

  it("renders a real featured preview only when media is configured, without embedding grants", async () => {
    let selected = {
      ...debate,
      status: "live",
      proposition: "Should <cities> change?",
      speakerB: { displayName: "B & C", handle: "other" },
    };
    const featured = {
      ...discovery,
      listWatchableDebates: async () => (selected ? [selected] : []),
    };
    const configured = express().use(
      createDiscoveryRouter({
        discovery: featured,
        mediaEnabled: true,
        applicationOrigin: "https://arena.example",
      }),
    );
    const home = await request(configured).get("/live");
    assert.match(home.text, /data-featured-preview/);
    assert.match(
      home.text,
      /data-preview-thumbnail src="\/api\/media\/events\/[a-f0-9-]+\/thumbnail"/,
    );
    assert.doesNotMatch(home.text, /<div class="arena-featured-backdrop"/);
    assert.match(home.text, /data-mode="live"/);
    assert.match(home.text, /Should &lt;cities&gt; change\?/);
    assert.match(home.text, /B &amp; C/);
    assert.match(home.text, /muted autoplay playsinline loop preload="none"/);
    assert.match(home.text, /hero-preview\.js\?v=/);
    assert.doesNotMatch(
      home.text,
      /Watch now|viewer-token|recordingKey|media\.bundle/,
    );
    selected = { ...debate, status: "replay", speakerA: null };
    const replay = await request(configured).get("/live");
    assert.match(replay.text, /FEATURED REPLAY/);
    assert.doesNotMatch(replay.text, /arena-featured-speakers/);
    assert.match(replay.text, /data-card-preview/);
    assert.match(replay.text, /loading="lazy"/);
    assert.match(replay.text, /Watch debate: Should we debate this\?/);
    assert.match(
      replay.text,
      /rel="canonical" href="https:\/\/arena\.example\/live"/,
    );
    selected = null;
    assert.doesNotMatch(
      (await request(configured).get("/live")).text,
      /data-featured-preview/,
    );
    assert.doesNotMatch(
      (await request(appWith(featured)).get("/live")).text,
      /data-featured-preview/,
    );
  });

  it("serves the public journey and stable canonical links without login", async () => {
    const home = await request(app).get("/");
    assert.equal(home.status, 200);
    assert.match(home.text, /id="ya-market-v4"/);
    assert.doesNotMatch(
      home.text,
      /data-debate-preview|Debates to watch|Topics in play/,
    );
    assert.match(
      (await request(app).get("/live")).text,
      /href="\/topics\/public-topic"/,
    );
    assert.equal(home.headers["cache-control"], "no-store");
    const page = await request(app).get("/debates/public-debate");
    assert.equal(page.status, 200);
    assert.match(
      page.text,
      /rel="canonical" href="https:\/\/arena\.example\/debates\/public-debate"/,
    );
    assert.match(page.text, /Alex Public/);
    assert.match(page.text, /preview-1/);
    assert.doesNotMatch(page.text, /winner|tally|payout/i);
    assert.equal((await request(app).get("/people/alex-public")).status, 200);
    assert.equal((await request(app).get("/topics/public-topic")).status, 200);
  });

  it("renders an unavailable homepage without substituting sample activity", async () => {
    const unavailable = () => {
      throw new Error("database unavailable");
    };
    const shell = express().use(
      createDiscoveryRouter({
        discovery: {
          ...discovery,
          listTopics: unavailable,
          listDebates: unavailable,
          listWatchableDebates: unavailable,
        },
        mediaEnabled: true,
        applicationOrigin: "https://arena.example",
      }),
    );
    const home = await request(shell).get("/");
    assert.equal(home.status, 503);
    assert.match(home.text, /id="ya-market-v4"/);
    assert.match(home.text, /Discovery temporarily unavailable/);
    assert.match(home.text, /History unavailable/);
    assert.doesNotMatch(
      home.text,
      /Concept · Sample data|AI models should be open source/,
    );
    assert.doesNotMatch(
      home.text,
      /data-debate-preview|hero-preview|Debates to watch/,
    );
  });

  it("validates filters, search length, and pagination", async () => {
    assert.equal(
      (await request(app).get("/api/public/debates?status=invalid")).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/public/topics?limit=0")).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/public/debates?offset=10001")).status,
      400,
    );
    assert.equal(
      (await request(app).get(`/api/public/topics?q=${"x".repeat(81)}`)).status,
      400,
    );
    assert.equal(
      (await request(app).get("/debates?status=replay")).status,
      200,
    );
    assert.match(
      (await request(app).get("/debates?status=replay")).text,
      /No debates found/,
    );
  });

  it("returns the public API shape and hides unknown records", async () => {
    const response = await request(app).get(
      "/api/public/debates/public-debate",
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.topic.slug, topic.slug);
    assert.equal(response.body.speakerA.handle, profile.handle);
    assert.equal(response.body.winner, undefined);
    assert.equal(
      (await request(app).get("/api/public/debates/secret-debate")).status,
      404,
    );
    assert.equal((await request(app).get("/topics/secret-topic")).status, 404);
    assert.equal((await request(app).get("/people/secret-person")).status, 404);
  });

  it("escapes stored content and search terms in HTML", async () => {
    const malicious = appWith({
      ...discovery,
      listTopics: async () => ({
        items: [{ ...topic, title: "<script>alert(1)</script>" }],
        pagination: { limit: 12, offset: 0, hasMore: false },
      }),
    });
    const response = await request(malicious).get(
      "/topics?q=%22%3E%3Cscript%3E",
    );
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.text, /<script>/);
    assert.match(response.text, /&lt;script&gt;/);
  });

  it("serves the CSS asset for the page shell", async () => {
    const page = await request(app).get("/debates/public-debate");
    assert.match(page.text, /\/assets\/site\.css\?v=[0-9a-f]{12}/);
    assert.match(page.text, /\/assets\/site\.js\?v=[0-9a-f]{12}/);
    assert.match(
      page.text,
      /<script type="module" src="\/assets\/media\.bundle\.js\?v=[0-9a-f]{12}">/,
    );
    assert.match(page.text, /data-media-microphone/);
    const response = await request(app).get("/assets/site.css");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/css/);
    assert.match(response.headers["cache-control"], /max-age=0/);
    assert.doesNotMatch(response.headers["cache-control"], /immutable/);
    assert.equal((await request(app).get("/assets/site.js")).status, 200);
    const accountScript = await request(app).get("/assets/account.js");
    const matchingScript = await request(app).get("/assets/matching.js");
    assert.equal(accountScript.status, 200);
    assert.equal(matchingScript.status, 200);
    assert.doesNotThrow(() => new Function(accountScript.text));
    assert.doesNotThrow(() => new Function(matchingScript.text));
    const revision = /\/assets\/site\.css\?v=([0-9a-f]{12})/.exec(page.text)[1];
    for (const name of ["site.css", "site.js", "media.bundle.js"]) {
      const versioned = await request(app).get(`/assets/${name}?v=${revision}`);
      assert.equal(versioned.status, 200);
      assert.equal(
        versioned.headers["cache-control"],
        "public, max-age=31536000, immutable",
      );
    }
    // A revision this process did not render keeps the revalidating headers.
    for (const url of [
      "/assets/site.css?v=000000000000",
      `/assets/site.css?v=${revision}&v=${revision}`,
      `/assets/offline.html?v=${revision}`,
    ]) {
      const response = await request(app).get(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "public, max-age=0");
    }
    // Shared bundle chunks are imported without ?v= and cached by content hash.
    const bundle = await request(app).get(
      `/assets/media.bundle.js?v=${revision}`,
    );
    const chunk = /from"\.\/(chunks\/chunk-[A-Z2-7]{8}\.js)"/.exec(
      bundle.text,
    )[1];
    const shared = await request(app).get(`/assets/${chunk}`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers["content-type"], /javascript/);
    assert.equal(
      shared.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    assert.equal(
      (await request(app).get("/assets/chunks/chunk-AAAAAAAA.js")).status,
      404,
    );
    const offline = await request(app).get("/assets/offline.html");
    assert.equal(offline.status, 200);
    assert.equal(offline.headers["cache-control"], "public, max-age=0");
    assert.equal(
      (await request(app).get(`/assets/missing.js?v=${revision}`)).status,
      404,
    );
    const worker = await request(app).get("/sw.js");
    assert.equal(worker.status, 200);
    assert.match(worker.headers["content-type"], /javascript/);
    assert.equal(worker.headers["cache-control"], "no-cache");
  });

  it("exposes the account page and follow controls in the public journey", async () => {
    const account = await request(app).get("/account");
    assert.equal(account.status, 200);
    assert.match(
      account.text,
      /href="\/api\/auth\/login\?connection=google&amp;return=%2Faccount" data-sign-in="google">Continue with Google</,
    );
    assert.match(
      account.text,
      /href="\/api\/auth\/login\?connection=email&amp;return=%2Faccount" data-sign-in="email">Continue with email</,
    );
    for (const retired of [
      /Sign-In with Ethereum/,
      /id="wallet-login"/,
      /id="email-login"/,
      /id="email-register"/,
      /id="email-auth"/,
      /id="embedded-wallet"/,
      /account-auth\.bundle/,
    ])
      assert.doesNotMatch(account.text, retired);
    assert.match(account.text, /id="profile-form"/);
    for (const retired of [
      /id="wallet-link"|Link another wallet/,
      /id="retained-wallets"/,
      /id="wallet-list"/,
      /id="wallet-change"/,
      /id="account-security-passkeys"/,
      /account-security\.bundle/,
    ])
      assert.doesNotMatch(account.text, retired);
    assert.match(account.text, /id="sign-in-methods"/);
    // Settings are four tabbed sections. The sessions list and the wallet
    // left the page: sign out ends this device, coins live on /coins.
    for (const tab of ["profile", "security", "notifications", "privacy"])
      assert.match(
        account.text,
        new RegExp(`role="tab" id="tab-${tab}" href="#${tab}"`),
      );
    assert.match(account.text, /href="\/api\/me\/export" download/);
    assert.match(account.text, /href="\/coins"/);
    for (const retired of [
      /account-session-list\.js/,
      /account-coins\.js/,
      /data-funds=/,
      /Signing in never approves/,
      /Active sessions/,
    ])
      assert.doesNotMatch(account.text, retired);
    // The handle field accepts nothing: handles are chosen once, in the pop-up.
    assert.match(account.text, /name="handle" readonly/);
    const coins = (await request(app).get("/coins")).text;
    assert.match(coins, /id="account-wallet"/);
    assert.match(coins, /data-funds="available"/);
    assert.match(coins, /account-coins\.js/);
    assert.doesNotMatch(coins, /nonredeemable play money/);
    assert.match(
      (await request(app).get("/topics/public-topic")).text,
      /data-follow-type="topics"/,
    );
    assert.match(
      (await request(app).get("/people/alex-public")).text,
      /data-follow-type="people"/,
    );
    assert.match((await request(app).get("/")).text, /href="\/account"/);
    const matching = await request(app).get("/match");
    assert.equal(matching.status, 200);
    assert.match(matching.text, /DEBATE MATCHING/);
    assert.match(matching.text, /id="request-create"/);
  });

  it("shows a readable error when public data is unavailable", async () => {
    const unavailable = appWith({
      ...discovery,
      listTopics: async () => {
        throw new Error("database unavailable");
      },
    });
    const response = await request(unavailable)
      .get("/topics")
      .set("Accept", "text/html");
    assert.equal(response.status, 500);
    assert.match(response.text, /Please try again shortly/);
    assert.doesNotMatch(response.text, /database unavailable/);
  });

  it("serves every public JSON read route and rejects malformed identifiers", async () => {
    for (const route of [
      "/api/public/topics",
      "/api/public/topics/public-topic",
      "/api/public/debates?status=scheduled&topic=public-topic&profile=alex-public",
      "/api/public/people/alex-public",
    ]) {
      assert.equal((await request(app).get(route)).status, 200, route);
    }
    for (const route of [
      "/api/public/topics/BAD",
      "/api/public/debates/BAD",
      "/api/public/people/BAD",
    ]) {
      assert.equal((await request(app).get(route)).status, 404, route);
    }
    assert.equal(
      (
        await request(app).get(
          "/api/public/debates?profile=x".replace(
            "profile=x",
            `profile=${"x".repeat(41)}`,
          ),
        )
      ).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/public/debates?status=all")).status,
      200,
    );
    assert.equal((await request(app).get("/debates?limit=0")).status, 400);
    assert.equal((await request(app).get("/topics?offset=-1")).status, 400);
  });

  it("renders empty, filtered, paged, and media-unavailable states", () => {
    const origin = "https://arena.example";
    const empty = {
      items: [],
      pagination: { limit: 12, offset: 0, hasMore: false },
    };
    const first = {
      items: [debate],
      pagination: { limit: 1, offset: 0, hasMore: true },
    };
    const second = {
      items: [debate],
      pagination: { limit: 1, offset: 1, hasMore: false },
    };
    assert.match(renderHome(origin), /No public ideas yet/);
    assert.match(renderLive(origin, [], empty), /No watchable debates yet/);
    assert.match(renderLive(origin, [], empty), /No public topics yet/);
    assert.match(renderTopics(origin, empty, "missing"), /No topics found/);
    assert.match(
      renderDebates(origin, empty, "missing", "all"),
      /No debates found/,
    );
    assert.match(
      renderTopics(origin, { ...first, items: [topic] }, ""),
      /Next →/,
    );
    assert.match(renderDebates(origin, second, "", "all"), /Previous/);
    assert.match(
      renderDebates(origin, second, "city", "scheduled"),
      /href="\/debates\?q=city&amp;status=scheduled&amp;limit=1"/,
    );
    assert.match(
      renderDebates(origin, second, "city", "scheduled"),
      /rel="canonical" href="https:\/\/arena\.example\/debates\?q=city&amp;status=scheduled&amp;limit=1&amp;offset=1"/,
    );
    assert.match(
      renderTopic(origin, topic, empty),
      /No public debates on this topic yet/,
    );
    assert.match(
      renderProfile(origin, profile, empty),
      /No public debates yet/,
    );
    assert.match(renderDebate(origin, debate), /Checking media availability/);
    assert.match(
      renderDebate(origin, { ...debate, status: "live" }),
      /LIVE DEBATE & REPLAY/,
    );
    assert.match(
      renderDebate(origin, { ...debate, status: "replay" }),
      /REPLAY/,
    );
    assert.match(
      renderDebate(origin, { ...debate, status: "finalized" }),
      /Finalized/,
    );
    assert.match(
      renderDebate(origin, { ...debate, status: "cancelled" }),
      /Cancelled/,
    );
    assert.doesNotMatch(
      renderDebate(origin, {
        ...debate,
        isDemo: true,
        scheduledAt: null,
        speakerA: null,
        speakerB: { handle: "morgan-lee", displayName: "Morgan Lee" },
        sponsor: { name: "Example Sponsor", disclosure: "Sponsored listing" },
      }),
      /Sponsored listing/,
    );
  });
});

describe("live topic queue pages", () => {
  const live = (matchmakingEnabled) =>
    express().use(
      createDiscoveryRouter({
        discovery,
        emailFirst: true,
        matchmakingEnabled,
        applicationOrigin: "https://arena.example",
      }),
    );

  it("loads the queue and shows its controls only when the queue is on", async () => {
    const on = live(true);
    const topicPage = await request(on).get(`/topics/${topic.slug}`);
    assert.match(
      topicPage.text,
      /<html lang="en" data-matchmaking data-email-first>/,
    );
    assert.match(topicPage.text, /data-queue-topic="public-topic"/);
    assert.match(topicPage.text, /data-queue-side="A">Queue for /);
    const debatePage = await request(on).get(`/debates/${debate.slug}`);
    assert.match(
      debatePage.text,
      /data-queue-banner[^>]*hidden><\/div><section class="arena-watch"/,
    );
    const match = await request(on).get("/match");
    assert.doesNotMatch(match.text, /id="open-queue"|value="queue"/);
    assert.match(match.text, /queue on a side/);

    const off = live(false);
    const plain = await request(off).get(`/topics/${topic.slug}`);
    assert.match(plain.text, /<html lang="en" data-email-first>/);
    assert.doesNotMatch(plain.text, /data-matchmaking|data-queue-topic/);
    assert.match((await request(off).get("/match")).text, /id="open-queue"/);
  });
});

describe("discovery repository visibility", () => {
  it("queries only published debates and topics with bounded parameters", async () => {
    const queries = [];
    const repository = createDiscoveryRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return { rows: [] };
      },
    });
    await repository.listDebates({
      query: "creative",
      status: "live",
      limit: 5,
      offset: 10,
    });
    await repository.listTopics({ query: "cities", limit: 4, offset: 2 });
    await repository.getDebate("missing");
    await repository.getTopic("missing");
    await repository.getProfile("missing");
    assert.equal(await repository.getFeaturedDebate(), null);
    assert.deepEqual(await repository.listWatchableDebates(), []);
    assert.equal(queries.length, 7);
    assert.deepEqual(queries[5].values, [1]);
    assert.deepEqual(queries[6].values, [9]);
    assert.ok(queries[0].sql.includes("d.publication_state = 'published'"));
    assert.ok(queries[0].sql.includes("t.publication_state = 'published'"));
    assert.ok(queries[0].sql.includes("pa.publication_state = 'published'"));
    assert.deepEqual(queries[0].values, [
      "creative",
      "live",
      null,
      null,
      6,
      10,
    ]);
    assert.deepEqual(queries[1].values, ["cities", 5, 2]);
    assert.ok(
      queries
        .slice(2)
        .every(({ sql }) => sql.includes("publication_state = 'published'")),
    );
  });

  it("maps optional public relations and detects the next page", async () => {
    const row = {
      ...debate,
      topicSlug: topic.slug,
      topicTitle: topic.title,
      sideALabel: topic.sideALabel,
      sideBLabel: topic.sideBLabel,
      speakerAHandle: profile.handle,
      speakerADisplayName: profile.displayName,
      speakerBHandle: null,
      speakerBDisplayName: null,
      sponsorName: "Example Sponsor",
      sponsorDisclosure: "Sponsored listing",
    };
    const repository = createDiscoveryRepository({
      query: async (sql) => ({
        rows: sql.includes("FROM debates")
          ? [row, row]
          : sql.includes("FROM topics")
            ? [topic]
            : [profile],
      }),
    });
    const list = await repository.listDebates({ limit: 1 });
    assert.equal(list.items.length, 1);
    assert.equal(list.pagination.hasMore, true);
    assert.deepEqual(list.items[0].speakerA, {
      handle: profile.handle,
      displayName: profile.displayName,
    });
    assert.equal(list.items[0].speakerB, null);
    assert.equal(list.items[0].sponsor, null);
    assert.equal((await repository.getDebate(debate.slug)).slug, debate.slug);
    assert.equal((await repository.getFeaturedDebate()).slug, debate.slug);
    assert.equal(
      (await repository.listWatchableDebates())[0].slug,
      debate.slug,
    );
    assert.equal((await repository.getTopic(topic.slug)).slug, topic.slug);
    assert.equal(
      (await repository.getProfile(profile.handle)).handle,
      profile.handle,
    );
    const anonymousRepository = createDiscoveryRepository({
      query: async () => ({
        rows: [
          {
            ...row,
            speakerAHandle: null,
            speakerADisplayName: null,
            speakerBHandle: "morgan-lee",
            speakerBDisplayName: "Morgan Lee",
            sponsorName: null,
            sponsorDisclosure: null,
          },
        ],
      }),
    });
    const anonymous = await anonymousRepository.getDebate(debate.slug);
    assert.equal(anonymous.speakerA, null);
    assert.deepEqual(anonymous.speakerB, {
      handle: "morgan-lee",
      displayName: "Morgan Lee",
    });
    assert.equal(anonymous.sponsor, null);
  });
});
