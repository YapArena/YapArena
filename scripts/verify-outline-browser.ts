import type { Browser, Page } from "playwright-core";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  PublicDebate,
  PublicTopic,
} from "../src/features/discovery/public-types.ts";
import type { OutlineSnapshot } from "../src/features/outline/public-types.ts";
import type { OutlineEdit } from "../src/features/outline/reducer.ts";
/* global document, window */
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { chromium } from "playwright-core";
import { renderDebate } from "../dist/features/discovery/web.js";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";
import {
  createOutlineFlagRouter,
  createOutlineRouter,
} from "../dist/features/outline/router.js";

// Decision 0012: the AI outline panel in Chrome with synthetic LiveKit
// messages. It serves the built browser modules and the real outline routes
// over an in-memory store; no database, LiveKit or model is involved, and it
// refuses nothing because it reaches nothing hosted.

type Edit = OutlineEdit;
// The fixture routes call only getDebate on the discovery repository.
type DiscoveryOptions = Parameters<typeof createDiscoveryRouter>[0];
type CreateFixtureRouter = (
  options: Omit<DiscoveryOptions, "discovery"> & {
    discovery: Pick<DiscoveryOptions["discovery"], "getDebate">;
  },
) => ReturnType<typeof createDiscoveryRouter>;
declare global {
  interface Window {
    harness: {
      reads: string[];
      emit(message: unknown): void;
      attachSpeaker(): void;
    };
  }
}
const debateId = "22222222-2222-4222-8222-222222222222";
const topic: PublicTopic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "energy",
  title: "Energy",
  summary: "Synthetic outline fixture.",
  sideALabel: "For",
  sideBLabel: "Against",
  isDemo: false,
  createdAt: new Date(),
};
const debate: PublicDebate = {
  id: debateId,
  slug: "keep-nuclear",
  proposition: "Faut-il garder le nucléaire ?",
  status: "live",
  rulesVersion: "prototype-media-1",
  scheduledAt: null,
  liveStartedAt: new Date(),
  liveEndedAt: null,
  isDemo: false,
  createdAt: new Date(),
  topic,
  speakerA: { handle: "maya", displayName: "Maya" },
  speakerB: { handle: "jonah", displayName: "Jonah" },
  sponsor: null,
};
const span = { startMs: 0, endMs: 1000 };
const add = (turn: number, index: number, label: string): Edit => ({
  op: "add_argument",
  id: `t${turn}a${index}`,
  label,
  span,
});
const point = (argument: string, index: number, text: string): Edit => ({
  op: "add_point",
  argument,
  id: `${argument}p${index}`,
  text,
  span,
});
// The server's store: version 1 (turn 1, side B, English) and later versions
// published by the test.
const versions: {
  version: number;
  turnNumber: number;
  side: "A" | "B";
  language: "fr" | "en";
  edits: Edit[];
}[] = [
  {
    version: 1,
    turnNumber: 1,
    side: "B",
    language: "en",
    edits: [add(1, 1, "Renewables are cheaper")],
  },
  {
    version: 2,
    turnNumber: 2,
    side: "A",
    language: "fr",
    edits: [
      add(2, 1, "Le nucléaire est pilotable"),
      point("t2a1", 1, "Production stable jour et nuit"),
    ],
  },
];
const snapshot = (): OutlineSnapshot => ({
  kind: "snapshot",
  debateId,
  version: 2,
  current: {
    turnNumber: 2,
    side: "A",
    language: "fr",
    arguments: [
      {
        id: "t2a1",
        label: "Le nucléaire est pilotable",
        span,
        points: [
          { id: "t2a1p1", text: "Production stable jour et nuit", span },
        ],
        lastPoint: 1,
        rebuts: null,
      },
    ],
  },
  turns: [
    {
      turnNumber: 1,
      side: "B",
      language: "en",
      arguments: [
        {
          id: "t1a1",
          label: "Renewables are cheaper",
          rebuts: null,
          continues: null,
        },
      ],
      final: true,
    },
  ],
  flags: [],
  finals: 1,
});
const flags: string[] = [];
const outlines = {
  isPublic: async (id: string) => id === debateId,
  snapshot: async () => snapshot(),
  since: async (_id: string, after: number) => {
    const head = versions.at(-1)!.version;
    return {
      kind: "edits" as const,
      debateId,
      from: after,
      version: head,
      versions: versions.filter((v) => v.version > after),
    };
  },
  flag: async (input: { itemId: string }) => {
    flags.push(input.itemId);
    return { side: "A" as const };
  },
};

