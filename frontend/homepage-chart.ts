import type { HomeIdea } from "../src/features/discovery/homepage-model.ts";
import type {
  HomeMetric,
  HomeRange,
  chartGeometry,
} from "../src/features/discovery/homepage-chart.ts";
// SVG setAttribute accepts numeric coordinates through existing WebIDL string coercion.
interface NumericCoordinates {
  setAttribute(name: "x" | "y" | "width", value: number): void;
}
interface ChartOptions {
  root: HTMLElement;
  svg: SVGSVGElement;
  m: HomeIdea;
  metric: HomeMetric;
  range: HomeRange;
  c: ReturnType<typeof chartGeometry>;
  activate(reset: () => void): void;
  deactivate(reset: () => void): void;
  pin(value: boolean): void;
}
/* global document, window, matchMedia, setTimeout, clearTimeout, IntersectionObserver, requestAnimationFrame, cancelAnimationFrame */
import { formatValue } from "../src/features/discovery/homepage-chart.ts";
import { changeText } from "../src/features/discovery/homepage-view.ts";
import { html } from "../src/platform/html.ts";

// Lines draw from left to right the first time each graph is seen on screen.
// The topic page's endorsement history (topic-chart.ts) draws the same way.
const DRAW_MS = 1500;
const drawn = new Set<string>();
export function reveal(svg: SVGSVGElement, key: string) {
  svg.classList.remove("is-pending", "is-drawing");
  if (
    drawn.has(key) ||
    !("IntersectionObserver" in window) ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return () => {};
  svg.classList.add("is-pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      drawn.add(key);
      svg.classList.replace("is-pending", "is-drawing");
      timer = setTimeout(() => svg.classList.remove("is-drawing"), DRAW_MS);
    },
    { threshold: 0.3 },
  );
  observer.observe(svg);
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}
let sparkObserver: IntersectionObserver | undefined;
export function revealSparks(container: ParentNode) {
  sparkObserver?.disconnect();
  sparkObserver = undefined;
  if (
    !("IntersectionObserver" in window) ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const spark = entry.target as SVGSVGElement;
        observer.unobserve(spark);
        drawn.add(spark.dataset.drawKey!);
        spark.classList.replace("is-pending", "is-drawing");
        setTimeout(() => spark.classList.remove("is-drawing"), DRAW_MS);
      }
    },
    { threshold: 0.6 },
  );
  container
    .querySelectorAll<SVGSVGElement>(".ya-spark:has(.ya-spark-line)")
    .forEach((spark) => {
      const key =
        "spark:" +
        (spark.closest<HTMLElement>("[data-expand]")?.dataset.expand ?? "");
      if (drawn.has(key)) return;
      spark.dataset.drawKey = key;
      spark.classList.add("is-pending");
      observer.observe(spark);
    });
  sparkObserver = observer;
}
export function bindHomepageChart({
  root,
  svg,
  m,
  metric,
  range,
  c,
  activate,
  deactivate,
  pin,
}: ChartOptions) {
  const detail = svg.id === "ya-detail-chart",
    prefix = detail ? "#ya-detail-" : "#ya-";
  // The trending card shows For and Against beside the chart and the metric's
  // value in its legend; an idea with no rounds yet shows neither. The
  // expanded idea shows the metric's value.
  const valueEl = root.querySelector<HTMLElement>(prefix + "value"),
    againstEl = detail ? null : root.querySelector<HTMLElement>("#ya-against"),
    legendEl = detail ? null : root.querySelector<HTMLElement>("#ya-legend"),
    legendName = detail
      ? null
      : root.querySelector<HTMLElement>("#ya-legend-name"),
    labelEl = root.querySelector<HTMLElement>(
      detail ? "#ya-detail-label" : "#ya-metric-label",
    ),
    changeEl = root.querySelector<HTMLElement>(prefix + "change");
  const tooltip = root.querySelector<HTMLElement>("#ya-chart-tooltip")!,
    clip = svg.querySelector<SVGRectElement & NumericCoordinates>(
      "[data-chart-clip]",
    ),
    marker = svg.querySelector<SVGRectElement & NumericCoordinates>(
      "[data-chart-hover-marker]",
    );
  const outcomes = Boolean(againstEl);
  const metricValue = (value: number | null) =>
    formatValue(value, metric) +
    (metric === "price" && value !== null ? " YC" : "");
  const lifecycle = new AbortController(),
    signal = lifecycle.signal;
  const stopReveal = reveal(
    svg,
    [detail ? "detail" : "main", m.id, metric, range].join(":"),
  );
  let frame = 0,
    pinned = false,
    pendingX = 0,
    active = false;
  function latest() {
    const latestValue = metric === "price" ? m.price : m.pct;
    if (legendName)
      legendName.textContent = metric === "price" ? "YES price" : "Endorsement";
    if (legendEl) legendEl.textContent = metricValue(latestValue);
    if (outcomes) {
      valueEl!.textContent = formatValue(m.pct);
      againstEl!.textContent = m.pct === null ? "—" : formatValue(100 - m.pct);
    } else if (valueEl) valueEl.textContent = formatValue(latestValue, metric);
    if (!labelEl || !changeEl) return;
    // Under For and Against, the line describes the endorsement they show.
    const shown: HomeMetric = outcomes ? "endorsement" : metric;
    labelEl.textContent = m.activity
      ? shown === "price"
        ? "Shared YES offer · synthetic simulation"
        : "Synthetic bots + shared participants · settled round"
      : m.reference
        ? shown === "price"
          ? "Last executed YES price · completed round"
          : "Participant endorsement · latest closed round"
        : shown === "price"
          ? "Topic execution price history unavailable"
          : "Topic endorsement history unavailable";
    changeEl.textContent =
      m.reference || m.activity
        ? shown === "price"
          ? "YC / YES contract"
          : changeText(m, true)
        : "";
    changeEl.classList.toggle("down", shown !== "price" && (m.delta ?? 0) < 0);
  }
  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    pinned = false;
    pin(false);
    svg.classList.remove("is-scrubbing");
    clip?.setAttribute("width", c.w);
    if (active) {
      tooltip.classList.remove("is-visible");
      tooltip.setAttribute("aria-hidden", "true");
      active = false;
      deactivate(reset);
    }
    latest();
  }
  let keyboard = svg.nextElementSibling;
  if (!keyboard || !keyboard.classList.contains("ya-scrub-control")) {
    keyboard = document.createElement("label");
    keyboard.className = "ya-scrub-control";
    keyboard.innerHTML =
      html`<span>Explore chart history</span><input type="range" min="0" max="1000" step="10" value="1000" aria-label="Explore ${detail ? "expanded idea" : "trending idea"} chart history">`.toString();
    svg.insertAdjacentElement("afterend", keyboard);
  }
  const slider = keyboard.querySelector("input")!;
  slider.disabled = !c.points.length;
  svg.setAttribute(
    "aria-label",
    `${m.reference ? "Sample" : m.activity ? "Synthetic" : "Unavailable"} ${metric === "price" ? "YES offered price history in Yap Coins" : "endorsement history across completed rounds"}. ${c.points.length ? "Move across the chart to inspect history." : "No topic-level history is available."}`,
  );
  function show(px: number) {
    if (!c.points.length) return;
    activate(reset);
    active = true;
    const chartX = Math.max(c.left, Math.min(c.w - c.right, px)),
      fraction = (chartX - c.left) / (c.w - c.right - c.left),
      value = c.valueAt(fraction),
      chartY = c.y(value!);
    const end = c.times.at(-1) ?? Date.UTC(2026, 9, 16, 23, 59),
      span = c.times.length
        ? Math.max(1, end - c.times[0]!)
        : (range === "1D" ? 1 : range === "1W" ? 7 : 30) * 86400000,
      date = new Date(end - span + fraction * span);
    const day = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const stamp =
      day +
      " · " +
      date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
    clip?.setAttribute("width", chartX);
    marker?.setAttribute("x", chartX - 5);
    marker?.setAttribute("y", chartY - 5);
    svg.classList.add("is-scrubbing");
    if (legendEl) legendEl.textContent = metricValue(value);
    if (outcomes) {
      if (metric === "endorsement") {
        valueEl!.textContent = formatValue(value);
        againstEl!.textContent = formatValue(100 - value!);
      }
    } else if (valueEl) valueEl.textContent = formatValue(value, metric);
    if (labelEl)
      labelEl.textContent =
        stamp +
        " · " +
        (metric === "price"
          ? m.activity
            ? "Shared YES offer"
            : "YES execution price"
          : "Endorsement");
    const delta = value! - c.points[0]!;
    if (changeEl) {
      changeEl.textContent =
        metric === "price"
          ? "YC / YES contract"
          : (delta >= 0 ? "↗ " : "↘ ") + Math.abs(delta).toFixed(1) + " pp";
      changeEl.classList.toggle("down", metric !== "price" && delta < 0);
    }
    // The small label beside the marker: the day and the value.
    tooltip.querySelector("[data-tip-date]")!.textContent = day;
    tooltip.querySelector("strong")!.textContent = metricValue(value);
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    const rect = svg.getBoundingClientRect(),
      base = root.getBoundingClientRect(),
      tip = tooltip.getBoundingClientRect(),
      sx = rect.left - base.left + (chartX * rect.width) / c.w,
      sy = rect.top - base.top + (chartY * rect.height) / c.h;
    // The small value label sits beside the marker, flipping left near the edge.
    tooltip.style.left =
      (sx + 12 + tip.width > base.width - 8 ? sx - 12 - tip.width : sx + 12) +
      "px";
    tooltip.style.top = sy - tip.height / 2 + "px";
    slider.value = String(Math.round(fraction * 1000));
    slider.setAttribute(
      "aria-valuetext",
      stamp +
        ", " +
        formatValue(value, metric) +
        (metric === "price" ? " Yap Coins" : " endorsement"),
    );
  }
  function request(event: PointerEvent) {
    if (!c.points.length) return;
    const rect = svg.getBoundingClientRect();
    pendingX = ((event.clientX - rect.left) * c.w) / rect.width;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        show(pendingX);
      });
  }
  svg.addEventListener(
    "pointermove",
    (e) => {
      if (!pinned || e.pointerType === "touch") request(e);
    },
    { signal },
  );
  svg.addEventListener(
    "pointerleave",
    () => {
      if (!pinned) reset();
    },
    { signal },
  );
  svg.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") {
        pinned = !pinned;
        pin(pinned);
        if (pinned) request(e);
        else reset();
      }
    },
    { signal },
  );
  svg.addEventListener("pointercancel", reset, { signal });
  slider.addEventListener(
    "input",
    () =>
      show(c.left + (Number(slider.value) / 1000) * (c.w - c.left - c.right)),
    { signal },
  );
  slider.addEventListener(
    "focus",
    () =>
      show(c.left + (Number(slider.value) / 1000) * (c.w - c.left - c.right)),
    { signal },
  );
  slider.addEventListener("blur", reset, { signal });
  slider.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        reset();
        slider.blur();
      }
    },
    { signal },
  );
  latest();
  return {
    destroy() {
      stopReveal();
      lifecycle.abort();
      reset();
    },
  };
}
