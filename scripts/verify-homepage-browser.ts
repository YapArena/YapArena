import type { Browser, Page, Frame } from "playwright-core";
import type { AddressInfo } from "node:net";
import type {
  PublicTopic,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
/* global document, window, getComputedStyle, DOMMatrixReadOnly */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

const referencePath = process.env.HOMEPAGE_REFERENCE_PATH;
const reference = referencePath ? await readFile(referencePath, "utf8") : null;
if (referencePath)
  assert.ok(
    reference!.includes("ya-market-v4") && reference!.includes("data-srcdoc"),
  );
if (process.argv.includes("--compare-reference") && !reference)
  throw new Error(
    "Reference comparison requires HOMEPAGE_REFERENCE_PATH pointing to the supplied HTML export",
  );
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
  speakerA: { handle: "alex", displayName: "Alex Public" },
  speakerB: { handle: "morgan", displayName: "Morgan Public" },
  sponsor: null,
};
const list = <T>(items: T[]) => ({
  items,
  pagination: { limit: 12, offset: 0, hasMore: false },
});
let signedIn = false,
  followed = false,
  followWrites = 0,
  unavailable = false,
  tickerTrial = false;
const app = express();
if (reference) app.get("/reference", (_r, s) => s.type("html").send(reference));
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
        return list(
          tickerTrial
            ? [
                topic,
                ...["Second", "Third"].map((label, i) => ({
                  ...topic,
                  id: `ticker-${i}`,
                  slug: `ticker-${i}`,
                  title: `${label} public idea`,
                })),
              ]
            : [topic],
        );
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
  }[] = [],
  comparisons: { width: number; maxGeometryDifference: number }[] = [];
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
    try {
      window.localStorage.setItem("yaparena-measurement-declined", "1");
    } catch {
      /* The exported reference iframe intentionally has an opaque origin. */
    }
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
  async function pause(scope: Page | Frame) {
    await scope
      .getByRole("button", { name: "Pause trending rotation", exact: true })
      .click();
  }
  async function stableShot(scope: Page | Frame, name: string) {
    await scope.evaluate(() => {
      for (const a of document
        .querySelector<HTMLElement>("#ya-argument-track")!
        .getAnimations()) {
        a.pause();
        a.currentTime = 0;
      }
      const fill = document.querySelector<HTMLElement>(
        ".ya-carousel-dot[aria-current=true] .ya-dot-fill",
      )!;
      for (const a of fill?.getAnimations() ?? []) a.cancel();
      if (fill) fill.style.transform = "scaleX(0)";
    });
    // Chrome clips cross-origin iframe rasterization to the outer viewport.
    // Use matching full-product capture viewports at the original responsive
    // width, changing only the export shell rather than its product DOM/CSS.
    const height = await scope
      .locator("#ya-market-v4")
      .evaluate((n) => n.scrollHeight);
    await page.setViewportSize({
      width: page.viewportSize()!.width,
      height: Math.ceil(height),
    });
    if ((scope as Frame).frameElement) {
      await (
        await (scope as Frame).frameElement()
      ).evaluate((frame: HTMLIFrameElement, height) => {
        frame.style.height = `${height}px`;
      }, height);
    }
    await scope.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await scope
      .locator("#ya-market-v4")
      .screenshot({ path: `${directory}/${name}.png` });
  }
  async function geometry(
    scope: Page | Frame,
  ): Promise<Record<string, Record<string, number>>> {
    return scope.evaluate(() => {
      const origin = document
        .querySelector<HTMLElement>("#ya-market-v4")!
        .getBoundingClientRect();
      return Object.fromEntries(
        [
          ".ya-top",
          ".ya-content",
          ".ya-heading",
          ".ya-layout",
          ".ya-feature",
          ".ya-side",
          ".ya-grid",
          ".ya-marketcard",
        ].map((selector) => {
          const rect = document
            .querySelector<HTMLElement>(selector)!
            .getBoundingClientRect();
          return [
            selector,
            {
              x: rect.x - origin.x,
              y: rect.y - origin.y,
              width: rect.width,
              height: rect.height,
            },
          ];
        }),
      );
    });
  }
  async function compare(width: number) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(base + "/reference");
    const ref = page.frames().find((f) => f.parentFrame())!;
    await ref.locator("[data-expand]").first().waitFor();
    await pause(ref);
    await stableShot(ref, `reference-${width}-initial`);
    const expected = await geometry(ref);
    await openNative();
    await pause(page);
    await stableShot(page, `implemented-${width}-initial`);
    const actual = await geometry(page);
    for (const key of Object.keys(expected))
      for (const dimension of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(expected[key]![dimension]! - actual[key]![dimension]!) < 1,
          `${width}px ${key}.${dimension}: reference ${expected[key]![dimension]!} / implementation ${actual[key]![dimension]!}`,
        );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    comparisons.push({
      width,
      maxGeometryDifference: Math.max(
        ...Object.keys(expected).flatMap((k) =>
          Object.keys(expected[k]!).map((d) =>
            Math.abs(expected[k]![d]! - actual[k]![d]!),
          ),
        ),
      ),
    });
    if (width === 1440 || width === 390) {
      await page.getByRole("button", { name: "Next trending idea" }).click();
      await page.waitForFunction(
        () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
      );
      await stableShot(page, `implemented-${width}-second`);
      await page.locator("#ya-chart").hover({
        position: {
          x: Math.min(
            180,
            (await page.locator("#ya-chart").boundingBox())!.width * 0.4,
          ),
          y: 60,
        },
      });
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector<HTMLElement>("#ya-chart-tooltip")!,
          ).opacity === "1",
      );
      await page.screenshot({
        path: `${directory}/implemented-${width}-hover.png`,
        fullPage: true,
      });
      await page.locator('[data-expand="ai"]').click();
      await page.locator("#ya-detail").waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>("#ya-detail")!.getAnimations()
            .length === 0,
      );
      await stableShot(page, `implemented-${width}-expanded`);
      await page.goto(base + "/reference");
      const r = page.frames().find((f) => f.parentFrame())!;
      await r.locator("[data-expand]").first().waitFor();
      await pause(r);
      await r.getByRole("button", { name: "Next trending idea" }).click();
      await r.waitForFunction(
        () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
      );
      await stableShot(r, `reference-${width}-second`);
      await r.locator("#ya-chart").hover({
        position: {
          x: Math.min(
            180,
            (await r.locator("#ya-chart").boundingBox())!.width * 0.4,
          ),
          y: 60,
        },
      });
      await r.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector<HTMLElement>("#ya-chart-tooltip")!,
          ).opacity === "1",
      );
      await r
        .locator("#ya-market-v4")
        .screenshot({ path: `${directory}/reference-${width}-hover.png` });
      await r.locator('[data-expand="ai"]').click();
      await r.waitForFunction(
        () =>
          document.querySelector<HTMLElement>("#ya-detail")?.getAnimations()
            .length === 0,
      );
      await stableShot(r, `reference-${width}-expanded`);
    }
  }
  for (const width of [1440, 1920, 1024, 768, 390, 320]) {
    if (reference) await compare(width);
    else {
      await page.setViewportSize({ width, height: 1100 });
      await openNative();
      await pause(page);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${width}px: no horizontal overflow`,
      );
      await stableShot(page, `implemented-${width}-initial`);
    }
  }
  checks.responsiveScreenshots = true;
  if (reference) checks.referenceGeometry = true;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openNative();
  await pause(page);
  // The maintained functional gate uses the checked-in deterministic concept data.
  // The separate, explicitly requested export comparison remains available locally.
  const expectedIdeas = referenceHomepage().ideas.map((idea) => ({
    title: idea.title,
    arguments: idea.arguments.map((argument) => argument.text),
    rates: idea.arguments.map((argument) => `${argument.rate}%`),
    debate: idea.short,
  }));
  if (reference) {
    await page.goto(base + "/reference");
    const ref = page.frames().find((f) => f.parentFrame())!;
    await ref.locator("[data-expand]").first().waitFor();
    await pause(ref);
    for (const [i, id] of [
      "ai",
      "work",
      "nuclear",
      "ubi",
      "city",
      "growth",
    ].entries()) {
      await ref.locator(`[data-trending="${id}"]`).click();
      await ref.waitForFunction(
        () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
      );
      assert.deepEqual(
        await ref.evaluate(() => ({
          title: document.querySelector<HTMLElement>("#ya-title")!.textContent,
          arguments: [
            ...document.querySelectorAll<HTMLElement>(
              ".ya-argument-list:first-child .ya-argument-text",
            ),
          ].map((n) => n.textContent),
          rates: [
            ...document.querySelectorAll<HTMLElement>(
              ".ya-argument-list:first-child strong",
            ),
          ].map((n) => n.textContent),
          debate: document.querySelector<HTMLElement>(
            "#ya-side .ya-debate-title",
          )!.textContent,
        })),
        expectedIdeas[i],
      );
    }
  }
  await openNative();
  await pause(page);
  for (const [i, id] of [
    "ai",
    "work",
    "nuclear",
    "ubi",
    "city",
    "growth",
  ].entries()) {
    await page.locator(`[data-trending="${id}"]`).click();
    await page.waitForFunction(
      () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
    );
    const actual = await page.evaluate(() => ({
      title: document.querySelector<HTMLElement>("#ya-title")!.textContent,
      arguments: [
        ...document.querySelectorAll<HTMLElement>(
          ".ya-argument-list:first-child .ya-argument-text",
        ),
      ].map((n) => n.textContent),
      rates: [
        ...document.querySelectorAll<HTMLElement>(
          ".ya-argument-list:first-child strong",
        ),
      ].map((n) => n.textContent),
      debate: document.querySelector<HTMLElement>("#ya-side .ya-debate-title")!
        .textContent,
    }));
    assert.deepEqual(actual, expectedIdeas[i]);
  }
  checks.everySlideHasItsOwnArgumentsAndDebate = true;
  await page.getByRole("button", { name: "Next trending idea" }).click();
  const animation = await page.locator("#ya-trending-slide").evaluate((n) => ({
    first: (n.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!
      .transform,
    duration: n.getAnimations()[0]!.effect!.getTiming().duration as number,
    easing: n.getAnimations()[0]!.effect!.getTiming().easing,
  }));
  assert.equal(animation.first, "translateX(104%)");
  assert.equal(animation.duration, 620);
  assert.equal(animation.easing, "cubic-bezier(0.22, 0.68, 0.16, 1)");
  await page.getByRole("button", { name: "Previous trending idea" }).click();
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
  for (let i = 0; i < 7; i++)
    await page.getByRole("button", { name: "Next trending idea" }).click();
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
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.carousel,
    ),
    "next",
  );
  await page.waitForFunction(
    () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
  );
  checks.slideDirectionsTimingAndRapidNavigation = true;
  // Both chart sizes scrub locally at the actual pointer x and restore the latest readout.
  await page.locator('[data-trending="ai"]').click();
  await page.waitForFunction(
    () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
  );
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
    }));
    assert.ok(Math.abs(state.x - state.width * 0.37) < 1);
    assert.notEqual(await page.locator(readout).textContent(), "68%");
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
  await scrub("#ya-chart", "#ya-value");
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
  await page.getByRole("button", { name: "Next trending idea" }).click();
  assert.equal(
    await page.locator("#ya-detail h2").textContent(),
    "AI models should be open source.",
  );
  await page.selectOption("#ya-sort", "moves");
  const placement = await page.locator("#ya-detail").evaluate((n) => ({
    previous: (n.previousElementSibling as HTMLElement).dataset.expand,
    width: n.getBoundingClientRect().width,
    grid: n.parentElement!.getBoundingClientRect().width,
  }));
  assert.equal(placement.previous, "work");
  assert.equal(placement.width, placement.grid);
  await page.locator('[data-debate-filter="replay"]').focus();
  await page.setViewportSize({ width: 390, height: 844 });
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
  checks.independentExpansionPlacementAndDebateFilters = true;
  await page.locator("#ya-search").fill("nuclear");
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator("#ya-search").fill("");
  await page.locator('[data-filter="Climate"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator('[data-filter="All"]').click();
  await page.locator('[data-nav="following"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 2);
  assert.equal(followWrites, 0);
  checks.searchCategoriesSortingAndLocalDemoFollows = true;
  // Verify actual animation direction/loop period and independent pause.
  await page.locator('[data-nav="all"]').click();
  await page.locator('[data-trending="ai"]').click();
  await page.waitForFunction(
    () => !document.querySelector<HTMLElement>(".ya-carousel-ghost")!,
  );
  await page.getByRole("button", { name: "Play trending rotation" }).click();
  await page.locator("#ya-search").focus();
  await page.mouse.move(0, 0);
  const transform = () =>
    page
      .locator("#ya-argument-track")
      .evaluate(
        (n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m42,
      );
  const first = await transform();
  await page.waitForTimeout(90);
  assert.ok((await transform()) < first);
  const cycle = await page.locator("#ya-argument-track").evaluate((n) => ({
    duration: n.getAnimations()[0]!.effect!.getTiming().duration as number,
    children: n.children.length,
    hidden: n.children[1]!.getAttribute("aria-hidden"),
  }));
  assert.deepEqual(cycle, { duration: 32000, children: 2, hidden: "true" });
  await page.locator("#ya-arguments").hover();
  const held = await transform();
  await page.waitForTimeout(90);
  assert.ok(Math.abs((await transform()) - held) < 1);
  const pageTop = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(40);
  const scrolled = await transform();
  assert.ok(Math.abs(scrolled - held + 120) < 2);
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(40);
  assert.ok(Math.abs((await transform()) - scrolled - 60) < 2);
  assert.equal(await page.evaluate(() => window.scrollY), pageTop);
  await page.locator("#ya-arguments").dispatchEvent("wheel", {
    deltaY: 1,
    deltaMode: 1,
    cancelable: true,
  });
  assert.ok(Math.abs((await transform()) - scrolled - 44) < 2);
  const inspected = await transform();
  await page.locator("#ya-arguments").dispatchEvent("wheel", {
    deltaY: 120,
    ctrlKey: true,
    cancelable: true,
  });
  assert.ok(Math.abs((await transform()) - inspected) < 1);
  await page
    .locator("#ya-arguments")
    .screenshot({ path: directory + "/manual-argument-scroll.png" });
  await page.mouse.move(0, 0);
  const resumed = await transform();
  assert.ok(Math.abs(resumed - inspected) < 6);
  await page.waitForTimeout(90);
  assert.ok((await transform()) < resumed);
  const argumentWindow = page.locator(".ya-arguments-window");
  await argumentWindow.focus();
  await page.keyboard.press("Home");
  assert.ok(Math.abs(await transform()) < 1);
  await page.keyboard.press("ArrowDown");
  assert.ok(Math.abs((await transform()) + 60) < 1);
  await page.keyboard.press("End");
  assert.ok((await transform()) < -60);
  await page.locator("#ya-argument-track").evaluate((n) => {
    n.getAnimations()[0]!.currentTime = 31990;
  });
  await argumentWindow.dispatchEvent("wheel", {
    deltaY: 120,
    cancelable: true,
  });
  const wrapped = await page.locator("#ya-argument-track").evaluate((n) => ({
    time: n.getAnimations()[0]!.currentTime as number,
    copies: n.children.length,
  }));
  assert.ok(wrapped.time > 0 && wrapped.time < 10000);
  assert.equal(wrapped.copies, 2);
  checks.manualArgumentScrollAndContinuousResume = true;
  await page.getByRole("button", { name: "Pause argument flow" }).click();
  assert.equal(
    await page.locator("#ya-arguments").getAttribute("data-paused"),
    "true",
  );
  checks.upwardArgumentLoopAndPause = true;
  // Use the browser's controlled clock to inspect progress/advance over repeated cycles.
  const timed = await context.newPage();
  await timed.clock.install();
  await timed.goto(base + "/home?reference=1");
  await timed.locator("[data-expand]").first().waitFor();
  await timed.mouse.move(0, 0);
  const selected = () =>
    timed
      .locator(".ya-carousel-dot[aria-current=true]")
      .getAttribute("data-trending");
  await timed.clock.runFor(2000);
  const elapsed = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  assert.ok(elapsed > 0.28 && elapsed < 0.36);
  await timed
    .locator("#ya-chart")
    .dispatchEvent("pointerenter", { pointerType: "mouse" }); // Hover the actual carousel region below.
  await timed
    .locator("#ya-carousel")
    .dispatchEvent("pointerenter", { pointerType: "mouse" });
  await timed.clock.runFor(10000);
  assert.equal(await selected(), "ai");
  const preserved = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  assert.ok(Math.abs(preserved - elapsed) < 0.01);
  await timed
    .locator("#ya-carousel")
    .dispatchEvent("pointerleave", { pointerType: "mouse" });
  await timed.clock.runFor(4700);
  assert.equal(await selected(), "work");
  await timed.clock.runFor(6520);
  assert.equal(await selected(), "nuclear");
  await timed.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await timed.clock.runFor(13000);
  assert.equal(await selected(), "nuclear");
  await timed.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await timed.locator('[data-carousel="pause"]').dispatchEvent("click");
  const savedFill = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  await timed.clock.runFor(8000);
  assert.equal(await selected(), "nuclear");
  await timed.locator('[data-carousel="pause"]').dispatchEvent("click");
  await timed.clock.runFor((1 - savedFill) * 6500 + 32);
  assert.equal(await selected(), "ubi");
  await timed.locator('#ya-side [data-action="trade"]').dispatchEvent("click");
  await timed.locator("#ya-search").focus();
  await timed.clock.runFor(13000);
  assert.equal(await selected(), "ubi");
  await timed.locator('#ya-side [data-action="live"]').dispatchEvent("click");
  await timed.locator("#ya-search").focus();
  await timed.clock.runFor(6520);
  assert.equal(await selected(), "city");
  await timed.close();
  // IntersectionObserver uses the actual compositor, independently of the
  // controlled animation clock above. Exercise offscreen suspension in real time.
  const offscreen = await context.newPage();
  await offscreen.setViewportSize({ width: 1440, height: 500 });
  await offscreen.goto(base + "/home?reference=1");
  await offscreen.locator("#ya-grid [data-expand]").first().waitFor();
  await offscreen.mouse.move(0, 0);
  const offscreenSelected = await offscreen
    .locator(".ya-carousel-dot[aria-current=true]")
    .getAttribute("data-trending");
  await offscreen.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
  );
  await offscreen.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("#ya-market-v4")!.dataset
        .motionPaused === "true",
  );
  assert.ok(
    await offscreen
      .locator("#ya-carousel")
      .evaluate((n) => n.getBoundingClientRect().bottom < 0),
  );
  await offscreen.waitForTimeout(6700);
  assert.equal(
    await offscreen
      .locator(".ya-carousel-dot[aria-current=true]")
      .getAttribute("data-trending"),
    offscreenSelected,
  );
  await offscreen.close();
  checks.synchronizedProgressPauseResumeAndRepeatedCycles = true;
  checks.manualPauseAttentionAndOffscreenHold = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openNative();
  assert.equal(
    await page.getByRole("button", { name: "Play trending rotation" }).count(),
    1,
  );
  assert.equal(
    await page
      .locator("#ya-argument-track")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await page.getByRole("button", { name: "Next trending idea" }).click();
  assert.equal(await page.locator(".ya-carousel-ghost").count(), 0);
  checks.reducedMotionManualNavigation = true;
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
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
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
  assert.equal(await page.locator("#ya-value").textContent(), "—");
  assert.equal(await page.locator("#ya-price").textContent(), "—");
  assert.equal(await page.locator("#ya-chart .ya-linepath").count(), 0);
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
  await page.locator("#ya-follow").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLElement>("#ya-follow")!
        .getAttribute("aria-pressed") === "true",
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
    await plain.locator('#ya-side a[href="/debates/published-debate"]').count(),
    2,
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
  assert.match((await page.locator(".ya-empty").textContent())!, /unavailable/);
  assert.equal(await page.locator("#ya-value").textContent(), "—");
  unavailable = false;
  checks.unavailableNeverSubstitutesConceptData = true;
  tickerTrial = true;
  const tickerPage = await context.newPage();
  tickerPage.on("pageerror", (e) => errors.push(e.message));
  await tickerPage.goto(base + "/home");
  const ticker = tickerPage.locator(".ya-ticker-marquee"),
    tickerTrack = tickerPage.locator(".ya-ticker-track");
  await tickerTrack.waitFor();
  const tickerX = () =>
    tickerTrack.evaluate(
      (n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m41,
    );
  const startX = await tickerX();
  await tickerPage.waitForTimeout(200);
  assert.ok((await tickerX()) < startX);
  const timing = await tickerTrack.evaluate((n) => ({
    duration: n.getAnimations()[0]!.effect!.getTiming().duration as number,
    width: n.firstElementChild!.getBoundingClientRect().width,
    second: n.lastElementChild!.getBoundingClientRect().width,
  }));
  assert.ok(Math.abs(timing.width - timing.second) < 0.01);
  assert.ok(
    timing.duration >= 60000 && (timing.width / timing.duration) * 1000 <= 24.1,
  );
  assert.equal(await ticker.locator("button[data-select]").count(), 3);
  assert.equal(await ticker.locator('[aria-hidden="true"] button').count(), 0);
  await ticker.hover();
  const heldX = await tickerX();
  await tickerPage.waitForTimeout(100);
  assert.ok(Math.abs((await tickerX()) - heldX) < 1);
  await tickerPage.mouse.move(0, 0);
  await tickerPage.waitForTimeout(100);
  assert.ok((await tickerX()) < heldX);
  const lastTickerButton = ticker.locator("button[data-select]").last();
  await lastTickerButton.focus();
  await tickerPage.waitForTimeout(30);
  assert.ok(
    await lastTickerButton.evaluate((n) => {
      const b = n.getBoundingClientRect(),
        p = n.closest(".ya-ticker")!.getBoundingClientRect();
      return b.left >= p.left - 1 && b.right <= p.right + 1;
    }),
  );
  await tickerPage.keyboard.press("Enter");
  assert.equal(
    await tickerPage
      .locator('.ya-carousel-dot[aria-current="true"]')
      .getAttribute("data-trending"),
    "ticker-1",
  );
  await tickerPage.locator("#ya-search").focus();
  await tickerTrack.evaluate((n) => {
    const a = n.getAnimations()[0]!;
    a.currentTime = Number(a.effect!.getTiming().duration) * 0.99;
  });
  await ticker.hover();
  await ticker.locator('[aria-hidden="true"] [data-select]').first().click();
  assert.equal(
    await tickerPage
      .locator('.ya-carousel-dot[aria-current="true"]')
      .getAttribute("data-trending"),
    topic.id,
  );
  for (const width of [1440, 390, 320]) {
    await tickerPage.setViewportSize({ width, height: 1000 });
    assert.ok(
      await tickerPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.ok(
      await ticker.locator(".ya-tick").evaluateAll((nodes) =>
        nodes.every((n) => {
          const s = getComputedStyle(n);
          return s.borderRightWidth === "0px" && s.borderBottomWidth === "0px";
        }),
      ),
    );
  }
  await ticker.screenshot({ path: directory + "/ticker-320.png" });
  await tickerPage.locator("#ya-search").focus();
  await tickerPage.mouse.move(0, 0);
  await tickerPage.locator("#ya-carousel-pause").click();
  assert.equal(
    await tickerTrack.evaluate((n) => n.getAnimations()[0]!.playState),
    "paused",
  );
  await tickerPage.locator("#ya-carousel-pause").click();
  await tickerPage.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  });
  await tickerPage.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("#ya-market-v4")!.dataset
        .tickerPaused === "true",
  );
  await tickerPage.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await tickerTrack.evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  assert.equal(
    await ticker
      .locator('[aria-hidden="true"]')
      .evaluate((n) => getComputedStyle(n).display),
    "none",
  );
  await tickerPage.close();
  tickerTrial = false;
  checks.slowTickerDirectionPauseKeyboardCopiesReducedMotionAndNoSeparators = true;
  assert.deepEqual(errors, []);
  const evidence = {
    result: "PASS",
    referenceComparison: reference
      ? "performed"
      : "not requested; functional checks use checked-in fixtures",
    ...(reference
      ? {
          referenceSha256: createHash("sha256").update(reference).digest("hex"),
          referenceBytes: Buffer.byteLength(reference),
        }
      : {}),
    comparisons,
    checks,
    errors,
    violations,
    scope:
      "Loopback Express application with synthetic public records/auth responses and checked-in concept fixtures; optional original-export comparison is reported separately. No hosted writes or media sessions.",
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
    JSON.stringify(
      { result: "FAIL", checks, errors, violations, comparisons },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
