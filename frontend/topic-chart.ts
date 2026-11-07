// A topic's endorsement history on its page (src/features/discovery/
// topic-history-web.ts): the chart the home used to show, drawn with the same
// geometry and bound with the same pointer, touch and keyboard inspection
// (frontend/homepage-chart.ts). The metric and period buttons redraw it, and
// so does a change of width.
import type { HomeIdea } from "../src/features/discovery/homepage-model.ts";
import {
  chartGeometry,
  type HomeMetric,
  type HomeRange,
} from "../src/features/discovery/homepage-chart.ts";
import { bindHomepageChart } from "./homepage-chart.js";

/* global window, document, ResizeObserver, requestAnimationFrame, cancelAnimationFrame */
// Selectors and dataset values below come from topicHistoryMarkup(); non-null
// assertions state its guarantees.
interface ChartDataset extends DOMStringMap {
  metric?: HomeMetric;
  range?: HomeRange;
}
type ChartButton = HTMLButtonElement & { readonly dataset: ChartDataset };

const root = document.querySelector<HTMLElement>("[data-topic-history]");
const template = document.getElementById(
  "topic-history-data",
) as HTMLTemplateElement | null;

if (root && template) {
  const m: HomeIdea = JSON.parse(template.content.textContent!);
  const svg = root.querySelector<SVGSVGElement>("#ya-chart")!;
  const buttons = [
    ...root.querySelectorAll<ChartButton>("[data-metric],[data-range]"),
  ];
  let metric: HomeMetric = "endorsement";
  let range: HomeRange = "1D";
  let chart: ReturnType<typeof bindHomepageChart> | undefined;
  let reset: (() => void) | undefined;
  let frame = 0;
  let width = 0;

  function draw() {
    chart?.destroy();
    const box = svg.getBoundingClientRect();
    width = box.width;
    const c = chartGeometry(m, metric, range, box.width, false, box.height);
    svg.setAttribute("viewBox", `0 0 ${c.w} ${c.h}`);
    svg.dataset.latestRound = m.activity?.items.at(-1)?.id ?? "";
    svg.innerHTML = c.markup.toString();
    chart = bindHomepageChart({
      root: root!,
      svg,
      m,
      metric,
      range,
      c,
      activate(next) {
        reset = next;
      },
      deactivate(previous) {
        if (reset === previous) reset = undefined;
      },
      pin() {},
    });
  }

  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<ChartButton>(
      "[data-metric],[data-range]",
    );
    if (!button) return;
    if (button.dataset.metric) metric = button.dataset.metric;
    if (button.dataset.range) range = button.dataset.range;
    for (const other of buttons)
      other.setAttribute(
        "aria-pressed",
        String(
          other.dataset.metric
            ? other.dataset.metric === metric
            : other.dataset.range === range,
        ),
      );
    draw();
  });
  // A tap anywhere else on the page ends a touch inspection, as it did on
  // the home.
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target as Element).closest(".ya-chart,.ya-scrub-control"))
      reset?.();
  });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (Math.abs(svg.getBoundingClientRect().width - width) > 1) draw();
      });
    });
    observer.observe(svg);
    window.addEventListener(
      "pagehide",
      () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      },
      { once: true },
    );
  }
  draw();
}
