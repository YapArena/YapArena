/* global window, document, KeyboardEvent, CompositionEvent */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import axe from "axe-core";
import type { Browser, Page, ViewportSize } from "playwright-core";
import type { publicFrame } from "../dist/features/community/delivery.js";

declare global {
  interface Window {
    axe: typeof axe;
    chatConfirmationAnnouncements: number;
    originalPendingRow: Element | SVGElement;
    __communityTrialFrames: ReturnType<typeof publicFrame>[];
  }
}
interface FixtureMessage {
  id: string;
  debateId: string;
  clientMessageId: string | null;
  body: string;
  authorName: string;
  state: "visible" | "removed";
  revision: string;
  createdAt: string;
}
interface PostPayload {
  body: string;
  clientMessageId: string;
}
interface PostOutcome {
  abort?: boolean;
  status?: number;
  json?: object;
  headers?: Record<string, string>;
}
interface PendingPost {
  payload: PostPayload;
  item: FixtureMessage;
  release: (value: PostOutcome) => void;
}

// Deterministic real-browser transport races. All content and responses are synthetic.

// The like, share and refresh controls sit in the chat's "⋯" menu (debate
// page direction BC1).
async function openChatMenu(page: Page) {
  const menu = page.locator("[data-chat-more]");
  if (!(await menu.evaluate((node: HTMLDetailsElement) => node.open)))
    await menu.locator("summary").click();
}

