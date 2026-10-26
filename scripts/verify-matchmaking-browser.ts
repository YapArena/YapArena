import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  createProfileForTest,
  signInForTest,
  testIdentityEntry,
} from "./browser-sign-in.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import pg from "pg";

// Decision 0011: two real browsers through the live queue and a "now" challenge, against the
// guarded disposable database the isolation harness provides (fresh installation only). The
// web child gets runtime credentials only; the owner URL stays here for fixtures and checks.
// LiveKit is not configured, so the journey ends in the debate room's join countdown and the
// automatic no-show; automatic start with media is covered by the unit and PostgreSQL suites.
const runtimeUrl = new URL(process.env.A4_TEST_DATABASE_URL!),
  ownerUrl = new URL(process.env.A4_TEST_OWNER_URL!);
for (const url of [runtimeUrl, ownerUrl]) {
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /^\/revocation_test_a4_fresh$/);
}
const owner = new pg.Pool({
  connectionString: ownerUrl.href,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
});
const tag = randomUUID().slice(0, 8);
const artifactDir =
  process.env.MATCHMAKING_ARTIFACT_DIR ??
  "/private/tmp/yaparena-matchmaking-browser";
const slug = `queue-browser-${tag}`;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as AddressInfo).port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;

let browser: Browser | undefined;
let server: ChildProcess | undefined;
let phase = "setup";
const errors: string[] = [];
const screenshots: string[] = [];
const steps: string[] = [];

interface Player {
  name: string;
  handle: string;
  context: BrowserContext;
  page: Page;
}

