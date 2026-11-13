// A topic's figure after each revealed turn (Decision 0015), drawn by
// src/features/discovery/topic-endorsement-web.ts. This redraws it for the
// chart's width and the chosen range (All, 1D, 1W or 1M) and inspects it like
// the home's chart: the pointer, a tap (touch pins it until a tap elsewhere)
// or the arrow keys on a hidden slider move a square marker from point to
// point, and a label beside it names the turn and the figure then.
import {
  changeSince,
  pointText,
  topicEndorsementGeometry,
  wholePercent,
  yesShare,
  type TopicChartData,
  type TopicRange,
} from "../src/features/discovery/topic-endorsement-chart.ts";
import { html } from "../src/platform/html.ts";
import { reveal } from "./homepage-chart.js";

/* global window, document, ResizeObserver, requestAnimationFrame, cancelAnimationFrame */
// SVG setAttribute accepts numeric coordinates through existing WebIDL string coercion.
interface NumericCoordinates {
  setAttribute(name: "x" | "y" | "width", value: number): void;
}
interface RangeDataset extends DOMStringMap {
  range?: TopicRange;
}
type RangeButton = HTMLButtonElement & { readonly dataset: RangeDataset };

// Selectors below come from topicHistoryMarkup(); non-null assertions state
// its guarantees.
const root = document.querySelector<HTMLElement>("[data-topic-history]");
const template = document.getElementById(
  "topic-endorsement-data",
) as HTMLTemplateElement | null;

if (root && template) {
  const data: TopicChartData = JSON.parse(template.content.textContent!);
  const svg = root.querySelector<SVGSVGElement>("#ya-chart")!;
  const legend = root.querySelector<HTMLElement>("#ya-legend")!;
  const label = root.querySelector<HTMLElement>("#ya-metric-label")!;
  const change = root.querySelector<HTMLElement>("#ya-change")!;
  const tooltip = root.querySelector<HTMLElement>("#ya-chart-tooltip")!;
  const resting = label.textContent ?? "";
  const buttons = [...root.querySelectorAll<RangeButton>("[data-range]")];
  let range: TopicRange = "All";
  let frame = 0;
  let width = 0;
  let stop: (() => void) | undefined;
  let reset: (() => void) | undefined;

  // The hidden slider the keyboard inspects the chart with.
  const control = document.createElement("label");
  control.className = "ya-scrub-control";
  control.innerHTML =
    html`<span>Explore the topic figure's history</span><input type="range" min="0" step="1" aria-label="Explore the topic figure's history">`.toString();
  svg.insertAdjacentElement("afterend", control);
  const slider = control.querySelector("input")!;

  function setChange(text: string) {
    change.textContent = text;
    change.classList.toggle("down", text.startsWith("−"));
  }

  function draw() {
    stop?.();
    const box = svg.getBoundingClientRect();
    width = box.width;
    const c = topicEndorsementGeometry(
      data.points,
      range,
      box.width,
      box.height,
    );
    svg.setAttribute("viewBox", `0 0 ${c.w} ${c.h}`);
    svg.innerHTML = c.markup.toString();
    const clip = svg.querySelector<SVGRectElement & NumericCoordinates>(
      "[data-chart-clip]",
    );
    const marker = svg.querySelector<SVGRectElement & NumericCoordinates>(
      "[data-chart-hover-marker]",
    );
    const last = c.shown.length - 1;
    const lifecycle = new AbortController(),
      signal = lifecycle.signal;
    const stopReveal = reveal(svg, `topic:${range}`);
    let pinned = false,
      active = false,
      pending = 0,
      raf = 0;
    slider.max = String(Math.max(0, last));
    slider.value = String(Math.max(0, last));
    slider.disabled = last < 0;

    function latest() {
      const point = c.shown[last];
      legend.textContent = point ? `${wholePercent(yesShare(point))}%` : "—";
      label.textContent = resting;
      setChange(changeSince(c.shown));
      // The keyboard starts again from the latest point.
      slider.value = String(Math.max(0, last));
      slider.removeAttribute("aria-valuetext");
    }
    function rest() {
      cancelAnimationFrame(raf);
      raf = 0;
      pinned = false;
      svg.classList.remove("is-scrubbing");
      clip?.setAttribute("width", c.w);
      if (active) {
        tooltip.classList.remove("is-visible");
        tooltip.setAttribute("aria-hidden", "true");
        active = false;
        if (reset === rest) reset = undefined;
      }
      latest();
    }
    function show(index: number) {
      const point = c.shown[index];
      if (!point) return;
      active = true;
      reset = rest;
      const x = c.x(index),
        y = c.y(c.values[index]!);
      const text = pointText(point);
      clip?.setAttribute("width", x);
      marker?.setAttribute("x", x - 5);
      marker?.setAttribute("y", y - 5);
      svg.classList.add("is-scrubbing");
      legend.textContent = text.value;
      label.textContent = text.head;
      setChange(changeSince(c.shown, index));
      tooltip.querySelector("[data-tip-head]")!.textContent = text.head;
      tooltip.querySelector("[data-tip-value]")!.textContent = text.value;
      tooltip.querySelector("[data-tip-rest]")!.textContent = text.rest;
      tooltip.classList.add("is-visible");
      tooltip.setAttribute("aria-hidden", "false");
      const rect = svg.getBoundingClientRect(),
        base = root!.getBoundingClientRect(),
        tip = tooltip.getBoundingClientRect(),
        sx = rect.left - base.left + (x * rect.width) / c.w,
        sy = rect.top - base.top + (y * rect.height) / c.h;
      // Beside the marker, flipping left near the edge.
      tooltip.style.left =
        (sx + 12 + tip.width > base.width - 8 ? sx - 12 - tip.width : sx + 12) +
        "px";
      tooltip.style.top = sy - tip.height / 2 + "px";
      slider.value = String(index);
      slider.setAttribute("aria-valuetext", text.label);
    }
    function request(event: PointerEvent) {
      const rect = svg.getBoundingClientRect();
      pending = c.nearest(((event.clientX - rect.left) * c.w) / rect.width);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          show(pending);
        });
    }
    svg.addEventListener(
      "pointermove",
      (event) => {
        if (!pinned || event.pointerType === "touch") request(event);
      },
      { signal },
    );
    svg.addEventListener(
      "pointerleave",
      () => {
        if (!pinned) rest();
      },
      { signal },
    );
    svg.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType !== "touch") return;
        pinned = !pinned;
        if (pinned) request(event);
        else rest();
      },
      { signal },
    );
    svg.addEventListener("pointercancel", rest, { signal });
    slider.addEventListener("input", () => show(Number(slider.value)), {
      signal,
    });
    slider.addEventListener("focus", () => show(Number(slider.value)), {
      signal,
    });
    slider.addEventListener("blur", rest, { signal });
    slider.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        rest();
        slider.blur();
      },
      { signal },
    );
    latest();
    stop = () => {
      stopReveal();
      lifecycle.abort();
      rest();
    };
  }

  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<RangeButton>(
      "[data-range]",
    );
    if (!button?.dataset.range) return;
    range = button.dataset.range;
    for (const other of buttons)
      other.setAttribute("aria-pressed", String(other === button));
    draw();
  });
  // A tap anywhere else on the page ends a touch inspection.
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
