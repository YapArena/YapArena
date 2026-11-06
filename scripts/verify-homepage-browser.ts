import type { Browser, Page } from "playwright-core";
import type { AddressInfo } from "node:net";
import type {
  PublicTopic,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import express from "express";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { referenceHomepage } from "../dist/features/discovery/homepage-reference.js";

// These component fixtures exercise discovery/account rendering and the mocked
// auth, wallet and follow routes above the application. Services omitted here
// are only captured by unrelated route handlers; no fixture calls those methods.
// Keep each supplied method tied to its production signature without inventing
// implementations for unused fixture services.
type ApplicationOptions = Parameters<typeof createApp>[0];
type FixtureServices =
  | "discovery"
  | "identity"
  | "matching"
  | "media"
  | "mediaProvider"
  | "messages"
  | "users"
  | "sessions";
type HomepageFixtureOptions = Omit<ApplicationOptions, FixtureServices> & {
  discovery: Pick<
    NonNullable<ApplicationOptions["discovery"]>,
    | "listTopics"
    | "listWatchableDebates"
    | "listDebates"
    | "getDebate"
    | "getTopic"
  >;
  identity: Pick<NonNullable<ApplicationOptions["identity"]>, never>;
  matching: Pick<NonNullable<ApplicationOptions["matching"]>, never>;
  media: Pick<NonNullable<ApplicationOptions["media"]>, never>;
  mediaProvider: Pick<
    NonNullable<ApplicationOptions["mediaProvider"]>,
    "publicUrl" | "playbackOrigin" | "playbackOrigins"
  >;
  messages: Pick<ApplicationOptions["messages"], "isReady">;
  sessions: Pick<ApplicationOptions["sessions"], "findUserByTokenHash">;
};
type CreateHomepageFixtureApp = (
  options: HomepageFixtureOptions,
) => ReturnType<typeof createApp>;

const directory =
  process.env.HOMEPAGE_ARTIFACT_DIR ?? "/private/tmp/yaparena-homepage-browser";
await mkdir(directory, { recursive: true });
const topic: PublicTopic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "published-idea",
  title: "Published public idea",
  summary: "Synthetic local integration fixture.",
  sideALabel: "Support",
  sideBLabel: "Oppose",
  category: "other",
  isDemo: false,
  createdAt: new Date("2026-10-01"),
};
const debate: PublicDebate = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "published-debate",
  proposition: "A public debate for the idea",
  status: "replay",
  rulesVersion: "prototype-media-1",
  scheduledAt: null,
  liveStartedAt: new Date("2026-10-01"),
  liveEndedAt: new Date("2026-10-01"),
  isDemo: false,
  createdAt: new Date("2026-10-01"),
  topic: {
    slug: topic.slug,
    title: topic.title,
    sideALabel: topic.sideALabel,
    sideBLabel: topic.sideBLabel,
  },
  speakerA: { handle: "alex", displayName: "Alex Public", avatarId: "yap-owl" },
  speakerB: {
    handle: "morgan",
    displayName: "Morgan Public",
    avatarId: "yap-frog",
  },
  sponsor: null,
};
const list = <T>(items: T[]) => ({
  items,
  pagination: { limit: 12, offset: 0, hasMore: false },
});
let signedIn = false,
  followed = false,
  followWrites = 0,
  unavailable = false;
const app = express();
app.get("/api/auth/me", (_r, s) =>
  signedIn
    ? s.json({ user: { id: "synthetic-local-user" } })
    : s.status(401).json({ error: "authentication required" }),
);
app.get("/api/me/profile", (_r, s) =>
  signedIn
    ? s.json({ profile: { displayName: "Local Tester" } })
    : s.sendStatus(401),
);
// Every account is email-first since Decision 0009, so the header reads the
// account wallet rather than the historical play wallet.
app.get("/api/account-wallet", (_r, s) =>
  signedIn
    ? s.json({
        enabled: true,
        withdrawalsEnabled: false,
        available: "1234.00",
        reserved: "0.00",
      })
    : s.sendStatus(401),
);
app
  .route("/api/me/follows/topics/:slug")
  .get((_r, s) =>
    signedIn
      ? s.json({ following: followed })
      : s.status(401).json({ error: "authentication required" }),
  )
  .put((_r, s) => {
    if (!signedIn) return s.sendStatus(401);
    followWrites++;
    followed = true;
    return s.json({ following: true });
  })
  .delete((_r, s) => {
    if (!signedIn) return s.sendStatus(401);
    followWrites++;
    followed = false;
    return s.json({ following: false });
  });
