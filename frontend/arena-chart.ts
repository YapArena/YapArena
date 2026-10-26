import type { Fraction, RoundPoint, Timeline } from "./arena-types.js";
export type ChartPoint = RoundPoint & { yes: number | null; x: number };
/* global document */
import { createChartStatement } from "./arena-statement.js";
export function sharePercent(share: Fraction | null | undefined) {
  if (!share || !/^\d{1,30}$/.test(share.n) || !/^[1-9]\d{0,29}$/.test(share.d))
    return null;
  const n = BigInt(share.n),
    d = BigInt(share.d);
  return n <= d ? (100 * Number(n)) / Number(d) : null;
}

export function chartPoints(items: RoundPoint[]) {
  return items.map((item, index) => ({
    ...item,
    yes: sharePercent(item.share),
    x:
      items.length === 1
        ? 349
        : 46 + (index * 606) / Math.max(1, items.length - 1),
  }));
}

/**
 * Decision 0012: the chart heading's text for a settled turn window, from
 * its final AI outline's argument labels. It replaces the manual argument
 * label for turn windows; null when the window has no final outline.
 */
export function windowArgumentLabel(labels: readonly string[]) {
  const clean = labels.map((label) => label.trim()).filter(Boolean);
  return clean.length ? clean.join(" · ") : null;
}

export function nearestRound<T extends { x: number }>(points: T[], x: number) {
  if (!Number.isFinite(x) || !points.length) return null;
  return points.reduce((nearest, point) =>
    Math.abs(point.x - x) < Math.abs(nearest.x - x) ? point : nearest,
  );
}

export function chartBadges(share: Fraction | null | undefined) {
  const yes = sharePercent(share);
  const badges = (
    [
      { side: "yes", value: yes },
      { side: "no", value: yes === null ? null : 100 - yes },
    ] as const
  ).map((badge) => ({
    ...badge,
    y: Math.max(30, Math.min(266, 284 - (badge.value ?? 50) * 2.5 - 13)),
  }));
  if (Math.abs(badges[0]!.y - badges[1]!.y) < 32) {
    const middle = (badges[0]!.y + badges[1]!.y) / 2;
    const yesAbove = (yes ?? 50) >= 50;
    badges[0]!.y = middle + (yesAbove ? -16 : 16);
    badges[1]!.y = middle + (yesAbove ? 16 : -16);
  }
  return badges;
}

export function roundProgress(
  opensAt: string | undefined,
  closesAt: string | undefined,
  now = Date.now(),
) {
  // Date(undefined) intentionally flows through the existing invalid-date branch.
  const opens = new Date(opensAt!).getTime(),
    closes = new Date(closesAt!).getTime();
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || closes <= opens)
    return { percent: 0, seconds: 0 };
  return {
    percent: Math.max(
      0,
      Math.min(100, ((closes - now) / (closes - opens)) * 100),
    ),
    seconds: Math.max(0, Math.ceil((closes - now) / 1000)),
  };
}

