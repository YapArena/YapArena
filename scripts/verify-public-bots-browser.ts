import type { BrowserContext, Response } from "playwright-core";
import type { Pool } from "pg";
import type { PublicBotActivity } from "../src/features/a4/public-bot-types.ts";
import type { HomeData } from "../src/features/discovery/homepage-model.ts";
import type { Run } from "./browser-fixture-types.ts";
/* global document,window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import axe from "axe-core";
import { retryOnReset, signInForTest } from "./browser-sign-in.ts";

export async function verifyPublicBotsBrowser({
  base,
  context,
  owner,
  debate,
  topic,
  debateSlug,
  artifactDir,
}: {
  base: string;
  context: BrowserContext;
  owner: Pool;
  debate: string;
  topic: string;
  debateSlug: string;
  artifactDir: string;
}) {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  await mkdir(artifactDir, { recursive: true });
  const isolated = await context.browser()!.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
    bypassCSP: false,
  });
  const home = await isolated.newPage(),
    watch = await isolated.newPage(),
    errors: string[] = [],
    checks: Record<string, boolean> = {};
  for (const page of [home, watch])
    page.on("pageerror", (e) => errors.push(e.message));
  async function api<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const options = body
      ? { data: body, headers: { "Idempotency-Key": randomUUID() } }
      : {};
    const response = await retryOnReset(() =>
      isolated.request[body ? "post" : "get"](base + "/api/" + path, options),
    );
    const data: T & { error?: string } = await response.json();
    assert.ok(
      response.ok(),
      `${path}: ${response.status()} ${data.error ?? ""}`,
    );
    return data;
  }
  async function settled(runId: string) {
    let complete!: Run;
    for (let i = 0; i < 50; i++) {
      complete = await api<Run>(`a4/runs/${runId}`);
      if (complete.state === "complete") break;
      await delay(500);
    }
    assert.equal(complete.state, "complete");
    return complete;
  }
  const shots = [];
  let expectedRound: { id: string; mode: "mixed" | "observer" } | undefined;
  const homepageResponses: Response[] = [];
  home.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/public/homepage" &&
      response.status() === 200
    )
      homepageResponses.push(response);
  });
  try {
    // The arena creator can still have its normal 60-second round in flight.
    // Keep its consent and settlements independent of this shared-history trial.
    await signInForTest(
      isolated,
      base,
      `public-bots-${randomUUID()}@example.test`,
    );
    const account = (await api<{ user: { id: string } }>("auth/me")).user.id;
    const caller = await context.request.get(base + "/api/auth/me");
    assert.equal(caller.status(), 200);
    const callerIdentity: { user: { id: string } } = await caller.json();
    assert.notEqual(account, callerIdentity.user.id);
    await api("me/profile", {
      handle: "shared-ui-" + randomUUID().slice(0, 8),
      displayName: "UI Test Participant",
      bio: "Synthetic local interface trial.",
      acceptTerms: true,
    });
    const profile = await isolated.request.patch(base + "/api/me/profile", {
      data: { publicationState: "published" },
      headers: { "Idempotency-Key": randomUUID() },
    });
    assert.equal(profile.status(), 200);
    const histories = await Promise.all(
      ["Opening case", "Cost analysis"].map((argumentLabel) =>
        api<{ id: string }>("a4/runs", {
          debateId: debate,
          mode: "mixed",
          config: { population: 500, roundSeconds: 10, argumentLabel },
          speed: 20,
        }),
      ),
    );
    await Promise.all(histories.map((history) => settled(history.id)));
    const seed = () =>
      promisify(execFile)(process.execPath, ["scripts/seed-public-bots.ts"], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: process.env.A4_TEST_OWNER_URL,
          PUBLIC_BOTS_STAGE_ORIGIN: base,
          PUBLIC_BOTS_SEED_ACK: "synthetic-only",
        },
      });
    const seeded: { inserted: number } = JSON.parse((await seed()).stdout);
    assert.ok(seeded.inserted >= 36);
    assert.equal(JSON.parse((await seed()).stdout).inserted, 0);
    const seedIds = (
      await owner.query<{ id: string }>(
        "SELECT id FROM a4_synthetic_rounds WHERE debate_id=$1 ORDER BY simulated_at,id",
        [debate],
      )
    ).rows.map((r) => r.id);
    checks.operatorSeedIsIdempotentAndUsesStoredArgumentResults = true;
    await api("a4/publication", { published: true });
    const callerPublication = await context.request.get(
      base + "/api/a4/publication",
    );
    assert.equal(callerPublication.status(), 200);
    const callerConsent: { published: boolean } =
      await callerPublication.json();
    assert.equal(
      callerConsent.published,
      false,
      "sharing this fixture must not publish the arena creator's other rounds",
    );
    checks.separateCreatorKeepsWorkspaceRoundsPrivate = true;
    await home.goto(base + "/home");
    await watch.goto(base + "/debates/" + debateSlug);
    home.setDefaultTimeout(20000);
    watch.setDefaultTimeout(20000);
    await home.bringToFront();
    const dismiss = home.getByRole("button", { name: "Not now", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await home.locator(`[data-trending="${topic}"]`).click();
    await watch
      .locator("[data-shared-arguments]")
      .waitFor({ state: "visible" });
    assert.equal(
      await watch.locator("[data-shared-argument-list] article").count(),
      6,
    );
    assert.match(
      (await home.locator("#ya-metric-label").textContent())!,
      /Synthetic/,
    );
    assert.equal(
      await home.locator('[data-site-header] nav a[href="/live"]').count(),
      1,
    );
    const before = await api<PublicBotActivity>(
      `public/debates/${debate}/activity`,
    );
    assert.ok(before.items.length >= 18);
    assert.equal(before.items.length, 38);
    assert.ok(before.items.some((r) => r.mode === "mixed"));
    await home.locator(`[data-expand="${topic}"]`).click();
    assert.equal(
      await home
        .locator(`#ya-debate-grid a[href="/debates/${debateSlug}"]`)
        .count(),
      1,
    );
    await home.locator("#ya-search").focus();
    await home.mouse.move(0, 0);
    checks.databaseBackedHomeExpansionAndDebateArguments = true;
    async function round(mode: "mixed" | "observer", label: string) {
      const inspecting = mode === "observer";
      const previousRound = await home
        .locator("#ya-chart")
        .getAttribute("data-latest-round");
      if (inspecting) {
        await home.bringToFront();
        await home.locator("#ya-carousel .ya-scrub-control input").focus();
        await home.locator("#ya-carousel-count").hover();
        assert.equal(await home.locator("#ya-chart.is-scrubbing").count(), 1);
      }
      const created = await api<{ id: string }>("a4/runs", {
        debateId: debate,
        mode,
        config: {
          population: 30,
          preset: "heterogeneous",
          roundSeconds: 10,
          argumentLabel: label,
        },
      });
      const state = await api<Run>(`a4/runs/${created.id}`),
        id = state.rounds[0]!.id;
      expectedRound = { id, mode };
      if (mode === "mixed")
        await api(`a4/rounds/${id}/submit`, {
          accountId: account,
          side: "YES",
          ceiling: "1",
          quantity: 1,
          rule: state.config.rule,
        });
      assert.ok(
        !(
          await api<PublicBotActivity>(`public/debates/${debate}/activity`)
        ).items.some((r) => r.id === id),
        "pending round remains sealed",
      );
      await settled(created.id);
      const latest = (
        await api<PublicBotActivity>(`public/debates/${debate}/activity`)
      ).items.at(-1)!;
      assert.equal(latest.id, id);
      assert.equal(latest.mode, mode);
      assert.equal(latest.humans, mode === "mixed" ? 1 : 0);
      assert.equal(latest.ownLimit, null);
      assert.equal(latest.runId, null);
      if (inspecting) {
        const containsRound = async (response: Response) => {
          if (
            new URL(response.url()).pathname !== "/api/public/homepage" ||
            response.status() !== 200
          )
            return false;
          const snapshot: HomeData = await response.json();
          return snapshot.ideas.some(
            (idea) =>
              idea.id === topic && idea.activity?.items.at(-1)?.id === id,
          );
        };
        let received = false;
        for (const response of homepageResponses) {
          if (await containsRound(response)) {
            received = true;
            break;
          }
        }
        if (!received)
          await home.waitForResponse(containsRound, { timeout: 20000 });
        assert.equal(
          await home.locator("#ya-chart").getAttribute("data-latest-round"),
          previousRound,
          "active inspection holds a received settlement until interaction ends",
        );
      }
      // Observe polling only after foregrounding and ending chart interaction.
      await home.bringToFront();
      await home.locator("#ya-search").click();
      await home.mouse.move(0, 0);
      assert.equal(await home.evaluate(() => document.hidden), false);
      assert.deepEqual(
        await home.evaluate(() => ({
          carouselActive: document
            .querySelector("#ya-carousel")!
            .matches(":hover,:focus-within"),
          tickerActive: document
            .querySelector(".ya-ticker")!
            .matches(":hover,:focus-within"),
          inspecting: document.querySelectorAll(".is-scrubbing").length,
        })),
        { carouselActive: false, tickerActive: false, inspecting: 0 },
        "live refresh observation requires an idle homepage",
      );
      await home.waitForFunction(
        (id) =>
          document.querySelector<SVGSVGElement>("#ya-chart")?.dataset
            .latestRound === id,
        id,
        { timeout: 20000 },
      );
      await home.waitForFunction(
        (id) =>
          document.querySelector<SVGSVGElement>("#ya-detail-chart")?.dataset
            .latestRound === id,
        id,
        { timeout: 20000 },
      );
      if (inspecting) checks.activeInspectionDefersAndIdleReleasesUpdate = true;
      await watch.bringToFront();
      assert.equal(await watch.evaluate(() => document.hidden), false);
      await watch.locator(`[data-chart-round="${id}"]`).waitFor();
      return id;
    }
    const observer = await round("observer", "Observer argument follow-up");
    const mixed = await round("mixed", "Mixed-round cost analysis");
    checks.observerAndMixedSettlementRefreshHomeExpandedAndDebateWithoutReload = true;
    checks.pendingPrivacyAndAggregateOnlyPublication = true;
    await watch.locator(`[data-chart-round="${observer}"]`).focus();
    await watch.keyboard.press("Enter");
    assert.match(
      (await watch.locator("[data-price-context]").textContent())!,
      /Observer argument follow-up/,
    );
    // Decision 0013: the debate page has only the shared view; personal
    // runs and receipts live in the Bots sandbox on /coins.
    assert.equal(await watch.locator("[data-shared-view]").count(), 0);
    assert.match(
      (await watch.locator("[data-arena-scope]").textContent())!,
      /Shared simulation/,
    );
    checks.debatePageShowsSharedHistoryOnly = true;
    await home.screenshot({
      path: artifactDir + "/home-expanded.png",
      fullPage: true,
    });
    shots.push("home-expanded.png");
    await watch.screenshot({
      path: artifactDir + "/debate-shared.png",
      fullPage: true,
    });
    shots.push("debate-shared.png");
    for (const page of [home, watch]) {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "No mobile overflow",
      );
      await page.evaluate(axe.source);
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map((v) => ({
          id: v.id,
          targets: v.nodes.map((n) => n.target),
        })),
      );
      assert.deepEqual(violations, []);
    }
    await home.screenshot({
      path: artifactDir + "/home-mobile.png",
      fullPage: true,
    });
    shots.push("home-mobile.png");
    await watch.screenshot({
      path: artifactDir + "/debate-mobile.png",
      fullPage: true,
    });
    shots.push("debate-mobile.png");
    checks.mobileAndAccessibility = true;
    const anonymous = await context.browser()!.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    const publicWatch = await anonymous.newPage();
    publicWatch.on("pageerror", (e) => errors.push(e.message));
    await publicWatch.goto(base + "/debates/" + debateSlug);
    await publicWatch.locator(`[data-chart-round="${mixed}"]`).waitFor();
    for (const selector of [
      "[data-inline-access]",
      "[data-inline-form]",
      "[data-a4-content]",
    ])
      assert.equal(await publicWatch.locator(selector).count(), 0);
    assert.equal(
      await publicWatch.locator("[data-shared-argument-list] article").count(),
      6,
    );
    await anonymous.close();
    checks.signedOutSharedHistoryWithoutPrivateAccess = true;
    // Sharing is withdrawn from the Bots sandbox on /coins, while the debate
    // page stays open to show the personal rounds leave the shared chart.
    const coins = await isolated.newPage();
    coins.on("pageerror", (e) => errors.push(e.message));
    await coins.goto(`${base}/coins?debate=${debate}`);
    await coins.locator("[data-a4-content]").waitFor({ state: "visible" });
    assert.equal(await coins.locator("[data-a4-publish]").isChecked(), true);
    const withdrawn = coins.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/a4/publication" &&
        r.request().method() === "POST" &&
        r.ok(),
    );
    await coins.locator("[data-a4-publish]").uncheck();
    await withdrawn;
    await coins.close();
    await watch.bringToFront();
    await watch.waitForFunction(
      (id) =>
        !document.querySelector<HTMLElement>(`[data-chart-round="${id}"]`)!,
      mixed,
      { timeout: 20000 },
    );
    assert.equal(
      (await api<PublicBotActivity>(`public/debates/${debate}/activity`)).items
        .length,
      36,
    );
    await home.bringToFront();
    await home.locator("#ya-search").click();
    await home.mouse.move(0, 0);
    await home.waitForFunction(
      (id) =>
        document.querySelector<SVGSVGElement>("#ya-chart")?.dataset
          .latestRound === id,
      seedIds.at(-1),
      { timeout: 20000 },
    );
    checks.consentWithdrawalRemovesPersonalRoundsEverywhere = true;
    await home.setViewportSize({ width: 1440, height: 1100 });
    await home.locator('[data-site-header] nav a[href="/live"]').click();
    assert.ok(home.url().endsWith("/live"));
    assert.equal(await home.locator(".arena-featured").count(), 1);
    assert.equal(
      await home
        .getByRole("heading", { name: "Debates to watch", exact: true })
        .count(),
      1,
    );
    checks.visibleLiveNavigationAndOriginalLivePage = true;
    assert.deepEqual(errors, []);
    await writeFile(
      artifactDir + "/evidence.json",
      JSON.stringify(
        {
          result: "PASS",
          checks,
          errors,
          screenshots: shots,
          scope:
            "Disposable local PostgreSQL, real A4 worker/HTTP/browser; no hosted test writes or media sessions",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ result: "PASS", checks }));
  } catch (error) {
    await home.screenshot({
      path: artifactDir + "/home-failure.png",
      fullPage: true,
    });
    await writeFile(
      artifactDir + "/evidence.json",
      JSON.stringify(
        {
          result: "FAIL",
          checks,
          expectedRound,
          errors,
          home: await home.evaluate(() => ({
            hidden: document.hidden,
            focused: document.activeElement?.id,
            hovered: Array.from(
              document.querySelectorAll(":hover"),
              (n) => n.id || n.tagName,
            ),
            inspecting: document.querySelectorAll(".is-scrubbing").length,
            status: document.querySelector("#ya-status")?.textContent,
            latestRound:
              document.querySelector<SVGSVGElement>("#ya-chart")?.dataset
                .latestRound,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    await watch.screenshot({
      path: artifactDir + "/failure.png",
      fullPage: true,
    });
    throw error;
  } finally {
    await isolated.close();
  }
}
