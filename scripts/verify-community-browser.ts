/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import pg from "pg";
import { verifyChatClient } from "./verify-chat-client.ts";
import { createProfileForTest, signInForTest } from "./browser-sign-in.ts";

const base = process.env.BROWSER_BASE_URL ?? "http://localhost:53000";
const chromePath =
  process.env.BROWSER_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for the local fixture");
const databaseUrl = new URL(
  process.env.DATABASE_FIXTURE_URL ?? process.env.DATABASE_URL,
);
if (process.env.BROWSER_DATABASE_PORT)
  databaseUrl.port = process.env.BROWSER_DATABASE_PORT;
const hosted = !["localhost", "127.0.0.1"].includes(databaseUrl.hostname);
if (hosted) {
  assert.equal(process.env.BROWSER_HOSTED_SYNTHETIC, "1");
  assert.equal(base, "https://yaparena-staging-web.onrender.com");
  assert.equal(databaseUrl.port, "5432");
  assert.equal(databaseUrl.searchParams.get("sslmode"), "verify-full");
}
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 2,
  connectionTimeoutMillis: 10000,
  query_timeout: 15000,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
});
const suffix = randomUUID().slice(0, 8);
const eventId = randomUUID();
const eventSlug = `community-browser-${suffix}`;
const accounts: string[] = [];
let topicId: string | undefined;
let browser!: Browser;
const timings: Record<string, number | string> = {};
const connectionReady = /(?:Live|Polling) updates on/;
const chatReportDetail = `Synthetic chat case ${suffix}`;
const eventReportDetail = `Synthetic event case ${suffix}`;
const oldReportDetail = `Synthetic old chat case ${suffix}`;

// The like, share, refresh and report controls sit in the chat's "⋯" menu
// (debate page direction BC1).
async function openChatMenu(page: Page) {
  const menu = page.locator("[data-chat-more]");
  if (!(await menu.evaluate((node: HTMLDetailsElement) => node.open)))
    await menu.locator("summary").click();
}
// Chat is a tab of the rail panel on phones and when the video is too small
// for chat over it, as in this trial's 1280 × 720 desktop pages.
async function showChat(page: Page) {
  const tab = page.locator("#arena-tab-chat");
  if (await tab.isVisible()) await tab.click();
}
async function closeChatMenu(page: Page) {
  await page
    .locator("[data-chat-more]")
    .evaluate((node: HTMLDetailsElement) => {
      node.open = false;
    });
}
async function axeViolations(page: Page, selector: string) {
  await page.evaluate((source) => {
    window.eval(source);
  }, axe.source);
  return page.evaluate(async (target) => {
    const root = document.querySelector(target);
    if (!root)
      throw new Error(`Accessibility scan target is missing: ${target}`);
    const result = await window.axe.run(root, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    }));
  }, selector);
}

async function register(name: string, publishProfile = false) {
  const email = `community-browser-${name}-${suffix}@example.test`;
  const context = await browser.newContext({ bypassCSP: true });
  const { user } = await signInForTest(context, base, email);
  const handle = `browser-${name}-${suffix}`;
  // Accounts that only moderate get a private profile, so the handle pop-up
  // stays away; chat still refuses them until a profile is public.
  if (!publishProfile)
    await createProfileForTest(context, base, { handle, displayName: name });
  const page = await context.newPage();
  await page.goto(`${base}/account`);
  await page.locator("#signed-in").waitFor({ state: "visible" });
  const userId = user.id;
  assert.ok(userId, `registered ${name}`);
  accounts.push(userId);
  if (publishProfile) {
    // A new account picks its username and handle in the pop-up before
    // anything else, and every profile is public.
    const setup = page.locator("dialog.profile-setup");
    await setup.waitFor({ state: "visible" });
    await setup.getByLabel("Username", { exact: true }).fill(name);
    await setup.getByLabel("Handle", { exact: true }).fill(handle);
    await setup.getByText(`@${handle} is free.`).waitFor();
    await setup.getByRole("button", { name: "Continue" }).click();
    await setup.getByRole("checkbox", { name: /18 or older/ }).check();
    await setup.getByRole("button", { name: "Claim my handle" }).click();
    await setup.getByRole("button", { name: "Start exploring" }).click();
    await setup.waitFor({ state: "detached" });
    await page
      .locator("#account-handle")
      .getByText(`@${handle}`, { exact: true })
      .waitFor();
  }
  return { context, page, userId };
}

