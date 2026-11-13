import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AddressInfo } from "node:net";
import type {
  PublicTopic,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
import type { EndorsementHistoryPoint } from "../src/features/endorsement/types.ts";
import type { TopicEndorsementView } from "../src/features/endorsement/topic-page.ts";
import type { WaitingTopic } from "../src/features/discovery/home-list-model.ts";
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import express from "express";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";

// The home as a debate list (first-run plan PR 6) and the endorsement chart
// that moved to topic pages. These component fixtures exercise discovery
// rendering, the public waiting list, the public turn windows and the mocked
// auth, wallet and follow routes above the application. Services omitted here
// are only captured by unrelated route handlers; no fixture calls those
// methods. Keep each supplied method tied to its production signature without
// inventing implementations for unused fixture services.
type ApplicationOptions = Parameters<typeof createApp>[0];
type FixtureServices =
  | "discovery"
  | "identity"
  | "matching"
  | "matchmaking"
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
  matchmaking: Pick<
    NonNullable<ApplicationOptions["matchmaking"]>,
    "waitingTopics"
  >;
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
const HOUR = 3_600_000;
const started = Date.now();
const at = (hours: number) => new Date(started + hours * HOUR);
const topic = (slug: string, title: string, index: number): PublicTopic => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  slug,
  title,
  summary: "Synthetic local integration fixture.",
  sideALabel: "Support",
  sideBLabel: "Oppose",
  category: "other",
  isDemo: false,
  createdAt: new Date("2026-10-01"),
});
const idea = topic("published-idea", "Published public idea", 1);
const work = topic("future-of-work", "The future of work", 2);
let count = 0;
const debate = (
  on: PublicTopic,
  proposition: string,
  fields: Partial<PublicDebate>,
): PublicDebate => {
  count++;
  return {
    id: `22222222-2222-4222-8222-${String(count).padStart(12, "0")}`,
    slug: `published-debate-${count}`,
    proposition,
    status: "replay",
    rulesVersion: "prototype-media-1",
    scheduledAt: null,
    liveStartedAt: null,
    liveEndedAt: null,
    isDemo: false,
    createdAt: new Date("2026-10-01"),
    topic: {
      slug: on.slug,
      title: on.title,
      sideALabel: on.sideALabel,
      sideBLabel: on.sideBLabel,
    },
    speakerA: {
      handle: "alex",
      displayName: "Alex Public",
      avatarId: "yap-owl",
    },
    speakerB: {
      handle: "morgan",
      displayName: "Morgan Public",
      avatarId: "yap-frog",
    },
    sponsor: null,
    ...fields,
  };
};
const liveDebate = debate(idea, "Should the idea go live?", {
  status: "live",
  liveStartedAt: at(-0.2),
});
const otherLive = debate(work, "Should the four-day week become standard?", {
  status: "live",
  liveStartedAt: at(-0.1),
});
const soon = debate(work, "Can a shorter week work for everyone?", {
  status: "scheduled",
  scheduledAt: at(2.25),
});
// Staging showed "Starts Oct 27" long after Oct 27; neither this nor a debate
// more than a day away is on the home.
const pastStart = debate(idea, "A start that already passed", {
  status: "scheduled",
  scheduledAt: new Date("2026-10-27T17:00:00Z"),
});
const later = debate(idea, "A debate in three days", {
  status: "scheduled",
  scheduledAt: at(72),
});
const answerable = debate(idea, "A replay still taking answers", {
  liveStartedAt: at(-27),
  liveEndedAt: at(-26),
});
// Within 120 hours, but its turn windows have no open one: finished.
const closedEarly = debate(work, "A replay whose answers closed", {
  liveStartedAt: at(-51),
  liveEndedAt: at(-50),
});
const finished = debate(idea, "A finished debate", {
  status: "finalized",
  liveStartedAt: at(-201),
  liveEndedAt: at(-200),
});
const waiting: WaitingTopic[] = [
  {
    slug: work.slug,
    title: work.title,
    sideALabel: work.sideALabel,
    sideBLabel: work.sideBLabel,
    waiting: { sideA: 1, sideB: 0 },
  },
];
const scenarios = {
  busy: [
    liveDebate,
    otherLive,
    soon,
    pastStart,
    later,
    answerable,
    closedEarly,
    finished,
  ],
  quiet: [answerable, finished],
  empty: [],
};
let scenario: keyof typeof scenarios = "busy";
const visible = () => scenarios[scenario];
// Decision 0015: twelve revealed turns of two debates for the topic page's
// last-answer figure and its history, the last four revealed together.
const switching = {
  multiAnswerAccounts: 412,
  switchers: 74,
  stayed: 49,
  cameBack: 25,
  pairs: { within: 300, between: 200 },
  switches: { within: 12, between: 18 },
  toYes: 18,
  toNo: 12,
};
const point = (index: number): EndorsementHistoryPoint => {
  const late = index >= 8;
  const accounts = 100 + index * 40;
  return {
    id: String(index + 1),
    // The earlier debate's turns end two days before the latest reveal.
    revealedAt: new Date(
      started - (late ? 1 : 48 + (7 - index) * 3) * HOUR,
    ).toISOString(),
    turnNumber: late ? index - 7 : index + 1,
    debate: late
      ? { slug: answerable.slug, title: answerable.proposition }
      : { slug: "earlier-debate", title: "An earlier debate on this idea" },
    yes: Math.round(accounts * (0.5 + 0.08 * Math.sin(index / 2))),
    accounts,
  };
};
const history = Array.from({ length: 12 }, (_, index) => point(index));
const endorsement: TopicEndorsementView = {
  figure: {
    yes: history.at(-1)!.yes,
    accounts: history.at(-1)!.accounts,
    switching,
    revealedAt: history.at(-1)!.revealedAt,
    lastDebate: {
      slug: answerable.slug,
      title: answerable.proposition,
      liveEndedAt: new Date(started - 2 * HOUR).toISOString(),
    },
    debatesCounted: 2,
  },
  history,
  debates: [
    {
      debateId: answerable.id,
      throughTurn: 4,
      yes: 52,
      accounts: 140,
      switching,
    },
  ],
  sideAIsYes: true,
};
const list = <T>(items: T[]) => ({
  items,
  pagination: { limit: 12, offset: 0, hasMore: false },
});
let signedIn = false,
  unavailable = false;
