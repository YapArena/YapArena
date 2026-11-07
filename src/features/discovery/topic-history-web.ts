// A topic's endorsement history on its page (first-run plan PR 6: the chart
// moved here from the old home). It reuses the home's chart: the idea model
// (homepage-model.ts), its geometry (homepage-chart.ts) and the pointer, touch
// and keyboard inspection in frontend/homepage-chart.ts, which
// frontend/topic-chart.ts binds. A topic shows it only once it has history:
// shared, labelled bot rounds and opted-in mixed and observer rounds
// (docs/shared-bot-discovery.md).
import type { PublicBotActivity } from "../a4/public-bot-types.ts";
import { html } from "../../platform/html.ts";
import { chartGeometry, formatValue } from "./homepage-chart.ts";
import { publicHomepage, type HomeIdea } from "./homepage-model.ts";
import { changeText } from "./homepage-view.ts";
import { inscription } from "./kit-web.ts";
import type { PublicTopic } from "./public-types.ts";

/** The topic as the chart's idea, or null while it has no rounds. */
export function topicHistory(
  topic: PublicTopic,
  activity: PublicBotActivity | undefined,
): HomeIdea | null {
  if (!activity?.items.length) return null;
  return publicHomepage([topic], [], { [topic.id]: activity }).ideas[0] ?? null;
}

const segments = (
  label: string,
  key: "metric" | "range",
  options: [string, string][],
) =>
  html`<div class="ya-segments" role="group" aria-label="${label}">${options.map(([value, name], index) => html`<button type="button" data-${key}="${value}" aria-pressed="${String(index === 0)}">${name}</button>`)}</div>`;

/** The section under the topic's debates, with the data its script draws from. */
export function topicHistoryMarkup(m: HomeIdea) {
  const c = chartGeometry(m, "endorsement", "1D", 800);
  return html`<section class="container page-section topic-history" aria-labelledby="topic-history-title" data-topic-history><div class="section-head"><p class="kicker">${inscription("Shared simulation")}</p><h2 class="section-title" id="topic-history-title">${inscription("Endorsement history")}</h2></div><div class="card topic-chart-card"><div class="topic-chart-bar"><p class="topic-chart-legend"><i aria-hidden="true"></i><span id="ya-legend-name">Endorsement</span> <strong class="num" id="ya-legend">${formatValue(m.pct)}</strong></p><div class="topic-chart-tools">${segments(
    "Chart metric",
    "metric",
    [
      ["endorsement", "Endorsement"],
      ["price", "Price"],
    ],
  )}${segments("Chart period", "range", [
    ["1D", "1D"],
    ["1W", "1W"],
    ["1M", "1M"],
  ])}</div></div><svg id="ya-chart" class="ya-chart" role="img" aria-label="Synthetic simulation endorsement history" viewBox="0 0 ${c.w} ${c.h}" data-latest-round="${m.activity?.items.at(-1)?.id ?? ""}">${c.markup}</svg><p class="topic-chart-meta"><span id="ya-metric-label">Synthetic bots + shared participants · settled round</span> <span class="ya-change" id="ya-change">${changeText(m, true)}</span></p></div><div id="ya-chart-tooltip" class="ya-chart-tooltip" role="tooltip" aria-hidden="true"><span data-tip-date></span> <strong></strong></div></section><template id="topic-history-data">${JSON.stringify(m)}</template>`;
}
