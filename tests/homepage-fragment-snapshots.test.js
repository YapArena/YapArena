// Byte-for-byte snapshots of the shared homepage fragments that the browser
// renders into the page (frontend/homepage.ts). Update deliberately:
// node --test --test-update-snapshots tests/homepage-fragment-snapshots.test.js
import { it } from "node:test";
import * as view from "../dist/features/discovery/homepage-view.js";
import { chartGeometry } from "../dist/features/discovery/homepage-chart.js";
import { emptyIdea } from "../dist/features/discovery/homepage-model.js";
import { homes, snapshot } from "./page-fixtures.js";

it("renders the shared homepage fragments", (t) => {
  const ideas = [
    ...homes.reference.ideas,
    ...homes.public.ideas,
    ...homes.synthetic.ideas,
    { ...homes.public.ideas[0], demo: true },
    emptyIdea,
  ];
  for (const m of ideas) {
    const fragments = [
      view.followMarkup(m),
      view.followMarkup(m, true, true),
      view.argumentsMarkup(m),
      view.sparkMarkup(m),
      view.cardMarkup(m),
      view.cardMarkup(m, true),
      view.trendMarkup(m),
      view.trendMarkup(m, true),
      view.detailMarkup(m),
      view.detailMarkup(m, true),
    ];
    for (const filter of ["all", "live", "replay", "none"])
      fragments.push(view.debatesMarkup(m, filter, m.debates[0]?.id ?? null));
    for (const d of m.debates) fragments.push(view.playerMarkup(m, d));
    snapshot(t, fragments.map(String).join("\n"));
  }
  // One idea per chart branch: reference history, synthetic history, none.
  for (const m of [
    homes.reference.ideas[0],
    homes.synthetic.ideas[0],
    emptyIdea,
  ]) {
    const charts = [];
    for (const metric of ["endorsement", "price"])
      for (const range of ["1D", "1W", "1M"])
        for (const detail of [false, true])
          charts.push(chartGeometry(m, metric, range, 800, detail).markup);
    snapshot(t, charts.map(String).join("\n"));
  }
  for (const data of Object.values(homes)) {
    snapshot(t, view.dotsMarkup(data.ideas, data.ideas[0]?.id ?? ""));
    snapshot(t, view.navMarkup(data.ideas, data.ideas[0]?.id ?? ""));
    snapshot(t, view.railMarkup(data));
    snapshot(t, view.filtersMarkup(data));
    snapshot(t, view.homepageMarkup(data));
  }
});
