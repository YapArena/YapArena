import type { BrowserContext } from "playwright-core";
import type {
  PublicList,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
import type { RoundPoint, SharedActivity } from "../frontend/arena-types.ts";
/* global document, window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import axe from "axe-core";
import { retryOnReset, signInForTest } from "./browser-sign-in.ts";
export async function verifyArenaBrowser({
  base,
  context,
  debateSlug,
  artifactDir,
  setReplay,
}: {
  base: string;
  context: BrowserContext;
  debateSlug: string;
  artifactDir: string;
  setReplay: () => Promise<unknown>;
}) {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  const directory = artifactDir;
  await mkdir(directory, { recursive: true });
  const page = await context.newPage(),
    errors: string[] = [];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  let phase = "register";
  const checks: Record<string, boolean> = {};
  async function api<T>(
    path: string,
    body?: Record<string, unknown>,
    method: "get" | "post" | "patch" = body ? "post" : "get",
  ): Promise<T> {
    const options = body
      ? { data: body, headers: { "Idempotency-Key": randomUUID() } }
      : {};
    const r = await retryOnReset(() =>
      context.request[method](base + "/api/" + path, options),
    );
    const data: T & { error?: string } = await r.json();
    assert.ok(r.ok(), `${path}: ${r.status()} ${data.error ?? ""}`);
    return data;
  }
  try {
    await signInForTest(
      context,
      base,
      "neon-ui-" + randomUUID() + "@example.test",
    );
    // A published profile before the first page keeps the handle pop-up away.
    await api("me/profile", {
      handle: "ui-trial-" + randomUUID().slice(0, 8),
      displayName: "UI Test Participant",
      bio: "Synthetic local interface trial.",
      publicationState: "published",
    });
    await page.goto(base + "/account");
    const dismiss = page.getByRole("button", { name: "Not now", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator("#signed-in").waitFor({ state: "visible" });
    const debates = await api<PublicList<PublicDebate>>(
        "public/debates?limit=50",
      ),
      debate = debates.items.find((d) => d.slug === debateSlug);
    assert.ok(debate);
    // Decision 0013: the debate page shows only the shared, revealed bot
    // history; Bots mode itself lives on /coins. Publishing lets this
    // account's runs reach that history. Consent is withdrawn at the end so
    // the shared-history check's exact round counts stay unaffected.
    await api("a4/publication", { published: true });
    const createRun = (argumentLabel: string) =>
      api<{ id: string }>("a4/runs", {
        debateId: debate.id,
        mode: "mixed",
        config: { population: 500, roundSeconds: 10, argumentLabel },
        speed: 20,
      });
    for (const label of ["Opening case", "Cost analysis"])
      await createRun(label);
    await page.goto(base + "/debates/" + debateSlug);
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator("[data-a4-inline]").waitFor();
    // The chart shares the rail panel with the AI outline and About
    // (direction BC1, revision 2): open Results for the chart checks.
    await page.locator("#arena-tab-results").click();
    phase = "live chat";
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("[data-community-chat-form]")!
          .dataset.writable === "true",
    );
    const message = "Synthetic interface trial " + randomUUID().slice(0, 8);
    await page.locator("[data-community-chat-form] textarea").fill(message);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .locator("[data-community-messages]")
      .getByText(message, { exact: true })
      .waitFor();
    checks.realLiveChat = true;
    phase = "dynamic chart";
    await page.waitForFunction(
      () =>
        document.querySelectorAll<HTMLElement>("[data-chart-round]").length >=
        2,
      {},
      { timeout: 45000 },
    );
    await page
      .locator("[data-arena-sync]")
      .filter({ hasText: "Synthetic activity" })
      .waitFor();
    checks.chartUpdatedAfterRealSettlements = true;
    const activity = () =>
      api<SharedActivity>(`public/debates/${debate.id}/activity`);
    let history = await activity();
    assert.equal(history.items.length, 2);
    const first = history.items[0]!;
    let latest = history.items.at(-1)!;
    async function expectInspection(point: RoundPoint) {
      await page.waitForFunction(
        (id) =>
          document.querySelector<HTMLElement>("[data-chart-badges]")!.dataset
            .roundId === id &&
          document.querySelector<HTMLSelectElement>("[data-price-round]")!
            .value === id,
        point.id,
      );
      const yes = (100 * Number(point.share!.n)) / Number(point.share!.d);
      assert.equal(
        await page.locator('[data-chart-badge="yes"] text').textContent(),
        `${yes.toFixed(0)}%`,
      );
      assert.equal(
        await page.locator('[data-chart-badge="no"] text').textContent(),
        `${(100 - yes).toFixed(0)}%`,
      );
      assert.equal(
        await page.locator("[data-price-yes]").textContent(),
        `${(Number(point.offer!.n) / Number(point.offer!.d)).toFixed(2)} YC`,
      );
      assert.match(
        (await page.locator("[data-price-context]").textContent())!,
        new RegExp(`Round ${point.number}`),
      );
    }
    await expectInspection(latest);
    const graphGeometry = () =>
      page.locator(".arena-chart").evaluate((node) => {
        const bounds = node.getBoundingClientRect(),
          panel = node.closest(".arena-chart-panel")!.getBoundingClientRect();
        return {
          x: bounds.x - panel.x,
          y: bounds.y - panel.y,
          width: bounds.width,
          height: bounds.height,
        };
      });
    const originalStatement = await page
        .locator("[data-chart-statement]")
        .textContent(),
      originalGraph = await graphGeometry(),
      offerMarker = (await page
        .locator('[data-price-marker="offer"]')
        .elementHandle())!;
    await offerMarker.evaluate(async (node) => {
      await Promise.all(
        node.getAnimations().map((animation) => animation.finished),
      );
      window.__arenaMotion = [];
      window.__arenaHeadingMotion = false;
      node.addEventListener("transitionrun", (event) => {
        if ((event as TransitionEvent).propertyName === "transform")
          window.__arenaMotion.push({
            current: new window.DOMMatrixReadOnly(
              window.getComputedStyle(node).transform,
            ).m41,
            target: new window.DOMMatrixReadOnly(node.style.transform).m41,
          });
      });
      new window.MutationObserver(() => {
        if (
          document
            .querySelector<HTMLElement>("#arena-chart-title")!
            .getAnimations({ subtree: true }).length
        )
          window.__arenaHeadingMotion = true;
      }).observe(document.querySelector<HTMLElement>("#arena-chart-title")!, {
        childList: true,
      });
    });
    await page.locator(`[data-chart-round="${first.id}"]`).hover();
    await expectInspection(first);
    assert.equal(await page.locator("[data-chart-tooltip]").count(), 0);
    assert.equal(
      await page.locator("[data-chart-statement]").textContent(),
      `“${first.argumentLabel}”`,
    );
    assert.equal(
      await page
        .locator(".arena-chart-axis-badge, .arena-chart-argument-symbol")
        .count(),
      0,
    );
    assert.match(
      (await page.locator("[data-price-explanation]").textContent())!,
      /Typical limits|Typical No limit/,
    );
    assert.notEqual(await page.locator("[data-price-yes]").textContent(), "—");
    // A new published settlement re-renders the shared history through the
    // room signal while the pointer stays on the inspected round.
    const refreshed = page.waitForResponse(
      async (r) =>
        r.url().includes(`/api/public/debates/${debate.id}/activity`) &&
        r.ok() &&
        ((await r.json()) as SharedActivity).items.length === 3,
      { timeout: 45000 },
    );
    await createRun("Pilot studies");
    const response = await refreshed;
    await response.finished();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-chart-round]").length === 3,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(resolve),
          ),
        ),
    );
    await expectInspection(first);
    assert.equal(
      await page.locator("[data-chart-statement]").textContent(),
      `“${first.argumentLabel}”`,
    );
    history = await activity();
    assert.equal(history.items.length, 3);
    assert.equal(history.items[0]!.id, first.id);
    latest = history.items.at(-1)!;
    assert.equal(latest.argumentLabel, "Pilot studies");
    assert.equal(await offerMarker.evaluate((node) => node.isConnected), true);
    assert.equal(await page.evaluate(() => window.__arenaHeadingMotion), true);
    assert.equal(
      await page.evaluate(() =>
        window.__arenaMotion.some(
          ({ current, target }) => Math.abs(current - target) > 0.001,
        ),
      ),
      true,
    );
    assert.deepEqual(await graphGeometry(), originalGraph);
    checks.persistentPriceMarkersSlideAndHeadingAnimatesWithoutLayoutShift = true;
    const graphBounds = (await page.locator(".arena-chart").boundingBox())!,
      scaleBounds = (await page.locator(".arena-price-scale").boundingBox())!;
    assert.ok(
      Math.abs(scaleBounds.y - graphBounds.y - graphBounds.height) <= 4,
      "median scale directly adjoins the X-axis canvas",
    );
    assert.equal(
      await page
        .locator(".arena-price-inspector")
        .evaluate(
          (node) =>
            node.firstElementChild!.matches(".arena-price-scale") &&
            node.previousElementSibling!.matches(".arena-chart-plot"),
        ),
      true,
    );
    await page.screenshot({ path: directory + "/hover.png", fullPage: true });
    await page.locator(".arena-chart-question").hover();
    await expectInspection(latest);
    assert.equal(
      await page.locator("[data-chart-statement]").textContent(),
      originalStatement,
    );
    assert.equal(await page.locator("[data-chart-cursor] > *").count(), 0);
    checks.latestBadgesAndMedianRestoreTogether = true;
    checks.hoverSurvivesRefreshAndScaleAdjoinsAxis = true;
    for (const point of [first, latest, first])
      await page.locator(`[data-chart-round="${point.id}"]`).hover();
    await expectInspection(first);
    assert.equal(
      await page.locator("[data-chart-statement]").textContent(),
      `“${first.argumentLabel}”`,
    );
    assert.ok((await page.locator(".arena-statement-layer").count()) <= 2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(`[data-chart-round="${latest.id}"]`).hover();
    await expectInspection(latest);
    assert.equal(
      await offerMarker.evaluate(
        (node) => window.getComputedStyle(node).transitionDuration,
      ),
      "0s",
    );
    assert.equal(
      await page
        .locator("#arena-chart-title")
        .evaluate((node) => node.getAnimations({ subtree: true }).length),
      0,
    );
    await page.locator(".arena-chart-question").hover();
    assert.equal(
      await page.locator("[data-chart-statement]").textContent(),
      originalStatement,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    checks.rapidScrubbingAndReducedMotion = true;
    // Layout since 2026-10-30 (direction BC1, amending Decision 0013): one
    // screen; the stage on the left with chat over the video from 1200px;
    // the rail on the right holds the answer panel and, below it, the AI
    // outline, results and about panel. The video and the panel start level.
    await page.evaluate(() => window.scrollTo(0, 0));
    const sidebar = (await page.locator("[data-stake-panel]").boundingBox())!,
      video = (await page.locator("[data-arena-video]").boundingBox())!,
      insight = (await page.locator("[data-insight]").boundingBox())!,
      chatPanel = (await page
        .locator("[data-community-chat-panel]")
        .boundingBox())!;
    assert.ok(
      Math.abs(sidebar.y - video.y) <= 2,
      "video and answer panel start level",
    );
    assert.ok(
      video.x + video.width < sidebar.x,
      "the video is left of the rail",
    );
    assert.ok(
      chatPanel.x >= video.x &&
        chatPanel.y >= video.y &&
        chatPanel.x + chatPanel.width <= video.x + video.width + 1 &&
        chatPanel.y + chatPanel.height <= video.y + video.height + 1,
      "chat sits over the video",
    );
    assert.ok(
      Math.abs(insight.x - sidebar.x) <= 1 &&
        insight.y >= sidebar.y + sidebar.height,
      "the outline, results and about panel is in the rail, below the answer panel",
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight + 1,
      ),
      "the page fits one screen",
    );
    // The turn clock: a timer on the emblem, between the debaters' cards.
    assert.equal(
      await page
        .locator(".arena-turn-face [data-media-clock]")
        .getAttribute("role"),
      "timer",
    );
    assert.equal(
      await page.locator(".arena-turn-face canvas.arena-ring").count(),
      1,
    );
    // Chat over the video can be hidden and shown again.
    await page.locator("[data-arena-video]").hover();
    await page.locator("[data-chat-toggle]").click();
    assert.equal(
      await page.locator("[data-community-chat-panel]").isVisible(),
      false,
    );
    await page.locator("[data-chat-toggle]").click();
    assert.equal(
      await page.locator("[data-community-chat-panel]").isVisible(),
      true,
    );
    // The frame over the speaking debater's video lights up, and only
    // theirs. Stand-in videos: no LiveKit tracks here.
    if (
      (await page
        .locator("[data-arena]")
        .getAttribute("data-debate-status")) === "live"
    ) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const lit = await page.evaluate((debateId) => {
        const box = document.querySelector("[data-media-videos]")!;
        const videos = (["A", "B"] as const).map((side) => {
          const video = document.createElement("video");
          video.dataset.side = side;
          box.append(video);
          return video;
        });
        const shadows = (["A", "B"] as const).map((activeSide) => {
          window.dispatchEvent(
            new CustomEvent("yap:turn", {
              detail: {
                debateId,
                eventStatus: "live",
                state: "running",
                activeSide,
                turnNumber: 1,
                turnDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
                serverOffset: 0,
              },
            }),
          );
          return (["A", "B"] as const).map((side) =>
            getComputedStyle(
              document.querySelector(`.arena-frame[data-side="${side}"]`)!,
            ).boxShadow.includes("inset"),
          );
        });
        for (const video of videos) video.remove();
        return shadows;
      }, debate.id);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      assert.deepEqual(lit, [
        [true, false],
        [false, true],
      ]);
      checks.speakerFrameLights = true;
    }
    checks.hoverPricesArgumentsAndCompactSidebar = true;
    const media = (await page.locator("[data-media-event]").elementHandle())!,
      chat = (await page
        .locator("[data-community-chat-panel]")
        .elementHandle())!;
    phase = "expand";
    await page.locator("[data-arena-video]").hover();
    const original = (await page.locator("[data-arena-video]").boundingBox())!;
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    assert.equal(
      await page.locator("[data-video-expand]").getAttribute("aria-expanded"),
      "true",
    );
    const enlarged = (await page.locator("[data-arena-video]").boundingBox())!;
    // The enlarged video fills the window, 24px in from each edge.
    assert.ok(
      enlarged.width > original.width &&
        enlarged.width >= page.viewportSize()!.width - 2 * 24 - 2,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("[data-video-expand]").getAttribute("aria-expanded"),
      "false",
    );
    const restored = (await page.locator("[data-arena-video]").boundingBox())!;
    assert.deepEqual(restored, original);
    assert.equal(await media.evaluate((n) => n.isConnected), true);
    assert.equal(await chat.evaluate((n) => n.isConnected), true);
    checks.expandEscapeRestoreExactBounds = true;
    phase = "desktop screenshot";
    await page.screenshot({ path: directory + "/desktop.png", fullPage: true });
    phase = "preserved live DOM";
    await page.locator("[data-arena-video]").hover();
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Restore video size", exact: true })
      .click();
    assert.equal(await media.evaluate((n) => n.isConnected), true);
    assert.equal(await chat.evaluate((n) => n.isConnected), true);
    phase = "round selection";
    await page.locator(`[data-chart-round="${first.id}"]`).click();
    await page
      .locator(`[data-chart-round="${first.id}"].is-selected`)
      .waitFor({ state: "attached" });
    await expectInspection(first);
    checks.chartSelectionMarksRound = true;
    await page.locator("#arena-tab-about").click();
    assert.equal(
      await page
        .getByRole("link", { name: "Practice with bots →" })
        .getAttribute("href"),
      `/coins?debate=${debate.id}`,
    );
    checks.botsSandboxLink = true;
    phase = "a11y";
    // The video's hover corners, name tags and chat controls fade over
    // 0.15s; scan them hidden or shown, not mid-fade, when their text is
    // still partly transparent.
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll(
          ".arena-video-overlay, .arena-frame-tag, .arena-chat-toggle, .chat-older",
        ),
      ].every((node) => ["0", "1"].includes(getComputedStyle(node).opacity)),
    );
    await page.addScriptTag({ content: axe.source });
    const a11y = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      }));
    });
    await writeFile(directory + "/axe.json", JSON.stringify(a11y, null, 2));
    assert.deepEqual(
      a11y.filter((v) => ["critical", "serious"].includes(v.impact!)),
      [],
    );
    checks.axeNoSeriousViolations = true;
    phase = "mobile";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator("[data-chart-round]").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    // The answer bar is pinned to the bottom of the first screen.
    const bar = (await page.locator("[data-stake-panel]").boundingBox())!;
    assert.ok(
      bar.y >= 0 && bar.y + bar.height <= 844 + 1 && bar.y > 844 / 2,
      "the answer bar shows at the bottom of the first screen",
    );
    // The rail panel's tabs follow the WAI pattern; on phones chat is one
    // of them, after the AI outline when the outline is on.
    const tabs = page.locator("[data-arena-tabs]");
    await tabs.locator('[role="tab"][aria-selected="true"]').focus();
    await page.keyboard.press("Home");
    const chatTab = tabs.getByRole("tab", { name: /^Chat/ });
    if ((await chatTab.getAttribute("aria-selected")) !== "true")
      await page.keyboard.press("ArrowRight");
    assert.equal(await chatTab.getAttribute("aria-selected"), "true");
    assert.equal(
      await chatTab.evaluate((node) => document.activeElement === node),
      true,
    );
    assert.ok(await page.locator("[data-community-chat-panel]").isVisible());
    await page.keyboard.press("End");
    assert.equal(
      await tabs
        .getByRole("tab", { name: "About" })
        .getAttribute("aria-selected"),
      "true",
    );
    checks.mobileTabsKeyboard = true;
    await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
    checks.mobileNoOverflow = true;
    // Reduced motion removes the hover fades.
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await page
        .locator(".arena-video-overlay")
        .first()
        .evaluate((node) => getComputedStyle(node).transitionDuration),
      "0s",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    checks.reducedMotionHoverCorners = true;
    phase = "search";
    await page.locator("#header-search").fill("walkability");
    await page.locator("#header-search").press("Enter");
    await page.waitForURL("**/debates?q=walkability");
    assert.ok(await page.locator(".debate-card").count());
    checks.headerSearch = true;
    phase = "replay layout and uninterrupted playback";
    await setReplay();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(base + "/debates/" + debateSlug);
    await page
      .getByRole("region", { name: "Debate replay", exact: true })
      .waitFor();
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = "#112d43";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#64cfff";
        ctx.fillRect((frame++ * 8) % 640, 150, 50, 50);
      };
      draw();
      window.arenaSyntheticFrame = (setInterval as Window["setInterval"])(
        draw,
        80,
      );
      const video = document.querySelector<HTMLVideoElement>(
        "[data-media-replay-video]",
      )!;
      video.srcObject = canvas.captureStream(12);
      video.muted = true;
      video.hidden = false;
      await video.play();
      window.arenaSyntheticVideo = video;
    });
    await page.waitForFunction(
      () => window.arenaSyntheticVideo.currentTime > 0.2,
    );
    const beforeTime = await page
      .locator("[data-media-replay-video]")
      .evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.locator("[data-arena-video]").hover();
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    await page.waitForFunction(
      (t) => window.arenaSyntheticVideo.currentTime > t + 0.2,
      beforeTime,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector<HTMLVideoElement>(
            "[data-media-replay-video]",
          )! === window.arenaSyntheticVideo &&
          !window.arenaSyntheticVideo.paused,
      ),
      true,
    );
    await page.screenshot({
      path: directory + "/replay-desktop.png",
      fullPage: true,
    });
    checks.replayLayoutAndUninterruptedSyntheticPlayback = true;
    await api("a4/publication", { published: false });
    assert.equal((await activity()).items.length, 0);
    checks.consentWithdrawalClearsSharedHistory = true;
    assert.deepEqual(errors, []);
    checks.noPageErrors = true;
    await writeFile(
      directory + "/evidence.json",
      JSON.stringify(
        {
          result: "PASS",
          checks,
          scope:
            "Local browser with real PostgreSQL and actual settlement worker; media provider unavailable, transport not assessed",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ result: "PASS", checks }));
  } catch (error) {
    await page.screenshot({ path: directory + "/failure.png", fullPage: true });
    await writeFile(
      directory + "/failure.json",
      JSON.stringify(
        { phase, message: (error as Error).message, errors, checks },
        null,
        2,
      ),
    );
    console.error(
      JSON.stringify({
        result: "FAIL",
        phase,
        message: (error as Error).message.slice(0, 500),
        errors,
      }),
    );
    throw error;
  } finally {
    await page.close();
  }
}
