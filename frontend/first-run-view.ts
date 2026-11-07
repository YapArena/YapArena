// The first-run guide's pieces as DOM: the icon lines of "How YAP Arena
// works" and the coin menu, and the one-time tip card. The words come from
// frontend/first-run-copy.ts.
import type { GuideLine, Tip } from "./first-run-copy.js";

const svgNamespace = "http://www.w3.org/2000/svg";

function svg(viewBox: string, shapes: [string, Record<string, string>][]) {
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.setAttribute("viewBox", viewBox);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  for (const [name, attributes] of shapes) {
    const shape = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes))
      shape.setAttribute(key, value);
    icon.append(shape);
  }
  return icon;
}

// Two speakers, Yes and No, and a copy of the top bar's coin.
function icon(kind: GuideLine["icon"]): Element {
  if (kind === "debate")
    return svg("0 0 18 18", [
      [
        "rect",
        {
          x: "1",
          y: "4",
          width: "7",
          height: "10",
          rx: "1.5",
          class: "first-run-speaker-a",
        },
      ],
      [
        "rect",
        {
          x: "10",
          y: "4",
          width: "7",
          height: "10",
          rx: "1.5",
          class: "first-run-speaker-b",
        },
      ],
    ]);
  if (kind === "answer")
    return svg("0 0 18 18", [
      [
        "rect",
        {
          x: "1",
          y: "6",
          width: "7",
          height: "6",
          rx: "3",
          class: "first-run-yes",
        },
      ],
      [
        "rect",
        {
          x: "10",
          y: "6",
          width: "7",
          height: "6",
          rx: "3",
          class: "first-run-no",
        },
      ],
    ]);
  const coin = document.querySelector(".header-coin")?.cloneNode(true);
  return coin instanceof Element
    ? coin
    : svg("0 0 18 18", [
        ["circle", { cx: "9", cy: "9", r: "7", class: "first-run-coin" }],
      ]);
}

/** A list of icon lines: "<b>lead</b> rest". */
export function guideList(lines: readonly GuideLine[], className: string) {
  const list = document.createElement("ul");
  list.className = `first-run-how ${className}`;
  list.append(
    ...lines.map((line) => {
      const item = document.createElement("li");
      const glyph = document.createElement("span");
      glyph.className = "first-run-glyph";
      glyph.append(icon(line.icon));
      const text = document.createElement("p");
      const lead = document.createElement("b");
      lead.textContent = line.lead;
      text.append(lead, line.rest);
      item.append(glyph, text);
      return item;
    }),
  );
  return list;
}

/** A tip card with its count and "Got it", which calls `dismiss`. */
export function tipCard(tip: Tip, dismiss: () => void) {
  const card = document.createElement("div");
  card.className = "first-run-tip";
  card.setAttribute("role", "note");
  const text = document.createElement("p");
  const lead = document.createElement("b");
  lead.textContent = tip.lead;
  text.append(lead, tip.rest);
  const row = document.createElement("div");
  row.className = "first-run-tip-row";
  const count = document.createElement("span");
  count.textContent = tip.count;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Got it";
  button.addEventListener("click", dismiss);
  row.append(count, button);
  card.append(text, row);
  return card;
}

/** Whether this browser has seen a tip; storage failures count as unseen. */
export function tipSeen(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markTipSeen(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private windows may refuse storage; the tip then shows again next visit.
  }
}
