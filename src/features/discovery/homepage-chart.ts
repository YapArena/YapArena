import type { HomeIdea } from "./homepage-model.ts";
import { html, type SafeHtml } from "../../platform/html.ts";
export type HomeMetric = "endorsement" | "price";
export type HomeRange = "1D" | "1W" | "1M";
export const formatValue = (
  value: number | null,
  metric: HomeMetric = "endorsement",
) =>
  value === null
    ? "—"
    : metric === "price"
      ? value.toFixed(2)
      : Math.round(value) + "%";
export function chartSeries(
  m: HomeIdea,
  metric: HomeMetric,
  range: HomeRange,
): number[] {
  if (m.activity)
    return historyRows(m, metric, range).map((r) =>
      metric === "price"
        ? Number(r.offer!.n) / Number(r.offer!.d)
        : (Number(r.share!.n) * 100) / Number(r.share!.d),
    );
  if (!m.reference || m.price === null) return [];
  if (metric === "price")
    return [
      0.31,
      0.38,
      0.28,
      0.42,
      0.34,
      0.46,
      0.31,
      0.39,
      0.26,
      0.35,
      0.42,
      0.3,
      0.38,
      0.27,
      0.4,
      m.price,
    ].map((v, i) =>
      i === 15 || range === "1D"
        ? v
        : Math.min(
            0.8,
            v + (range === "1W" ? 0.06 * Math.sin(i) : 0.1 * Math.cos(i)),
          ),
    );
  return m.points.map((v, i) =>
    range === "1D"
      ? v
      : Math.max(
          0,
          Math.min(
            100,
            v + ((range === "1W" ? 4 : 7) * Math.sin(i * 0.75) * (15 - i)) / 15,
          ),
        ),
  );
}
export function historyRows(m: HomeIdea, metric: HomeMetric, range: HomeRange) {
  const rows = m.activity?.items ?? [];
  const end = Date.parse(rows.at(-1)?.settledAt ?? "");
  const span = (range === "1D" ? 1 : range === "1W" ? 7 : 30) * 86400000;
  return rows.filter(
    (r) =>
      Date.parse(r.settledAt) >= end - span &&
      (metric === "price" ? r.offer : r.share),
  );
}
export function interpolate(points: number[], fraction: number): number | null {
  if (!points.length) return null;
  if (points.length === 1) return points[0]!;
  const at = Math.max(0, Math.min(1, fraction)) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(at));
  return points[i]! + (points[i + 1]! - points[i]!) * (at - i);
}
/**
 * Five dotted guides between the range's ends, labelled on the right when
 * there is a line to read. Shared by the home's chart and the topic page's
 * endorsement history (topic-endorsement-chart.ts).
 */
export function chartGuides(o: {
  lo: number;
  hi: number;
  w: number;
  left: number;
  right: number;
  y: (value: number) => number;
  labelled: boolean;
  label: (value: number) => string;
}): SafeHtml[] {
  return [0, 1, 2, 3, 4].map((k) => {
    const v = o.lo + ((o.hi - o.lo) * k) / 4;
    return html`<line class="ya-guide" x1="${o.left}" y1="${o.y(v)}" x2="${o.labelled ? o.w - o.right + 2 : o.w - o.left}" y2="${o.y(v)}"/>${o.labelled ? html`<text x="${o.w - o.right + 9}" y="${o.y(v) + 4}">${o.label(v)}</text>` : ""}`;
  });
}

/**
 * The line through the points, with the clip rectangle that hides it to the
 * right of the pointer while scrubbing.
 */
export function chartLine(
  points: readonly (readonly [number, number])[],
  clip: string,
  w: number,
  h: number,
): SafeHtml {
  const path = points
    .map(([px, py], i) => (i ? "L" : "M") + px + "," + py)
    .join(" ");
  return html`<clipPath id="${clip}"><rect data-chart-clip x="0" y="0" width="${w}" height="${h}"/></clipPath><path class="ya-linepath" pathLength="1" d="${path}" clip-path="url(#${clip})"/>`;
}

/**
 * The line ends on a square pixel that pulses; the marker that follows the
 * pointer is a square too, and a transparent rectangle takes the pointer.
 */
export function chartEnd(
  x: number,
  y: number,
  box: { w: number; h: number; left: number; right: number },
): SafeHtml {
  const endX = x - 4,
    endY = y - 4;
  return html`<g class="ya-endpoint" aria-hidden="true"><rect class="ya-endpoint-pulse" x="${endX}" y="${endY}" width="8" height="8"/><rect x="${endX}" y="${endY}" width="8" height="8"/></g><g class="ya-hover-group" aria-hidden="true"><rect data-chart-hover-marker width="10" height="10"/></g><rect data-chart-hit x="${box.left}" y="0" width="${box.w - box.left - box.right}" height="${box.h}" fill="transparent"/>`;
}

