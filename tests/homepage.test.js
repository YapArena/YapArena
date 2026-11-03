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
import { pixelMark, fnv1a } from "../dist/features/discovery/pixel-mark.js";
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
  // Without the server's avatar addresses, the slots keep initials.
  assert.deepEqual(m.debates[0].avatars, [null, null]);
  const withAvatars = publicHomepage(
    [topic],
    [
      {
        ...debate,
        speakerA: { displayName: "Alex Rivera", avatarId: "yap-owl" },
      },
    ],
    {},
    (id) => `/assets/avatars/${id}.svg?v=0123456789ab`,
  ).ideas[0].debates[0];
  // A named speaker gets their avatar; the missing one keeps initials.
  assert.deepEqual(withAvatars.avatars, [
    "/assets/avatars/yap-owl.svg?v=0123456789ab",
    null,
  ]);
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
    const trend = String(view.trendMarkup(m));
    assert.ok(trend.includes('id="ya-chart"'));
    assert.ok(trend.includes('aria-label="Follow this idea"'));
    assert.ok(
      String(view.trendMarkup(m, true)).includes(
        'aria-label="Following this idea"',
      ),
    );
    // Up to three arguments, never the old looping copy.
    const args = String(view.argumentsMarkup(m));
    assert.ok(!args.includes("inert"));
    assert.ok((args.match(/class="trend-arg[ "]/g) ?? []).length <= 3);
    assert.ok(String(view.detailMarkup(m, true)).includes("ya-detail-chart"));
    String(view.sparkMarkup(m));
    for (const d of m.debates)
      assert.ok(String(view.playerMarkup(m, d)).includes("Concept preview"));
    for (const filter of ["all", "live", "replay", "none"])
      String(view.debatesMarkup(m, filter, m.debates[0]?.id ?? null));
  }
  assert.ok(
    String(view.followMarkup(real)).includes(
      'class="ya-follow ya-bookmark follow-button"',
    ),
  );
  assert.ok(
    String(view.followMarkup(real)).includes('data-follow-icon="true"'),
  );
  assert.ok(
    String(view.followMarkup(real, false, true)).includes(
      'data-follow-compact="true"',
    ),
  );
  assert.ok(
    !String(view.followMarkup({ ...real, demo: true })).includes(
      "data-follow-type",
    ),
  );
  assert.ok(!String(view.followMarkup(emptyIdea)).includes("follow-button"));
  // One way into the debate; the old "Enter round" is gone.
  const trend = String(view.trendMarkup(real));
  assert.ok(trend.includes('href="/debates/real-debate">Explore debate</a>'));
  assert.ok(!trend.includes("Enter round"));
  assert.ok(trend.includes("No rounds yet"));
  assert.ok(trend.includes("Live now"));
  // Sample ideas have no page: their links open the idea's panel.
  assert.match(
    String(view.trendMarkup(concepts.ideas[1])),
    /data-open-idea="[^"]+"/,
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
  assert.ok(empty.includes('href="/home">Try again</a>'));
  assert.ok(!empty.includes("ya-home-data"));
  const none = String(view.homepageMarkup(publicHomepage([], [])));
  assert.ok(none.includes("No public ideas yet"));
  assert.ok(
    none.includes("Published topics and their debates will appear here."),
  );
  assert.ok(
    String(view.homepageMarkup(publicHomepage([topic], [debate]))).includes(
      "Ideas",
    ),
  );
  const page = String(view.homepageMarkup(concepts));
  assert.ok(page.includes('aria-label="1 of 6: '));
  assert.ok(!page.includes("ya-ticker"));
  assert.ok(!page.includes('data-carousel="pause"'));
});
it("names the neighbours, ranks popular ideas and shows what is live", () => {
  const nav = String(view.navMarkup(concepts.ideas, concepts.ideas[0].id));
  assert.ok(
    nav.includes(`aria-label="Previous idea: ${concepts.ideas.at(-1).title}"`),
  );
  assert.ok(nav.includes(`aria-label="Next idea: ${concepts.ideas[1].title}"`));
  assert.ok(!nav.includes("disabled"));
  assert.ok(
    String(view.navMarkup([concepts.ideas[0]], concepts.ideas[0].id)).includes(
      "disabled",
    ),
  );
  const rail = String(view.railMarkup(concepts));
  assert.ok(rail.includes("rail-live"));
  assert.ok(rail.includes("Take a side"));
  assert.ok(rail.includes("Join the arena"));
  assert.equal((rail.match(/class="rail-rank num"/g) ?? []).length, 5);
  // Nothing live: no Live now card.
  assert.ok(
    !String(view.railMarkup(publicHomepage([topic], []))).includes("rail-live"),
  );
  const dots = String(view.dotsMarkup(concepts.ideas, concepts.ideas[2].id));
  assert.equal((dots.match(/aria-current="true"/g) ?? []).length, 1);
});
it("draws an idea's pixel mark from its id, mirrored, in a visit colour", () => {
  const a = String(pixelMark("idea-a", 48));
  assert.equal(a, String(pixelMark("idea-a", 48)));
  assert.notEqual(a, String(pixelMark("idea-b", 48)));
  assert.match(a, /^<svg class="pixel-mark" width="48" height="48"/);
  assert.match(a, /fill="var\(--visit-[0-4]\)"/);
  assert.match(a, /aria-hidden="true"/);
  assert.equal(fnv1a(""), 0x811c9dc5);
  // Every cell has its mirror: columns 0 and 1 reflect to 4 and 3.
  const cells = [...a.matchAll(/M(\d(?:\.5)?) (\d\.5)h1v1h-1z/g)].map(
    ([, x, y]) => `${x},${y}`,
  );
  for (const cell of cells) {
    const [x, y] = cell.split(",").map(Number);
    assert.ok(cells.includes(`${5 - x},${y}`));
  }
});
it("reproduces both chart geometries/ranges and interpolates the actual pointer fraction", () => {
  for (const m of [...concepts.ideas, emptyIdea])
    for (const metric of ["endorsement", "price"])
      for (const range of ["1D", "1W", "1M"])
        for (const detail of [false, true]) {
          const series = chartSeries(m, metric, range),
            c = chartGeometry(m, metric, range, 900, detail),
            markup = String(c.markup);
          assert.equal(c.h, detail ? 290 : 240);
          assert.equal(c.w, 900);
          if (m.reference) {
            assert.equal(series.length, 16);
            assert.equal(series.at(-1), metric === "price" ? m.price : m.pct);
            assert.ok(markup.includes("data-chart-clip"));
            assert.ok(markup.includes("data-chart-hover-marker"));
            assert.equal((markup.match(/class="ya-guide"/g) ?? []).length, 5);
            assert.ok(markup.includes("ya-endpoint-pulse"));
            assert.ok(markup.includes("ya-endpoint"));
          } else {
            assert.deepEqual(series, []);
            assert.ok(
              markup.includes("The chart starts after the first closed round."),
            );
            assert.ok(!markup.includes("ya-linepath"));
          }
        }
  assert.equal(chartGeometry(emptyIdea, "price", "1D", 10).w, 190);
  assert.equal(chartGeometry(emptyIdea, "price", "1D", 400, false, 320).h, 320);
  assert.equal(chartGeometry(emptyIdea, "price", "1D", 400, false, 20).h, 160);
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
