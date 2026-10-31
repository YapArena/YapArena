import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "playwright-core";
import {
  createProfileForTest,
  signInForTest,
  testIdentityEntry,
} from "./browser-sign-in.ts";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Run, Round, Fraction } from "./browser-fixture-types.ts";
type Fixture = {
  name: string;
  seed: string;
  branch: string;
  executed: boolean;
  share: Fraction;
  accepted: number;
  offer: Fraction;
  premium: string;
  payout: string;
  net: string;
  released: string;
};
import { verifyArenaBrowser } from "./verify-arena-browser.ts";
import { verifyPublicBotsBrowser } from "./verify-public-bots-browser.ts";
/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import axe from "axe-core";
import pg from "pg";
const runtimeUrl = new URL(process.env.A4_TEST_DATABASE_URL!),
  ownerUrl = new URL(process.env.A4_TEST_OWNER_URL!);
for (const url of [runtimeUrl, ownerUrl]) {
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /^\/revocation_test_a4_(fresh|upgrade)$/);
}
const owner = new pg.Pool({
  connectionString: ownerUrl.href,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
});
const tag = randomUUID().slice(0, 8),
  artifactDir =
    process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp/yaparena-a4-browser";
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as AddressInfo).port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let browser!: Browser, server!: ChildProcess, page!: Page;
let phase = "account and inline commitment";
const errors: string[] = [],
  screenshots: string[] = [],
  outcomes: {
    name: string;
    repetition: number;
    branch: string;
    offer: Fraction | null;
    receipt: Round["receipt"];
    available: string;
    reserved: string;
  }[] = [];
// Decision 0013: Bots mode lives on /coins; the debate page only links to it.
const debatePageBots = {
  privateControlsRemoved: false,
  sandboxLink: false,
  coinsPreselectsDebate: false,
  humanModeRemoved: false,
};
const repetitions = Number(process.env.A4_BROWSER_REPETITIONS ?? 2);
assert.ok(
  Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5,
  "A4_BROWSER_REPETITIONS must be an integer from 1 to 5",
);
// Owner-only fixtures in the guarded disposable database. The application still
// generates and commits its normal round seed; only these synthetic reference
// sessions receive a known input before any bots or human commitments exist.
async function fixtureSeed(seed: string) {
  assert.ok(["browser-release-0", "browser-release-120"].includes(seed));
  await owner.query(`CREATE OR REPLACE FUNCTION yaparena.browser_release_seed()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,yaparena,pg_temp AS $fixture$
    BEGIN NEW.seed := '${seed}'; RETURN NEW; END $fixture$`);
  await owner.query(
    "REVOKE ALL ON FUNCTION yaparena.browser_release_seed() FROM PUBLIC,yaparena_runtime",
  );
}
async function view(context: BrowserContext, id: string): Promise<Run> {
  const response = await context.request.get(`${base}/api/a4/runs/${id}`);
  assert.equal(response.status(), 200);
  return response.json();
}
const coins = (state: Run, kind: string) =>
  state.balances
    .filter((balance) => balance.kind === kind)
    .reduce((sum, balance) => sum + BigInt(balance.amount), 0n);
