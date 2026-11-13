import type { BrowserContext, Page, Route } from "playwright-core";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  PublicDebate,
  PublicTopic,
} from "../src/features/discovery/public-types.ts";
/* global document, window, HTMLVideoElement */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import axe from "axe-core";
import { chromium, type Browser } from "playwright-core";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";

// Direction BC1's replay board in Chrome: the turn timeline under the
// video and Results by turn under the scoreboard, and on phones the rows
// and the price draw card (first-run build plan PR 8). It serves the built
// browser modules and the real debate page. The turn windows and their
// final outline labels come from fixture answers to the public reads, and
// the replay position from synthetic yap:playback events, as the replay
// player sends them. It also clicks the stage's Play replay and Join as
// viewer buttons with a real mouse, and checks that the last-answer bar on
// the video's bottom edge (Decision 0015) takes only its own strip, the
// visible 6 px over a replay's native controls. No database, media or hosted service is
// involved. With REPLAY_TIMELINE_ARTIFACT_DIR set it saves phone screenshots.

type DiscoveryOptions = Parameters<typeof createDiscoveryRouter>[0];
type CreateFixtureRouter = (
  options: Omit<DiscoveryOptions, "discovery"> & {
    discovery: Pick<DiscoveryOptions["discovery"], "getDebate">;
  },
) => ReturnType<typeof createDiscoveryRouter>;
declare global {
  interface Window {
    // Writes to the replay video's position, and Play replay presses.
    seeks: number[];
    plays: number;
  }
}

const debateId = "33333333-3333-4333-8333-333333333333";
const topic: PublicTopic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "transit",
  title: "Transit",
  summary: "Synthetic replay timeline fixture.",
  sideALabel: "Free for everyone",
  sideBLabel: "Fix service first",
  category: "other",
  isDemo: false,
  createdAt: new Date(),
};
const base: PublicDebate = {
  id: debateId,
  slug: "free-transit",
  proposition: "Should Montreal make public transit free for everyone in 2035?",
  status: "finalized",
  rulesVersion: "prototype-media-1",
  scheduledAt: new Date("2026-10-23T23:00:00.000Z"),
  liveStartedAt: new Date("2026-10-23T23:00:00.000Z"),
  liveEndedAt: new Date("2026-10-23T23:12:00.000Z"),
  isDemo: false,
  createdAt: new Date(),
  topic,
  speakerA: {
    handle: "mayachen",
    displayName: "Maya Chen",
    avatarId: "yap-owl",
  },
  speakerB: {
    handle: "leot",
    displayName: "Léo Tremblay",
    avatarId: "yap-frog",
  },
  sponsor: null,
  timing: { turnCount: 10, turnSeconds: 60 },
};
let debate: PublicDebate = base;

const liveStart = Date.parse("2026-10-23T23:00:00.000Z");
// Each turn plays for 60 seconds, one second apart, from 0:02.
const start = (turn: number) => 2 + (turn - 1) * 61;
const shares = [52, 47, 55, 52, 61, 52, 63, 56, 64, 60];
// Each turn's final AI outline labels; turn 1 has two arguments.
const labels = [
  ["Free fares bring riders back", "Cars leave downtown"],
  ["Service is too unreliable today"],
  ["Tallinn's ridership rose"],
  ["Fares fund a third of operations"],
  ["A congestion charge can replace fares"],
  ["Riders want frequency"],
  ["Low-income riders gain most"],
  ["Targeted passes cost less"],
  ["One fare-free city is simpler"],
  ["Fix the metro first"],
];
const artifacts = process.env.REPLAY_TIMELINE_ARTIFACT_DIR;
const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
function windows(revealed: boolean, count = 10, recorded = true) {
  return Array.from({ length: count }, (_, index) => {
    const turn = index + 1;
    return {
      id: `55555555-5555-4555-8555-${String(turn).padStart(12, "0")}`,
      turnNumber: turn,
      side: turn % 2 ? "A" : "B",
      opensAt: new Date(liveStart + index * 61_000).toISOString(),
      closesAt: new Date(liveStart + index * 61_000 + 60_000).toISOString(),
      state: revealed ? "settled" : "open",
      voidReason: null,
      revealMode: "five_day",
      revealAt: revealed ? new Date(0).toISOString() : future,
      recording: recorded
        ? { startSeconds: start(turn), endSeconds: start(turn) + 60 }
        : null,
      // Turn 5's price was drawn over the whole range (the A4 engine's
      // exploratory branch); the others between a and b.
      pricing: revealed
        ? {
            share: { n: String(shares[index]), d: "100" },
            a: { n: "45", d: "100" },
            b: { n: "60", d: "100" },
            price: { n: turn === 5 ? "81" : "52", d: "100" },
            branch: turn === 5 ? "exploratory" : "targeted",
            reason: null,
          }
        : null,
    };
  });
}
let windowList = windows(true);
// Decision 0015: the debate's last-answer figure in the window list, for a
// debate whose question is the topic title.
const endorsement = {
  throughTurn: 10,
  yes: 47,
  accounts: 100,
  previous: { throughTurn: 9, yes: 45, accounts: 98 },
  switched: { toYes: 6, toNo: 3, cameBack: 1 },
  multiAnswerAccounts: 30,
};

