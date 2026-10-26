import type { BrowserContext } from "playwright-core";
import type {
  PublicList,
  PublicDebate,
} from "../src/features/discovery/public-types.ts";
import type { Timeline, RoundPoint } from "../frontend/arena-types.ts";
/* global document, window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import axe from "axe-core";
import { signInForTest } from "./browser-sign-in.ts";
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
    const r = await context.request[method](
      base + "/api/" + path,
      body ? { data: body, headers: { "Idempotency-Key": randomUUID() } } : {},
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
    const histories = [];
    for (let i = 0; i < 2; i++)
      histories.push(
        await api("a4/runs", {
          debateId: debate.id,
          mode: "mixed",
          config: {
            population: 500,
            roundSeconds: 10,
            argumentLabel: i ? "Cost analysis" : "Opening case",
          },
          speed: 20,
        }),
      );
    await page.goto(base + "/debates/" + debateSlug);
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator("[data-inline-access]").waitFor({ state: "visible" });
    await page
      .locator("[data-arena-sync]")
      .filter({ hasText: "Connected" })
      .waitFor();
    if (
      (await page.locator("[data-inline-setup]").getAttribute("open")) === null
    )
      await page.locator("[data-inline-setup] summary").click();
    await page.locator("[data-inline-argument]").fill("Pilot studies");
    await page.locator("[data-inline-bots]").click();
    await page.locator("[data-inline-form]").waitFor({ state: "visible" });
    const remaining = Number(
      await page
        .locator("[data-arena-round-progress]")
        .getAttribute("aria-valuenow"),
    );
    assert.ok(remaining > 0 && remaining <= 100);
    await page.waitForFunction(
      (before) =>
        Number(
          document
            .querySelector<HTMLElement>("[data-arena-round-progress]")!
            .getAttribute("aria-valuenow"),
        ) < before,
      remaining,
    );
    checks.roundProgressDrains = true;
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
    checks.chartUpdatedAfterRealSettlements = true;
    const history = await api<Timeline>(
        `a4/debates/${debate.id}/timeline?scope=sandbox`,
      ),
      first = history.items[0]!,
      latest = history.items.at(-1)!;
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
        `${((100 * Number(point.offer!.n)) / Number(point.offer!.d)).toFixed(2)}¢`,
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
    const beforeHover = await page.locator("[data-inline-runs]").inputValue(),
      originalStatement = await page
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
      /Median interval|NO median/,
    );
    assert.notEqual(await page.locator("[data-price-yes]").textContent(), "—");
    assert.equal(
      await page.locator("[data-inline-runs]").inputValue(),
      beforeHover,
    );
    // A settled private sandbox has no deadline or room signal left, so its
    // next timed refresh can be 30 s away. Returning focus refreshes the
    // workspace now, without moving the pointer off the inspected round.
    const refreshed = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/a4/debates/${debate.id}/workspace`) &&
        r.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const response = await refreshed;
    await response.finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(resolve),
          ),
        ),
    );
    await expectInspection(first);
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
    // Layout since 2026-10-25: chat left, video centre, participation right,
    // all three starting level at the top of the workspace.
    const sidebar = (await page.locator("[data-arena-sidecar]").boundingBox())!,
      video = (await page.locator("[data-arena-video]").boundingBox())!,
      chatPanel = (await page
        .locator("[data-community-chat-panel]")
        .boundingBox())!;
    assert.ok(
      Math.abs(sidebar.y - video.y) <= 2 &&
        Math.abs(chatPanel.y - video.y) <= 2,
      "chat, video and participation card start level",
    );
    assert.ok(
      chatPanel.x < video.x && video.x < sidebar.x,
      "chat is left of the video and the participation card right of it",
    );
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
    assert.ok(enlarged.width > original.width * 2);
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
    phase = "commit";
    await page.locator("[data-inline-form] input[name=side][value=NO]").check();
    await page.locator("[data-inline-form] input[name=ceiling]").fill("0.78");
    await page.locator('[data-inline-form] [data-quantity="50"]').click();
    assert.equal(
      await page
        .locator("[data-inline-form] input[name=quantity]")
        .inputValue(),
      "50",
    );
    await page.locator("[data-inline-form] button[type=submit]").click();
    await page.locator("[data-inline-review]").waitFor({ state: "visible" });
    await page.locator("[data-inline-commit]").click();
    await page.locator("[data-inline-review]").waitFor({ state: "hidden" });
    await page
      .locator("[data-inline-receipt]")
      .getByText("committed", { exact: true })
      .waitFor();
    checks.bindingCommitmentAndQuickQuantity = true;
    const active = await page.locator("[data-inline-runs]").inputValue();
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
    await page.locator("[data-chart-round]").first().click();
    await page.waitForFunction(
      (id) =>
        document.querySelector<HTMLSelectElement>("[data-inline-runs]")!
          .value !== id,
      active,
    );
    checks.chartSelectionLoadsRound = true;
    await page.locator("[data-detail-tab=info]").click();
    assert.equal(
      await page.locator("[data-detail-panel=info]").isVisible(),
      true,
    );
    await page.locator("[data-detail-tab=rounds]").click();
    checks.sidebarTabs = true;
    phase = "a11y";
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
    await page.locator("[data-inline-access]").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
    checks.mobileNoOverflow = true;
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
    await page.locator("[data-detail-tab=info]").click();
    await page.locator("[data-detail-tab=rounds]").click();
    await page.screenshot({
      path: directory + "/replay-desktop.png",
      fullPage: true,
    });
    checks.replayLayoutAndUninterruptedSyntheticPlayback = true;
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
