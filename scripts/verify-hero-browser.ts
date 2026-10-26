import type { Browser } from "playwright-core";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  PublicTopic,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
/* global document, window */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";
import { buildReplayThumbnail } from "../dist/features/media/replay-thumbnail.js";

// This component gate uses home/live/debate listing routes. The omitted topic,
// profile and featured-debate methods are not called by these fixture routes.
type DiscoveryOptions = Parameters<typeof createDiscoveryRouter>[0];
type HeroFixtureOptions = Omit<DiscoveryOptions, "discovery"> & {
  discovery: Pick<
    DiscoveryOptions["discovery"],
    "listWatchableDebates" | "listDebates" | "listTopics" | "getDebate"
  >;
};
type CreateHeroFixtureRouter = (
  options: HeroFixtureOptions,
) => ReturnType<typeof createDiscoveryRouter>;

// Component trial only: synthetic local media, no hosted target or account writes.
const directory =
  process.env.LIVE_ARTIFACT_DIR ?? "/private/tmp/yaparena-live-feed-browser";
await mkdir(directory, { recursive: true });
const fixtures = await mkdtemp(join(tmpdir(), "yaparena-hero-fixture-"));
let browser: Browser | undefined, server: Server | undefined;
try {
  const videoPath = join(fixtures, "preview.webm");
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=960x540:rate=12",
    "-t",
    "8",
    "-c:v",
    "libvpx",
    "-b:v",
    "300k",
    "-an",
    videoPath,
  ]);
  const thumbnailPath = join(fixtures, "thumbnail.jpg");
  await buildReplayThumbnail(videoPath, thumbnailPath);
  const topic: PublicTopic = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "cities",
    title: "Cities & society",
    summary: "Synthetic local interface fixture.",
    sideALabel: "People first",
    sideBLabel: "Keep cars moving",
    isDemo: false,
    createdAt: new Date(),
  };
  const debate: PublicDebate = {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "the-walkable-city",
    proposition: "Should cities prioritize walkability over cars?",
    status: "replay",
    rulesVersion: "prototype-media-1",
    scheduledAt: null,
    liveStartedAt: new Date(),
    liveEndedAt: new Date(),
    isDemo: false,
    createdAt: new Date(),
    topic,
    speakerA: { handle: "alex", displayName: "Alex Rivera" },
    speakerB: { handle: "morgan", displayName: "Morgan Lee" },
    sponsor: null,
  };
  const catalog = [
    debate,
    ...[
      "Should public transit be free?",
      "Can technology make cities greener?",
      "Should housing be a public service?",
      "Does remote work strengthen communities?",
      "Should cities invest more in public spaces?",
    ].map((proposition, index) => ({
      ...debate,
      id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
      slug: `synthetic-debate-${index + 1}`,
      proposition,
    })),
  ];
  const list = <T>(items: T[]) => ({
    items,
    pagination: { limit: 3, offset: 0, hasMore: false },
  });
  let grants = 0,
    deny = false;
  const app = express();
  app.use(
    "/assets",
    express.static(new URL("../public/", import.meta.url).pathname),
  );
  app.get("/fixture.webm", (_r, s) => s.sendFile(videoPath));
  app.get("/api/media/events/:id/thumbnail", (_r, s) =>
    s.sendFile(thumbnailPath),
  );
  app.get("/api/media/events/:id/replay", (_r, s) => {
    grants++;
    if (deny) return s.status(404).json({ error: "unavailable" });
    return s.json({
      type: "file",
      url: "/fixture.webm",
      expiresIn: 300,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
  });
  app.get("/api/media/events/:id", (_r, s) =>
    s.json({
      eventStatus: "replay",
      state: { state: "ended", recordingStatus: "ready" },
    }),
  );
  app.use(
    (createDiscoveryRouter as CreateHeroFixtureRouter)({
      discovery: {
        listWatchableDebates: async () => catalog,
        listDebates: async () => list([debate]),
        listTopics: async () => list([topic]),
        getDebate: async (slug) =>
          catalog.find((debate) => debate.slug === slug) ?? null,
      },
      mediaEnabled: true,
      applicationOrigin: "http://localhost",
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const checks: Record<string, boolean> = {},
    errors: string[] = [],
    requests: string[] = [];
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "no-preference",
  });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() =>
    window.localStorage.setItem("yaparena-measurement-declined", "1"),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.mouse.move(0, 0);
  await page.goto(base);
  assert.equal(await page.locator("h1").textContent(), "Yap Arena");
  assert.equal(await page.locator("[data-debate-preview]").count(), 0);
  assert.equal(
    requests.some((url) => url.includes("/api/media/")),
    false,
  );
  await page.getByRole("link", { name: "Watch debates", exact: true }).click();
  await page.waitForURL("**/live");
  checks.homeAndLiveNavigation = true;
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "true",
  );
  assert.equal(await page.locator("h1").textContent(), debate.proposition);
  assert.equal(
    await page
      .locator("[data-featured-preview] [data-preview-video]")
      .evaluate(
        (video: HTMLVideoElement) =>
          video.muted && !video.paused && video.currentTime >= 0,
      ),
    true,
  );
  assert.equal(
    requests.some((url) =>
      /hero-live\.bundle|media\.bundle|replay\.bundle/.test(url),
    ),
    false,
    "native replay does not load a live SDK, full watching client or HLS library",
  );
  checks.mutedAutoplayAndDeferredTransport = true;
  await page.waitForFunction(
    () =>
      Number(
        window.getComputedStyle(
          document.querySelector<HTMLElement>(
            "[data-featured-preview] [data-preview-media]",
          )!,
        ).opacity,
      ) === 1,
  );
  await page.screenshot({ path: directory + "/desktop.png", fullPage: true });
  await page
    .locator("[data-featured-preview]")
    .getByRole("button", { name: "Pause video preview" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>(
        "[data-featured-preview] [data-preview-thumbnail]",
      )!.naturalWidth > 0,
  );
  await page.waitForFunction(
    () =>
      Number(
        window.getComputedStyle(
          document.querySelector<HTMLElement>(
            "[data-featured-preview] [data-preview-media]",
          )!,
        ).opacity,
      ) === 0,
  );
  assert.equal(await page.locator(".arena-featured-backdrop").count(), 0);
  assert.match(
    (await page
      .locator("[data-featured-preview] [data-preview-thumbnail]")
      .getAttribute("src"))!,
    new RegExp(`/events/${debate.id}/thumbnail`),
  );
  await page.screenshot({ path: directory + "/thumbnail.png", fullPage: true });
  checks.pausedPreviewShowsOwnRecordingThumbnail = true;
  assert.equal(
    await page
      .locator("[data-featured-preview] [data-preview-video]")
      .evaluate(
        (video: HTMLVideoElement) => video.paused && !video.getAttribute("src"),
      ),
    true,
  );
  await page
    .locator("[data-featured-preview]")
    .getByRole("button", { name: "Play video preview" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "true",
  );
  await page.locator(".site-footer").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "false",
  );
  const stopped = grants;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "true",
  );
  assert.ok(grants > stopped);
  checks.pauseAndOffscreenRelease = true;
  await page.locator("[data-featured-preview] [data-preview-open]").hover();
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLElement>("[data-featured-preview]")!
      .classList.contains("is-entering"),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".is-entering").count(), 0);
  await page.mouse.move(0, 0);
  await page.locator("[data-featured-preview] [data-preview-open]").hover();
  await page.mouse.move(0, 0);
  assert.equal(await page.locator(".is-entering").count(), 0);
  checks.hoverCancellation = true;
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  );
  assert.deepEqual(violations, []);
  checks.axeNoViolations = true;
  // Preserve the old card grid geometry while exercising actual video handoff.
  const cards = page.locator("[data-card-preview]");
  assert.equal(await cards.count(), 6);
  await page.evaluate(() => {
    window.scrollTo(
      0,
      document
        .querySelector<HTMLVideoElement>(".arena-video-grid")!
        .getBoundingClientRect().top +
        window.scrollY -
        120,
    );
  });
  await cards.first().locator("[data-preview-video]").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-card-preview]")!.dataset
        .playing === "true",
  );
  const grid = await page.locator(".arena-video-grid").evaluate((node) => ({
    columns: window.getComputedStyle(node).gridTemplateColumns.split(" ")
      .length,
    gap: window.getComputedStyle(node).gap,
    height: node.firstElementChild!.getBoundingClientRect().height,
    video: (() => {
      const rect = node
        .querySelector<HTMLVideoElement>("video")!
        .getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })(),
    width: node.firstElementChild!.getBoundingClientRect().width,
  }));
  assert.equal(grid.columns, 3);
  assert.equal(grid.gap, "14px");
  assert.equal(grid.height, 320);
  assert.equal(grid.video.height, grid.height - 2);
  assert.ok(Math.abs(grid.video.width - (grid.width - 2)) < 1);
  await cards.nth(1).locator("[data-preview-open]").hover();
  await page.waitForFunction(
    () =>
      document.querySelectorAll<HTMLElement>("[data-card-preview]")[1]!.dataset
        .playing === "true",
  );
  assert.equal(
    await page.locator('[data-debate-preview][data-active="true"]').count(),
    1,
  );
  assert.equal(
    await cards
      .first()
      .locator("video")
      .evaluate(
        (video: HTMLVideoElement) => video.paused && !video.getAttribute("src"),
      ),
    true,
  );
  await cards
    .nth(1)
    .locator("video")
    .evaluate((video: HTMLVideoElement) => {
      video.currentTime = video.duration - 0.3;
    });
  await page.waitForFunction(() => {
    const video = document.querySelectorAll<HTMLVideoElement>(
      "[data-card-preview] video",
    )[1]!;
    return (
      video.currentTime < 2 &&
      video.currentTime > 0 &&
      !video.paused &&
      video.loop
    );
  });
  checks.visibleVideoGridAndReplayLoop = true;
  await cards.nth(2).locator("[data-preview-open]").focus();
  await page.waitForFunction(
    () =>
      document.querySelectorAll<HTMLElement>("[data-card-preview]")[2]!.dataset
        .playing === "true",
  );
  assert.equal(
    await page.locator('[data-debate-preview][data-active="true"]').count(),
    1,
  );
  checks.hoverAndKeyboardTransferSinglePreview = true;
  await page.waitForFunction(
    () =>
      Number(
        window.getComputedStyle(
          document.querySelectorAll<HTMLElement>(
            "[data-card-preview] [data-preview-media]",
          )[2]!,
        ).opacity,
      ) === 1,
  );
  await page.screenshot({ path: directory + "/grid.png" });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(
    await page.locator('[data-debate-preview][data-active="true"]').count(),
    0,
  );
  assert.equal(
    await cards
      .locator("video")
      .evaluateAll((videos: HTMLVideoElement[]) =>
        videos.every((v) => v.paused && !v.getAttribute("src")),
      ),
    true,
  );
  checks.hiddenTabReleasesAllVideo = true;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    (document.activeElement as HTMLElement).blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.mouse.move(0, 0);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "true",
  );
  // Let the programmatic scroll finish dispatching its cancellation event.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
  await page.locator("[data-featured-preview] [data-preview-open]").hover();
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLElement>("[data-featured-preview]")!
        .classList.contains("is-entering"),
    null,
    { timeout: 5000 },
  );
  await page
    .locator("[data-featured-preview] video")
    .evaluate((video: HTMLVideoElement) =>
      video.dispatchEvent(new Event("waiting")),
    );
  assert.equal(await page.locator(".is-entering").count(), 0);
  await page
    .locator("[data-featured-preview] video")
    .evaluate((video: HTMLVideoElement) =>
      video.dispatchEvent(new Event("playing")),
    );
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLElement>("[data-featured-preview]")!
      .classList.contains("is-entering"),
  );
  checks.bufferingRestartsHoverCountdown = true;
  await page.waitForURL("**/debates/the-walkable-city");
  assert.equal(await page.locator("[data-media-event]").count(), 1);
  checks.sustainedHoverEntersWatchingInterface = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const beforeReduced = grants;
  await page.goto(base + "/live");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>(
        "[data-featured-preview] [data-preview-status]",
      )!.textContent === "Preview paused",
  );
  await page
    .locator("[data-featured-preview]")
    .getByRole("button", { name: "Play video preview" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-featured-preview]")!.dataset
        .playing === "true",
  );
  assert.equal(grants, beforeReduced + 1);
  await page.locator("[data-featured-preview] [data-preview-open]").hover();
  assert.equal(await page.locator(".is-entering").count(), 0);
  checks.reducedMotionUsesExplicitPlay = true;
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
  await page.locator("[data-featured-preview] [data-preview-open]").click();
  await page.waitForURL("**/debates/the-walkable-city");
  checks.mobileAndClickEntry = true;
  const saved = await context.newPage();
  await saved.addInitScript(() =>
    Object.defineProperty(window.navigator, "connection", {
      value: { saveData: true, effectiveType: "4g", addEventListener() {} },
      configurable: true,
    }),
  );
  // Count only grants this saved /live tab requests. The debate page the
  // other tab just opened may request its own grant at any moment, which a
  // shared server counter would wrongly attribute to the saved tab.
  let savedGrants = 0;
  saved.on("request", (request) => {
    if (
      /^\/api\/media\/events\/[^/]+\/replay$/.test(
        new URL(request.url()).pathname,
      )
    )
      savedGrants++;
  });
  await saved.goto(base + "/live");
  await saved
    .locator("[data-featured-preview]")
    .getByRole("button", { name: "Play video preview" })
    .waitFor();
  await saved.evaluate(
    () => new Promise((resolve) => window.setTimeout(resolve, 2000)),
  );
  assert.equal(savedGrants, 0);
  assert.equal(
    await saved
      .locator("[data-featured-preview] [data-preview-thumbnail]")
      .evaluate((image: HTMLImageElement) => image.naturalWidth > 0),
    true,
  );
  checks.saveDataSkipsAutoplay = true;
  deny = true;
  await saved
    .locator("[data-featured-preview]")
    .getByRole("button", { name: "Play video preview" })
    .click();
  await saved.waitForFunction(
    () =>
      document.querySelector<HTMLElement>(
        "[data-featured-preview] [data-preview-status]",
      )!.textContent === "Preview unavailable",
  );
  assert.equal(await saved.locator("h1").textContent(), debate.proposition);
  checks.deniedPreviewKeepsUsableHero = true;
  assert.deepEqual(errors, []);
  await writeFile(
    directory + "/evidence.json",
    JSON.stringify(
      {
        result: "PASS",
        checks,
        errors,
        scope:
          "Loopback component trial with synthetic WebM; real LiveKit/HLS delivery and devices are not assessed.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result: "PASS", checks }));
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
  }
  await rm(fixtures, { recursive: true, force: true });
}