const follows: string[] = [];
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
app.get("/api/me/follows", (_r, s) =>
  signedIn
    ? s.json({
        items: follows.map((slug, index) => ({
          id: String(index),
          targetType: "topic",
          slug,
          title: slug,
          createdAt: new Date("2026-10-01"),
        })),
        pagination: { limit: 50, offset: 0, hasMore: false },
      })
    : s.status(401).json({ error: "authentication required" }),
);
app.get("/api/me/follows/topics/:slug", (r, s) =>
  signedIn
    ? s.json({ following: follows.includes(r.params.slug) })
    : s.status(401).json({ error: "authentication required" }),
);
// Each debate's public turn windows: open while a replay takes answers,
// revealed with a share afterwards.
app.get("/api/public/debates/:id/windows", (r, s) => {
  const found = visible().find((d) => d.id === r.params.id);
  if (!found?.liveEndedAt)
    return s.status(404).json({ error: "debate not found" });
  const open = found.id === answerable.id;
  return s.json({
    debateId: found.id,
    eventStatus: found.status,
    serverNow: new Date().toISOString(),
    revealMode: "five_day",
    revealAt: new Date(found.liveEndedAt.getTime() + 120 * HOUR).toISOString(),
    windows: [1, 2, 3, 4, 5, 6].map((turnNumber) => ({
      id: `${found.id}-${turnNumber}`,
      turnNumber,
      side: turnNumber % 2 ? "A" : "B",
      state: open ? "open" : "settled",
      pricing: open
        ? null
        : { share: { n: String(48 + turnNumber * 2), d: "100" } },
    })),
  });
});
app.use(
  (createApp as CreateHomepageFixtureApp)({
    discovery: {
      listTopics: async () => {
        if (unavailable) throw Error("local fixture unavailable");
        return list([idea, work]);
      },
      listWatchableDebates: async () =>
        visible().filter((d) => d.status === "live"),
      listDebates: async ({ status, topicSlug }) => {
        if (unavailable) throw Error("local fixture unavailable");
        return list(
          visible().filter(
            (d) =>
              (!status || d.status === status) &&
              (!topicSlug || d.topic.slug === topicSlug),
          ),
        );
      },
      getDebate: async (slug) => visible().find((d) => d.slug === slug) ?? null,
      getTopic: async (slug) =>
        [idea, work].find((t) => t.slug === slug) ?? null,
    },
    identity: {},
    matching: {},
    matchmaking: {
      waitingTopics: async () => (scenario === "empty" ? [] : waiting),
    },
    // Configure the existing media boundary only to select its public playable list.
    // No provider connection is used by the home.
    media: {},
    mediaProvider: {
      publicUrl: "wss://media.example.test",
      playbackOrigin: "https://media.example.test",
      playbackOrigins: ["https://media.example.test"],
    },
    messages: { isReady: async () => {} },
    // The idea has revealed turns; the other topic has none yet.
    topicEndorsement: {
      topic: async (id) =>
        id === idea.id
          ? endorsement
          : { figure: null, history: [], debates: [], sideAIsYes: true },
    },
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
  async function newContext(options: Parameters<Browser["newContext"]>[0]) {
    const context = await browser!.newContext(options);
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
    return context;
  }
  const context = await newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  // The browser's second render (follows, waiting list, turn windows) is done
  // once the finished debate shows its result.
  async function openHome(target: Page = page, name = scenario) {
    scenario = name;
    await target.goto(base + "/home");
    await target.locator("[data-home-feed]").waitFor();
    if (name !== "empty")
      await target.waitForFunction(() =>
        document
          .querySelector("[data-home-feed]")!
          .textContent.includes("said yes"),
      );
  }
  const noOverflow = (scope: Page) =>
    scope.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
  const text = (selector: string, target: Page = page) =>
    target
      .locator(selector)
      .evaluateAll((nodes) =>
        nodes.map((n) =>
          (n as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        ),
      );
  // Section titles by their real spelling (the visible Dydema capitals show
  // U as V).
  const titles = (target: Page = page) =>
    target
      .locator(".home-section-title > .sr-only")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent));
  async function axeCheck(target: Page) {
    await target.evaluate(axe.source);
    const found = await target.evaluate(async () =>
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
    violations.push(...found);
  }

  for (const width of [1440, 1920, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await openHome();
    assert.ok(await noOverflow(page), `${width}px: no horizontal overflow`);
    await page.screenshot({
      path: `${directory}/home-${width}.png`,
      fullPage: true,
    });
  }
  checks.responsiveScreenshots = true;

  await page.setViewportSize({ width: 1440, height: 1100 });
  await openHome();
  // Signed out: the intro, the chips and the lists, in the confirmed order.
  assert.equal(await page.locator("[data-home-intro]").isVisible(), true);
  assert.deepEqual(await text("[data-home-filter]"), [
    "All",
    "Soon · 1",
    "Replays · 3",
  ]);
  assert.deepEqual(await titles(), [
    "Live now",
    "Starting soon",
    "Someone's waiting",
    "Replays you can still answer",
    "Finished debates",
  ]);
  const top = page.locator(".home-top .home-feature");
  assert.equal(await top.getAttribute("href"), `/debates/${liveDebate.slug}`);
  assert.match((await top.innerText()).replace(/\s+/g, " "), /LIVE .*Watch$/);
  assert.equal(await page.locator(".btn-primary:visible").count(), 1);
  assert.equal(
    await page
      .locator(`.home-top .home-row[href="/debates/${otherLive.slug}"]`)
      .count(),
    1,
  );
  const soonRows = await text('[data-home-section="soon"] .home-row');
  assert.equal(soonRows.length, 1);
  assert.match(
    soonRows[0]!,
    /Can a shorter week work for everyone\? .* in 2 h 1[45]$/,
  );
  const feed = (await page.locator("[data-home-feed]").innerText()).replace(
    /\s+/g,
    " ",
  );
  for (const hidden of [pastStart.proposition, later.proposition, "Oct 27"])
    assert.ok(!feed.includes(hidden), `${hidden} is not on the home`);
  assert.doesNotMatch(feed, /voted|winner/i);
  const wait = page.locator('[data-home-section="waiting"] .home-row');
  assert.equal(
    await wait.getAttribute("href"),
    `/topics/${work.slug}#queue-side-b`,
  );
  assert.match(
    (await wait.innerText()).replace(/\s+/g, " "),
    /The future of work 1 person waiting to argue Support Take the other side: Oppose Argue against/,
  );
  assert.deepEqual(
    await text('[data-home-section="replays"] .home-row-meta + .home-row-meta'),
    ["Answers close in 3 days"],
  );
  assert.match(
    await page.locator('[data-home-section="replays"] .home-row').innerText(),
    /Answer$/,
  );
  // The replay whose turn windows have no open one is finished, with its result.
  assert.deepEqual(
    await text(
      '[data-home-section="finished"] .home-row-meta + .home-row-meta',
    ),
    [
      "Ended 2 days ago · Turn 6: 60% said yes",
      "Ended 8 days ago · Turn 6: 60% said yes",
    ],
  );
  assert.equal(
    requests.filter((u) => u.endsWith("/windows")).length >= 3,
    true,
  );
  assert.equal(
    requests.some((u) =>
      /viewer-token|\/replay\?|livekit|media\.bundle|replay\.bundle|homepage\.bundle|\/api\/public\/homepage/.test(
        u,
      ),
    ),
    false,
  );
  checks.busyHomeListsInOrderWithResultsAndWaiting = true;

  // The chips filter the list and say what they show.
  await page.getByRole("button", { name: "Soon · 1" }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Soon · 1" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(await titles(), ["Starting soon"]);
  assert.equal(
    await page.locator("[data-home-status]").textContent(),
    "Showing Soon · 1.",
  );
  await page.getByRole("button", { name: "Replays · 3" }).click();
  assert.deepEqual(await titles(), [
    "Replays you can still answer",
    "Finished debates",
  ]);
  await page.getByRole("button", { name: "All", exact: true }).click();
  assert.equal(await page.locator(".home-top").count(), 1);
  checks.chipsFilterSoonAndReplays = true;

  // The intro closes, gives focus to the chips and stays closed.
  await page.getByRole("button", { name: "Close the introduction" }).click();
  assert.equal(await page.locator("[data-home-intro]").isVisible(), false);
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.homeFilter,
    ),
    "all",
  );
  await openHome();
  assert.equal(await page.locator("[data-home-intro]").isVisible(), false);
  await page.evaluate(() =>
    window.localStorage.removeItem("yaparena-home-intro"),
  );
  checks.introClosesAndStaysClosed = true;

  // Signed in, following a topic: its soon debate leads, the live debates
  // follow as "Live in other topics", and the intro is gone.
  signedIn = true;
  follows.push(work.slug);
  // The live debate on the followed topic leads.
  await openHome();
  assert.equal(
    await page.locator(".home-top .home-feature").getAttribute("href"),
    `/debates/${otherLive.slug}`,
  );
  assert.deepEqual((await titles()).slice(0, 2), [
    "Live in your topics",
    "Live in other topics",
  ]);
  assert.equal(await page.locator("[data-home-intro]").isVisible(), false);
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLElement>("[data-header-balance]")!
      .textContent.includes("1234.00"),
  );
  follows.length = 0;
  follows.push(idea.slug);
  scenario = "quiet";
  await openHome(page, "quiet");
  assert.match(
    await page.locator(".home-quiet").innerText(),
    /^Nothing live right now\. Live debates show here first\.$/,
  );
  assert.equal((await titles())[0], "From your topics");
  signedIn = false;
  follows.length = 0;
  checks.followedTopicsLeadAndLiveIsNeverHidden = true;

  // A quiet day: nothing live, so the replay still taking answers leads.
  await openHome(page, "quiet");
  assert.deepEqual((await titles()).slice(0, 2), [
    "You can still answer",
    "Someone's waiting",
  ]);
  assert.match(
    await page.locator(".home-top .home-feature").innerText(),
    /Answer$/,
  );
  assert.equal(await page.locator("[data-home-feed] svg.ya-chart").count(), 0);
  // Nothing at all: start the first debate, never an empty card or chart.
  await openHome(page, "empty");
  assert.deepEqual(await titles(), ["Start the first debate"]);
  assert.match(
    (await page.locator(".home-top .home-feature").innerText()).replace(
      /\s+/g,
      " ",
    ),
    /^Open a topic and queue on a side\. .* Pick a topic$/,
  );
  assert.equal(
    await page.locator(".home-top a").getAttribute("href"),
    "/topics",
  );
  checks.quietAndEmptyDaysFillTheTop = true;

  // The top slot and its button fit the first screen on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page, "busy");
  assert.ok(await noOverflow(page));
  const button = (await page.locator(".home-top .btn-primary").boundingBox())!;
  assert.ok(
    button.y + button.height <= 787,
    `390: Watch ends at ${button.y + button.height}`,
  );
  await axeCheck(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openHome();
  await axeCheck(page);
  assert.deepEqual(violations, []);
  assert.deepEqual(await page.evaluate(() => window.homeCsp), []);
  checks.firstScreenAccessibilityAndCsp = true;

  // Reduced motion stops the live pixel.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHome();
  assert.equal(
    await page
      .locator(".home-top .live-pixel")
      .first()
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.reducedMotion = true;

  // Decision 0015: the topic page's last-answer figure and its history after
  // each revealed turn, inspected like the home's chart.
  async function openTopic(target: Page) {
    await target.goto(`${base}/topics/${idea.slug}`);
    await target.locator("#ya-chart .ya-linepath").waitFor();
  }
  await openTopic(page);
  assert.match(
    (await page.locator(".topic-figure-lead").textContent())!,
    /^Of [\d,]+ accounts, \d+% last answered Yes \(.+\)\.$/,
  );
  assert.match(
    (await page.locator(".topic-changes").textContent())!,
    /412 accounts answered more than once/,
  );
  assert.equal(await page.locator(".dcard-final").count(), 1);
  assert.equal(
    await page.locator("#ya-chart").getAttribute("data-latest-point"),
    "12",
  );
  const chart = page.locator("#ya-chart");
  await chart.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    document.querySelector("#ya-chart")!.classList.contains("is-drawing"),
  );
  await page.waitForFunction(
    () =>
      !document.querySelector("#ya-chart")!.classList.contains("is-drawing"),
  );
  await page.screenshot({
    path: `${directory}/topic-1440.png`,
    fullPage: true,
  });
  const rect = (await chart.boundingBox())!;
  const before = requests.length;
  const latest = await page.locator("#ya-legend").textContent();
  // The marker snaps to the nearest point: the fifth of twelve at 37%.
  await chart.hover({ position: { x: rect.width * 0.37, y: 70 } });
  await page.waitForFunction(() =>
    document.querySelector("#ya-chart")!.classList.contains("is-scrubbing"),
  );
  assert.match(
    (await page.locator("#ya-chart-tooltip").textContent())!,
    /^[A-Z][a-z]{2} \d{1,2} · Turn 5 · An earlier debate on this idea\d+% Yes · [\d,]+ accounts$/,
  );
  assert.match(
    (await page.locator("#ya-metric-label").textContent())!,
    /^[A-Z][a-z]{2} \d{1,2} · Turn 5 · /,
  );
  assert.notEqual(await page.locator("#ya-legend").textContent(), latest);
  await page.locator(".topic-history").screenshot({
    path: `${directory}/topic-inspect-1440.png`,
  });
  assert.equal(requests.length, before);
  await page.mouse.move(0, 0);
  await page.waitForFunction(
    () =>
      !document.querySelector("#ya-chart")!.classList.contains("is-scrubbing"),
  );
  assert.equal(await page.locator("#ya-legend").textContent(), latest);
  const slider = page.getByRole("slider", {
    name: "Explore the topic figure's history",
  });
  await slider.focus();
  await slider.press("ArrowLeft");
  assert.match(
    (await slider.getAttribute("aria-valuetext"))!,
    /· Turn 3 · .+: \d+% Yes · [\d,]+ accounts$/,
  );
  await slider.press("Escape");
  assert.equal(await page.locator("#ya-legend").textContent(), latest);
  assert.equal(await page.getByRole("button", { name: "Price" }).count(), 0);
  // 1D keeps the latest debate's four points, revealed together.
  await page.getByRole("button", { name: "1D", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "All", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await slider.focus();
  assert.equal(await slider.getAttribute("max"), "3");
  await slider.press("Escape");
  await axeCheck(page);
  assert.deepEqual(violations, []);
  // A topic without revealed turns says when its figure starts; no chart.
  await page.goto(`${base}/topics/${work.slug}`);
  assert.equal(await page.locator("[data-topic-history]").count(), 0);
  assert.match(
    (await page.locator("[data-topic-endorsement]").textContent())!,
    /The figure starts when a debate's first turn is revealed/,
  );
  await page.screenshot({
    path: `${directory}/topic-empty-1440.png`,
    fullPage: true,
  });
  checks.topicPageFigureChartPointerKeyboardAndRanges = true;

  const touchContext = await newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const phone = await touchContext.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await openTopic(phone);
  assert.ok(await noOverflow(phone));
  assert.equal(
    await phone
      .locator("#ya-chart .ya-endpoint-pulse")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await phone.locator("#ya-chart").scrollIntoViewIfNeeded();
  const phoneChart = (await phone.locator("#ya-chart").boundingBox())!;
  await phone.touchscreen.tap(
    phoneChart.x + phoneChart.width * 0.4,
    phoneChart.y + 50,
  );
  await phone.waitForFunction(() =>
    document.querySelector("#ya-chart")!.classList.contains("is-scrubbing"),
  );
  await phone.locator(".topic-copy h1").tap();
  await phone.waitForFunction(
    () =>
      !document.querySelector("#ya-chart")!.classList.contains("is-scrubbing"),
  );
  await phone.screenshot({
    path: `${directory}/topic-390.png`,
    fullPage: true,
  });
  await phone.goto(`${base}/topics/${work.slug}`);
  assert.ok(await noOverflow(phone));
  await phone.screenshot({
    path: `${directory}/topic-empty-390.png`,
    fullPage: true,
  });
  await phone.setViewportSize({ width: 768, height: 1024 });
  await openTopic(phone);
  assert.ok(await noOverflow(phone));
  await phone.screenshot({
    path: `${directory}/topic-768.png`,
    fullPage: true,
  });
  await phone.goto(`${base}/topics/${work.slug}`);
  await phone.screenshot({
    path: `${directory}/topic-empty-768.png`,
    fullPage: true,
  });
  await phone.setViewportSize({ width: 390, height: 844 });
  await openHome(phone, "busy");
  assert.ok(await noOverflow(phone));
  await touchContext.close();
  checks.topicPageTouchInspectionAndPhones = true;

  // Without JavaScript the server's list still links every debate.
  const nojs: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 1100 },
    }),
    plain = await nojs.newPage();
  scenario = "busy";
  await plain.goto(base + "/home");
  assert.equal(await plain.locator("h1").textContent(), "Yap Arena");
  assert.equal(
    await plain
      .locator(`a.home-row[href="/debates/${answerable.slug}"]`)
      .count(),
    1,
  );
  await plain.locator(".home-top .home-feature").click();
  assert.ok(plain.url().endsWith(`/debates/${liveDebate.slug}`));
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

  unavailable = true;
  const response = await page.goto(base + "/home");
  assert.equal(response!.status(), 503);
  assert.match(
    (await page.locator(".home-state").textContent())!,
    /unavailable/,
  );
  assert.equal(await page.locator("[data-home-feed]").count(), 0);
  assert.equal(await page.locator(".site-footer").count(), 1);
  unavailable = false;
  checks.unavailableShowsOneState = true;
  assert.deepEqual(errors, []);
  const evidence = {
    result: "PASS",
    checks,
    errors,
    violations,
    scope:
      "Loopback Express application with synthetic public records, waiting list, turn windows and auth responses. No hosted writes or media sessions.",
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