export function chartGeometry(
  m: HomeIdea,
  metric: HomeMetric,
  range: HomeRange,
  width = 800,
  detail = false,
  // The trending card's chart fills its column, so the page passes its
  // measured height.
  height?: number,
) {
  const w = Math.max(190, width),
    h = detail ? 290 : Math.max(160, Math.round(height ?? 240));
  const left = 8,
    right = 48,
    top = 12,
    bottom = 28;
  const points = chartSeries(m, metric, range);
  const rows = historyRows(m, metric, range),
    times = rows.map((r) => Date.parse(r.settledAt));
  const first = times[0] ?? 0,
    last = times.at(-1) ?? 1,
    span = Math.max(1, last - first);
  const factor = metric === "price" ? 100 : 1,
    margin = metric === "price" ? 0.06 : 3;
  const lo = points.length
    ? Math.floor((Math.min(...points) - margin) * factor) / factor
    : 0;
  const hi = points.length
    ? Math.ceil((Math.max(...points) + margin) * factor) / factor
    : metric === "price"
      ? 1
      : 100;
  const x = (i: number) =>
    left +
    (m.activity
      ? ((times[i] ?? first) - first) / span
      : i / Math.max(1, points.length - 1)) *
      (w - left - right);
  const valueAt = (fraction: number) => {
    if (!times.length) return interpolate(points, fraction);
    const at = first + Math.max(0, Math.min(1, fraction)) * span;
    if (at <= first) return points[0]!;
    if (at >= last) return points.at(-1)!;
    const next = times.findIndex((t) => t >= at);
    if (next <= 0) return next === 0 ? points[0]! : points.at(-1)!;
    const part =
      (at - times[next - 1]!) / Math.max(1, times[next]! - times[next - 1]!);
    return points[next - 1]! + (points[next]! - points[next - 1]!) * part;
  };
  const y = (value: number) =>
    top + ((hi - value) / (hi - lo)) * (h - top - bottom);
  const markup: SafeHtml[] = [
    html`<title>${points.length ? "Sample" : "Unavailable"} ${metric === "price" ? "YES execution prices, in Yap Coins" : "participant endorsement, in percent"}</title>`,
  ];
  markup.push(
    ...chartGuides({
      lo,
      hi,
      w,
      left,
      right,
      y,
      labelled: points.length > 0,
      label: (v) => (metric === "price" ? v.toFixed(2) : Math.round(v) + "%"),
    }),
  );
  if (points.length) {
    markup.push(
      chartLine(
        points.map((v, i) => [x(i), y(v)]),
        detail ? "ya-detail-chart-clip" : "ya-chart-clip",
        w,
        h,
      ),
    );
    // Five dates under the line: the sample's own, or the rounds' times.
    const labels =
      range === "1D"
        ? ["00:00", "06:00", "12:00", "18:00", "Now"]
        : range === "1W"
          ? ["Oct 9", "Oct 11", "Oct 12", "Oct 14", "Oct 16"]
          : ["Sep 16", "Sep 23", "Sep 30", "Oct 7", "Oct 16"];
    [0, 1, 2, 3, 4]
      .map((i) => Math.round((i * (points.length - 1)) / 4))
      .forEach((i, j) => {
        if (m.activity)
          labels[j] =
            range === "1D"
              ? new Date(times[i]!).toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "UTC",
                })
              : new Date(times[i]!).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                });
        markup.push(
          html`<text x="${x(i)}" y="${h - 4}" text-anchor="${j === 0 ? "start" : j === 4 ? "end" : "middle"}">${labels[j]}</text>`,
        );
      });
    // The line ends on a square pixel that pulses; the marker that follows the
    // pointer is a square too.
    markup.push(
      chartEnd(x(points.length - 1), y(points.at(-1)!), {
        w,
        h,
        left,
        right,
      }),
    );
  } else
    markup.push(
      // Between the second and third guides, clear of the lines.
      html`<text class="ya-chart-empty" x="${w / 2}" y="${top + (h - top - bottom) * 0.375 + 5}" text-anchor="middle">The chart starts after the first closed round.</text>`,
    );
  return {
    w,
    h,
    left,
    right,
    top,
    bottom,
    points,
    x,
    y,
    markup: html`${markup}`,
    rows,
    times,
    valueAt,
  };
}
