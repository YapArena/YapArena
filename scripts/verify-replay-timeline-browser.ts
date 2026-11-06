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
import express from "express";
import axe from "axe-core";
import { chromium, type Browser } from "playwright-core";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";

// Direction BC1's replay board in Chrome: the turn timeline under the
// video and Results by turn under the scoreboard. It serves the built
// browser modules and the real debate page. The turn windows come from a
// fixture answer to the public window list, and the replay position from
// synthetic yap:playback events, as the replay player sends them. It also
// clicks the stage's Play replay and Join as viewer buttons with a real
// mouse. No database, media or hosted service is involved.

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
      pricing: revealed
        ? {
            share: { n: String(shares[index]), d: "100" },
            a: { n: "45", d: "100" },
            b: { n: "60", d: "100" },
            price: { n: "52", d: "100" },
            branch: "targeted",
            reason: null,
          }
        : null,
    };
  });
}
let windowList = windows(true);

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
  ): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const context = await browser!.newContext({
      viewport: { width, height },
      serviceWorkers: "block",
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

  // 9. A phone: no sideways scroll, the timeline and bars fit, the bars name
  //    their speakers by initials.
  {
    const { context, page, errors } = await open(390, 844);
    await page.locator("[data-turn-bars]:not([hidden])").waitFor();
    assert.deepEqual(
      await page.evaluate(() => {
        const list = document.querySelector("[data-turn-bar-list]")!;
        const timeline = document.querySelector("[data-replay-timeline-list]")!;
        const initials = document.querySelector<HTMLElement>(
          ".arena-turn-bar-initials",
        )!;
        return {
          noSideScroll:
            document.documentElement.scrollWidth <= window.innerWidth,
          barsFit: list.scrollWidth <= list.clientWidth,
          timelineFits: timeline.scrollWidth <= timeline.clientWidth,
          initials:
            getComputedStyle(initials).display !== "none"
              ? initials.textContent
              : null,
          segmentHeight: Math.round(
            document
              .querySelector("[data-timeline-turn] button")!
              .getBoundingClientRect().height,
          ),
        };
      }),
      {
        noSideScroll: true,
        barsFit: true,
        timelineFits: true,
        initials: "MC",
        segmentHeight: 44,
      },
    );
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
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1440, 900],
  ] as const) {
    debate = base;
    windowList = windows(true);
    {
      const { context, page, errors } = await open(width, height);
      await clickCentre(page, "[data-media-replay]", width);
      await page.locator("[data-media-replay-video]:not([hidden])").waitFor();
      assert.equal(await page.evaluate(() => window.plays), 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
    debate = { ...base, status: "live", liveEndedAt: null };
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

  console.log(JSON.stringify({ replayTimelineBrowser: "PASS", ...results }));
} finally {
  await browser?.close();
  server?.close();
}
