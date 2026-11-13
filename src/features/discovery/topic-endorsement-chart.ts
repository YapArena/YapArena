// Decision 0015: a topic's figure after each revealed turn, the line on the
// topic page. Browser-safe: the page draws it on the server and
// frontend/topic-chart.ts redraws it for its width and range. It reuses the
// home chart's guides, line, end pixel, hover marker and hit rectangle
// (homepage-chart.ts); points sit at their position in the history, not at
// their time, because a five-day debate's turns are revealed together.
import { html, type SafeHtml } from "../../platform/html.ts";
import { chartEnd, chartGuides, chartLine } from "./homepage-chart.ts";

export type TopicRange = "All" | "1D" | "1W" | "1M";
export const TOPIC_RANGES: readonly TopicRange[] = ["All", "1D", "1W", "1M"];

/** A point as the page embeds it (<template id="topic-endorsement-data">). */
export interface TopicChartPoint {
  id: string;
  revealedAt: string;
  turnNumber: number;
  /** null once the debate is no longer public; its points stay. */
  debate: { slug: string; title: string } | null;
  yes: number;
  accounts: number;
}

export interface TopicChartData {
  points: TopicChartPoint[];
}

const DAY = 86_400_000;
const spans: Record<Exclude<TopicRange, "All">, number> = {
  "1D": DAY,
  "1W": 7 * DAY,
  "1M": 30 * DAY,
};

/** The Yes share in percent, unrounded. */
export const yesShare = (point: Pick<TopicChartPoint, "yes" | "accounts">) =>
  (point.yes * 100) / point.accounts;

/** A whole percent, as everywhere else on the site. */
export const wholePercent = (value: number) => Math.round(value);

const count = (value: number) => value.toLocaleString("en-US");

export const accountsText = (accounts: number) =>
  `${count(accounts)} account${accounts === 1 ? "" : "s"}`;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/**
 * The points a range shows: those revealed within the range of the latest
 * point, and at least every point of the debate that produced it. Points
 * without accounts have no share and are left out.
 */
export function rangePoints(
  points: readonly TopicChartPoint[],
  range: TopicRange,
): TopicChartPoint[] {
  const counted = points.filter((p) => p.accounts > 0);
  const last = counted.at(-1);
  if (range === "All" || !last) return counted;
  const end = Date.parse(last.revealedAt);
  const inRange = counted.findIndex(
    (p) => Date.parse(p.revealedAt) >= end - spans[range],
  );
  let run = counted.length - 1;
  const slug = last.debate?.slug;
  while (
    slug !== undefined &&
    run > 0 &&
    counted[run - 1]!.debate?.slug === slug
  )
    run--;
  return counted.slice(Math.min(inRange, run));
}

/** The tooltip's two lines for one point. */
export function pointText(point: TopicChartPoint) {
  const head = [
    day(point.revealedAt),
    `Turn ${point.turnNumber}`,
    ...(point.debate ? [point.debate.title] : []),
  ].join(" · ");
  const value = `${wholePercent(yesShare(point))}%`;
  const rest = `Yes · ${accountsText(point.accounts)}`;
  return { head, value, rest, label: `${head}: ${value} ${rest}` };
}

/** "+3 pts since Nov 5", from the first point shown to the given one. */
export function changeSince(
  shown: readonly TopicChartPoint[],
  index = shown.length - 1,
) {
  const first = shown[0],
    point = shown[index];
  if (!first || !point || index === 0) return "";
  const delta = wholePercent(yesShare(point)) - wholePercent(yesShare(first));
  const since = `since ${day(first.revealedAt)}`;
  if (delta === 0) return `No change ${since}`;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} pt${Math.abs(delta) === 1 ? "" : "s"} ${since}`;
}

export function topicEndorsementGeometry(
  points: readonly TopicChartPoint[],
  range: TopicRange,
  width = 800,
  height?: number,
) {
  const w = Math.max(190, width),
    h = Math.max(160, Math.round(height ?? 240));
  const left = 8,
    right = 48,
    top = 12,
    bottom = 28;
  const shown = rangePoints(points, range);
  const values = shown.map(yesShare);
  const lo = values.length
    ? Math.max(0, Math.floor(Math.min(...values) - 3))
    : 0;
  const hi = values.length
    ? Math.min(100, Math.ceil(Math.max(...values) + 3))
    : 100;
  const plot = w - left - right;
  // By position: one point sits at the right end, with the latest.
  const x = (i: number) =>
    left + (shown.length > 1 ? i / (shown.length - 1) : 1) * plot;
  const y = (value: number) =>
    top + ((hi - value) / Math.max(1, hi - lo)) * (h - top - bottom);
  /** The point nearest to a chart x coordinate. */
  const nearest = (chartX: number) =>
    shown.length > 1
      ? Math.max(
          0,
          Math.min(
            shown.length - 1,
            Math.round(((chartX - left) / plot) * (shown.length - 1)),
          ),
        )
      : 0;
  const markup: SafeHtml[] = [
    html`<title>Topic figure after each revealed turn</title>`,
    ...chartGuides({
      lo,
      hi,
      w,
      left,
      right,
      y,
      labelled: shown.length > 0,
      label: (v) => `${Math.round(v)}%`,
    }),
  ];
  if (shown.length) {
    markup.push(
      chartLine(
        values.map((v, i) => [x(i), y(v)]),
        "ya-chart-clip",
        w,
        h,
      ),
    );
    // The dates (times within one day) of the points at five positions.
    const positions = [
      ...new Set(
        [0, 1, 2, 3, 4].map((k) => Math.round((k * (shown.length - 1)) / 4)),
      ),
    ];
    positions.forEach((i, j) => {
      const at = shown[i]!.revealedAt;
      const anchor =
        positions.length === 1
          ? "end"
          : j === 0
            ? "start"
            : j === positions.length - 1
              ? "end"
              : "middle";
      markup.push(
        html`<text x="${x(i)}" y="${h - 4}" text-anchor="${anchor}">${range === "1D" ? time(at) : day(at)}</text>`,
      );
    });
    markup.push(
      chartEnd(x(shown.length - 1), y(values.at(-1)!), { w, h, left, right }),
    );
  }
  return {
    w,
    h,
    left,
    right,
    top,
    bottom,
    shown,
    values,
    x,
    y,
    nearest,
    markup: html`${markup}`,
  };
}
