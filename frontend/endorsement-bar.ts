// Decision 0015: the debate's last-answer bar on the video's bottom edge and
// its card. It reads the figure from the answer panel's window list
// (frontend/stake-windows.ts), so it adds no request of its own, and it never
// announces anything live: aria-valuetext is read when the bar has focus.
import {
  barView,
  cardLeft,
  type BarLabels,
  type BarView,
} from "./endorsement-bar-model.js";
import { onDebateEndorsement } from "./stake-windows.js";

function line(className: string, text: string) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function cardContent(view: BarView) {
  const parts: HTMLElement[] = [
    line("arena-endorsement-heading", view.card.heading),
  ];
  if (view.card.shares.length) {
    const shares = document.createElement("dl");
    shares.className = "arena-endorsement-shares";
    for (const share of view.card.shares) {
      const row = document.createElement("div");
      row.dataset.answer = share.answer;
      const name = document.createElement("dt");
      name.textContent = share.label;
      const value = document.createElement("dd");
      value.textContent = `${share.percent}%`;
      row.append(name, value);
      shares.append(row);
    }
    parts.push(shares);
  }
  const lines: [string, string | null][] = [
    ["arena-endorsement-counts", view.card.counts],
    ["arena-endorsement-change", view.card.change],
    ["arena-endorsement-switches", view.card.switches],
    ["arena-endorsement-status", view.card.status],
    ["arena-endorsement-footer", view.card.footer],
  ];
  for (const [className, text] of lines)
    if (text) parts.push(line(className, text));
  return parts;
}

function start(bar: HTMLElement, card: HTMLElement, debateId: string) {
  const labels: BarLabels = {
    sideA: bar.dataset.sideA ?? "",
    sideB: bar.dataset.sideB ?? "",
    sideAIsYes: bar.dataset.sideAIsYes !== "false",
  };
  let view = barView(
    { endorsement: null, revealMode: "per_round", revealAt: null, now: 0 },
    labels,
  );
  // The kind of pointer behind the press in progress, so a tap's focus and
  // click make one toggle and a mouse click keeps the hover card open.
  let pressing: string | null = null;

  function place() {
    const surface = bar.parentElement;
    if (!surface || card.hidden) return;
    const left = cardLeft(
      surface.clientWidth,
      card.offsetWidth,
      view.empty ? 50 : view.yesPercent,
    );
    card.style.left = `${left}px`;
  }
  function open() {
    if (!card.hidden) return;
    card.hidden = false;
    place();
  }
  function close() {
    card.hidden = true;
  }
  function toggle() {
    if (card.hidden) open();
    else close();
  }
  function render(next: BarView) {
    view = next;
    bar.dataset.empty = String(next.empty);
    bar.style.setProperty("--yes-share", `${next.yesPercent}%`);
    bar.setAttribute("aria-valuenow", String(next.yesPercent));
    bar.setAttribute("aria-valuetext", next.valueText);
    card.replaceChildren(...cardContent(next));
    place();
  }

  // Until the first window read arrives, the card says when results come
  // for a per-round debate; the read replaces it.
  card.replaceChildren(...cardContent(view));
  onDebateEndorsement(debateId, (next) =>
    render(barView({ ...next, now: Date.now() }, labels)),
  );

  bar.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") open();
  });
  bar.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && document.activeElement !== bar)
      close();
  });
  bar.addEventListener("pointerdown", (event) => {
    pressing = event.pointerType;
  });
  bar.addEventListener("focus", () => {
    // Keyboard focus opens the card; a press decides in its click.
    if (pressing === null) open();
  });
  bar.addEventListener("blur", close);
  bar.addEventListener("click", () => {
    if (pressing === "mouse") open();
    else toggle();
    pressing = null;
  });
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  // A tap anywhere else closes it, as on the topic chart.
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !bar.contains(event.target)) close();
  });
  window.addEventListener("resize", place);
}

const bar = document.querySelector<HTMLElement>("[data-endorsement-bar]");
const card = document.querySelector<HTMLElement>("[data-endorsement-card]");
const debateId = bar?.dataset.debateId;
if (bar && card && debateId) start(bar, card, debateId);