try {
  await mkdir(artifactDir, { recursive: true });
  await owner.query("UPDATE a4_controls SET enabled=true,bots_enabled=true");
  await fixtureSeed("browser-release-0");
  await owner.query(`CREATE TRIGGER browser_release_seed BEFORE INSERT ON yaparena.a4_sessions
    FOR EACH ROW WHEN (NEW.mode='mixed' AND NEW.config->>'preset'='reference')
    EXECUTE FUNCTION yaparena.browser_release_seed()`);
  const topic = (
    await owner.query<{ id: string }>(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'A4 browser fixture','Synthetic local browser evidence','Support','Oppose','published') RETURNING id",
      [`a4-browser-${tag}`],
    )
  ).rows[0]!.id;
  const debate = (
    await owner.query<{ id: string }>(
      "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT $1,$2,'Should cities prioritize quiet streets?','scheduled','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
      [`a4-browser-${tag}`, topic],
    )
  ).rows[0]!.id;
  // Separate web child receives only runtime secrets; owner fixture URL stays here.
  server = spawn(process.execPath, [testIdentityEntry], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      DATABASE_URL: runtimeUrl.href,
      A4_MODE: "bots",
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: base,
      LOG_LEVEL: "error",
      API_RATE_LIMIT: "10000",
      AUTH_RATE_LIMIT: "100",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr!.resume();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* server is still starting */
    }
    await delay(100);
  }
  assert.ok(
    ready,
    "runtime web process starts (inspect the isolated server configuration; raw diagnostics withheld)",
  );
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const contextOptions: BrowserContextOptions = {
    viewport: { width: 1440, height: 1000 },
    bypassCSP: true,
    reducedMotion: "reduce",
  };
  let context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(20000);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  async function register(label: string) {
    await signInForTest(
      page.context(),
      base,
      `a4-browser-${tag}-${label}@example.test`,
    );
    // A private profile keeps the handle pop-up away from this journey.
    await createProfileForTest(page.context(), base, {
      handle: `a4-${tag}-${label}`,
      displayName: `A4 ${label}`,
    });
    await page.goto(`${base}/account`);
    await page.locator("#signed-in").waitFor({ state: "visible" });
  }
  await register("inline");
  phase = "debate page links to the Bots sandbox on /coins";
  await page.goto(`${base}/debates/a4-browser-${tag}`);
  await page.locator("[data-a4-inline]").waitFor();
  for (const selector of [
    "[data-inline-access]",
    "[data-inline-form]",
    "[data-inline-review]",
    ".arena-orders",
    "[data-detail-tab]",
    "[data-shared-view]",
  ])
    assert.equal(
      await page.locator(selector).count(),
      0,
      `${selector} left the debate page`,
    );
  debatePageBots.privateControlsRemoved = true;
  const botsLink = page.getByRole("link", {
    name: "Practice with bots →",
  });
  assert.equal(await botsLink.getAttribute("href"), `/coins?debate=${debate}`);
  debatePageBots.sandboxLink = true;
  await page.screenshot({
    path: `${artifactDir}/debate-bots-link.png`,
    fullPage: true,
  });
  screenshots.push("debate-bots-link.png");
  await botsLink.click();
  await page.locator("[data-a4-content]").waitFor({ state: "visible" });
  assert.equal(
    await page.locator('[data-a4-create] select[name="debateId"]').inputValue(),
    debate,
  );
  debatePageBots.coinsPreselectsDebate = true;
  assert.equal(
    await page.locator('[data-a4-create] option[value="human"]').count(),
    0,
  );
  assert.equal(await page.locator("[data-a4-refill]").isHidden(), true);
  debatePageBots.humanModeRemoved = true;
  console.log(
    JSON.stringify({
      trial: "a4-bots-sandbox-link",
      result: "PASS",
      ...debatePageBots,
    }),
  );
  async function commitmentScenario(fixture: Fixture, repetition: number) {
    phase = `${fixture.name} repetition ${repetition}`;
    // Each case is an independent real account. Keep production per-account A4
    // throttles intact instead of accumulating unrelated polling across cases.
    if (outcomes.length) {
      await context.close();
      context = await browser.newContext(contextOptions);
      context.setDefaultTimeout(20000);
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await register(`${fixture.name}-${repetition}`);
      await page.goto(`${base}/coins`);
      await page.locator("[data-a4-content]").waitFor({ state: "visible" });
    }
    await fixtureSeed(fixture.seed);
    await page
      .locator('[data-a4-create] select[name="debateId"]')
      .selectOption(debate);
    if (
      (await page.locator("[data-a4-create] details").getAttribute("open")) ===
      null
    )
      await page.locator("[data-a4-create] details summary").click();
    assert.equal(
      await page
        .locator('[data-a4-create] input[name="population"]')
        .inputValue(),
      "500",
    );
    await page
      .locator('[data-a4-create] select[name="preset"]')
      .selectOption("reference");
    await page
      .locator('[data-a4-create] input[name="roundSeconds"]')
      .fill("20");
    const creating = page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/a4/runs` &&
        response.request().method() === "POST",
    );
    await page.locator('[data-a4-create] button[type="submit"]').click();
    const created = await creating;
    assert.equal(created.status(), 201);
    const selected: string = (await created.json()).id;
    await page.waitForFunction(
      (id) =>
        document.querySelector<HTMLSelectElement>("[data-a4-runs]")?.value ===
        id,
      selected,
    );
    await page
      .locator("[data-a4-run-summary]")
      .getByText("BOTS + YOU", { exact: false })
      .waitFor();
    // The select is populated before refresh renders the new scope. Wait for
    // its open commitment form before checking the freshly issued balance.
    await page.locator("[data-a4-submit]").waitFor({ state: "visible" });
    assert.match(
      (await page.locator("[data-a4-balance]").textContent())!,
      /1000[.]000000 Yap Coins/,
    );
    const initial = await view(context, selected);
    assert.equal(
      initial.config.epsilon,
      50000,
      "default exploratory pricing stays enabled",
    );
    assert.equal(coins(initial, "available"), 1000000000n);
    assert.equal(initial.rounds[0]!.diagnostics, undefined);
    const anonymous = await browser.newContext();
    try {
      assert.equal(
        (
          await anonymous.request.get(`${base}/api/a4/runs/${selected}`)
        ).status(),
        401,
      );
    } finally {
      await anonymous.close();
    }
    await page
      .locator('[data-a4-submit] select[name="side"]')
      .selectOption("NO");
    await page.locator('[data-a4-submit] input[name="ceiling"]').fill("0.78");
    await page.locator('[data-a4-submit] input[name="quantity"]').fill("10");
    await page.locator('[data-a4-submit] button[type="submit"]').click();
    await page.locator("[data-a4-review]").waitFor({ state: "visible" });
    assert.match(
      (await page.locator("[data-a4-terms]").textContent())!,
      /10[.]000000 Yap Coins/,
    );
    const shot = `${fixture.name}-${repetition}-commitment.png`;
    await page.screenshot({ path: `${artifactDir}/${shot}` });
    screenshots.push(shot);
    await page.keyboard.press("Tab");
    assert.ok(
      await page
        .locator("[data-a4-review]")
        .evaluate((d) => d.contains(document.activeElement as HTMLElement)),
    );
    await page.locator("[data-a4-commit]").click();
    await page.locator("[data-a4-review]").waitFor({ state: "hidden" });
    await page
      .locator("[data-a4-rounds]")
      .getByText("committed", { exact: true })
      .waitFor();
    const committed = await view(context, selected);
    assert.equal(coins(committed, "available"), 990000000n);
    assert.equal(coins(committed, "reserved"), 10000000n);
    assert.equal(committed.rounds[0]!.receipt!.status, "committed");
    assert.equal(committed.rounds[0]!.diagnostics, undefined);
    assert.equal(committed.rounds[0]!.receipt!.payout, undefined);
    assert.equal(committed.rounds[0]!.receipt!.net, undefined);
    await page.reload();
    await page.locator("[data-a4-content]").waitFor({ state: "visible" });
    await page.locator("[data-a4-runs]").selectOption(selected);
    await page
      .locator("[data-a4-rounds]")
      .getByText("committed", { exact: true })
      .waitFor();
    // UI pause/resume/step; persisted worker performs pricing/execution and final reveal.
    await page.locator('[data-a4-control="pause"]').click();
    await page
      .locator("[data-a4-run-summary]")
      .getByText("paused", { exact: false })
      .waitFor();
    await page.locator('[data-a4-control="run"]').click();
    await page.locator('[data-a4-control="step"]').click();
    await page.locator("[data-a4-speed]").selectOption("20");
    await page.locator("[data-a4-refresh]").click();
    // Assert participant JSON omits sealed data, using the same signed-in browser HTTP client.
    const sealed = await context.request.get(`${base}/api/a4/runs/${selected}`);
    const hidden: Run = await sealed.json();
    if (!hidden.rounds[0]!.revealed) {
      assert.equal(hidden.rounds[0]!.diagnostics, undefined);
      assert.equal(hidden.rounds[0]!.receipt!.payout, undefined);
      assert.equal(hidden.rounds[0]!.receipt!.net, undefined);
    }
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLElement>("[data-a4-rounds]")
          ?.textContent.includes("settled"),
      undefined,
      { timeout: 45000 },
    );
    const final = await view(context, selected);
    assert.equal(final.state, "complete");
    assert.equal(final.rounds[0]!.diagnostics!.totals.bots, 500);
    assert.equal(final.rounds[0]!.diagnostics!.totals.humans, 1);
    const round = final.rounds[0]!,
      receipt = round.receipt!;
    assert.equal(round.diagnostics!.pricing!.branch, fixture.branch);
    assert.deepEqual(round.offer, fixture.offer);
    assert.deepEqual(round.diagnostics!.pricing!.share, fixture.share);
    assert.equal(round.diagnostics!.totals.accepted, fixture.accepted);
    assert.equal(
      round.diagnostics!.totals.executed,
      fixture.executed ? 501 : 0,
    );
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.executed, fixture.executed);
    assert.equal(receipt.status, fixture.executed ? "settled" : "no_opposite");
    assert.equal(receipt.premium, fixture.premium);
    assert.equal(receipt.fee, "0");
    assert.equal(receipt.payout, fixture.payout);
    assert.equal(receipt.net, fixture.net);
    assert.equal(receipt.released, fixture.released);
    assert.equal(coins(final, "reserved"), 0n);
    assert.equal(coins(final, "available"), 1000000000n + BigInt(fixture.net));
    if (!fixture.executed) {
      assert.equal(round.diagnostics!.noTrade, true);
      assert.equal(round.diagnostics!.totals.executed, 0);
    }
    await page.reload();
    await page.locator("[data-a4-content]").waitFor({ state: "visible" });
    await page.locator("[data-a4-runs]").selectOption(selected);
    await page
      .locator("[data-a4-rounds] .a4-receipt")
      .getByText(fixture.executed ? "settled" : "no opposite", { exact: true })
      .waitFor();
    assert.deepEqual(
      (await view(context, selected)).rounds[0]!.receipt,
      receipt,
      "settled receipt persists across reload",
    );
    outcomes.push({
      name: fixture.name,
      repetition,
      branch: fixture.branch,
      offer: round.offer,
      receipt,
      available: String(coins(final, "available")),
      reserved: "0",
    });
    console.log(
      `A4 ${fixture.name} repetition ${repetition}: exact offer, receipt, balances and reload PASS`,
    );
    return selected;
  }
  const fixtures: Fixture[] = [
    {
      name: "execution",
      seed: "browser-release-0",
      branch: "targeted",
      executed: true,
      share: { n: "50", d: "501" },
      accepted: 501,
      offer: { n: "211411757063649478847", d: "922337203685477580800" },
      premium: "7707870",
      payout: "9001996",
      net: "1294126",
      released: "2292130",
    },
    {
      name: "no-trade",
      seed: "browser-release-120",
      branch: "exploratory",
      executed: false,
      share: { n: "196", d: "501" },
      accepted: 305,
      offer: { n: "26206439567801318193", d: "36893488147419103232" },
      premium: "0",
      payout: "0",
      net: "0",
      released: "10000000",
    },
  ];
  const privateRuns = [];
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (const fixture of fixtures)
      privateRuns.push(await commitmentScenario(fixture, repetition));
  await page.locator("[data-a4-rounds] details summary").click();
  await page.screenshot({
    path: `${artifactDir}/settled-desktop.png`,
    fullPage: true,
  });
  screenshots.push("settled-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${artifactDir}/settled-mobile.png`,
    fullPage: true,
  });
  screenshots.push("settled-mobile.png");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "no horizontal page overflow",
  );
  await page.evaluate((source) => window.eval(source), axe.source);
  const accessibility = await page.evaluate(async () => {
    const r = await window.axe.run(
      document.querySelector<HTMLElement>("main")!,
      {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      },
    );
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    }));
  });
  assert.deepEqual(accessibility, []);
  // A second bot-only run demonstrates observer isolation and archival reset without deleting history.
  await page
    .locator('[data-a4-create] select[name="mode"]')
    .selectOption("observer");
  await page.locator("[data-a4-create] details summary").click();
  await page
    .locator('[data-a4-create] input[name="seed"]')
    .fill("browser-replay");
  await page.locator('[data-a4-create] button[type="submit"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("BOT-ONLY OBSERVER", { exact: false })
    .waitFor();
  assert.equal(await page.locator("[data-a4-submit]").isVisible(), false);
  await page.locator('[data-a4-control="archive"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("archived", { exact: false })
    .waitFor();
  const logout = await context.request.post(`${base}/api/auth/logout`);
  assert.equal(logout.status(), 204);
  await page.locator("[data-a4-refresh]").click();
  await page.locator("[data-a4-content]").waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-a4-rounds]").textContent(), "");
  assert.deepEqual(errors, []);
  await writeFile(
    `${artifactDir}/browser-evidence.json`,
    `${JSON.stringify({ base: "isolated loopback web runtime", viewport: [1440, 1000, 390, 844], account: "synthetic email registration", population: 500, humanParticipants: 1, repetitions, outcomes, debatePageBots, checks: ["starter coins", "NO conversion review", "keyboard dialog focus", "binding submit", "reload receipt", "pause/run/step/speed", "sealed response", "worker settlement", "deterministic execution and exploratory no-trade", "exact balances and reservation release", "paginated revealed diagnostics", "bot-only observer", "archive/reset isolation", "mobile overflow", "axe WCAG A/AA"], accessibility, errors, screenshots }, null, 2)}\n`,
  );
  await page.close();
  phase = "debate workspace";
  await owner.query(
    "UPDATE debates SET status='live',proposition='Should cities prioritize walkability over cars?' WHERE id=$1",
    [debate],
  );
  await verifyArenaBrowser({
    base,
    context,
    debateSlug: `a4-browser-${tag}`,
    artifactDir: `${artifactDir}/arena`,
    setReplay: () =>
      owner.query("UPDATE debates SET status='replay' WHERE id=$1", [debate]),
  });
  for (const id of privateRuns)
    assert.equal(
      (await context.request.get(`${base}/api/a4/runs/${id}`)).status(),
      404,
      "another signed-in account cannot read private runs",
    );
  phase = "shared discovery and privacy";
  await verifyPublicBotsBrowser({
    base,
    context,
    owner,
    debate,
    topic,
    debateSlug: `a4-browser-${tag}`,
    artifactDir: `${artifactDir}/shared-bots`,
  });
  console.log(`A4 browser PASS; evidence ${artifactDir}`);
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: `${artifactDir}/failure.png`, fullPage: true })
      .catch(() => {});
  await writeFile(
    `${artifactDir}/browser-evidence.json`,
    JSON.stringify(
      {
        result: "FAIL",
        phase,
        error: (error as Error).name,
        outcomes,
        debatePageBots,
        errors,
        screenshots,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  try {
    await owner.query(
      "DROP TRIGGER IF EXISTS browser_release_seed ON yaparena.a4_sessions",
    );
    await owner.query(
      "DROP FUNCTION IF EXISTS yaparena.browser_release_seed()",
    );
  } finally {
    await owner.end();
  }
}
