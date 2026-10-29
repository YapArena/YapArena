import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { createSessionCheck } from "../dist/platform/auth/router.js";
import { POINTER_SETTINGS, PixelLife, SETTINGS } from "../public/pixel-life.js";
import {
  FINAL_STEP,
  FLIP_EVERY_MS,
  FLIP_MS,
  HEADLINE_PHRASES,
  NOUN_TRACK,
  PRONOUN_TRACK,
  REVEAL_END_MS,
  canAdvance,
  initialStep,
  nextMove,
  phraseAt,
  restingPositions,
} from "../public/landing-headline.js";

const discovery = {
  listTopics: async () => ({
    items: [],
    pagination: { limit: 12, offset: 0, hasMore: false },
  }),
  listDebates: async () => ({
    items: [],
    pagination: { limit: 12, offset: 0, hasMore: false },
  }),
};

function landingApp({ findUserByTokenHash = async () => null, auth0 } = {}) {
  return createApp({
    discovery,
    messages: { isReady: async () => {} },
    sessions: { findUserByTokenHash },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "https://arena.example",
    auth0,
  });
}

const member = createHash("sha256").update("member").digest("hex");
const app = landingApp({
  findUserByTokenHash: async (hash) => (hash === member ? { id: "7" } : null),
});

describe("landing page", () => {
  it("serves the landing page to readers without a session", async () => {
    const page = await request(app).get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.headers.vary, /Cookie/);
    assert.match(
      page.text,
      /<a class="landing-brand" href="\/"><img src="\/assets\/landing\/yaparena-logo\.png\?v=[0-9a-f]{12}" width="575" height="151" alt="YAP Arena"><\/a>/,
    );
    assert.match(
      page.text,
      /<div class="pixel-logo" data-pixel-logo><canvas class="aura" aria-hidden="true"><\/canvas><img id="pixel-logo" src="\/assets\/landing\/yaparena-emblem\.png\?v=[0-9a-f]{12}" width="2048" height="1715" alt=""><canvas class="bloom" aria-hidden="true"><\/canvas><canvas class="cores" aria-hidden="true"><\/canvas><\/div>/,
    );
    assert.match(page.text, /role="status" data-pixel-status/);
    assert.match(
      page.text,
      /href="\/api\/auth\/login\?connection=google&amp;return=%2Fhome" data-sign-in="google">Continue with Google</,
    );
    assert.match(
      page.text,
      /href="\/api\/auth\/login\?connection=email&amp;return=%2Fhome" data-sign-in="email">Continue with email</,
    );
    assert.match(
      page.text,
      /href="\/api\/auth\/login\?return=%2Fhome">Sign in</,
    );
    assert.match(page.text, /href="\/home">Explore debates without an account/);
    assert.match(
      page.text,
      /rel="canonical" href="https:\/\/arena\.example\/"/,
    );
    assert.match(
      page.text,
      /<script type="module" src="\/assets\/landing\.js\?v=[0-9a-f]{12}"><\/script>/,
    );
    assert.equal(page.text.match(/<h1\b/g).length, 1);
    // The landing page stands alone: no site header or homepage scripts.
    assert.doesNotMatch(
      page.text,
      /data-site-header|homepage\.bundle|measurement\.js|site\.css|account-balance/,
    );
  });

  it("renders the rotating headline, the page-load reveal and one shared container", async () => {
    const { text } = await request(app).get("/");
    assert.doesNotMatch(text, /Where ideas move/);
    const headline =
      /<h1 id="landing-title" class="landing-headline" data-headline>([\s\S]*?)<\/h1>/.exec(
        text,
      )[1];
    // Screen readers get one stable sentence; the animated lines are hidden.
    assert.match(
      headline,
      /^<span class="sr-only">Your opinions, debates, ideas and discussions matter\. Yappers matter\.<\/span>/,
    );
    assert.match(
      headline,
      /<span class="headline-line reveal" aria-hidden="true"><span class="headline-y">Y<\/span><span class="flip" data-flip="pronoun">/,
    );
    assert.match(
      headline,
      /<span class="headline-line reveal reveal-2" aria-hidden="true">matter<\/span>$/,
    );
    // The server's words match the script's tracks, trailing copies included.
    const words = (slot) =>
      [
        ...new RegExp(
          `data-flip="${slot}"><span class="flip-track">(.*?</span>)</span></span>`,
        )
          .exec(headline)[1]
          .matchAll(/<span class="flip-word">(.*?)<\/span>/g),
      ].map((match) => match[1].replace("\u00a0", ""));
    assert.deepEqual(words("pronoun"), [...PRONOUN_TRACK]);
    assert.deepEqual(words("noun"), [...NOUN_TRACK]);
    assert.match(headline, /<span class="flip-word">\u00a0opinions<\/span>/);
    // Reveal order: headline lines, then the heading, buttons and sign-in.
    for (const pattern of [
      /<h2 class="reveal reveal-3">Join the arena\.<\/h2>/,
      /<div class="landing-actions reveal reveal-4">/,
      /<div class="landing-sign-in reveal reveal-5">/,
      /<a class="landing-explore reveal reveal-5" href="\/home">/,
    ])
      assert.match(text, pattern);
    for (const pattern of [
      /<header class="landing-header landing-container">/,
      /<main id="main" class="landing-main landing-container">/,
      /<footer class="landing-footer landing-container">/,
    ])
      assert.match(text, pattern);
    assert.match(text, /viewport-fit=cover/);
    assert.match(
      text,
      /Press Space to pause or resume the emblem and the headline\./,
    );
  });

  it("sends signed-in readers to /home and keeps others on the landing page", async () => {
    const signedIn = await request(app)
      .get("/")
      .set("Cookie", "session=member");
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.location, "/home");
    assert.match(signedIn.headers.vary, /Cookie/);
    const revoked = await request(app).get("/").set("Cookie", "session=other");
    assert.equal(revoked.status, 200);
    assert.match(revoked.text, /data-pixel-logo/);
    const outage = landingApp({
      findUserByTokenHash: async () => {
        throw new Error("sessions unavailable");
      },
    });
    const fallback = await request(outage)
      .get("/")
      .set("Cookie", "session=member");
    assert.equal(fallback.status, 200);
    assert.match(fallback.text, /data-pixel-logo/);
  });

  it("serves the former homepage at /home and links the app brand there", async () => {
    const home = await request(app).get("/home");
    assert.equal(home.status, 200);
    assert.match(home.text, /id="ya-market-v4"/);
    assert.match(
      home.text,
      /rel="canonical" href="https:\/\/arena\.example\/home"/,
    );
    assert.match(
      home.text,
      /<a class="brand" href="\/home" aria-label="YAP Arena home">/,
    );
    assert.match(home.text, /homepage\.bundle\.js\?v=/);
  });

  it("serves the landing stylesheet, scripts and logo images", async () => {
    const css = await request(app).get("/assets/landing.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /^text\/css/);
    const script = await request(app).get("/assets/landing.js");
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /javascript/);
    assert.match(script.text, /from "\.\/pixel-life\.js"/);
    assert.match(script.text, /\/api\/auth\/me/);
    assert.equal((await request(app).get("/assets/pixel-life.js")).status, 200);
    for (const name of ["yaparena-logo.png", "yaparena-emblem.png"]) {
      const image = await request(app).get(`/assets/landing/${name}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers["content-type"], "image/png");
    }
  });

  it("self-hosts Forum Regular for the headline, set in capitals", async () => {
    const font = "/assets/landing/fonts/forum-latin-400-normal.woff2";
    const page = await request(app).get("/");
    // Preloaded at the exact URL landing.css resolves, so it downloads once.
    assert.match(
      page.text,
      /<link rel="preload" href="\/assets\/landing\/fonts\/forum-latin-400-normal\.woff2" as="font" type="font\/woff2" crossorigin>/,
    );
    assert.doesNotMatch(page.text, /fonts\.googleapis|fonts\.gstatic/);
    assert.doesNotMatch((await request(app).get("/home")).text, /forum-latin/);
    const file = await request(app).get(font);
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "font/woff2");
    assert.equal(Number(file.headers["content-length"]), 23820);
    const license = await request(app).get("/assets/landing/fonts/OFL.txt");
    assert.equal(license.status, 200);
    assert.match(license.text, /Denis Masharov/);
    assert.match(license.text, /SIL Open Font License, Version 1\.1/);
    const css = (await request(app).get("/assets/landing.css")).text;
    assert.match(
      css,
      /@font-face \{\s*font-family: "Forum";\s*font-style: normal;\s*font-weight: 400;\s*font-display: swap;\s*src: url\("landing\/fonts\/forum-latin-400-normal\.woff2"\) format\("woff2"\);/,
    );
    assert.equal(
      new URL(
        "landing/fonts/forum-latin-400-normal.woff2",
        "https://a/assets/landing.css?v=1",
      ).pathname,
      font,
    );
    const rule = (selector) =>
      new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(
        css,
      )[1];
    const headline = rule(".landing-headline");
    assert.match(
      headline,
      /font-family: "Forum", Georgia, "Times New Roman", serif;/,
    );
    assert.match(headline, /font-size: clamp\(3rem, 5\.4vw, 4rem\);/);
    assert.match(headline, /font-weight: 400;/);
    assert.match(headline, /line-height: 1\.05;/);
    assert.match(headline, /letter-spacing: -0\.04em;/);
    assert.match(rule(".headline-line"), /text-transform: uppercase;/);
    // The layout is unchanged: Forum in capitals fits the half-width column.
    assert.match(rule(".landing-join"), /grid-column: 1 \/ span 6;/);
    assert.match(rule(".landing-emblem"), /grid-column: 7 \/ span 6;/);
  });

  it("returns sign-in to /home unless the link names another page", async () => {
    const created = [];
    const auth0 = {
      client: {
        authorizationUrl: async () =>
          new URL("https://tenant.example.test/authorize"),
        logoutUrl: () => new URL("https://tenant.example.test/v2/logout"),
      },
      accounts: {},
      state: {
        create: async (transaction) => created.push(transaction.returnPath),
        consume: async () => null,
      },
    };
    const signIn = landingApp({ auth0 });
    assert.equal((await request(signIn).get("/api/auth/login")).status, 303);
    assert.equal(
      (await request(signIn).get("/api/auth/login?return=%2Flive")).status,
      303,
    );
    assert.deepEqual(created, ["/home", "/live"]);
    const expired = await request(signIn)
      .get("/api/auth/callback?code=c&state=s")
      .set("Cookie", `sign-in=${"b".repeat(43)}`);
    assert.equal(expired.status, 400);
    assert.match(
      expired.text,
      /href="\/api\/auth\/login\?return=%2Fhome">Try again</,
    );
    assert.match(expired.text, /href="\/">Back to YAP Arena</);
    assert.match(expired.text, /<a class="brand" href="\/home"/);
  });
});

describe("session check", () => {
  it("reads only this environment's session cookie and accepts active sessions", async () => {
    const seen = [];
    const sessions = {
      findUserByTokenHash: async (hash) => {
        seen.push(hash);
        return hash === member ? { id: "7" } : null;
      },
    };
    const production = createSessionCheck({
      sessions,
      environment: "production",
    });
    assert.equal(
      await production({ cookies: { "__Host-session": "member" } }),
      true,
    );
    assert.equal(await production({ cookies: { session: "member" } }), false);
    assert.equal(
      await production({ cookies: { "__Host-session": "other" } }),
      false,
    );
    assert.equal(
      await production({ cookies: { "__Host-session": ["member"] } }),
      false,
    );
    assert.equal(await production({ cookies: {} }), false);
    assert.equal(seen.length, 2);
    const local = createSessionCheck({ sessions, environment: "test" });
    assert.equal(await local({ cookies: { session: "member" } }), true);
  });
});

// A small grid of square tiles with centers `pitch` apart.
function grid(columns, rows, { pitch = 6, size = 5, missing = [] } = {}) {
  const tiles = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      if (missing.some(([c, r]) => c === column && r === row)) continue;
      const left = column * pitch,
        top = row * pitch;
      tiles.push({
        id: tiles.length,
        x: left + (size - 1) / 2,
        y: top + (size - 1) / 2,
        left,
        top,
        width: size,
        height: size,
        area: size * size,
      });
    }
  return tiles;
}

describe("pixel life", () => {
  it("keeps the supplied animation settings", () => {
    assert.equal(SETTINGS.restOpacity, 0.13);
    assert.equal(SETTINGS.concurrentBursts, 3);
    assert.deepEqual(SETTINGS.eventWindow, [3500, 5000]);
    assert.deepEqual(SETTINGS.clusterSize, [28, 50]);
    assert.deepEqual(SETTINGS.fade, [470, 900]);
    assert.equal(SETTINGS.auraOpacity, 0.95);
    assert.deepEqual(POINTER_SETTINGS, {
      throttleMs: 32,
      tileCooldownMs: 300,
      ignitionMs: 32,
      hitTolerancePx: 1.5,
      maxSamplesPerFrame: 8,
      maxInputAgeMs: 80,
    });
  });

  it("finds each bright opaque tile and ignores specks and dim pixels", () => {
    const width = 20,
      height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    const paint = (left, top, size, red = 255, alpha = 255) => {
      for (let y = top; y < top + size; y++)
        for (let x = left; x < left + size; x++) {
          const i = (y * width + x) * 4;
          data[i] = red;
          data[i + 3] = alpha;
        }
    };
    paint(0, 0, 5);
    paint(6, 1, 5);
    paint(12, 0, 5, 100); // Too dark.
    paint(12, 6, 2); // Too small.
    paint(17, 0, 3, 255, 120); // Too transparent.
    const tiles = PixelLife.detectTiles(data, width, height);
    assert.deepEqual(tiles, [
      { id: 0, x: 2, y: 2, left: 0, top: 0, width: 5, height: 5, area: 25 },
      { id: 1, x: 8, y: 3, left: 6, top: 1, width: 5, height: 5, area: 25 },
    ]);
  });

  it("links only immediate side and corner neighbors", () => {
    const graph = PixelLife.buildGraph(grid(3, 3, { missing: [[1, 0]] }));
    assert.equal(graph.pitchX, 6);
    assert.equal(graph.pitchY, 6);
    const ids = (id) => graph.neighbors[id].map((edge) => edge.id).sort();
    // Row 0 is now tiles 0 and 1 (columns 0 and 2); the gap is never bridged.
    assert.deepEqual(ids(0), [2, 3]);
    assert.deepEqual(ids(1), [3, 4]);
    // The center tile (id 3) touches every remaining tile.
    assert.deepEqual(ids(3), [0, 1, 2, 4, 5, 6, 7]);
    const corner = graph.neighbors[0].find((edge) => edge.id === 3);
    assert.equal(corner.diagonal, true);
    assert.equal(
      graph.neighbors[0].find((edge) => edge.id === 2).diagonal,
      false,
    );
    const lone = PixelLife.buildGraph(grid(1, 1));
    assert.equal(lone.pitchX, 6);
    assert.deepEqual(lone.neighbors, [[]]);
    const empty = PixelLife.buildGraph([]);
    assert.ok(Number.isNaN(empty.pitchX));
  });

  it("hits the closest tile within the tolerance", () => {
    const graph = PixelLife.buildGraph(grid(2, 1));
    assert.equal(PixelLife.hitTest(graph, 2, 2), 0);
    assert.equal(PixelLife.hitTest(graph, 5.5, 2), null);
    assert.equal(PixelLife.hitTest(graph, 5.8, 2, 1), 1);
    assert.equal(PixelLife.hitTest(graph, 5.2, 2, 1), 0);
    // An exact tie keeps the first tile.
    assert.equal(PixelLife.hitTest(graph, 5.5, 2, 1), 0);
    assert.equal(PixelLife.hitTest(graph, Number.NaN, 2, 10), null);
    assert.equal(PixelLife.hitTest(graph, 2, Infinity, 10), null);
  });

  it("plans bounded bursts that spread only through neighbors", () => {
    const graph = PixelLife.buildGraph(grid(24, 24));
    const deadline = SETTINGS.eventWindow[1] - SETTINGS.quietTime;
    for (let run = 0; run < 150; run++) {
      const plan = PixelLife.planEvent(graph, SETTINGS, run % 2 ? 300 : null);
      if (run % 2) assert.equal(plan.root, 300);
      assert.ok(plan.nodes.length >= 1);
      assert.ok(plan.nodes.length <= SETTINGS.clusterSize[1]);
      assert.equal(plan.nodes[0].id, plan.root);
      assert.equal(plan.nodes[0].parent, null);
      assert.equal(
        new Set(plan.nodes.map((n) => n.id)).size,
        plan.nodes.length,
      );
      const planned = new Map(plan.nodes.map((n) => [n.id, n]));
      const origin = graph.tiles[plan.root];
      for (const node of plan.nodes) {
        assert.ok(node.end <= deadline);
        assert.ok(node.depth <= SETTINGS.maxHops[1]);
        const tile = graph.tiles[node.id];
        assert.ok(
          Math.hypot(
            (tile.x - origin.x) / graph.pitchX,
            (tile.y - origin.y) / graph.pitchY,
          ) <= plan.radius,
        );
        if (node.parent === null) continue;
        const parent = planned.get(node.parent);
        assert.ok(parent && parent.onset < node.onset);
        assert.ok(graph.neighbors[node.parent].some((e) => e.id === node.id));
        assert.equal(node.epicenter, node.depth <= 1);
      }
      assert.equal(plan.duration, Math.max(...plan.nodes.map((n) => n.end)));
      assert.ok(plan.interval >= plan.duration + SETTINGS.pause[0]);
      assert.ok(plan.interval <= plan.duration + SETTINGS.pause[1]);
    }
  });

  it("plans a single tile for pointer feedback and drops nodes that would outlast the window", () => {
    const graph = PixelLife.buildGraph(grid(10, 10));
    const feedback = PixelLife.planEvent(
      graph,
      { ...SETTINGS, clusterSize: [1, 1] },
      42,
    );
    assert.deepEqual(
      feedback.nodes.map((n) => n.id),
      [42],
    );
    // The root always fits in 1,420 ms; many of its descendants do not.
    const short = { ...SETTINGS, eventWindow: [1600, 1600] };
    for (let run = 0; run < 40; run++) {
      const plan = PixelLife.planEvent(graph, short);
      assert.ok(plan.nodes.length >= 1);
      for (const node of plan.nodes)
        assert.ok(node.end <= 1600 - SETTINGS.quietTime);
    }
  });

  it("lights, holds and fades each tile", () => {
    const node = {
      onset: 100,
      attack: 100,
      hold: 50,
      decay: 500,
      end: 750,
      energy: 1,
      brightness: 1,
      visualBoost: 1,
      surge: 0,
      surgeAt: 0.4,
    };
    assert.equal(PixelLife.brightnessAt(node, 100), 0);
    assert.equal(PixelLife.brightnessAt(node, 150), 0.5);
    assert.equal(PixelLife.brightnessAt(node, 132, 32), 1);
    assert.equal(PixelLife.brightnessAt(node, 225), 1);
    assert.ok(
      Math.abs(PixelLife.brightnessAt(node, 500) - 0.5 ** 1.65) < 1e-12,
    );
    assert.equal(PixelLife.brightnessAt(node, 750), 0);
    const surging = { ...node, surge: 0.4 };
    assert.ok(
      PixelLife.brightnessAt(surging, 450) > PixelLife.brightnessAt(node, 450),
    );
    assert.equal(
      PixelLife.brightnessAt({ ...node, visualBoost: 1.45 }, 225),
      1,
    );
    for (let run = 0; run < 20; run++) {
      const value = PixelLife.random(250, 650);
      assert.ok(value >= 250 && value < 650);
    }
  });
});

describe("rotating headline", () => {
  it("shows the five phrases in order", () => {
    assert.deepEqual(
      HEADLINE_PHRASES.map((_, step) => phraseAt(step)),
      [
        "Your opinions matter",
        "Your debates matter",
        "Your ideas matter",
        "Your discussions matter",
        "Yappers matter",
      ],
    );
    assert.equal(FINAL_STEP, 4);
  });

  it("moves only the noun on 1→2, 2→3 and 3→4", () => {
    for (const from of [0, 1, 2]) {
      const move = nextMove(from);
      assert.equal(move.to, from + 1);
      assert.deepEqual(move.moves, { pronoun: false, noun: true });
      assert.deepEqual(move.positions, { pronoun: 0, noun: from + 1 });
      assert.equal(move.wraps, false);
    }
  });

  it("moves both slots into Yappers and back, always upward", () => {
    const into = nextMove(3);
    assert.equal(into.to, 4);
    assert.deepEqual(into.moves, { pronoun: true, noun: true });
    assert.deepEqual(into.positions, { pronoun: 1, noun: 4 });
    assert.equal(NOUN_TRACK[into.positions.noun], "");
    // 5→1 lands on the trailing copies, further up both tracks.
    const back = nextMove(4);
    assert.equal(back.to, 0);
    assert.deepEqual(back.moves, { pronoun: true, noun: true });
    assert.equal(back.wraps, true);
    assert.deepEqual(back.positions, {
      pronoun: PRONOUN_TRACK.length - 1,
      noun: NOUN_TRACK.length - 1,
    });
    assert.ok(back.positions.pronoun > restingPositions(4).pronoun);
    assert.ok(back.positions.noun > restingPositions(4).noun);
    assert.equal(PRONOUN_TRACK.at(-1), PRONOUN_TRACK[0]);
    assert.equal(NOUN_TRACK.at(-1), NOUN_TRACK[0]);
    assert.deepEqual(restingPositions(0), { pronoun: 0, noun: 0 });
  });

  it("loops indefinitely", () => {
    let step = 0;
    const seen = [];
    for (let i = 0; i < 12; i++) {
      step = nextMove(step).to;
      seen.push(step);
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2]);
  });

  it("holds while hidden or paused and starts at Yappers under reduced motion", () => {
    assert.equal(canAdvance({ hidden: false, paused: false }), true);
    assert.equal(canAdvance({ hidden: true, paused: false }), false);
    assert.equal(canAdvance({ hidden: false, paused: true }), false);
    assert.equal(initialStep(true), FINAL_STEP);
    assert.equal(initialStep(false), 0);
  });

  it("uses dydema.com's flip timings", () => {
    assert.equal(FLIP_EVERY_MS, 2600);
    assert.equal(FLIP_MS, 700);
    assert.equal(REVEAL_END_MS, 80 + 1050);
  });
});
