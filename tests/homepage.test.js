import assert from "node:assert/strict";
import { it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";
import {
  publicHomepage,
  emptyIdea,
} from "../dist/features/discovery/homepage-model.js";
import { referenceHomepage } from "../dist/features/discovery/homepage-reference.js";
import {
  chartGeometry,
  chartSeries,
  interpolate,
  formatValue,
} from "../dist/features/discovery/homepage-chart.js";
import { createRotationClock } from "../dist/features/discovery/homepage-clock.js";
import * as view from "../dist/features/discovery/homepage-view.js";
import { renderHome } from "../dist/features/discovery/web.js";
import { loadConfig } from "../dist/platform/config.js";
const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "public-idea",
  title: 'Public <idea> "safe"',
  sideALabel: "For <the> idea",
  sideBLabel: "Against & questioning",
  isDemo: false,
};
const debate = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "real-debate",
  proposition: "A real <question>?",
  status: "live",
  topic: { slug: topic.slug },
  speakerA: { displayName: "Alex Rivera" },
  speakerB: null,
};
const concepts = referenceHomepage();

it("adapts public topics/debates without manufacturing market histories or argument endorsements", () => {
  const data = publicHomepage(
    [topic],
    [
      debate,
      {
        ...debate,
        id: "replay",
        status: "finalized",
        speakerA: null,
        speakerB: { displayName: "Morgan B" },
      },
      { ...debate, topic: { slug: "other-topic" } },
    ],
  );
  assert.equal(data.reference, false);
  assert.deepEqual(data.following, []);
  const m = data.ideas[0];
  assert.equal(m.title, debate.proposition);
  assert.equal(m.short, debate.proposition);
  assert.equal(publicHomepage([topic], []).ideas[0].title, topic.title);
  assert.equal(m.live, 1);
  assert.equal(m.debates.length, 2);
  assert.equal(m.debates[0].href, "/debates/real-debate");
  assert.deepEqual(m.debates[0].names, [
    "Alex Rivera",
    "Speaker B",
    "AR",
    "SB",
  ]);
  assert.deepEqual(m.debates[1].names, ["Speaker A", "Morgan B", "SA", "MB"]);
  for (const key of ["pct", "delta", "vol", "people", "price", "viewers"])
    assert.equal(m[key], null);
  assert.deepEqual(m.points, []);
  assert.equal(
    m.arguments.every((a) => a.rate === null),
    true,
  );
  const html = renderHome("https://arena.example", data);
  assert.ok(html.includes("/topics/public-idea"));
  assert.ok(html.includes("/debates/real-debate"));
  assert.ok(html.includes("A real &lt;question&gt;?"));
  assert.ok(!html.includes("A real <question>"));
  assert.ok(!html.includes('class="ya-heading"'));
  assert.ok(html.includes('href="#main"'));
  assert.ok(html.includes('rel="canonical" href="https://arena.example/home"'));
  assert.ok(html.includes("data-header-balance"));
  assert.ok(html.includes("measurement.js?v="));
  assert.ok(
    !/iframe|srcdoc|unpkg|viewer-token|replay\.bundle|hero-preview/.test(html),
  );
  const embedded = html.match(
    /<template id="ya-home-data">([\s\S]*?)<\/template>/,
  )[1];
  assert.ok(!embedded.includes("<"));
  assert.ok(embedded.includes("&lt;question&gt;"));
});
it("gates reference data explicitly and never falls back to it on a real request failure", async () => {
  const app = (enabled) =>
    express().use(
      createDiscoveryRouter({
        discovery: {
          listTopics: async () => {
            throw Error("offline");
          },
        },
        homepageReferenceEnabled: enabled,
        applicationOrigin: "https://arena.example",
      }),
    );
  assert.equal(
    (await request(app(false)).get("/home?reference=1")).status,
    404,
  );
  assert.equal(
    (await request(app(true)).get("/home?reference=yes")).status,
    404,
  );
  const demo = await request(app(true)).get("/home?reference=1");
  assert.equal(demo.status, 200);
  assert.equal(demo.headers["cache-control"], "no-store");
  assert.ok(demo.text.includes("Concept · Sample data"));
  assert.ok(demo.text.includes("68%"));
  assert.ok(!demo.text.includes("measurement.js"));
  // The reference view moved with the homepage; / is the landing page.
  assert.ok(
    !(await request(app(true)).get("/?reference=1")).text.includes("68%"),
  );
  const failed = await request(app(true)).get("/home");
  assert.equal(failed.status, 503);
  assert.ok(failed.text.includes("Discovery temporarily unavailable"));
  assert.ok(!failed.text.includes("68%"));
  assert.equal(
    loadConfig({
      DATABASE_URL: "postgresql://localhost/test",
      HOMEPAGE_REFERENCE_ENABLED: "true",
    }).homepageReferenceEnabled,
    true,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgresql://localhost/test",
        HOMEPAGE_REFERENCE_ENABLED: "maybe",
      }),
    /must be true or false/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgresql://localhost/test",
        NODE_ENV: "production",
        HOMEPAGE_REFERENCE_ENABLED: "true",
      }),
    /development\/test only/,
  );
});
it("keeps reference/demo follows local and emits real canonical links and shared follow controls", () => {
  const real = publicHomepage([topic], [debate]).ideas[0];
  for (const m of [
    ...concepts.ideas,
    real,
    { ...real, demo: true },
    emptyIdea,
  ]) {
    const card = String(view.cardMarkup(m, true));
    assert.ok(card.includes('aria-expanded="true"'));
    assert.ok(String(view.cardMarkup(m)).includes('aria-expanded="false"'));
    assert.ok(String(view.featureMarkup(m)).includes('id="ya-chart"'));
    assert.ok(String(view.featureMarkup(m, true)).includes("Following"));
    assert.ok(
      String(view.argumentsMarkup(m)).includes('aria-hidden="true" inert'),
    );
    assert.ok(String(view.detailMarkup(m, true)).includes("ya-detail-chart"));
    for (const side of ["live", "debate", "trade"])
      assert.ok(String(view.sideMarkup(m, side, "NO")).length > 100);
    String(view.sparkMarkup(m));
    for (const d of m.debates)
      assert.ok(String(view.playerMarkup(m, d)).includes("Concept preview"));
    for (const filter of ["all", "live", "replay", "none"])
      String(view.debatesMarkup(m, filter, m.debates[0]?.id ?? null));
  }
  assert.ok(
    String(view.followMarkup(real)).includes('class="ya-follow follow-button"'),
  );
  assert.ok(
    !String(view.followMarkup({ ...real, demo: true })).includes(
      "data-follow-type",
    ),
  );
  assert.ok(!String(view.followMarkup(emptyIdea)).includes("follow-button"));
  assert.ok(
    String(view.sideMarkup(real)).includes('href="/debates/real-debate"'),
  );
  assert.ok(
    String(view.debatesMarkup(real)).startsWith(
      '<a href="/debates/real-debate"',
    ),
  );
  const empty = String(
    view.homepageMarkup({
      ...publicHomepage([], []),
      available: false,
    }),
  );
  assert.ok(empty.includes("Discovery temporarily unavailable"));
  assert.ok(
    String(view.homepageMarkup(publicHomepage([], []))).includes(
      "No public ideas yet",
    ),
  );
  assert.ok(
    String(view.homepageMarkup(publicHomepage([topic], [debate]))).includes(
      "Ideas",
    ),
  );
  assert.ok(String(view.homepageMarkup(concepts)).includes("1 / 6"));
});
it("reproduces both chart geometries/ranges and interpolates the actual pointer fraction", () => {
  for (const m of [...concepts.ideas, emptyIdea])
    for (const metric of ["endorsement", "price"])
      for (const range of ["1D", "1W", "1M"])
        for (const detail of [false, true]) {
          const series = chartSeries(m, metric, range),
            c = chartGeometry(m, metric, range, 900, detail),
            markup = String(c.markup);
          assert.equal(c.h, detail ? 290 : 165);
          assert.equal(c.w, 900);
          if (m.reference) {
            assert.equal(series.length, 16);
            assert.equal(series.at(-1), metric === "price" ? m.price : m.pct);
            assert.ok(markup.includes("data-chart-clip"));
            assert.ok(markup.includes("data-chart-hover-date"));
            assert.ok(markup.includes("ya-endpoint-pulse"));
            assert.ok(markup.includes("ya-endpoint"));
          } else {
            assert.deepEqual(series, []);
            assert.ok(markup.includes("History unavailable"));
            assert.ok(!markup.includes("ya-linepath"));
          }
        }
  assert.equal(chartGeometry(emptyIdea, "price", "1D", 10).w, 190);
  assert.equal(formatValue(null), "—");
  assert.equal(formatValue(0.34, "price"), "0.34");
  assert.equal(formatValue(67.6), "68%");
  assert.equal(interpolate([], 0.5), null);
  assert.equal(interpolate([40], 0.5), 40);
  assert.equal(interpolate([10, 20, 40], 0.25), 15);
  assert.equal(interpolate([10, 20, 40], 0.625), 25);
  assert.equal(interpolate([10, 20], -1), 10);
  assert.equal(interpolate([10, 20], 2), 20);
});
it("uses one clock for fill/advance, preserving elapsed time through repeated pauses and cycles", () => {
  let time = 0,
    next = 0,
    count = 0,
    fill = 0;
  const frames = new Map();
  let clock;
  clock = createRotationClock({
    now: () => time,
    frame: (cb) => {
      frames.set(++next, cb);
      return next;
    },
    cancel: (id) => frames.delete(id),
    progress: (v) => (fill = v),
    advance: () => {
      count++;
      clock.reset();
      clock.resume();
    },
  });
  const tick = (ms) => {
    time += ms;
    const work = [...frames.values()];
    frames.clear();
    work.forEach((cb) => cb());
  };
  clock.pause();
  clock.resume();
  clock.resume();
  assert.equal(frames.size, 1);
  tick(2000);
  assert.equal(fill, 2000 / 6500);
  clock.pause();
  clock.pause();
  tick(9000);
  assert.equal(fill, 2000 / 6500);
  assert.equal(count, 0);
  clock.resume();
  tick(4499);
  assert.equal(count, 0);
  tick(1);
  assert.equal(count, 1);
  assert.equal(fill, 0);
  tick(6500);
  assert.equal(count, 2);
  clock.reset();
  assert.equal(clock.fraction(), 0);
  clock.resume();
  tick(1000);
  clock.destroy();
  tick(10000);
  assert.equal(count, 2);
  clock.resume();
  assert.equal(frames.size, 0);
});