export function createRoundChart(
  root: HTMLElement,
  onSelect: (point: ChartPoint) => void,
  onInspect: (point: ChartPoint | null) => void = () => {},
) {
  const canvas = root.querySelector<SVGSVGElement>(".arena-chart")!;
  canvas.setAttribute("role", "group");
  const series = root.querySelector<SVGGElement>("[data-chart-series]")!;
  const ticks = root.querySelector<SVGGElement>("[data-chart-ticks]")!;
  const empty = root.querySelector<HTMLElement>("[data-chart-empty]")!;
  const cursor = root.querySelector<SVGGElement>("[data-chart-cursor]")!;
  const badges = root.querySelector<SVGGElement>("[data-chart-badges]")!;
  const statement = createChartStatement(root);
  const svg = <K extends keyof SVGElementTagNameMap>(
    name: K,
    attributes: Record<string, string | number> = {},
    text?: string,
  ) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    // setAttribute performs the original Web IDL string coercion for numeric SVG values.
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value as string);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let revision: string | undefined,
    points: ChartPoint[] = [],
    inspected: string | undefined;
  function renderBadges(point: ChartPoint | null | undefined) {
    badges.replaceChildren();
    badges.dataset.roundId = point?.id ?? "";
    if (!point) return;
    for (const { side, value, y } of chartBadges(point.share)) {
      const group = svg("g", {
        role: "img",
        "data-chart-badge": side,
        "aria-label": `Round ${point.number}: ${side.toUpperCase()} ${value === null ? "unavailable" : value.toFixed(2) + "%"}`,
      });
      group.append(
        svg("rect", {
          x: 662,
          y,
          width: 55,
          height: 27,
          rx: 6,
          class: `arena-chart-badge ${side}`,
        }),
        svg(
          "text",
          {
            x: 689,
            y: y + 18,
            "text-anchor": "middle",
            class: "arena-chart-badge-text",
          },
          value === null ? "—" : `${value.toFixed(0)}%`,
        ),
      );
      badges.append(group);
    }
  }
  function inspect(point: ChartPoint | null | undefined) {
    inspected = point?.id;
    cursor.replaceChildren();
    const displayed = point ?? points.at(-1);
    renderBadges(displayed);
    onInspect(displayed ?? null);
    statement.show(point);
    for (const group of series.querySelectorAll<SVGGElement>(
      "[data-chart-round]",
    ))
      group.classList.toggle(
        "is-inspected",
        group.dataset.chartRound === point?.id,
      );
    if (!point) {
      return;
    }
    cursor.append(
      svg("line", {
        x1: point.x,
        x2: point.x,
        y1: 34,
        y2: 284,
        class: "arena-chart-hover-line",
      }),
    );
    for (const value of point.yes === null ? [] : [point.yes, 100 - point.yes])
      cursor.append(
        svg("circle", {
          cx: point.x,
          cy: 284 - value * 2.5,
          r: 6,
          class: "arena-chart-hover-dot",
        }),
      );
  }
  function fromPointer(event: MouseEvent) {
    const transform = canvas.getScreenCTM();
    if (!transform || !points.length) return null;
    const coordinate = canvas.createSVGPoint();
    coordinate.x = event.clientX;
    coordinate.y = event.clientY;
    const position = coordinate.matrixTransform(transform.inverse());
    if (
      position.x < 36 ||
      position.x > 662 ||
      position.y < 24 ||
      position.y > 320
    )
      return null;
    return nearestRound(points, position.x);
  }
  canvas.addEventListener("pointermove", (event) => {
    const point = fromPointer(event);
    if (point?.id !== inspected) inspect(point);
  });
  canvas.addEventListener("pointerleave", () => inspect(null));
  canvas.addEventListener("click", (event) => {
    const point = fromPointer(event);
    if (point) {
      inspect(point);
      onSelect(point);
    }
  });
  canvas.addEventListener("focusout", (event) => {
    if (!canvas.contains(event.relatedTarget as Node | null)) inspect(null);
  });
  return {
    clear(message = "Sign in to see settled rounds and participate.") {
      revision = undefined;
      series.replaceChildren();
      ticks.replaceChildren();
      cursor.replaceChildren();
      badges.replaceChildren();
      delete badges.dataset.roundId;
      points = [];
      inspected = undefined;
      statement.clear();
      empty.hidden = false;
      empty.textContent = message;
    },
    render(data: Timeline, selectedId: string | null | undefined) {
      const nextRevision = `${data.revision}:${selectedId}`;
      if (nextRevision === revision) {
        inspect(points.find((p) => p.id === inspected));
        return;
      }
      revision = nextRevision;
      const focused = document.activeElement?.getAttribute("data-chart-round");
      const oldInspection = inspected;
      points = chartPoints(data.items);
      statement.reserveLabels(points);
      series.replaceChildren();
      ticks.replaceChildren();
      cursor.replaceChildren();
      empty.hidden = points.some((p) => p.yes !== null);
      empty.textContent = "Results will appear as rounds settle.";
      for (const side of ["yes", "no"]) {
        // Empty rounds interrupt a line: they never create a fictitious 50% point.
        const groups: (ChartPoint & { y: number })[][] = [[]];
        for (const point of points) {
          if (point.yes === null) {
            groups.push([]);
            continue;
          }
          const value = side === "yes" ? point.yes : 100 - point.yes;
          groups.at(-1)!.push({ ...point, y: 284 - value * 2.5 });
        }
        for (const group of groups.filter((g) => g.length > 1)) {
          const path = group
            .map(
              (p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`,
            )
            .join(" ");
          series.append(
            svg("path", {
              d: `${path} L${group.at(-1)!.x},284 L${group[0]!.x},284 Z`,
              fill: `url(#arena-${side}-fill)`,
            }),
          );
          series.append(
            svg("path", {
              d: path,
              class: `arena-chart-line ${side}`,
              fill: "none",
            }),
          );
        }
      }
      const stride = Math.max(1, Math.ceil(points.length / 8));
      for (const [index, point] of points.entries()) {
        if (index % stride === 0 || index === points.length - 1)
          ticks.append(
            svg(
              "text",
              { x: point.x, y: 314, "text-anchor": "middle" },
              `R${point.number}`,
            ),
          );
        const group = svg("g", {
          role: "button",
          tabindex:
            point.id === selectedId ||
            (!points.some((p) => p.id === selectedId) &&
              index === points.length - 1)
              ? "0"
              : "-1",
          "aria-label": `Round ${point.number}: ${point.argumentLabel || "Argument not labeled"}. ${point.yes === null ? "No endorsements" : `YES ${point.yes.toFixed(2)}%, NO ${(100 - point.yes).toFixed(2)}%`}. Offered price ${sharePercent(point.offer) === null ? "unavailable" : sharePercent(point.offer)!.toFixed(2) + " cents"}.`,
          class: `arena-chart-point${point.id === selectedId ? " is-selected" : ""}`,
          "data-chart-round": point.id,
        });
        if (point.yes !== null) {
          for (const [side, value] of [
            ["yes", point.yes],
            ["no", 100 - point.yes],
          ] as const)
            group.append(
              svg("circle", {
                cx: point.x,
                cy: 284 - value * 2.5,
                r: 4,
                class: side,
              }),
            );
        }
        group.append(
          svg("rect", {
            x: point.x - 6,
            y: 30,
            width: 12,
            height: 280,
            fill: "transparent",
          }),
        );
        group.addEventListener("focus", () => inspect(point));
        group.addEventListener("keydown", (event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? points.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        points.length - 1,
                        index + (event.key === "ArrowLeft" ? -1 : 1),
                      ),
                    );
            series
              .querySelector<SVGGElement>(
                `[data-chart-round="${points[next]!.id}"]`,
              )
              ?.focus();
          }
          if (event.key === "Escape") inspect(null);
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            onSelect(point);
          }
        });
        series.append(group);
      }
      inspect(points.find((p) => p.id === oldInspection));
      if (focused)
        series
          .querySelector<SVGGElement>(`[data-chart-round="${focused}"]`)
          ?.focus({ preventScroll: true });
    },
    preview(id: string) {
      inspect(points.find((p) => p.id === id));
    },
  };
}