app.use(
  (createApp as CreateHomepageFixtureApp)({
    discovery: {
      listTopics: async () => {
        if (unavailable) throw Error("local fixture unavailable");
        return list([topic]);
      },
      listWatchableDebates: async () => [debate],
      listDebates: async () => list([debate]),
      getDebate: async (slug) => (slug === debate.slug ? debate : null),
      getTopic: async (slug) => (slug === topic.slug ? topic : null),
    },
    homepageReferenceEnabled: true,
    // Configure the existing media boundary only to select its public playable list.
    // No provider connection is used by homepage cards.
    identity: {},
    matching: {},
    media: {},
    mediaProvider: {
      publicUrl: "wss://media.example.test",
      playbackOrigin: "https://media.example.test",
      playbackOrigins: ["https://media.example.test"],
    },
    messages: { isReady: async () => {} },
    sessions: { findUserByTokenHash: async () => null },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "http://localhost",
    environment: "development",
  }),
);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let browser: Browser | undefined;
const checks: Record<string, boolean> = {},
  errors: string[] = [],
  violations: {
    id: string;
    impact?: string | null;
    targets: axe.UnlabelledFrameSelector[];
  }[] = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "no-preference",
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    window.localStorage.setItem("yaparena-measurement-declined", "1");
    window.homeCsp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.homeCsp.push({
        directive: e.violatedDirective,
        uri: e.blockedURI,
      }),
    );
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  async function openNative() {
    await page.mouse.move(0, 0);
    await page.goto(base + "/home?reference=1");
    await page.locator("#ya-grid [data-expand]").first().waitFor();
  }
  const settled = () =>
    page.waitForFunction(
      () => !document.querySelector<HTMLElement>(".ya-carousel-ghost"),
    );
  const noOverflow = (scope: Page) =>
    scope.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
  for (const width of [1440, 1920, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await openNative();
    assert.ok(await noOverflow(page), `${width}px: no horizontal overflow`);
    await page.screenshot({
      path: `${directory}/implemented-${width}-initial.png`,
      fullPage: true,
    });
  }
  checks.responsiveScreenshots = true;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openNative();
  // Each slide shows its own idea, up to three of its arguments and its debaters.
  const ideas = referenceHomepage().ideas;
  for (const idea of ideas) {
    await page.locator(`[data-trending="${idea.id}"]`).click();
    await settled();
    assert.deepEqual(
      await page.evaluate(() => ({
        title: document.querySelector<HTMLElement>("#ya-title")!.textContent,
        arguments: [
          ...document.querySelectorAll<HTMLElement>(".trend-arg-text"),
        ].map((n) => n.textContent),
        rates: [
          ...document.querySelectorAll<HTMLElement>(".trend-arg-meta .num"),
        ].map((n) => n.textContent),
        people: [
          ...document.querySelectorAll<HTMLElement>(
            ".trend-people > span:not(.vs):not(.avatar-slot)",
          ),
        ].map((n) => n.textContent),
      })),
      {
        title: idea.title,
        arguments: idea.arguments.slice(0, 3).map((a) => a.text),
        rates: idea.arguments.slice(0, 3).map((a) => `${a.rate}%`),
        people: idea.debates[0]!.names.slice(0, 2),
      },
    );
    assert.equal(
      await page.locator("#ya-against").textContent(),
      `${100 - idea.pct!}%`,
    );
  }
  checks.everySlideHasItsOwnArgumentsAndDebate = true;
  // Every slide keeps the same height, so the carousel never jumps.
  const heights = new Set<number>();
  for (const idea of ideas) {
    await page.locator(`[data-trending="${idea.id}"]`).click();
    await settled();
    heights.add(
      Math.round(
        (await page.locator("#ya-trending-slide").boundingBox())!.height,
      ),
    );
  }
  assert.equal(heights.size, 1, `slide heights ${[...heights].join(", ")}`);
  checks.equalSlideHeights = true;
  await page.locator('[data-trending="ai"]').click();
  await settled();
  const next = page.locator('[data-carousel="next"]'),
    previous = page.locator('[data-carousel="previous"]');
  assert.equal(
    await next.getAttribute("aria-label"),
    `Next idea: ${ideas[1]!.title}`,
  );
  assert.equal(
    await previous.getAttribute("aria-label"),
    `Previous idea: ${ideas.at(-1)!.title}`,
  );
  await next.click();
  const animation = await page.locator("#ya-trending-slide").evaluate((n) => ({
    first: (n.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!
      .transform,
    duration: n.getAnimations()[0]!.effect!.getTiming().duration as number,
    easing: n.getAnimations()[0]!.effect!.getTiming().easing,
  }));
  assert.equal(animation.first, "translateX(104%)");
  assert.equal(animation.duration, 620);
  assert.equal(animation.easing, "cubic-bezier(0.22, 0.68, 0.16, 1)");
  await previous.click();
  assert.equal(
    await page
      .locator("#ya-trending-slide")
      .evaluate(
        (n) =>
          (n.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!
            .transform,
      ),
    "translateX(-104%)",
  );
  for (let i = 0; i < 7; i++) await page.keyboard.press("Enter");
  assert.equal(await page.locator(".ya-carousel-ghost").count(), 1);
  assert.deepEqual(
    await page.evaluate(() => {
      const seen = new Set<string>(),
        duplicates: string[] = [];
      document.querySelectorAll<HTMLElement>("[id]").forEach((n) => {
        if (seen.has(n.id)) duplicates.push(n.id);
        seen.add(n.id);
      });
      return duplicates;
    }),
    [],
  );
  // Renaming the neighbours keeps keyboard focus on the button.
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.carousel,
    ),
    "previous",
  );
  await settled();
  // Nothing turns by itself any more: no pause control, and the slide stays.
  assert.equal(await page.locator('[data-carousel="pause"]').count(), 0);
  const shown = await page.locator("#ya-title").textContent();
  await page.waitForTimeout(7000);
  assert.equal(await page.locator("#ya-title").textContent(), shown);
  checks.slideDirectionsTimingAndRapidNavigation = true;
  // Both chart sizes scrub locally at the actual pointer x and restore the latest readout.
  await page.locator('[data-trending="ai"]').click();
  await settled();
  async function scrub(selector: string, readout: string) {
    const chart = page.locator(selector),
      rect = (await chart.boundingBox())!,
      before = requests.length;
    await chart.hover({ position: { x: rect.width * 0.37, y: 70 } });
    await page.waitForFunction(
      (s) =>
        document
          .querySelector<HTMLElement>(s)!
          .classList.contains("is-scrubbing"),
      selector,
    );
    const state = await chart.evaluate((n) => ({
      x: Number(
        n
          .querySelector<HTMLElement>("[data-chart-clip]")!
          .getAttribute("width"),
      ),
      width: n.getBoundingClientRect().width,
      marker: n
        .querySelector("[data-chart-hover-marker]")!
        .getAttribute("width"),
    }));
    assert.ok(Math.abs(state.x - state.width * 0.37) < 1);
    assert.equal(state.marker, "10");
    const value = (await page.locator(readout).textContent())!;
    assert.notEqual(value, "68%");
    if (readout === "#ya-value") {
      // For and Against show that moment, and the label beside the marker too.
      assert.equal(
        await page.locator("#ya-against").textContent(),
        `${100 - Number.parseInt(value)}%`,
      );
      assert.match(
        (await page.locator("#ya-chart-tooltip").textContent())!,
        /^[A-Z][a-z]{2} \d{1,2} \d+%$/,
      );
      assert.match(
        (await page.locator("#ya-metric-label").textContent())!,
        / · \d\d:\d\d · Endorsement$/,
      );
    }
    await page.mouse.move(rect.x + rect.width * 0.63, rect.y + 90);
    await page.waitForTimeout(40);
    assert.equal(requests.length, before);
    await page.mouse.move(0, 0);
    await page.waitForFunction(
      (s) =>
        !document
          .querySelector<HTMLElement>(s)!
          .classList.contains("is-scrubbing"),
      selector,
    );
    assert.equal(await page.locator(readout).textContent(), "68%");
  }
  const outcomes = await page.locator(".trend-left").boundingBox();
  await scrub("#ya-chart", "#ya-value");
  // Nothing shifts while scrubbing.
  assert.deepEqual(await page.locator(".trend-left").boundingBox(), outcomes);
  await page.locator('[data-expand="ai"]').click();
  await scrub("#ya-detail-chart", "#ya-detail-value");
  const slider = page.getByRole("slider", {
    name: "Explore expanded idea chart history",
  });
  await slider.focus();
  await slider.press("ArrowLeft");
  assert.notEqual(await page.locator("#ya-detail-value").textContent(), "68%");
  await slider.press("Escape");
  assert.equal(await page.locator("#ya-detail-value").textContent(), "68%");
  await page.locator("#ya-detail-chart").dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: (await page.locator("#ya-detail-chart").boundingBox())!.x + 140,
  });
  await page.waitForFunction(() =>
    document
      .querySelector<SVGSVGElement>("#ya-detail-chart")!
      .classList.contains("is-scrubbing"),
  );
  await page.locator("#ya-detail-chart").dispatchEvent("pointercancel");
  checks.mainExpandedPointerTouchAndKeyboardCharts = true;
  await next.click();
  assert.equal(
    await page.locator("#ya-detail h3").textContent(),
    "AI models should be open source.",
  );
  await page.selectOption("#ya-sort", "moves");
  const placement = await page.locator("#ya-detail").evaluate((n) => ({
    previous: (n.previousElementSibling as HTMLElement).dataset.expand,
    width: n.getBoundingClientRect().width,
    grid: n.parentElement!.getBoundingClientRect().width,
  }));
  assert.equal(placement.width, placement.grid);
  const columns = await page
    .locator("#ya-grid")
    .evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(" ").length);
  const order = await page
    .locator("#ya-grid [data-expand]")
    .evaluateAll((cards) =>
      cards.map((c) => (c as HTMLElement).dataset.expand),
    );
  const index = order.indexOf("ai");
  assert.equal(
    placement.previous,
    order[
      Math.min(
        order.length - 1,
        Math.floor(index / columns) * columns + columns - 1,
      )
    ],
  );
  await page.locator('[data-debate-filter="replay"]').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  // Narrowing after scrubbing at full width never widens the page.
  await page.waitForTimeout(200);
  assert.ok(await noOverflow(page), "390px after scrubbing: no overflow");
  await page.waitForFunction(
    () =>
      (
        document.querySelector<HTMLElement>("#ya-detail")!
          .previousElementSibling as HTMLElement
      ).dataset.expand === "ai",
  );
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.debateFilter,
    ),
    "replay",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-debate-filter="replay"]').click();
  assert.equal(await page.locator("[data-open-debate]").count(), 2);
  await page.locator("[data-open-debate]").first().click();
  assert.equal(await page.locator("#ya-player-preview").isVisible(), true);
  await page.getByRole("button", { name: "Close debate preview" }).click();
  await page.locator('[data-debate-filter="live"]').click();
  assert.equal(await page.locator("[data-open-debate]").count(), 3);
  await page.locator("[data-open-debate]").first().click();
  await page.getByRole("button", { name: "Enter this round" }).click();
  await page.locator("#ya-inline-expectation").fill("72");
  await page.getByRole("button", { name: "Preview position" }).click();
  assert.match(
    (await page.locator("#ya-inline-review").textContent())!,
    /No coins spent/,
  );
  await page.getByRole("button", { name: "Close expanded idea" }).click();
  assert.equal(await page.locator("#ya-detail").count(), 0);
  // A sample idea's Explore debate opens its panel in the grid.
  await page.locator('[data-trending="ai"]').click();
  await settled();
  await page.locator(".trend-cta").click();
  await page.locator("#ya-detail").waitFor();
  assert.equal(
    await page.locator('[data-expand="ai"]').getAttribute("aria-expanded"),
    "true",
  );
  await page.getByRole("button", { name: "Close expanded idea" }).click();
  checks.independentExpansionPlacementAndDebateFilters = true;
  await page.locator("#ya-search").fill("nuclear");
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator("#ya-search").fill("");
  await page.locator('[data-filter="Climate"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator('[data-filter="All"]').click();
  await page.locator('[data-nav="following"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 2);
  assert.match(
    (await page.locator("#ya-grid-title").textContent())!,
    /Your watchlist/,
  );
  await page.locator("#ya-follow").click();
  assert.equal(
    await page.locator("#ya-follow").getAttribute("aria-label"),
    "Following this idea",
  );
  assert.equal(await page.locator("[data-expand]").count(), 3);
  await page.locator("#ya-follow").click();
  assert.equal(followWrites, 0);
  await page.locator('[data-nav="all"]').click();
  checks.searchCategoriesSortingAndLocalDemoFollows = true;
  // The rail: what's live with Watch, the invitation and the popular ideas.
  assert.equal(await page.locator(".rail-live").count(), 1);
  assert.equal(await page.locator(".rail-popular-list li").count(), 5);
  assert.equal(await page.locator(".rail-promo-guest").isVisible(), true);
  assert.equal(await page.locator(".rail-promo-member").isVisible(), false);
  await page.getByRole("link", { name: "Explore all ideas" }).click();
  await page.waitForFunction(() => window.location.hash === "#ya-ideas");
  checks.railLiveInvitationAndPopularIdeas = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openNative();
  assert.equal(
    await page
      .locator("#ya-chart .ya-endpoint-pulse")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator("#ya-chart")
      .evaluate((n) => n.classList.contains("is-pending")),
    false,
  );
  await next.click();
  assert.equal(await page.locator(".ya-carousel-ghost").count(), 0);
  checks.reducedMotionManualNavigation = true;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // The line draws left to right the first time it is seen, then the end pixel.
  await openNative();
  await page.waitForFunction(() =>
    document.querySelector("#ya-chart")!.classList.contains("is-drawing"),
  );
  assert.equal(
    await page
      .locator("#ya-chart .ya-linepath")
      .evaluate((n) => getComputedStyle(n).animationName),
    "ya-draw",
  );
  checks.chartDrawsInOnce = true;
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const phone = await touchContext.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(base + "/home?reference=1");
  await phone.locator("#ya-chart").waitFor();
  assert.ok(await noOverflow(phone));
  // Phones keep the outcomes, the chart and the debate; arguments stay on the idea.
  assert.equal(await phone.locator(".trend-args").isVisible(), false);
  await phone.locator("#ya-chart").scrollIntoViewIfNeeded();
  const phoneChart = (await phone.locator("#ya-chart").boundingBox())!;
  await phone.touchscreen.tap(
    phoneChart.x + phoneChart.width * 0.4,
    phoneChart.y + 50,
  );
  await phone.waitForFunction(() =>
    document
      .querySelector<SVGSVGElement>("#ya-chart")!
      .classList.contains("is-scrubbing"),
  );
  await phone.locator("#ya-search").tap();
  assert.equal(
    await phone.locator("#ya-chart").getAttribute("class"),
    "ya-chart",
  );
  await touchContext.close();
  checks.coarsePointerMobileTouchInspection = true;
  // Real data uses nullable histories, actual wallet/follows and canonical routes.
  await page.goto(base + "/home");
  await page.locator("#ya-grid [data-expand]").first().waitFor();
  assert.equal(await page.locator("#ya-value").count(), 0);
  assert.match(
    (await page.locator(".trend-none").textContent())!,
    /No rounds yet/,
  );
  assert.equal(await page.locator("#ya-chart .ya-linepath").count(), 0);
  assert.match(
    (await page.locator("#ya-chart").textContent())!,
    /The chart starts after the first closed round\./,
  );
  assert.equal(await page.locator(".trend-signin").isVisible(), true);
  // The trending card fits the first screen (docs/site-design.md).
  for (const [width, height, limit] of [
    [1440, 900, 800],
    [1280, 800, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const box = (await page.locator(".ya-carousel").boundingBox())!;
    assert.ok(
      box.y + box.height <= limit,
      `${width}: card ends at ${box.y + box.height}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const cta = (await page.locator(".trend-cta").boundingBox())!;
  assert.ok(
    cta.y + cta.height <= 820,
    `390: Explore debate ends at ${cta.y + cta.height}`,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  checks.trendingCardFitsTheFirstScreen = true;
  await page.locator('[data-nav="following"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLElement>("#ya-grid")!
      .textContent.includes("Sign in"),
  );
  signedIn = true;
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLElement>("[data-header-balance]")!
      .textContent.includes("1234.00"),
  );
  assert.equal(await page.locator(".trend-signin").isVisible(), false);
  assert.equal(await page.locator(".rail-promo-member").isVisible(), true);
  assert.equal(await page.locator(".rail-promo-guest").isVisible(), false);
  await page.locator("#ya-follow").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLElement>("#ya-follow")!
        .getAttribute("aria-pressed") === "true",
  );
  assert.equal(
    await page.locator("#ya-follow").getAttribute("aria-label"),
    "Following this idea",
  );
  assert.equal(followWrites, 1);
  await page.locator('[data-nav="following"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator("[data-expand]").click();
  assert.equal(
    await page
      .locator('#ya-debate-grid a[href="/debates/published-debate"]')
      .count(),
    1,
  );
  assert.equal(
    requests.some((u) =>
      /viewer-token|\/replay\?|livekit|media\.bundle|replay\.bundle/.test(u),
    ),
    false,
  );
  await page.evaluate(() => {
    window.yapFollows.initialize(document);
    window.yapFollows.initialize(document);
  }); // Dynamic controls are initialized once.
  await page.locator("#ya-detail .ya-follow").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLElement>("#ya-follow")!
        .getAttribute("aria-pressed") === "false",
  );
  assert.equal(followWrites, 2);
  checks.realNullableDataWalletFollowsAndCanonicalDebates = true;
  await page.evaluate(axe.source);
  const axeViolations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  );
  violations.push(...axeViolations);
  assert.deepEqual(violations, []);
  assert.deepEqual(await page.evaluate(() => window.homeCsp), []);
  checks.accessibilityAndCsp = true;
  const nojs = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 1100 },
    }),
    plain = await nojs.newPage();
  await plain.goto(base + "/home");
  assert.equal(await plain.locator("h1").textContent(), "Yap Arena");
  assert.equal(await plain.locator(".ya-heading").count(), 0);
  assert.equal(
    await plain.locator(".ya-cardtitle").textContent(),
    debate.proposition,
  );
  assert.equal(
    await plain
      .locator('a[data-expand][href="/topics/published-idea"]')
      .count(),
    1,
  );
  assert.equal(
    await plain.locator('.trend-cta[href="/debates/published-debate"]').count(),
    1,
  );
  await plain
    .getByRole("link", { name: "Explore debate", exact: true })
    .click();
  assert.ok(plain.url().endsWith("/debates/published-debate"));
  assert.equal(await plain.locator("[data-media-event]").count(), 1);
  await plain.goto(base + "/home");
  await plain.getByRole("searchbox", { name: "Search ideas" }).fill("idea");
  await Promise.all([
    plain.waitForURL((url) => url.pathname === "/topics"),
    plain.getByRole("searchbox", { name: "Search ideas" }).press("Enter"),
  ]);
  assert.equal(new URL(plain.url()).searchParams.get("q"), "idea");
  await plain.goto(base + "/home");
  // Without JavaScript the header still offers both Auth0 sign-in methods.
  for (const [name, connection] of [
    ["Continue with Google", "google"],
    ["Continue with email", "email"],
  ])
    assert.equal(
      await plain.getByRole("link", { name, exact: true }).getAttribute("href"),
      `/api/auth/login?connection=${connection}`,
    );
  await nojs.close();
  checks.serverRenderedNoJavaScriptFallback = true;
  checks.realDebateAndAccountNavigation = true;
  unavailable = true;
  const response = await page.goto(base + "/home");
  assert.equal(response!.status(), 503);
  assert.match(
    (await page.locator(".home-state").textContent())!,
    /unavailable/,
  );
  assert.equal(await page.locator("#ya-value").count(), 0);
  assert.equal(await page.locator(".site-footer").count(), 1);
  unavailable = false;
  checks.unavailableNeverSubstitutesConceptData = true;
  assert.deepEqual(errors, []);
  const evidence = {
    result: "PASS",
    checks,
    errors,
    violations,
    scope:
      "Loopback Express application with synthetic public records/auth responses and checked-in concept fixtures. No hosted writes or media sessions.",
  };
  await writeFile(
    directory + "/evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  const lastPage = browser?.contexts().at(-1)?.pages().at(-1);
  if (lastPage && !lastPage.isClosed())
    await lastPage
      .screenshot({ path: directory + "/failure.png", fullPage: true })
      .catch(() => {});
  await writeFile(
    directory + "/evidence.json",
    JSON.stringify({ result: "FAIL", checks, errors, violations }, null, 2) +
      "\n",
  );
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