async function player(name: string): Promise<Player> {
  const context = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(20_000);
  const handle = `q-${tag}-${name}`;
  await signInForTest(context, base, `queue-${tag}-${name}@example.test`);
  // A published profile can queue and be found for a challenge.
  await createProfileForTest(context, base, {
    handle,
    displayName: `Queue ${name}`,
    publicationState: "published",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  return { name, handle, context, page };
}

async function capture(page: Page, name: string) {
  const path = join(artifactDir, `${name}.png`);
  await page.screenshot({ path });
  screenshots.push(path);
}

const pill = (page: Page) => page.locator(".queue-pill-label");
// The header loads the queue module after the page; it fills the waiting line once it is ready.
async function openTopic(page: Page) {
  await page.goto(`${base}/topics/${slug}`);
  await page
    .locator("[data-queue-waiting]")
    .filter({ hasText: /waiting|first in line/ })
    .waitFor();
}
const banner = (page: Page) => page.locator("[data-queue-banner]");

async function debateFor(handle: string) {
  const result = await owner.query<{
    id: string;
    slug: string;
    status: string;
  }>(
    `SELECT d.id, d.slug, d.status FROM debates d
     JOIN event_participants p ON p.debate_id = d.id
     JOIN public_profiles pp ON pp.user_id = p.user_id
     WHERE pp.handle = $1 ORDER BY d.created_at DESC LIMIT 1`,
    [handle],
  );
  return result.rows[0];
}

try {
  await mkdir(artifactDir, { recursive: true });
  await owner.query(
    `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
     VALUES ($1, 'Canada should expand nuclear power', 'Synthetic queue browser fixture',
       'For', 'Against', 'published')`,
    [slug],
  );
  server = spawn(process.execPath, [testIdentityEntry], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      DATABASE_URL: runtimeUrl.href,
      MATCHMAKING_ENABLED: "true",
      // Earlier journeys on this database leave debates behind; the capacity gate has its own
      // PostgreSQL tests, so it stays out of the way here.
      LIVE_DEBATE_CAPACITY: "100",
      COMMUNITY_STREAM_ENABLED: "false",
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
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    try {
      ready = (await fetch(`${base}/ready`)).ok;
    } catch {
      /* the server is still starting */
    }
    if (!ready) await delay(100);
  }
  assert.ok(ready, "runtime web process starts with matchmaking enabled");
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const alice = await player("alice");
  const bob = await player("bob");

  phase = "queue on opposite sides";
  await openTopic(alice.page);
  await alice.page.locator('[data-queue-side="A"]').click();
  await pill(alice.page)
    .filter({ hasText: /^In queue/ })
    .waitFor();
  assert.equal(
    await alice.page.locator('[data-queue-side="A"]').textContent(),
    "Leave queue",
  );
  await openTopic(bob.page);
  await bob.page
    .locator("[data-queue-waiting]")
    .filter({ hasText: "1 person waiting for For" })
    .waitFor();
  await bob.page.locator('[data-queue-side="B"]').click();
  steps.push("both players queued on opposite sides");

  phase = "accept the match within 30 seconds";
  for (const { page } of [alice, bob])
    await page.getByRole("dialog", { name: "Match found" }).waitFor();
  await capture(alice.page, "match-found");
  for (const { page } of [alice, bob])
    await page
      .getByRole("dialog", { name: "Match found" })
      .getByRole("button", { name: "Accept" })
      .click();
  for (const { page } of [alice, bob]) {
    await page.waitForURL(/\/debates\/[^/]+$/);
    await banner(page)
      .filter({ hasText: /^Waiting for both speakers to join · \d:\d\d left$/ })
      .waitFor();
  }
  const queued = await debateFor(alice.handle);
  assert.ok(queued, "the match created a debate for both players");
  assert.equal((await debateFor(bob.handle))?.id, queued.id);
  assert.equal(queued.status, "scheduled");
  assert.equal(new URL(alice.page.url()).pathname, `/debates/${queued.slug}`);
  await capture(bob.page, "queue-join-countdown");
  steps.push(
    "both accepted and opened the debate room with its join countdown",
  );

  phase = "automatic no-show";
  // Neither speaker can join without media, so move the start back past the 90-second window.
  await owner.query(
    "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP - interval '91 seconds' WHERE id = $1",
    [queued.id],
  );
  await banner(alice.page)
    .filter({
      hasText:
        "This debate was cancelled because a speaker didn't join in time.",
    })
    .waitFor();
  assert.equal((await debateFor(alice.handle))?.status, "cancelled");
  steps.push("the sweep cancelled the unjoined debate and the room said so");

  phase = "challenge to debate now";
  await alice.page.goto(`${base}/match`);
  await alice.page.locator("#match-signed-in").waitFor({ state: "visible" });
  await bob.page.goto(`${base}/match`);
  const form = bob.page.locator("#challenge-create");
  await form.waitFor({ state: "visible" });
  await form.locator('input[name="targetHandle"]').fill(alice.handle);
  await form.locator('input[name="topicSlug"]').fill(slug);
  await form
    .locator('input[name="proposition"]')
    .fill("Canada should expand nuclear power");
  await form.locator('select[name="requestedSide"]').selectOption("B");
  await form.getByRole("button", { name: /Send challenge/ }).click();
  await bob.page
    .locator("#match-notice")
    .filter({ hasText: `@${alice.handle} has 2 minutes to answer.` })
    .waitFor();
  await pill(bob.page)
    .filter({ hasText: /^Challenge sent · \d:\d\d$/ })
    .waitFor();
  const dialog = alice.page.getByRole("dialog", { name: "Debate now?" });
  await dialog.waitFor();
  assert.match(
    (await dialog.textContent()) ?? "",
    new RegExp(`@${bob.handle}\\) challenges you to debate now`),
  );
  assert.match((await dialog.textContent()) ?? "", /You argue: For/);
  await capture(alice.page, "now-challenge");
  await dialog.getByRole("button", { name: "Accept" }).click();
  for (const { page } of [alice, bob])
    await page.waitForURL(/\/debates\/[^/]+$/);
  const challenged = await debateFor(alice.handle);
  assert.ok(challenged && challenged.id !== queued.id);
  assert.equal(challenged.status, "scheduled");
  for (const { page } of [alice, bob])
    assert.equal(new URL(page.url()).pathname, `/debates/${challenged.slug}`);
  await banner(bob.page)
    .filter({ hasText: /^Waiting for both speakers to join/ })
    .waitFor();
  steps.push(
    "a now challenge reached the other player at once, and accepting opened the room for both",
  );

  assert.deepEqual(errors, [], "no page errors");
  await writeFile(
    join(artifactDir, "evidence.json"),
    JSON.stringify(
      {
        status: "passed",
        scope:
          "Disposable PostgreSQL, two synthetic accounts in headless Chrome, no LiveKit",
        steps,
        screenshots,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(`Matchmaking browser journey PASS (${steps.length} steps).`);
} catch (error) {
  console.error(
    `Matchmaking browser journey FAILED during ${phase}: ${(error as Error).message}`,
  );
  for (const [index, context] of (browser?.contexts() ?? []).entries())
    for (const page of context.pages())
      await capture(page, `failure-${index}`).catch(() => {});
  if (errors.length) console.error(`Page errors: ${errors.join(" | ")}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(5000)]);
  }
  await owner.end();
}