let browser: Browser | undefined, server: Server | undefined;
try {
  const app = express();
  app.use(express.json());
  app.use(
    "/assets",
    express.static(new URL("../public/", import.meta.url).pathname),
  );
  app.use(createOutlineRouter(outlines));
  app.use(
    createOutlineFlagRouter(outlines, (request, _response, next) => {
      request.user = { id: "7", email: null, createdAt: new Date() };
      next();
    }),
  );
  // The panel exactly as the debate page renders it, without the page's
  // other modules, driven by a fake LiveKit Room.
  const page = renderDebate("http://localhost", debate, false, null, false, {
    state: snapshot(),
  });
  const panel = /<section class="live-outline"[\s\S]*?<\/section>/.exec(
    page,
  )![0];
  app.get("/harness", (_request, response) =>
    response.type("html")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/live-outline.css">
</head><body><main style="max-width:640px;margin:0 auto;padding:16px">${panel}</main>
<script type="module">
import { createLiveOutline } from "/assets/live-outline.js";
const listeners = [];
const fakeRoom = (identity, metadata) => ({
  on(event, callback) { if (event === "dataReceived") listeners.push(callback); },
  async disconnect() {},
  localParticipant: { identity, metadata },
});
const reads = [];
window.harness = {
  reads,
  outline: createLiveOutline(document.querySelector("[data-live-outline]"), {
    async fetchJson(path) { reads.push(path); return (await fetch(path)).json(); },
    async post(path, body) {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    },
    connectData: async () => fakeRoom("viewer-1", ""),
    events: window,
    random: () => 0,
    setTimer: (callback, ms) => setTimeout(callback, Math.min(ms, 50)),
    visible: () => !document.hidden,
  }),
  emit(message) {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    for (const listener of listeners) listener(payload, undefined, undefined, "yap.outline.v1");
  },
  attachSpeaker() {
    window.harness.outline.attach(fakeRoom("speaker-7", JSON.stringify({ side: "A" })));
  },
};
</script></body></html>`),
  );
  app.use(
    (createDiscoveryRouter as CreateFixtureRouter)({
      discovery: {
        getDebate: async (slug) => (slug === debate.slug ? debate : null),
      },
      mediaEnabled: true,
      applicationOrigin: "http://localhost",
      liveOutline: { snapshot: async () => snapshot() },
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const results: Record<string, unknown> = {};
  const message = (version: number, edits: Edit[], turnNumber = 2) => ({
    v: 1,
    type: "edits",
    debateId,
    version,
    turnNumber,
    side: turnNumber % 2 ? "B" : "A",
    language: turnNumber % 2 ? "en" : "fr",
    edits,
  });
  const publish = (version: number, edits: Edit[], turnNumber = 2) =>
    versions.push({
      version,
      turnNumber,
      side: turnNumber % 2 ? "B" : "A",
      language: turnNumber % 2 ? "en" : "fr",
      edits,
    });

  async function open(reducedMotion: "reduce" | "no-preference", width = 1280) {
    const context = await browser!.newContext({
      viewport: { width, height: 900 },
      reducedMotion,
    });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    const requests: string[] = [];
    tab.on("request", (request) => requests.push(request.url()));
    await tab.goto(`${base}/harness`);
    await tab.waitForFunction(() => window.harness?.reads.length === 1);
    return { tab, errors, requests };
  }
  const labels = (tab: Page) =>
    tab.$$eval(".live-outline-arguments .live-outline-label-text", (nodes) =>
      nodes.map((node) => node.textContent),
    );

  // 1. The page's initial state paints with no request, then the data-only
  //    connection fetches once what it may have missed.
  const live = await open("no-preference");
  assert.deepEqual(await labels(live.tab), ["Le nucléaire est pilotable"]);
  assert.equal(
    await live.tab.textContent("[data-live-outline-turn]"),
    "Turn 2 · Maya (For)",
  );
  assert.equal(
    await live.tab.getAttribute("[data-live-outline-arguments]", "lang"),
    "fr",
  );
  assert.equal(await live.tab.isVisible("[data-live-outline-earlier]"), true);
  results.initialReads = live.requests.filter((u) =>
    u.includes("/api/public/debates/"),
  ).length;
  assert.equal(results.initialReads, 1);

  // 2. Live versions apply from LiveKit with no HTTP request, touching only
  //    the changed nodes.
  const box = await live.tab.locator(".live-outline").boundingBox();
  await live.tab.evaluate(() => {
    (
      document.querySelector('[data-id="t2a1"]') as HTMLElement & {
        marked?: boolean;
      }
    ).marked = true;
  });
  const before = live.requests.length;
  const started = Date.now();
  let version = 2;
  const updates: Edit[][] = [
    [point("t2a1", 2, "Faibles émissions de CO2")],
    [
      {
        op: "update_argument",
        id: "t2a1",
        label: "Le nucléaire est pilotable et bas carbone",
        span,
      },
    ],
    [
      add(2, 2, "Les renouvelables ne suffisent pas"),
      point("t2a2", 1, "Il faut du stockage"),
    ],
    [{ op: "link_rebuttal", id: "t2a2", target: "t1a1" }],
    [
      add(2, 3, "Il faut prolonger les réacteurs"),
      point("t2a3", 1, "Ils sont déjà amortis"),
      point("t2a3", 2, "La sûreté est contrôlée"),
      point("t2a3", 3, "Le personnel est formé"),
    ],
    [
      add(2, 4, "Le coût du démantèlement est connu"),
      point("t2a4", 1, "Il est provisionné"),
      point("t2a4", 2, "Les audits le confirment"),
    ],
  ];
  for (const edits of updates) {
    version++;
    publish(version, edits);
    await live.tab.evaluate(
      (value) => window.harness.emit(value),
      message(version, edits),
    );
  }
  await live.tab.waitForFunction(
    () =>
      document.querySelectorAll(".live-outline-arguments > li").length === 4,
  );
  results.applyMs = Date.now() - started;
  assert.equal(live.requests.length, before, "zero requests per live update");
  assert.equal(
    await live.tab.evaluate(
      () =>
        (
          document.querySelector('[data-id="t2a1"]') as HTMLElement & {
            marked?: boolean;
          }
        ).marked,
    ),
    true,
    "the unchanged argument's node is kept",
  );
  assert.equal(
    await live.tab.textContent('[data-id="t2a2"] .live-outline-rebuts'),
    "Rebuts: Renewables are cheaper",
  );
  assert.ok(
    (
      await live.tab.locator('[data-id="t2a1p2"]').getAttribute("class")
    )?.includes("is-changed"),
    "a changed point is highlighted",
  );
  const after = await live.tab.locator(".live-outline").boundingBox();
  assert.equal(after!.height, box!.height, "the panel never changes height");
  assert.ok(
    await live.tab.$eval(
      ".live-outline-body",
      (node) => node.scrollHeight > node.clientHeight,
    ),
    "the outline scrolls inside the panel",
  );
  await live.tab.waitForFunction(() =>
    document
      .querySelector("[data-live-outline-announce]")!
      .textContent!.startsWith("New argument"),
  );
  results.announcement = await live.tab.textContent(
    "[data-live-outline-announce]",
  );

  // 3. A gap is repaired with exactly one catch-up request.
  version++;
  publish(version, [point("t2a2", 2, "Le stockage coûte cher")]);
  version++;
  publish(version, [point("t2a2", 3, "Les batteries vieillissent")]);
  const reads = live.requests.filter((u) =>
    u.includes("/api/public/debates/"),
  ).length;
  await live.tab.evaluate(
    (value) => window.harness.emit(value),
    message(version, [point("t2a2", 3, "Les batteries vieillissent")]),
  );
  await live.tab.waitForSelector('[data-id="t2a2p3"]');
  assert.equal(
    live.requests.filter((u) => u.includes("/api/public/debates/")).length,
    reads + 1,
    "one catch-up for a gap",
  );
  assert.equal(await live.tab.isVisible('[data-id="t2a2p2"]'), true);

  // 4. The next turn moves the finished one to the earlier turns.
  version++;
  publish(version, [add(3, 1, "Storage is getting cheaper")], 3);
  await live.tab.evaluate(
    (value) => window.harness.emit(value),
    message(version, [add(3, 1, "Storage is getting cheaper")], 3),
  );
  await live.tab.waitForFunction(() =>
    document
      .querySelector("[data-live-outline-turn]")!
      .textContent!.startsWith("Turn 3"),
  );
  assert.deepEqual(await labels(live.tab), ["Storage is getting cheaper"]);
  assert.equal(
    await live.tab.getAttribute("[data-live-outline-arguments]", "lang"),
    "en",
  );
  assert.equal(
    await live.tab.locator("[data-live-outline-turns] > li").count(),
    2,
  );

  // 5. Flag buttons appear only for the speaker's own items.
  assert.equal(await live.tab.locator(".live-outline-flag:visible").count(), 0);
  await live.tab.evaluate(() => window.harness.attachSpeaker());
  assert.equal(
    await live.tab.locator(".live-outline-flag:visible").count(),
    0,
    "side A sees no button on side B's turn",
  );
  await live.tab
    .locator(".live-outline-flag")
    .first()
    .evaluate((node) => {
      (node as HTMLElement).hidden = false;
    });
  assert.deepEqual(live.errors, []);
  await live.tab.context().close();

  // 6. Reduced motion: a changed item gets no animation (the class still
  //    marks it). A fresh page has caught up to turn 3 by now.
  const animation = async (reducedMotion: "reduce" | "no-preference") => {
    const view = await open(reducedMotion);
    await view.tab.waitForSelector('[data-id="t3a1"]');
    const name = await view.tab.$eval('[data-id="t3a1"]', (node) => {
      node.classList.add("is-changed");
      return getComputedStyle(node).animationName;
    });
    await view.tab.context().close();
    return name;
  };
  results.reducedMotion = await animation("reduce");
  assert.equal(results.reducedMotion, "none");
  assert.equal(await animation("no-preference"), "live-outline-flash");

  // 7. Phone width: no horizontal overflow.
  const phone = await open("no-preference", 375);
  assert.ok(
    await phone.tab.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await phone.tab.context().close();

  // 8. The real debate page renders the panel and paints its initial state
  //    from the embedded snapshot.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const tab = await context.newPage();
  await tab.goto(`${base}/debates/${debate.slug}`);
  await tab.waitForFunction(
    () =>
      document.querySelectorAll(".live-outline-arguments > li").length === 1,
  );
  assert.equal(await tab.locator("[data-live-captions]").count(), 1);
  // The heading is set in Dydema Capitals; its accessible name stays.
  assert.equal(
    await tab.getByRole("heading", { name: "AI outline" }).count(),
    1,
  );
  await context.close();

  console.log(JSON.stringify({ outlineBrowser: "PASS", ...results }));
} finally {
  await browser?.close();
  server?.close();
}
