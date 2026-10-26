import type { RoundPoint, Timeline } from "./arena-types.js";
interface PriceElements {
  round: HTMLSelectElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  drawing: SVGGElement;
}
/* global document, Option */
import { sharePercent } from "./arena-chart.js";

export const priceText = (percent: number | null) =>
  percent === null ? "—" : `${percent.toFixed(2)}¢`;

export function roundPrices(point: RoundPoint | null | undefined) {
  const offer = sharePercent(point?.offer),
    a = sharePercent(point?.medianNo),
    b = sharePercent(point?.medianYes),
    share = sharePercent(point?.share);
  const ownLimit =
    typeof point?.ownLimit === "string" &&
    /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(point.ownLimit)
      ? 100 * Number(point.ownLimit)
      : null;
  return {
    offer,
    noOffer: offer === null ? null : 100 - offer,
    a,
    b,
    share,
    ownLimit,
    interval: a !== null && b !== null && a < b,
  };
}

export function createPriceInspector(
  root: HTMLElement,
  onSelect: (point: RoundPoint) => void,
) {
  const el = <K extends string>(name: K) =>
      root.querySelector<
        K extends keyof PriceElements ? PriceElements[K] : HTMLElement
      >(`[data-price-${name}]`)!,
    select = el("round"),
    drawing = el("drawing");
  let points: RoundPoint[] = [],
    signature: string | undefined;
  const node = <K extends keyof SVGElementTagNameMap>(
    name: K,
    attributes: Record<string, string | number>,
    text?: string,
  ) => {
    const result = document.createElementNS("http://www.w3.org/2000/svg", name);
    // setAttribute performs the original Web IDL string coercion for numeric SVG values.
    for (const [key, value] of Object.entries(attributes))
      result.setAttribute(key, value as string);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  function choose(index: number) {
    const point = points[index];
    if (point) onSelect(point);
  }
  select.addEventListener("change", () => choose(select.selectedIndex));
  el("previous").addEventListener("click", () =>
    choose(select.selectedIndex - 1),
  );
  el("next").addEventListener("click", () => choose(select.selectedIndex + 1));
  const group = (name: string, children: SVGElement[]) => {
    const element = node("g", {
      class: "arena-price-motion",
      "data-price-marker": name,
      "aria-hidden": "true",
    });
    element.append(...children);
    drawing.append(element);
    return element;
  };
  const intervalLine = node("line", {
    x1: 0,
    x2: 1,
    y1: 28,
    y2: 28,
    class: "arena-price-interval",
    "vector-effect": "non-scaling-stroke",
  });
  const interval = group("interval", [intervalLine]);
  const intervalText = node("text", { x: 0, y: 66, "text-anchor": "middle" });
  const intervalLabel = group("interval-label", [intervalText]);
  const markers: Record<
    string,
    { layer: SVGGElement; title: SVGTitleElement }
  > = {};
  for (const [name, className, start, end] of [
    ["median-no", "arena-price-median", 19, 37],
    ["median-yes", "arena-price-median", 19, 37],
    ["share", "arena-price-share", 8, 46],
    ["limit", "arena-price-limit", 2, 46],
    ["offer", "arena-price-offer", 8, 46],
  ] as const) {
    const line = node("line", {
      x1: 0,
      x2: 0,
      y1: start,
      y2: end,
      class: className,
    });
    const title = node("title", {});
    line.append(title);
    const layer = group(name, [line]);
    markers[name] = { layer, title };
    if (name === "offer")
      layer.append(
        node("circle", { cx: 0, cy: 28, r: 7, class: "arena-price-offer-dot" }),
      );
  }
  const offerText = node("text", {
    x: 0,
    y: 10,
    "text-anchor": "middle",
    class: "arena-price-offer-label",
  });
  const offerLabel = group("offer-label", [offerText]);
  function place(layer: SVGElement, x: number, visible: boolean, width = 1) {
    if (!visible) {
      layer.style.opacity = "0";
      layer.style.pointerEvents = "none";
      layer.setAttribute("aria-hidden", "true");
      return;
    }
    const transform = `translate(${x}px, 0px) scaleX(${width})`;
    if (!layer.dataset.placed) {
      layer.style.transition = "none";
      layer.style.transform = transform;
      layer.getBoundingClientRect();
      layer.style.removeProperty("transition");
      layer.dataset.placed = "true";
    } else layer.style.transform = transform;
    layer.style.opacity = "1";
    layer.style.removeProperty("pointer-events");
    layer.setAttribute("aria-hidden", "false");
  }
  function show(point: RoundPoint | null | undefined) {
    const p = roundPrices(point);
    select.value = point?.id ?? "";
    el("previous").disabled = select.selectedIndex <= 0;
    el("next").disabled =
      select.selectedIndex < 0 || select.selectedIndex >= points.length - 1;
    el("context").textContent = point
      ? `Round ${point.number} · ${point.argumentLabel || "Argument not labeled"}${point.state === "too_few" ? " · too few positions" : point.state ? ` · ${point.state}` : " · settled"}`
      : "Start or select a round to inspect its offered price.";
    el("yes").textContent = priceText(p.offer);
    el("no").textContent = priceText(p.noOffer);
    const x = (value: number) => 46 + value * 6.06;
    place(
      interval,
      x(p.a ?? 0),
      p.interval,
      p.interval ? (p.b! - p.a!) * 6.06 : 1,
    );
    intervalText.textContent = p.interval
      ? `Median interval ${priceText(p.a)}–${priceText(p.b)}`
      : "";
    place(
      intervalLabel,
      Math.max(150, Math.min(558, x(((p.a ?? 0) + (p.b ?? 0)) / 2))),
      p.interval,
    );
    for (const [name, value, label] of [
      ["median-no", p.a, "Median NO floor"],
      ["median-yes", p.b, "Median YES ceiling"],
      ["share", p.share, "Final YES share"],
      ["limit", p.ownLimit, "Your YES-scale limit"],
      ["offer", p.offer, "Shared YES offer"],
    ] as const) {
      const marker = markers[name]!;
      marker.title.textContent =
        value === null
          ? ""
          : `${label}: ${name === "share" ? value.toFixed(2) + "%" : priceText(value)}`;
      place(marker.layer, x(value ?? 0), value !== null);
    }
    offerText.textContent = `p = ${priceText(p.offer)}`;
    place(
      offerLabel,
      Math.max(105, Math.min(615, x(p.offer ?? 0))),
      p.offer !== null,
    );
    const revealed = point && point.revealed !== false;
    const intervalDescription = p.interval
      ? `Median interval ${priceText(p.a)}–${priceText(p.b)}`
      : p.a !== null && p.b !== null
        ? `NO median ${priceText(p.a)} ≥ YES median ${priceText(p.b)} · no positive interval`
        : "Median interval unavailable · one side is missing";
    const description = !revealed
      ? "Medians and final endorsement rates remain sealed until final reveal."
      : point?.state === "too_few"
        ? "Too few positions to show results."
        : `${intervalDescription}${point!.branch ? ` · ${point!.branch} offer` : ""}.${p.ownLimit !== null ? ` Your YES-scale limit ${priceText(p.ownLimit)}.` : ""}`;
    el("explanation").textContent = description;
    root.querySelector("#arena-price-scale-title")!.textContent =
      `${el("context").textContent}. Shared YES offer ${priceText(p.offer)}. ${description}${p.share !== null ? ` Final YES ${p.share.toFixed(2)}%, NO ${(100 - p.share).toFixed(2)}%.` : ""} Prices are hundredths of one Yap Coin.`;
  }
  return {
    show,
    clear() {
      points = [];
      signature = undefined;
      for (const layer of drawing.children as HTMLCollectionOf<SVGElement>) {
        layer.style.transition = "none";
        layer.style.opacity = "0";
        layer.style.removeProperty("transform");
        delete layer.dataset.placed;
      }
      select.replaceChildren(new Option("No settled rounds", ""));
      select.disabled = true;
      show(null);
    },
    update(data: Timeline) {
      points = data.items;
      const next = JSON.stringify(
        points.map((p) => [p.id, p.number, p.argumentLabel, p.state]),
      );
      if (next !== signature) {
        const selected = select.value;
        signature = next;
        select.replaceChildren(
          ...points.map(
            (p) =>
              new Option(
                `R${p.number} · ${p.argumentLabel || "Unlabeled argument"}`,
                p.id,
              ),
          ),
        );
        if (!points.length) select.add(new Option("No settled rounds", ""));
        select.value = selected;
      }
      select.disabled = !points.length;
    },
  };
}