async function grantModerator(userId: string) {
  await pool.query<never>(
    "INSERT INTO account_roles (user_id, role) VALUES ($1, 'moderator') ON CONFLICT DO NOTHING",
    [userId],
  );
}

try {
  if (hosted)
    assert.equal(
      (
        await pool.query<{ identity: string }>(
          "SELECT current_user AS identity",
        )
      ).rows[0]!.identity,
      "yaparena_owner",
    );
  const topic = await pool.query<{ id: string }>(
    `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
     VALUES ($1, 'Community browser trial', 'Temporary local browser verification', 'For', 'Against', 'published')
     RETURNING id`,
    [`community-browser-topic-${suffix}`],
  );
  topicId = topic.rows[0]!.id;
  await pool.query<never>(
    `INSERT INTO debates (id, slug, topic_id, proposition, status, publication_state,
       rules_version, rules_snapshot, scheduled_at, live_started_at)
     SELECT $1, $2, $3, 'Should live debates have a community chat?',
       'live', 'published', version, rules, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM event_rule_versions WHERE version = 'prototype-media-1'`,
    [eventId, eventSlug, topicId],
  );
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  await mkdir(artifactDir, { recursive: true });
  const author = await register("author", true);
  await author.page.goto(`${base}/debates/${eventSlug}`);
  await showChat(author.page);
  await author.page
    .locator("[data-community-chat-form]")
    .waitFor({ state: "visible" });
  const reporter = await register("reporter", true);
  await reporter.page.goto(`${base}/debates/${eventSlug}`);
  await showChat(reporter.page);
  await reporter.page.getByText(connectionReady).waitFor();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    bypassCSP: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${base}/debates/${eventSlug}`);
  await showChat(mobilePage);
  await mobilePage.getByText(connectionReady).waitFor();
  await openChatMenu(author.page);
  await author.page.locator("[data-community-like]").click();
  try {
    await author.page
      .locator('[data-community-like][aria-pressed="true"]')
      .waitFor({ state: "visible", timeout: 5000 });
  } catch {
    throw new Error(
      `Like failed: ${await author.page.locator("[data-community-status]").textContent()}`,
    );
  }
  assert.equal(
    await author.page
      .locator("[data-community-like]")
      .getAttribute("aria-pressed"),
    "true",
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("A useful public comment");
  const firstMessageAt = performance.now();
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page.getByText("A useful public comment").waitFor();
  await reporter.page.getByText("A useful public comment").waitFor();
  timings.desktopChatDeliveryMs = Math.round(
    performance.now() - firstMessageAt,
  );
  await mobilePage.getByText("A useful public comment").waitFor();
  timings.mobileViewportChatDeliveryMs = Math.round(
    performance.now() - firstMessageAt,
  );
  assert.equal(
    await reporter.page
      .locator("[data-community-messages] [data-message-id]")
      .count(),
    1,
  );
  await reporter.context.setOffline(true);
  await reporter.page
    .getByText("Connection interrupted", { exact: false })
    .waitFor();
  await pool.query<never>(
    "UPDATE event_chat_messages SET created_at = CURRENT_TIMESTAMP - INTERVAL '20 seconds' WHERE debate_id = $1",
    [eventId],
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("Arrived while disconnected");
  await author.page.locator("[data-community-chat-form] button").click();
  await mobilePage.getByText("Arrived while disconnected").waitFor();
  const reconnectAt = performance.now();
  await reporter.context.setOffline(false);
  await reporter.page.getByText("Arrived while disconnected").waitFor();
  timings.reconnectCatchupMs = Math.round(performance.now() - reconnectAt);
  assert.deepEqual(
    await reporter.page
      .locator(
        "[data-community-messages] [data-message-id] .community-message-body",
      )
      .allTextContents(),
    ["A useful public comment", "Arrived while disconnected"],
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("Too soon");
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page
    .locator("[data-community-send-status]")
    .getByText("chat limit reached", { exact: false })
    .waitFor();
  assert.equal(
    await author.page
      .locator("[data-community-chat-form] textarea")
      .inputValue(),
    "",
  );
  await author.page
    .locator(".community-message")
    .filter({ hasText: "Too soon" })
    .getByRole("button", { name: "Recover to draft" })
    .click();
  assert.equal(
    await author.page
      .locator("[data-community-chat-form] textarea")
      .inputValue(),
    "Too soon",
  );
  const desktopConsent = author.page.getByRole("button", {
    name: "Reject all",
    exact: true,
  });
  if (await desktopConsent.isVisible()) await desktopConsent.click();
  await author.page.screenshot({
    path: `${artifactDir}/community-desktop.png`,
    fullPage: true,
  });
  assert.deepEqual(await axeViolations(author.page, "[data-arena]"), []);
  assert.deepEqual(
    await axeViolations(author.page, "[data-community-event]"),
    [],
  );

  await reporter.page
    .getByRole("button", { name: "Report message" })
    .first()
    .click();
  const reportForm = reporter.page.locator(".community-message form");
  await reportForm.locator("select").selectOption("spam");
  await reportForm.locator("textarea").fill(chatReportDetail);
  await reportForm.locator("button[type=submit]").click();
  await reporter.page
    .getByText("Report submitted privately", { exact: false })
    .waitFor();
  await openChatMenu(reporter.page);
  await reporter.page
    .locator("[data-community-report-form] select")
    .selectOption("other");
  await reporter.page
    .locator("[data-community-report-form] textarea")
    .fill(eventReportDetail);
  await reporter.page.locator("[data-community-report-form] button").click();
  await reporter.page
    .getByText("Report submitted privately", { exact: false })
    .waitFor();
  await closeChatMenu(reporter.page);

  const moderatorA = await register("moderator-a");
  await grantModerator(moderatorA.userId);
  await moderatorA.page.goto(`${base}/moderation`);
  await moderatorA.page
    .locator("[data-community-cases] .community-case")
    .first()
    .waitFor();
  await moderatorA.page.screenshot({
    path: `${artifactDir}/community-moderation.png`,
    fullPage: true,
  });
  assert.deepEqual(await axeViolations(moderatorA.page, "main"), []);
  const chatCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: chatReportDetail })
    .filter({ hasText: "chat · open" })
    .first();
  await chatCase.locator("select").first().selectOption("remove_chat");
  await chatCase.locator("select").nth(1).selectOption("spam");
  await chatCase
    .locator("textarea")
    .fill("This message needs removal pending appeal");
  await chatCase.getByRole("button", { name: "Save decision" }).click();
  await chatCase.waitFor({ state: "hidden" });
  await reporter.page
    .getByText("A useful public comment")
    .waitFor({ state: "hidden" });
  await mobilePage
    .getByText("A useful public comment")
    .waitFor({ state: "hidden" });
  const eventCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: eventReportDetail })
    .filter({ hasText: "event · open" })
    .first();
  await eventCase.locator("select").first().selectOption("pause_chat");
  await eventCase.locator("select").nth(1).selectOption("other");
  await eventCase.locator("textarea").fill("Pause chat for moderator review");
  await eventCase.getByRole("button", { name: "Save decision" }).click();
  await eventCase.waitFor({ state: "hidden" });
  await reporter.page
    .locator('[data-community-chat-form] button[type="submit"]:disabled')
    .waitFor({ state: "visible" });
  await mobilePage
    .locator('[data-community-chat-form] button[type="submit"]:disabled')
    .waitFor({ state: "visible" });
  await moderatorA.page
    .locator("[data-community-case-filter]")
    .selectOption("actioned");
  const pausedCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: eventReportDetail })
    .filter({ hasText: "pause_chat" })
    .first();
  await pausedCase.locator("textarea").fill("Review is complete, resume chat");
  await pausedCase.getByRole("button", { name: "Resume event chat" }).click();
  await reporter.page
    .locator('[data-community-chat-form] button[type="submit"]:enabled')
    .waitFor({ state: "visible" });

  await author.page.goto(`${base}/account/moderation`);
  const appealForm = author.page.locator("[data-community-list] form").first();
  await appealForm.waitFor();
  await appealForm
    .locator("textarea")
    .fill("The message was ordinary discussion, not spam");
  await appealForm.getByRole("button", { name: "Submit appeal" }).click();
  await author.page.getByText("Appeal: open").waitFor();

  const moderatorB = await register("moderator-b");
  await grantModerator(moderatorB.userId);
  await moderatorB.page.goto(`${base}/moderation`);
  const fixtureCase = (
    await pool.query<{ id: string }>(
      "SELECT id FROM moderation_cases WHERE debate_id=$1 AND reporter_user_id=$2 AND target_type='chat'",
      [eventId, reporter.userId],
    )
  ).rows[0]!;
  assert.ok(fixtureCase);
  const appealCard = moderatorB.page
    .locator("[data-community-appeals] .community-case")
    .filter({ hasText: `Case ${fixtureCase.id}` });
  await appealCard.waitFor();
  await appealCard.locator("select").selectOption("overturned");
  await appealCard
    .locator("textarea")
    .fill("The message is permitted after a second review");
  await appealCard
    .getByRole("button", { name: "Save appeal decision" })
    .click();
  await appealCard.waitFor({ state: "hidden" });
  await reporter.page.getByText("A useful public comment").waitFor();
  await mobilePage.getByText("A useful public comment").waitFor();
  assert.equal(
    await reporter.page.getByText("A useful public comment").count(),
    1,
  );
  await author.page.goto(`${base}/debates/${eventSlug}`);
  await showChat(author.page);
  await author.page.getByText("A useful public comment").waitFor();
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    // The HTTPS write commits, its response is lost, and the live stream plus
    // authenticated reconciliation must resolve the optimistic row exactly once.
    await author.page.getByText("Live updates on", { exact: true }).waitFor();
    await pool.query<never>(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '20 seconds' WHERE debate_id=$1",
      [eventId],
    );
    let lostConfirmation = false;
    await author.page.route(
      `**/api/community/events/${eventId}/chat`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 201);
        lostConfirmation = true;
        await route.abort("failed");
      },
    );
    await author.page
      .locator("[data-community-chat-form] textarea")
      .fill("Stream resolves lost confirmation");
    await author.page.locator("[data-community-chat-form] button").click();
    await mobilePage
      .getByText("Stream resolves lost confirmation", { exact: true })
      .waitFor();
    await author.page
      .locator("[data-message-id]")
      .filter({ hasText: "Stream resolves lost confirmation" })
      .waitFor();
    assert.equal(lostConfirmation, true);
    await author.page.waitForFunction(
      () =>
        [...document.querySelectorAll(".community-message-body")].filter(
          (node) => node.textContent === "Stream resolves lost confirmation",
        ).length === 1,
    );
    assert.equal(
      await author.page
        .getByText("Stream resolves lost confirmation", { exact: true })
        .count(),
      1,
    );
    const accepted = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM event_chat_messages WHERE debate_id=$1 AND body=$2",
      [eventId, "Stream resolves lost confirmation"],
    );
    assert.equal(accepted.rows[0]!.count, 1);
    await author.page.unroute(`**/api/community/events/${eventId}/chat`);
  }
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
  assert.deepEqual(await axeViolations(mobilePage, "[data-arena]"), []);
  assert.deepEqual(
    await axeViolations(mobilePage, "[data-community-event]"),
    [],
  );
  const touchTargets = await mobilePage
    .locator(".community-message-actions button")
    .evaluateAll((buttons) =>
      buttons.map((button) => ({
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      })),
    );
  assert.ok(
    touchTargets.length > 0 &&
      touchTargets.every((target) => target.width >= 44 && target.height >= 44),
    "mobile emulation uses 44px message actions",
  );
  const mobileConsent = mobilePage.getByRole("button", {
    name: "Reject all",
    exact: true,
  });
  if (await mobileConsent.isVisible()) await mobileConsent.click();
  await mobilePage.screenshot({
    path: `${artifactDir}/community-mobile.png`,
    fullPage: true,
  });
  await reporter.context.setOffline(true);
  await pool.query<never>(
    `INSERT INTO event_chat_messages (debate_id, author_user_id, body)
     SELECT $1, $2, 'Backlog ' || value FROM generate_series(1, 55) AS value`,
    [eventId, author.userId],
  );
  await reporter.context.setOffline(false);
  await reporter.page.getByText("Backlog 55", { exact: true }).waitFor();
  const backlog = await reporter.page
    .locator(
      "[data-community-messages] [data-message-id] .community-message-body",
    )
    .allTextContents();
  assert.deepEqual(
    backlog.filter((text) => text.startsWith("Backlog ")),
    Array.from({ length: 55 }, (_, index) => `Backlog ${index + 1}`),
  );
  await reporter.page.locator("[data-community-messages]").evaluate((node) => {
    node.scrollTop = 0;
  });
  await pool.query<never>(
    "INSERT INTO event_chat_messages (debate_id, author_user_id, body) VALUES ($1, $2, 'Latest while reading')",
    [eventId, author.userId],
  );
  await reporter.page
    .getByRole("button", { name: /new message.*Jump to latest/ })
    .waitFor();
  assert.ok(
    (await reporter.page
      .locator("[data-community-messages]")
      .evaluate((node) => node.scrollTop)) < 50,
  );
  await reporter.page
    .getByRole("button", { name: /new message.*Jump to latest/ })
    .click();
  assert.equal(
    await reporter.page
      .getByText("Latest while reading", { exact: true })
      .count(),
    1,
  );
  const archiveContext = await browser.newContext({ bypassCSP: true });
  const archivePage = await archiveContext.newPage();
  await archivePage.goto(`${base}/debates/${eventSlug}`);
  await showChat(archivePage);
  await archivePage
    .locator("[data-community-older]")
    .waitFor({ state: "visible" });
  await archivePage.locator("[data-community-older]").click();
  await archivePage.getByText("Backlog 1", { exact: true }).waitFor();
  await pool.query<never>(
    "INSERT INTO event_chat_messages (debate_id, author_user_id, body) VALUES ($1, $2, 'After history load')",
    [eventId, author.userId],
  );
  await archivePage.getByText("After history load", { exact: true }).waitFor();
  assert.equal(
    await archivePage.getByText("Backlog 1", { exact: true }).count(),
    1,
  );
  let stalePage: Page | undefined;
  let releaseHistory!: () => void;
  let historyCaptured!: () => void;
  let staleMessageId: string | undefined;
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    const staleContext = await browser.newContext({ bypassCSP: true });
    stalePage = await staleContext.newPage();
    await stalePage.addInitScript(() => {
      window.__communityTrialFrames = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args: ConstructorParameters<typeof EventSource>) {
          super(...args);
          this.addEventListener("community", (event: MessageEvent<string>) => {
            window.__communityTrialFrames.push(JSON.parse(event.data));
          });
        }
      };
    });
    await stalePage.goto(`${base}/debates/${eventSlug}`);
    await showChat(stalePage);
    await stalePage.getByText("Live updates on", { exact: true }).waitFor();
    const captured = new Promise<void>((resolve) => {
      historyCaptured = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    await stalePage.route(
      `**/api/community/events/${eventId}/chat?before=*`,
      async (route) => {
        const response = await route.fetch();
        const body: { items: { id: string; body: string | null }[] } =
          await response.json();
        assert.ok(
          body.items.some((m) => m.body === "Backlog 1"),
          "held history contains pre-removal content",
        );
        staleMessageId = body.items.find((m) => m.body === "Backlog 1")!.id;
        historyCaptured();
        await release;
        await route.fulfill({ response });
      },
    );
    await stalePage.locator("[data-community-older]").click();
    await captured;
  }
  const oldMessage = reporter.page
    .locator("[data-community-messages] [data-message-id]")
    .filter({ hasText: "Backlog 1" })
    .first();
  await oldMessage.getByRole("button", { name: "Report message" }).click();
  await oldMessage.locator("form select").selectOption("spam");
  await oldMessage.locator("form textarea").fill(oldReportDetail);
  await oldMessage.locator("form button[type=submit]").click();
  await oldMessage.locator("form").waitFor({ state: "hidden" });
  await moderatorB.page.locator("[data-community-refresh]").click();
  const oldCase = moderatorB.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: oldReportDetail });
  await oldCase.locator("select").first().selectOption("remove_chat");
  await oldCase.locator("select").nth(1).selectOption("spam");
  await oldCase.locator("textarea").fill("Remove older reported chat message");
  const removalAt = performance.now();
  await oldCase.getByRole("button", { name: "Save decision" }).click();
  await archivePage
    .getByText("Backlog 1", { exact: true })
    .waitFor({ state: "hidden" });
  timings.moderationRemovalMs = Math.round(performance.now() - removalAt);
  if (stalePage) {
    await stalePage.waitForFunction(
      (id) =>
        window.__communityTrialFrames.some((frame) =>
          frame.changes?.some(
            (change) =>
              change.message?.id === id &&
              change.message!.state === "removed" &&
              change.message!.body === null,
          ),
        ),
      staleMessageId,
    );
    releaseHistory();
    await stalePage.locator("[data-community-older]:enabled").waitFor();
    assert.equal(
      await stalePage.getByText("Backlog 1", { exact: true }).count(),
      0,
    );
    await stalePage.unroute(`**/api/community/events/${eventId}/chat?before=*`);
    await stalePage.locator("[data-community-older]").click();
    await stalePage.getByText("Backlog 2", { exact: true }).waitFor();
    assert.equal(
      await stalePage.getByText("Backlog 1", { exact: true }).count(),
      0,
    );
    timings.healthyStreamHttpRaces =
      "PASS: lost confirmation and delayed pre-removal history";
  }
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    await reporter.page.getByText("Live updates on", { exact: true }).waitFor();
    await archivePage.getByText("Live updates on", { exact: true }).waitFor();
    await archivePage
      .locator("[data-community-chat-form] textarea")
      .fill("Draft survives event ending");
    await pool.query<never>(
      "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
      [eventId],
    );
    await archivePage
      .locator('[data-community-chat-form] button[type="submit"]:disabled')
      .waitFor();
    assert.equal(
      await archivePage
        .locator("[data-community-chat-form] textarea")
        .inputValue(),
      "Draft survives event ending",
    );
    assert.equal(
      await reporter.page
        .getByText("After history load", { exact: true })
        .count(),
      1,
    );
    await pool.query<never>(
      "UPDATE topics SET publication_state='draft' WHERE id=$1",
      [topicId],
    );
    await archivePage
      .getByText("This event is no longer public.", { exact: true })
      .waitFor();
    assert.equal(await archivePage.locator("[data-message-id]").count(), 0);
    await pool.query<never>(
      "UPDATE topics SET publication_state='published' WHERE id=$1",
      [topicId],
    );
    await pool.query<never>("UPDATE debates SET status='live' WHERE id=$1", [
      eventId,
    ]);
  }
  const overlay = await mobilePage.goto(`${base}/overlay/${eventSlug}`);
  assert.equal(overlay!.status(), 200);
  assert.equal(
    await mobilePage
      .getByText("No winner or official support is shown")
      .count(),
    1,
  );
  const qr = await mobilePage.goto(`${base}/debates/${eventSlug}/qr.svg`);
  assert.equal(qr!.status(), 200);
  assert.match(qr!.headers()["content-type"]!, /image\/svg\+xml/);
  await verifyChatClient({ browser, base, eventSlug, eventId, artifactDir });
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      base,
      viewport: { desktop: "1280x720 or default", mobile: "390x844 emulation" },
      timings,
      result: "Community browser journeys verified at desktop and mobile sizes",
    }),
  );
} catch (error) {
  console.error(
    "Community browser trial failed:",
    (error as { message?: string }).message,
  );
  throw error;
} finally {
  if (browser) await browser.close();
  try {
    await pool.query<never>(
      "DELETE FROM moderation_cases WHERE debate_id = $1",
      [eventId],
    );
    await pool.query<never>(
      "DELETE FROM event_chat_messages WHERE debate_id = $1",
      [eventId],
    );
    await pool.query<never>(
      "DELETE FROM event_like_changes WHERE debate_id = $1",
      [eventId],
    );
    await pool.query<never>("DELETE FROM event_likes WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query<never>(
      "DELETE FROM event_chat_controls WHERE debate_id = $1",
      [eventId],
    );
    await pool.query<never>("DELETE FROM debates WHERE id = $1", [eventId]);
    if (topicId)
      await pool.query<never>("DELETE FROM topics WHERE id = $1", [topicId]);
    await pool.query<never>(
      "DELETE FROM community_room_events WHERE room_id=$1",
      [eventId],
    );
    await pool.query<never>("DELETE FROM community_rooms WHERE room_id=$1", [
      eventId,
    ]);
    for (const id of accounts) {
      await pool.query<never>("DELETE FROM sessions WHERE user_id = $1", [id]);
      await pool.query<never>(
        "DELETE FROM public_profiles WHERE user_id = $1",
        [id],
      );
      await pool.query<never>("DELETE FROM account_roles WHERE user_id = $1", [
        id,
      ]);
      await pool.query<never>(
        "DELETE FROM identity_audit_events WHERE user_id = $1",
        [id],
      );
      await pool.query<never>("DELETE FROM users WHERE id = $1", [id]);
    }
  } finally {
    await pool.end();
  }
}