let browser: Browser | undefined, server: Server | undefined;
try {
  const app = express();
  app.use(
    "/assets",
    express.static(new URL("../public/", import.meta.url).pathname),
  );
  app.use(
    (createDiscoveryRouter as CreateFixtureRouter)({
      discovery: {
        getDebate: async (slug) => (slug === debate.slug ? debate : null),
      },
      mediaEnabled: true,
      applicationOrigin: "http://localhost",
      endorsementBar: true,
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const results: Record<string, unknown> = {};

  // Every API answer is a fixture: the window list, the media snapshot of
  // an ended debate with its recording ready, a signed-out visitor, and 404
  // for the rest (no chat), which the page already handles.
  async function answer(route: Route) {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/media/events/${debateId}`)
      return route.fulfill({
        json: {
          state:
            debate.status === "live"
              ? null
              : {
                  debateId,
                  hasCaptions: false,
                  state: "ended",
                  activeSide: null,
                  turnNumber: 10,
                  turnDeadlineAt: null,
                  remainingMs: null,
                  activeMs: 600_000,
                  lastResumedAt: null,
                  revision: 31,
                  incident: null,
                  recordingStatus: "ready",
                },
          eventStatus: debate.status,
          automaticReplayPublication: true,
          streamRevision: "1",
          serverNow: new Date().toISOString(),
          extensionsEnabled: false,
        },
      });
    if (url.pathname === `/api/public/debates/${debateId}/windows`)
      return route.fulfill({
        json: {
          debateId,
          eventStatus: debate.status,
          serverNow: new Date().toISOString(),
          revealMode: "five_day",
          revealAt: windowList[0]?.revealAt ?? null,
          windows: windowList,
          endorsement:
            debate.proposition === topic.title &&
            windowList.every((window) => window.state === "settled")
              ? endorsement
              : null,
        },
      });
    // The turns' final outline labels, which label revealed turns.
    if (url.pathname === `/api/public/debates/${debateId}/outline/timeline`)
      return route.fulfill({
        json: {
          debateId,
          complete: true,
          timed: false,
          versions: [],
          turns: labels.map((items, index) => ({
            turnNumber: index + 1,
            side: index % 2 ? "B" : "A",
            language: "en",
            arguments: items.map((label, item) => ({
              id: `t${index + 1}a${item + 1}`,
              label,
              rebuts: null,
              continues: null,
            })),
            final: true,
          })),
        },
      });
    // A signed-out visitor.
    if (["/api/auth/me", "/api/me/roles"].includes(url.pathname))
      return route.fulfill({ status: 401, json: { error: "Sign in" } });
    return route.fulfill({ status: 404, json: { error: "fixture" } });
  }
  async function open(
    width: number,
    height: number,
    hasTouch = false,
  ): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const context = await browser!.newContext({
      viewport: { width, height },
      serviceWorkers: "block",
      hasTouch,
    });
    await context.route(`${origin}/api/**`, answer);
    // The replay video records the positions the page sets, and reports
    // the recording's length as known once it has a position, as a
    // loaded HLS replay does.
    await context.addInitScript(() => {
      window.seeks = [];
      window.plays = 0;
      let position = 0;
      let ready = 0;
      Object.defineProperty(HTMLVideoElement.prototype, "readyState", {
        get: () => ready,
      });
      Object.defineProperty(HTMLVideoElement.prototype, "currentTime", {
        get: () => position,
        set(value: number) {
          position = value;
          window.seeks.push(value);
        },
      });
      document.addEventListener(
        "click",
        (event) => {
          const button = (event.target as Element).closest(
            "[data-media-replay]",
          );
          if (!button) return;
          window.plays++;
          // The replay loads: show the video and report its metadata.
          setTimeout(() => {
            const video = document.querySelector<HTMLVideoElement>(
              "[data-media-replay-video]",
            )!;
            video.hidden = false;
            ready = 1;
            video.dispatchEvent(new Event("loadedmetadata"));
          }, 50);
        },
        true,
      );
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/debates/${debate.slug}`);
    // The cookie banner would cover the chart; decline, as a visitor would.
    await page
      .getByRole("button", { name: "Reject all", exact: true })
      .click({ timeout: 5000 })
      .catch(() => {});
    return { context, page, errors };
  }
  const play = (page: Page, positionSeconds: number) =>
    page.evaluate(
      ([id, position]) =>
        window.dispatchEvent(
          new CustomEvent("yap:playback", {
            detail: { debateId: id, positionSeconds: position, playing: true },
          }),
        ),
      [debateId, positionSeconds] as const,
    );
  const caption = (page: Page) =>
    page.locator("[data-turn-caption]").textContent();
  const segments = (page: Page) =>
    page.$$eval("[data-timeline-turn]", (items) =>
      items.map((item) => ({
        progress: Number(
          (item as HTMLElement).style.getPropertyValue("--progress"),
        ),
        playing: item.hasAttribute("data-playing"),
      })),
    );

  // 1. A finalized replay at 1440 × 900: the timeline under the video,
  //    Results by turn under the scoreboard, no Results tab.
  {
    const { context, page, errors } = await open(1440, 900);
    await page.locator("[data-replay-timeline]:not([data-waiting])").waitFor();
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    assert.deepEqual(
      await page.evaluate(() => {
        const results = document.querySelector("#arena-results")!;
        const video = document
          .querySelector("[data-arena-video]")!
          .getBoundingClientRect();
        const timeline = document
          .querySelector("[data-replay-timeline]")!
          .getBoundingClientRect();
        const scoreboard = document
          .querySelector(".arena-scoreboard")!
          .getBoundingClientRect();
        return {
          resultsTab: document.querySelectorAll("#arena-tab-results").length,
          inStage: results.parentElement!.matches(".arena-watch"),
          afterScoreboard:
            results.previousElementSibling!.matches(".arena-scoreboard"),
          timelineUnderVideo:
            timeline.top >= video.bottom && timeline.bottom <= scoreboard.top,
          // The scoreboard still ends on the first screen.
          scoreboardOnFirstScreen: scoreboard.bottom <= window.innerHeight,
          segments: document.querySelectorAll("[data-timeline-turn]").length,
          bars: document.querySelectorAll("[data-turn-bar]").length,
        };
      }),
      {
        resultsTab: 0,
        inStage: true,
        afterScoreboard: true,
        timelineUnderVideo: true,
        scoreboardOnFirstScreen: true,
        segments: 10,
        bars: 10,
      },
    );
    // Bars rise for a yes majority and drop for a no majority; the latest
    // revealed turn is chosen until the viewer picks one.
    assert.deepEqual(
      await page.$$eval("[data-turn-bar]", (items) =>
        items.map((item) => (item as HTMLElement).dataset.direction),
      ),
      ["up", "down", "up", "up", "up", "up", "up", "up", "up", "up"],
    );
    assert.equal(
      await page
        .locator('[data-turn-bar="10"] button')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.match(
      (await caption(page))!,
      /^Turn 10 · Léo Tremblay.*60% yes, 40% no$/,
    );
    results.layout = true;

    // 2. Before Play, choosing a turn on the timeline starts the replay
    //    there.
    await page.locator("[data-media-replay]:not([hidden])").waitFor();
    await page.locator('[data-timeline-turn="3"] button').click();
    await page.waitForFunction(() => window.seeks.length > 0);
    assert.equal(await page.evaluate(() => window.plays), 1);
    assert.deepEqual(await page.evaluate(() => window.seeks), [start(3)]);
    results.timelineStartsReplay = true;

    // 3. Playing at 3:24: turns 1 to 3 played, turn 4 playing, on the
    //    timeline, the bars and the scoreboard.
    await play(page, 204);
    const playing = await segments(page);
    assert.deepEqual(
      playing.map((segment) => segment.progress.toFixed(2)),
      [
        "1.00",
        "1.00",
        "1.00",
        "0.32",
        "0.00",
        "0.00",
        "0.00",
        "0.00",
        "0.00",
        "0.00",
      ],
    );
    assert.deepEqual(
      playing.map((segment) => segment.playing),
      [false, false, false, true, false, false, false, false, false, false],
    );
    assert.equal(
      await page
        .locator('[data-turn-bar="4"] button')
        .getAttribute("aria-current"),
      "true",
    );
    assert.match(
      (await page
        .locator('[data-turn-bar="4"] button')
        .getAttribute("aria-label"))!,
      /Playing now\.$/,
    );
    assert.equal(
      await page.locator("[data-turn-label] .sr-only").textContent(),
      "Turn 4 of 10",
    );
    results.followsPlayback = true;

    // 4. Choosing a bar fills it, captions it and plays from its start.
    await page.locator('[data-turn-bar="2"] button').click();
    assert.equal(
      await page
        .locator('[data-turn-bar="2"] button')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator('[data-turn-bar="2"]').getAttribute("data-selected"),
      "",
    );
    assert.match((await caption(page))!, /^Turn 2 · Léo Tremblay/);
    assert.match((await caption(page))!, /47% yes, 53% no$/);
    assert.equal(await page.evaluate(() => window.seeks.at(-1)), start(2));
    results.barSeeks = true;

    // 5. Hover previews a turn in the caption; leaving restores the choice.
    await page.locator('[data-turn-bar="5"] button').hover();
    assert.match((await caption(page))!, /^Turn 5 · Maya Chen/);
    await page.mouse.move(5, 5);
    assert.match((await caption(page))!, /^Turn 2/);
    results.hoverPreview = true;

    // 6. The keyboard: one tab stop per row, arrows move and preview,
    //    Enter chooses and seeks.
    await page.locator('[data-turn-bar="2"] button').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement).closest<HTMLElement>(
            "[data-turn-bar]",
          )?.dataset.turnBar,
      ),
      "3",
    );
    assert.match((await caption(page))!, /^Turn 3/);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.seeks.at(-1)), start(10));
    assert.equal(
      await page.$$eval(
        "[data-turn-bar] button",
        (buttons) =>
          buttons.filter((button) => (button as HTMLElement).tabIndex === 0)
            .length,
      ),
      1,
    );
    await page.locator('[data-timeline-turn="4"] button').focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.seeks.at(-1)), start(1));
    results.keyboard = true;

    // 7. The price inspector moved into a closed disclosure under the bars.
    assert.equal(
      await page.evaluate(() => {
        const details = document.querySelector<HTMLDetailsElement>(
          "[data-price-details]",
        )!;
        return (
          !details.hidden &&
          !details.open &&
          details.contains(document.querySelector(".arena-price-inspector"))
        );
      }),
      true,
    );
    results.priceInDisclosure = true;
    // The phone rows' lines and the card's phone parts stay hidden here.
    assert.deepEqual(
      await page.evaluate(() => {
        const shown = (selector: string) =>
          [...document.querySelectorAll<HTMLElement>(selector)].some(
            (node) => node.getClientRects().length > 0,
          );
        const first = document
          .querySelector('[data-turn-bar="1"]')!
          .getBoundingClientRect();
        const second = document
          .querySelector('[data-turn-bar="2"]')!
          .getBoundingClientRect();
        return {
          columns: Math.abs(first.top - second.top) < 1,
          lines: shown(".arena-turn-bar-line"),
          phoneParts: shown(
            ".arena-results-sub-phone, .arena-price-phone, [data-price-turn], [data-price-order], [data-price-range]",
          ),
          summary: document.querySelector("[data-price-details] > summary")!
            .textContent,
        };
      }),
      {
        columns: true,
        lines: false,
        phoneParts: false,
        summary: "Price and typical limitsPrice draw · a < p < b",
      },
    );
    results.desktopUnchangedByPhoneParts = true;

    // 8. No serious accessibility problems in the stage.
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const run = await window.axe.run(
        document.querySelector(".arena-watch")!,
        {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        },
      );
      return run.violations
        .filter((item) => ["serious", "critical"].includes(item.impact ?? ""))
        .map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
    });
    assert.deepEqual(violations, []);
    results.axe = true;
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 9. A phone: Results by turn as one row per turn with its speaker and
  //    arguments, and a revealed turn opening its "Price draw · a < p < b"
  //    card, with no sideways scroll at 390 or 320 px.
  {
    const { context, page, errors } = await open(390, 844);
    // The timeline and the bars build from the same windows read, each in
    // its own module; wait for both.
    await page.locator("[data-timeline-turn] button").first().waitFor();
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    await page
      .locator('[data-turn-bar="1"] .arena-turn-bar-line')
      .filter({ hasText: "Free fares" })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() => {
        const list = document.querySelector("[data-turn-bar-list]")!;
        const timeline = document.querySelector("[data-replay-timeline-list]")!;
        const row = (turn: number) =>
          document
            .querySelector(`[data-turn-bar="${turn}"] button`)!
            .getBoundingClientRect();
        const line = document.querySelector<HTMLElement>(
          '[data-turn-bar="1"] .arena-turn-bar-line',
        )!;
        return {
          noSideScroll:
            document.documentElement.scrollWidth <= window.innerWidth,
          rowsFit: list.scrollWidth <= list.clientWidth,
          timelineFits: timeline.scrollWidth <= timeline.clientWidth,
          stacked: row(2).top >= row(1).bottom,
          rowHeight: row(1).height >= 44,
          rows: document.querySelectorAll("[data-turn-bar]").length,
          line: getComputedStyle(line).display !== "none" && line.textContent,
          initials: getComputedStyle(
            document.querySelector(".arena-turn-bar-initials")!,
          ).display,
          // Each row carries the caption's content, so the caption hides.
          caption: getComputedStyle(
            document.querySelector("[data-turn-caption]")!,
          ).display,
          sub: document.querySelector(".arena-results-sub-phone")!.textContent,
          cardClosed: !document.querySelector<HTMLDetailsElement>(
            "[data-price-details]",
          )!.open,
          segmentHeight: Math.round(
            document
              .querySelector("[data-timeline-turn] button")!
              .getBoundingClientRect().height,
          ),
        };
      }),
      {
        noSideScroll: true,
        rowsFit: true,
        timelineFits: true,
        stacked: true,
        rowHeight: true,
        rows: 10,
        line: "Maya · “Free fares bring riders back · Cars leave downtown”",
        initials: "none",
        caption: "none",
        sub: "Share who said yes in each 60-second window · tap a turn for its price draw",
        cardClosed: true,
        segmentHeight: 44,
      },
    );
    assert.equal(
      await page.locator(".arena-results-sub-phone").isVisible(),
      true,
    );
    assert.equal(
      await page.locator(".arena-results-sub-wide").isVisible(),
      false,
    );
    // The rows stack, so Up and Down move between them as well.
    await page.locator('[data-turn-bar="10"] button').focus();
    await page.keyboard.press("ArrowUp");
    assert.equal(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement).closest<HTMLElement>(
            "[data-turn-bar]",
          )?.dataset.turnBar,
      ),
      "9",
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    assert.equal(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement).closest<HTMLElement>(
            "[data-turn-bar]",
          )?.dataset.turnBar,
      ),
      "1",
    );
    results.phoneRows = true;

    // Tapping a revealed row opens its card: the draw between a and b, the
    // drawn price and the inspector's own lines.
    const card = page.locator(".arena-price-inspector");
    const order = () =>
      page.locator("[data-price-order] .arena-price-chip b").allTextContents();
    await page.locator('[data-turn-bar="3"] button').click();
    await card.waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator('[data-turn-bar="3"] button')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator("[data-price-turn]").textContent(),
      "Turn 3",
    );
    assert.deepEqual(await order(), ["a 0.45", "p 0.52", "b 0.60"]);
    assert.equal(await page.locator("[data-price-range]").isVisible(), false);
    assert.equal(
      await page.locator("[data-price-explanation]").textContent(),
      "Typical limits 0.45 YC–0.60 YC · targeted draw.",
    );
    assert.equal(
      await page.locator("[data-price-details] > summary").innerText(),
      "Price draw · a < p < b",
    );
    assert.equal(await page.locator("#arena-price-round").isVisible(), false);
    // The card scrolls into view (smoothly, unless motion is reduced).
    await page.waitForFunction(() => {
      const box = document
        .querySelector(".arena-price-inspector")!
        .getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    });
    // The inspector's markers slide for 320 ms.
    const settle = () => page.waitForTimeout(400);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await settle();
      await page.screenshot({ path: join(artifacts, "phone-targeted.png") });
    }
    results.phoneCardBetween = true;

    // The card's next and previous buttons move the chosen row with it; a
    // whole-range draw says so and draws its band over the whole track.
    await page.getByRole("button", { name: "Next settled round" }).click();
    await page.getByRole("button", { name: "Next settled round" }).click();
    assert.equal(
      await page.locator("[data-price-turn]").textContent(),
      "Turn 5",
    );
    assert.equal(
      await page.locator('[data-turn-bar="5"]').getAttribute("data-selected"),
      "",
    );
    assert.deepEqual(await order(), ["0", "p 0.81", "1"]);
    assert.equal(
      await page.locator("[data-price-range]").innerText(),
      "Drawn over the whole range, from 0 to 1 YC.",
    );
    assert.deepEqual(
      await card.evaluate((node) => ({
        draw: (node as HTMLElement).dataset.draw,
        band: getComputedStyle(node.querySelector(".arena-price-track")!)
          .stroke,
        interval: getComputedStyle(
          node.querySelector('[data-price-marker="interval"]')!,
        ).display,
      })),
      { draw: "whole", band: "rgb(172, 172, 172)", interval: "none" },
    );
    if (artifacts) {
      await settle();
      await page.screenshot({ path: join(artifacts, "phone-whole-range.png") });
    }
    await page.getByRole("button", { name: "Previous settled round" }).click();
    assert.equal(
      await page.locator("[data-price-turn]").textContent(),
      "Turn 4",
    );
    results.phoneCardWholeRange = true;

    // No serious accessibility problems with the card open.
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const run = await window.axe.run(
        document.querySelector("#arena-results")!,
        {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        },
      );
      return run.violations
        .filter((item) => ["serious", "critical"].includes(item.impact ?? ""))
        .map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
    });
    assert.deepEqual(violations, []);
    results.phoneAxe = true;

    // 320 px, the narrowest phone: still no sideways scroll, card open.
    await page.setViewportSize({ width: 320, height: 640 });
    assert.deepEqual(
      await page.evaluate(() => {
        const order = document.querySelector("[data-price-order]")!;
        return {
          noSideScroll:
            document.documentElement.scrollWidth <= window.innerWidth,
          orderFits: order.scrollWidth <= order.clientWidth,
        };
      }),
      { noSideScroll: true, orderFits: true },
    );
    if (artifacts)
      await page.screenshot({
        path: join(artifacts, "phone-320.png"),
        fullPage: true,
      });
    assert.deepEqual(errors, []);
    results.phone = true;
    await context.close();
  }

  // 10. Before the five-day reveal: no bars yet, the caption says when, and
  //     no price disclosure.
  {
    debate = { ...base, status: "replay" };
    windowList = windows(false);
    const { context, page, errors } = await open(1440, 900);
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    assert.equal(
      await page.locator("[data-turn-bar][data-direction]").count(),
      0,
    );
    assert.match(
      (await caption(page))!,
      /^Results are revealed on \w{3} \d+ at /,
    );
    assert.equal(await page.locator("[data-price-details]").isHidden(), true);
    assert.deepEqual(errors, []);
    results.beforeReveal = true;
    await context.close();
  }

  // 11. Without the turns' places in the recording the timeline keeps its
  //     space but stays hidden; the bars still show.
  {
    windowList = windows(true, 10, false);
    debate = base;
    const { context, page, errors } = await open(1440, 900);
    // The timeline has the windows (its turns, unseen) and still waits.
    await page
      .locator("[data-timeline-turn] button")
      .first()
      .waitFor({ state: "attached" });
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    assert.deepEqual(
      await page.locator("[data-replay-timeline]").evaluate((node) => ({
        waiting: node.hasAttribute("data-waiting"),
        visibility: getComputedStyle(node).visibility,
        height: Math.round(node.getBoundingClientRect().height),
      })),
      { waiting: true, visibility: "hidden", height: 44 },
    );
    assert.deepEqual(errors, []);
    results.timelineWaitsForRecording = true;
    await context.close();
  }

  // 12. A live debate: Results stays the rail panel's tab, with a column for
  //     every turn of the debate, and no timeline.
  {
    debate = { ...base, status: "live", liveEndedAt: null };
    windowList = windows(false, 3, false);
    const { context, page, errors } = await open(1440, 900);
    await page.locator("#arena-tab-results").click();
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        inRail: Boolean(
          document.querySelector(".arena-insight > #arena-results"),
        ),
        columns: document.querySelectorAll("[data-turn-bar]").length,
        upcoming: document.querySelectorAll(
          '[data-turn-bar][data-state="upcoming"]',
        ).length,
        timeline: document.querySelectorAll("[data-replay-timeline]").length,
      })),
      { inRail: true, columns: 10, upcoming: 7, timeline: 0 },
    );
    assert.deepEqual(errors, []);
    results.live = true;
    await context.close();
  }

  // 13. The stage's buttons take a real mouse click at phone, tablet and
  //     desktop widths: Play replay on a replay, Join as viewer on a live
  //     debate. The empty video layer over the stage once took these clicks.
  //     Steps 2 and 4 press Play replay from script, which a cover misses.
  const clickCentre = async (page: Page, selector: string, width: number) => {
    const button = page.locator(`${selector}:not([hidden])`);
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    assert.equal(
      await page.evaluate(
        ([px, py, target]) => {
          const top = document.elementFromPoint(px, py)!;
          return top.closest(target) ? target : top.getAttribute("class");
        },
        [x, y, selector] as const,
      ),
      selector,
      `${selector} is covered at ${width}px`,
    );
    await page.mouse.click(x, y);
  };
  // What takes the pointer at the middle of the video's bottom edge, a few
  // pixels up: the last-answer bar or what lies under it.
  const bottomEdge = (page: Page) =>
    page.evaluate(() => {
      const surface = document
        .querySelector("[data-arena-video]")!
        .getBoundingClientRect();
      const x = surface.left + surface.width / 2;
      const at = (up: number) => {
        const top = document.elementFromPoint(x, surface.bottom - up);
        return top?.closest("[data-endorsement-bar]")
          ? "bar"
          : (top?.tagName.toLowerCase() ?? null);
      };
      return { 3: at(3), 9: at(9), 24: at(24) };
    });
  // Step 13 shows the bar: the debate asks its topic's question.
  const counted = { ...base, proposition: topic.title };
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1440, 900],
  ] as const) {
    debate = counted;
    windowList = windows(true);
    {
      const { context, page, errors } = await open(width, height);
      await page
        .locator('[data-endorsement-bar][data-empty="false"]')
        .waitFor();
      // Before Play the bar's 12 px hit area takes the bottom strip.
      assert.deepEqual(
        await bottomEdge(page),
        { 3: "bar", 9: "bar", 24: "div" },
        `bar hit area at ${width}px`,
      );
      await clickCentre(page, "[data-media-replay]", width);
      await page.locator("[data-media-replay-video]:not([hidden])").waitFor();
      assert.equal(await page.evaluate(() => window.plays), 1);
      // Over the replay video only its visible 6 px: the native controls
      // above take the pointer.
      assert.deepEqual(
        await bottomEdge(page),
        { 3: "bar", 9: "video", 24: "video" },
        `native controls covered at ${width}px`,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
    debate = { ...counted, status: "live", liveEndedAt: null };
    windowList = windows(false, 3, false);
    {
      const { context, page, errors } = await open(width, height);
      const token = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith(`/api/media/events/${debateId}/viewer-token`),
      );
      await clickCentre(page, "[data-media-viewer]", width);
      await token;
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  results.stageButtonsTakeClicks = true;
  results.endorsementBarLeavesNativeControls = true;

  // 14. The last-answer bar itself (Decision 0015): empty with its reveal
  //     note before a five-day debate's close and filled after; keyboard
  //     focus, Enter and Escape; a tap toggles it on a phone; it stays on the
  //     bottom edge in expanded mode; the overlay chat above it still takes
  //     clicks at 1440 px; nothing scrolls sideways; no serious axe issues.
  const barState = (page: Page) =>
    page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(
        "[data-endorsement-bar]",
      )!;
      const card = document.querySelector<HTMLElement>(
        "[data-endorsement-card]",
      )!;
      return {
        empty: bar.dataset.empty,
        value: bar.getAttribute("aria-valuetext"),
        open: !card.hidden,
        text: card.textContent,
      };
    });
  {
    debate = { ...counted, status: "ended" };
    windowList = windows(false);
    const { context, page, errors } = await open(1440, 900);
    await page.waitForFunction(() =>
      document
        .querySelector("[data-endorsement-card]")
        ?.textContent?.includes("5 days after the debate"),
    );
    const before = await barState(page);
    assert.equal(before.empty, "true");
    assert.equal(before.value, "No results revealed yet");
    assert.match(
      before.text!,
      /Answers stay hidden until .+, 5 days after the debate\./,
    );
    assert.equal(before.open, false);
    await context.close();
    assert.deepEqual(errors, []);
  }
  {
    debate = counted;
    windowList = windows(true);
    const { context, page, errors } = await open(1440, 900);
    const bar = page.locator('[data-endorsement-bar][data-empty="false"]');
    await bar.waitFor();
    const filled = await barState(page);
    assert.equal(
      filled.value,
      "47% Yes, Free for everyone; 53% No, Fix service first; 100 accounts",
    );
    assert.equal(
      await bar.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--yes-share"),
      ),
      "47%",
    );
    // Keyboard: focus opens, Escape closes, Enter toggles.
    await bar.focus();
    assert.equal((await barState(page)).open, true);
    assert.match(
      (await barState(page)).text!,
      /Last answers in this debate.*47%.*53%.*47 Yes · 53 No · 100 accounts · through turn 10.*Since turn 9: \+1 pt Yes.*10 accounts changed answer: 6 to Yes, 3 to No, 1 changed back.*Not a vote, a price or a forecast\./,
    );
    await page.keyboard.press("Escape");
    assert.equal((await barState(page)).open, false);
    await page.keyboard.press("Enter");
    assert.equal((await barState(page)).open, true);
    await page.keyboard.press("Enter");
    assert.equal((await barState(page)).open, false);
    // The card stays inside the video.
    await page.keyboard.press("Enter");
    const inside = await page.evaluate(() => {
      const surface = document
        .querySelector("[data-arena-video]")!
        .getBoundingClientRect();
      const card = document
        .querySelector("[data-endorsement-card]")!
        .getBoundingClientRect();
      return (
        card.left >= surface.left &&
        card.right <= surface.right &&
        card.top >= surface.top &&
        card.bottom <= surface.bottom
      );
    });
    assert.equal(inside, true);
    await page.keyboard.press("Escape");
    // The overlay chat's composer above the bar still takes the pointer.
    assert.equal(
      await page.evaluate(() => {
        const input = document
          .querySelector("#community-chat-body")!
          .getBoundingClientRect();
        const top = document.elementFromPoint(
          input.left + input.width / 2,
          input.top + input.height / 2,
        );
        return top?.id ?? top?.getAttribute("class");
      }),
      "community-chat-body",
    );
    // Expanded mode keeps the bar on the video's bottom edge.
    await page.locator("[data-video-expand]").click();
    assert.deepEqual(
      await page.evaluate(() => {
        const surface = document
          .querySelector("[data-arena-video].is-expanded")!
          .getBoundingClientRect();
        const bar = document
          .querySelector("[data-endorsement-bar]")!
          .getBoundingClientRect();
        return {
          bottom: Math.round(surface.bottom - bar.bottom),
          width: Math.round(surface.width - bar.width),
          height: Math.round(bar.height),
        };
      }),
      { bottom: 0, width: 0, height: 6 },
    );
    await page.keyboard.press("Escape");
    // No serious accessibility problems with the bar and its card.
    await bar.focus();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const run = await window.axe.run(
        document.querySelector(".arena-watch")!,
        {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        },
      );
      return run.violations
        .filter((item) => ["serious", "critical"].includes(item.impact ?? ""))
        .map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
    });
    assert.deepEqual(violations, []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    // A tap toggles the card on a phone, and a tap elsewhere closes it.
    const { context, page, errors } = await open(390, 844, true);
    const bar = page.locator('[data-endorsement-bar][data-empty="false"]');
    await bar.waitFor();
    await bar.scrollIntoViewIfNeeded();
    const box = (await bar.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await barState(page)).open, true);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await barState(page)).open, false);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await barState(page)).open, true);
    await page.touchscreen.tap(box.x + box.width / 2, box.y - 120);
    assert.equal((await barState(page)).open, false);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  results.endorsementBar = true;

  console.log(JSON.stringify({ replayTimelineBrowser: "PASS", ...results }));
} finally {
  await browser?.close();
  server?.close();
}