export async function verifyChatClient({
  browser,
  base,
  eventSlug,
  eventId,
  artifactDir,
}: {
  browser: Browser;
  base: string;
  eventSlug: string;
  eventId: string;
  artifactDir: string;
}) {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
  });
  // This deterministic prerequisite fixture intentionally exercises degraded polling.
  await context.route(`**/api/community/events/${eventId}/stream*`, (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let nextId = 9007199254740993n;
  const feed: FixtureMessage[] = [];
  const posts: PendingPost[] = [];
  const cursors: (string | null)[] = [];
  let nextCursor = 0n;
  const log: { cursor: string; id: string }[] = [];
  const versions = new Map<string, { fingerprint: string; cursor: string }>();
  let fixtureAccount = "synthetic";
  const submissionOwners = new Map<string, string>();
  let heldReconciliation: {
    promise: Promise<void>;
    entered(): void;
    release(): void;
  } | null = null;
  function capture() {
    for (const item of feed) {
      const fingerprint = `${item.state}:${item.revision}:${item.body}`;
      if (versions.get(item.id)?.fingerprint !== fingerprint) {
        const cursor = String(++nextCursor);
        versions.set(item.id, { fingerprint, cursor });
        log.push({ cursor, id: item.id });
      }
    }
  }
  function publicItem(item: FixtureMessage) {
    return {
      ...item,
      body: item.state === "removed" ? null : item.body,
      clientMessageId: null,
      streamRevision: versions.get(item.id)?.cursor ?? "0",
    };
  }
  function summary() {
    return {
      likes: "0",
      chatState: "open",
      chatWritable: true,
      eventStatus: "live",
      revision: String(nextCursor),
    };
  }

  let disconnected = false;
  function message(
    body: string,
    clientMessageId: string | null = null,
  ): FixtureMessage {
    const item: FixtureMessage = {
      id: String(nextId++),
      debateId: eventId,
      clientMessageId,
      body,
      authorName: "Synthetic participant with a long readable author name",
      state: "visible",
      revision: "0",
      createdAt: "2026-10-06T12:00:00Z",
    };
    return item;
  }
  for (let n = 1; n <= 60; n++)
    feed.push(
      message(`History ${n}\nPlain text <strong>is not HTML</strong>.`),
    );
  const initialCursor = feed.at(-1)!.id;
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: { id: fixtureAccount, email: null } } }),
  );
  await page.route(`**/api/community/events/${eventId}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/chat") && request.method() === "POST") {
      const payload: PostPayload = request.postDataJSON();
      let release!: (value: PostOutcome) => void;
      const outcome = new Promise<PostOutcome>((resolve) => {
        release = resolve;
      });
      const post = {
        payload,
        item: message(payload.body, payload.clientMessageId),
        release,
      };
      submissionOwners.set(post.item.id, fixtureAccount);
      posts.push(post);
      const result = await outcome;
      if (result.abort) await route.abort("failed");
      else
        await route.fulfill({
          status: result.status ?? 201,
          json: result.json ?? post.item,
          headers: result.headers ?? {},
        });
      return;
    }
    if (url.pathname.endsWith("/stream")) return route.abort();
    if (
      disconnected &&
      (url.pathname.includes("/chat") || url.pathname.endsWith("/updates"))
    )
      return route.abort("internetdisconnected");
    if (url.pathname.endsWith("/updates")) {
      capture();
      const raw = url.searchParams.get("cursor");
      const after = raw ? BigInt(raw.split(":")[2]!) : null;
      const events = log
        .filter((e) => after !== null && BigInt(e.cursor) > after)
        .slice(0, 10);
      const cursor =
        after === null
          ? String(nextCursor)
          : (events.at(-1)?.cursor ?? String(after));
      const items = feed.filter((item) => item.state === "visible");
      cursors.push(
        ...(after === null
          ? items.slice(-10)
          : events.map((e) => feed.find((item) => item.id === e.id)!)
        ).map((item) => item.id),
      );
      return route.fulfill({
        json: {
          version: 1,
          roomId: eventId,
          cursor: `v1:${eventId}:${cursor}`,
          kind: after === null ? "snapshot" : "changes",
          snapshot:
            after === null
              ? {
                  summary: summary(),
                  items: items.slice(-10).map(publicItem),
                  hasMore: items.length > 10,
                }
              : undefined,
          changes:
            after === null
              ? undefined
              : events.map((e) => ({
                  type: "message",
                  message: publicItem(feed.find((item) => item.id === e.id)!),
                  summary: summary(),
                })),
          more: BigInt(cursor) < nextCursor,
        },
      });
    }
    if (url.pathname.endsWith("/chat/submissions")) {
      const keys = new Set((url.searchParams.get("keys") || "").split(","));
      const account = fixtureAccount;
      const items = feed
        .filter(
          (item) =>
            keys.has(item.clientMessageId!) &&
            submissionOwners.get(item.id) === account,
        )
        .map((item) => ({
          ...publicItem(item),
          clientMessageId: item.clientMessageId,
        }));
      const gate = heldReconciliation;
      if (gate) {
        gate.entered();
        await gate.promise;
      }
      return route.fulfill({
        json: items,
      });
    }
    if (url.pathname.endsWith("/chat/sync")) {
      const after = url.searchParams.get("after");
      cursors.push(after);
      const items = feed.filter(
        (item) => item.state === "visible" && BigInt(item.id) > BigInt(after!),
      );
      const watched = new Set((url.searchParams.get("watch") || "").split(","));
      const allWatched = feed.filter((item) => watched.has(item.id));
      return route.fulfill({
        json: {
          items: items.slice(0, 50),
          hasMore: items.length > 50,
          watched: allWatched.filter((item) => item.state === "visible"),
          removed: allWatched
            .filter((item) => item.state === "removed")
            .map((item) => ({ ...item, body: null })),
        },
      });
    }
    if (url.pathname.endsWith("/chat")) {
      const before = url.searchParams.get("before");
      const items = feed.filter(
        (item) =>
          item.state === "visible" &&
          (!before || BigInt(item.id) < BigInt(before)),
      );
      return route.fulfill({
        json: { items: items.slice(-50), hasMore: items.length > 50 },
      });
    }
    return route.fulfill({
      json: { likes: 0, liked: false, chatState: "open", chatWritable: true },
    });
  });
  const composer = page.locator("[data-community-chat-form] textarea");
  const rows = page.locator(".community-message");
  const refresh = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.url().includes("/updates") && response.status() === 200,
    );
    await openChatMenu(page);
    await page.locator("[data-community-refresh]").click();
    await response;
    // Close the menu so it doesn't cover the messages.
    await page
      .locator("[data-chat-more]")
      .evaluate((node: HTMLDetailsElement) => {
        node.open = false;
      });
  };
  const waitPost = async (count: number) => {
    for (let n = 0; n < 100 && posts.length < count; n++) await delay(20);
    assert.equal(posts.length, count);
    return posts[count - 1]!;
  };
  const send = async (body: string, count: number) => {
    await composer.fill(body);
    await composer.press("Enter");
    const post = await waitPost(count);
    assert.match(
      post.payload.clientMessageId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/,
    );
    const row = page.locator(
      `[data-submission-id="${post.payload.clientMessageId}"]`,
    );
    await row
      .locator(".community-message-delivery")
      .getByText("Sending…")
      .waitFor();
    assert.equal(await composer.inputValue(), "");
    assert.equal(
      await composer.evaluate((node) => document.activeElement === node),
      true,
    );
    assert.equal(await composer.isEditable(), true);
    return { post, row };
  };
  try {
    await page.goto(`${base}/debates/${eventSlug}`);
    await page.getByText("Polling updates on", { exact: false }).waitFor();
    const consent = page.getByRole("button", { name: "Not now", exact: true });
    if (await consent.isVisible()) await consent.click();
    assert.equal(await rows.count(), 10);
    await page.locator("[data-community-older]").click();
    await page
      .locator(".community-message-body")
      .filter({ hasText: /^History 1\n/ })
      .waitFor();
    assert.equal(await rows.count(), 60);
    assert.equal(
      await rows.locator(".community-message-body strong").count(),
      0,
      "user content remains text",
    );
    assert.equal(
      await page.locator("[data-community-messages]").getAttribute("aria-live"),
      null,
    );
    await page.locator("[data-community-messages]").evaluate((node) => {
      node.scrollTop = 0;
    });
    const topBefore = await page
      .locator("[data-community-messages]")
      .evaluate((node) => node.scrollTop);
    await page.evaluate(() => {
      window.chatConfirmationAnnouncements = 0;
      const live = document.querySelector("[data-community-send-status]")!;
      new window.MutationObserver(() => {
        if (live.textContent === "Message sent.")
          window.chatConfirmationAnnouncements++;
      }).observe(live, { childList: true });
    });
    const gap = message(
      "A preceding message must not be skipped by a POST cursor",
    );
    const responseFirst = await send("Response first", 1);
    await responseFirst.row.evaluate((node) => {
      window.originalPendingRow = node;
    });
    await composer.fill("Text typed during the request");
    await composer.press("Shift+Enter");
    assert.equal(
      await composer.inputValue(),
      "Text typed during the request\n",
    );
    await openChatMenu(page);
    await page.locator("[data-community-like]").focus();
    feed.push(gap, responseFirst.post.item);
    responseFirst.post.release({});
    await responseFirst.row
      .locator(".community-message-delivery")
      .getByText("Sent", { exact: true })
      .waitFor();
    assert.equal(
      await composer.inputValue(),
      "Text typed during the request\n",
    );
    assert.equal(
      await page
        .locator("[data-community-like]")
        .evaluate((node) => document.activeElement === node),
      true,
      "late acknowledgment does not steal focus",
    );
    assert.equal(
      await responseFirst.row.evaluate(
        (node) => node === window.originalPendingRow,
      ),
      true,
    );
    await page.getByText(gap.body, { exact: true }).waitFor();
    assert.ok(
      cursors.includes(initialCursor),
      "cursor comes from reads, never POST",
    );
    assert.ok(
      (await page
        .locator("[data-community-messages]")
        .evaluate((node) => node.scrollTop)) <=
        topBefore + 2,
    );
    assert.match(
      (await page.locator("[data-community-new]").textContent())!,
      /^1 new message/,
    );

    const feedFirst = await send("Feed first", 2);
    feed.push(feedFirst.post.item);
    await refresh();
    await feedFirst.row
      .locator(".community-message-delivery")
      .getByText("Sent", { exact: true })
      .waitFor();
    await composer.fill("Keep this active draft");
    feedFirst.post.release({
      status: 503,
      json: { error: "Late ambiguous failure" },
    });
    await refresh();
    assert.equal(
      await page
        .locator(`[data-message-id="${feedFirst.post.item.id}"]`)
        .count(),
      1,
    );
    assert.equal(await composer.inputValue(), "Keep this active draft");
    assert.equal(
      await feedFirst.row
        .getByText("Delivery unconfirmed", { exact: false })
        .count(),
      0,
    );
    assert.match(
      (await page.locator("[data-community-new]").textContent())!,
      /^1 new message/,
      "confirming a local row does not increment unread",
    );

    assert.equal(
      await page.evaluate(() => window.chatConfirmationAnnouncements),
      2,
      "each submission announces confirmation once across feed/POST races",
    );
    const lost = await send("Committed but acknowledgment lost", 3);
    await composer.fill("New draft while delivery fails");
    lost.post.release({ abort: true });
    await lost.row
      .getByText("Delivery unconfirmed", { exact: false })
      .waitFor();
    assert.equal(await composer.inputValue(), "New draft while delivery fails");
    await lost.row.getByRole("button", { name: "Recover to draft" }).click();
    assert.equal(
      await composer.inputValue(),
      "New draft while delivery fails\nCommitted but acknowledgment lost",
    );
    await lost.row.getByRole("button", { name: "Retry unchanged" }).click();
    const retried = await waitPost(4);
    assert.deepEqual(
      retried.payload,
      lost.post.payload,
      "retry reuses text and UUID",
    );
    feed.push(lost.post.item);
    retried.release({ json: lost.post.item });
    await lost.row
      .locator(".community-message-delivery")
      .getByText("Sent", { exact: true })
      .waitFor();
    assert.equal(
      await composer.inputValue(),
      "New draft while delivery fails\nCommitted but acknowledgment lost",
    );

    const moderated = await send("Moderation beats delayed response", 5);
    feed.push(moderated.post.item);
    await refresh();
    await moderated.row
      .locator(".community-message-delivery")
      .getByText("Sent", { exact: true })
      .waitFor();
    const originalAck = { ...moderated.post.item };
    moderated.post.item.state = "removed";
    moderated.post.item.revision = "1";
    await refresh();
    await moderated.row
      .getByText("Removed by moderation.", { exact: true })
      .waitFor();
    moderated.post.release({ json: originalAck });
    await refresh();
    assert.equal(
      await moderated.row.getByText(originalAck.body, { exact: true }).count(),
      0,
    );
    moderated.post.item.state = "visible";
    moderated.post.item.revision = "2";
    await refresh();
    await moderated.row.getByText(originalAck.body, { exact: true }).waitFor();

    const rejected = await send("Explicitly rejected", 6);
    await composer.fill("Newer draft survives rejection");
    rejected.post.release({
      status: 403,
      json: {
        error: "Published profile required",
        code: "CHAT_PROFILE_REQUIRED",
      },
    });
    await rejected.row.getByText("Rejected", { exact: false }).waitFor();
    const postCount = posts.length;
    disconnected = true;
    await openChatMenu(page);
    await page.locator("[data-community-refresh]").click();
    await page.getByText("Connection interrupted", { exact: false }).waitFor();
    disconnected = false;
    feed.push(message("Arrived during reconnect"));
    await refresh();
    await page.getByText("Arrived during reconnect", { exact: true }).waitFor();
    assert.equal(
      posts.length,
      postCount,
      "reconnect never sends a draft or retries a rejection",
    );
    assert.equal(await composer.inputValue(), "Newer draft survives rejection");
    await rejected.row
      .getByRole("button", { name: "Recover to draft" })
      .click();
    await composer.fill("Edited recovered text");
    await composer.press("Enter");
    const edited = await waitPost(7);
    assert.notEqual(
      edited.payload.clientMessageId,
      rejected.post.payload.clientMessageId,
    );
    edited.release({});
    feed.push(edited.item);
    await page
      .locator(`[data-submission-id="${edited.payload.clientMessageId}"]`)
      .getByText("Sent", { exact: true })
      .waitFor();

    await composer.fill("IME composition");
    await composer.evaluate((node) => {
      node.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      node.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(posts.length, 7);
    assert.equal(await composer.inputValue(), "IME composition");

    const cooled = await send("Hourly limit feedback", 8);
    cooled.post.release({
      status: 429,
      json: {
        error: "chat limit reached",
        code: "CHAT_HOURLY_LIMIT",
        retryAfterSeconds: 2,
      },
      headers: { "Retry-After": "2" },
    });
    await cooled.row
      .getByText("Waiting for posting allowance", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .locator('[data-community-chat-form] button[type="submit"]')
        .isDisabled(),
      true,
    );
    await composer.fill("Editable during cooldown");
    assert.equal(await composer.isEditable(), true);
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>(
          '[data-community-chat-form] button[type="submit"]',
        )!.disabled,
    );
    assert.equal(posts.length, 8);

    const unchangedRecovery = await send("Recover unchanged safely", 9);
    unchangedRecovery.post.release({ abort: true });
    await unchangedRecovery.row
      .getByText("Delivery unconfirmed", { exact: false })
      .waitFor();
    await unchangedRecovery.row
      .getByRole("button", { name: "Recover to draft" })
      .click();
    assert.equal(await composer.inputValue(), "Recover unchanged safely");
    await composer.press("Enter");
    const recoveredRetry = await waitPost(10);
    assert.deepEqual(
      recoveredRetry.payload,
      unchangedRecovery.post.payload,
      "sending an unchanged recovered draft also reuses the original key",
    );
    recoveredRetry.release({ json: unchangedRecovery.post.item });
    feed.push(unchangedRecovery.post.item);
    await unchangedRecovery.row.getByText("Sent", { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), "");

    // Bounded retention while a reader is at history, followed by tail reload.
    await page.locator("[data-community-messages]").evaluate((node) => {
      node.scrollTop = 0;
    });
    for (let n = 1; n <= 550; n++) feed.push(message(`Catch-up ${n}`));
    await refresh();
    for (let n = 0; n < 600 && !cursors.includes(feed.at(-1)!.id); n++)
      await delay(25);
    assert.ok(
      cursors.includes(feed.at(-1)!.id),
      "durable catch-up includes the newest server ID",
    );
    assert.ok(
      (await page
        .locator("[data-community-messages] [data-message-id]")
        .count()) <= 500,
    );
    assert.ok(
      (await page
        .locator("[data-community-messages]")
        .evaluate((node) => node.scrollTop)) < 5,
      "history remains anchored during bounded catch-up",
    );
    await page.locator("[data-community-new]").click();
    await page.getByText("Catch-up 550", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-community-new]").isVisible(), false);
    assert.equal(
      await page
        .locator("[data-community-messages]")
        .evaluate((node) => document.activeElement === node),
      true,
    );

    const long = message(`Multiline synthetic content\n${"x".repeat(470)}`);
    long.authorName = "SyntheticLongAuthor".repeat(5).slice(0, 80);
    feed.push(long);
    await refresh();
    await page.getByText(long.body, { exact: true }).waitFor();
    const screenshotPending = await send(
      "A thoughtful synthetic comment\nand a second line",
      11,
    );
    assert.equal(
      await screenshotPending.row
        .locator(".community-message-body")
        .textContent(),
      screenshotPending.post.payload.body,
    );

    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["zoom", { width: 1280, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
      ["narrow", { width: 320, height: 640 }],
      ["keyboard", { width: 390, height: 400 }],
    ] satisfies [string, ViewportSize][]) {
      if (await consent.isVisible()) await consent.click();
      await page.setViewportSize(viewport);
      await page.evaluate(
        (zoom) => {
          document.documentElement.style.zoom = zoom;
        },
        name === "zoom" ? "2" : "1",
      );
      try {
        await page.waitForFunction(
          () => {
            const list = document.querySelector("[data-community-messages]")!;
            return list.scrollHeight - list.scrollTop - list.clientHeight < 2;
          },
          undefined,
          { timeout: 5000 },
        );
      } catch {
        const gap = await page
          .locator("[data-community-messages]")
          .evaluate(
            (list) => list.scrollHeight - list.scrollTop - list.clientHeight,
          );
        throw new Error(`${name} latest-row gap after resize: ${gap}px`);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 1) {
        const wide = await page.evaluate(() =>
          Array.from(document.querySelectorAll("body *"))
            .filter(
              (node) =>
                node.getBoundingClientRect().right > window.innerWidth + 1,
            )
            .slice(0, 12)
            .map((node) => ({
              tag: node.tagName,
              class: node.className,
              right: Math.round(node.getBoundingClientRect().right),
            })),
        );
        console.log(JSON.stringify({ viewport: name, overflow, wide }));
      }
      assert.ok(overflow <= 1, `${name} horizontal overflow`);
      assert.equal(await composer.isVisible(), true);
      const panelLayout = await page
        .locator("[data-community-chat-panel]")
        .evaluate((panel) => {
          const feed = panel.querySelector("[data-community-messages]")!;
          const form = panel.querySelector("[data-community-chat-form]")!;
          return {
            feedHeight: feed.clientHeight,
            composerBottom: form.getBoundingClientRect().bottom,
            panelBottom: panel.getBoundingClientRect().bottom,
          };
        });
      assert.ok(panelLayout.feedHeight >= 48, `${name} usable feed height`);
      assert.ok(
        panelLayout.composerBottom <= panelLayout.panelBottom + 1,
        `${name} composer contained in chat panel`,
      );
      await page.evaluate((source) => window.eval(source), axe.source);
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(
            document.querySelector("[data-community-chat-panel]")!,
            {
              runOnly: {
                type: "tag",
                values: [
                  "wcag2a",
                  "wcag2aa",
                  "wcag21a",
                  "wcag21aa",
                  "wcag22aa",
                ],
              },
            },
          )
        ).violations.map((item) => ({ id: item.id, impact: item.impact })),
      );
      assert.deepEqual(violations, [], `${name} axe WCAG scan`);
      if (["desktop", "mobile"].includes(name))
        await page
          .locator("[data-arena]")
          .screenshot({ path: `${artifactDir}/chat-feedback-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    fixtureAccount = "original-chat-account";
    const originalReady = page.waitForResponse((response) =>
      response.url().endsWith("/my-like"),
    );
    await page.reload();
    await originalReady;
    await page.getByText("Polling updates on", { exact: false }).waitFor();
    const original = await send(
      "Original account pending message",
      posts.length + 1,
    );
    let releaseReconciliation!: () => void, enterReconciliation!: () => void;
    const reconciliationEntered = new Promise<void>((resolve) => {
      enterReconciliation = resolve;
    });
    heldReconciliation = {
      promise: new Promise<void>((resolve) => {
        releaseReconciliation = resolve;
      }),
      entered: enterReconciliation,
      release: () => releaseReconciliation(),
    };
    feed.push(original.post.item);
    original.post.release({ abort: true });
    await original.row
      .getByText("Delivery unconfirmed", { exact: false })
      .waitFor();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await Promise.race([
      reconciliationEntered,
      delay(10000).then(() => {
        throw new Error(
          "owned reconciliation did not reach its bounded barrier",
        );
      }),
    ]);
    fixtureAccount = "replacement-chat-account";
    const replacementReady = page.waitForResponse((response) =>
      response.url().endsWith("/my-like"),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await replacementReady;
    const beforeReplacement = posts.length;
    heldReconciliation.release();
    heldReconciliation = null;
    await delay(500);
    await original.row
      .getByText("Delivery unconfirmed", { exact: false })
      .waitFor();
    assert.equal(
      await original.row
        .getByRole("button", { name: "Retry unchanged" })
        .isDisabled(),
      true,
    );
    assert.equal(
      posts.length,
      beforeReplacement,
      "account switch never retries the old submission",
    );
    await composer.fill("Draft for the current account");
    await original.row
      .getByRole("button", { name: "Recover to draft" })
      .click();
    assert.equal(
      await composer.inputValue(),
      "Draft for the current account\nOriginal account pending message",
    );
    await composer.press("Enter");
    const reviewed = await waitPost(beforeReplacement + 1);
    assert.notEqual(
      reviewed.payload.clientMessageId,
      original.post.payload.clientMessageId,
    );
    reviewed.release({});
    await page
      .locator(`[data-submission-id="${reviewed.payload.clientMessageId}"]`)
      .getByText("Sent", { exact: true })
      .waitFor();
    fixtureAccount = "original-chat-account";
    const returnReady = page.waitForResponse((response) =>
      response.url().endsWith("/my-like"),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await returnReady;
    await original.row.getByText("Sent", { exact: true }).waitFor();
    assert.equal(
      posts.length,
      beforeReplacement + 1,
      "original account reconciles without another POST",
    );
    assert.deepEqual(errors, []);
    console.log(
      "Deterministic chat browser races, draft recovery, IME/focus, cursor/history/retention/reconnect, held old-account reconciliation, explicit new-account draft confirmation, desktop/mobile/narrow/reduced-height layouts, 200% CSS zoom and axe WCAG 2.2 checks PASS",
    );
  } finally {
    heldReconciliation?.release();
    for (const post of posts) post.release({ abort: true });
    await context.close();
  }
}
