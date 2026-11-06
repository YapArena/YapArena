// The Queue tab (/queue, first-run plan PR 3). It fills "Someone's waiting"
// from GET /api/matchmaking/waiting, notes waiting counts on the questions
// below, and hands every side button's tap to frontend/matchmaking.ts as a
// yap:queue-request, so queuing keeps the topic page's sign-in, camera,
// one-queue and overlay rules. Loaded only when the queue is on.
import { api } from "./lib/api.js";
import type { QueueState, Side } from "./matchmaking-logic.js";
import {
  rowWaitingText,
  sideButtonView,
  waitingRows,
  waitingText,
  type WaitingTopic,
} from "./queue-page-model.js";

const REFRESH_MS = 20_000;
const note = document.querySelector<HTMLElement>("[data-queue-page-note]");
const section = document.querySelector<HTMLElement>("[data-waiting-section]");
const list = document.querySelector<HTMLOListElement>("[data-waiting-list]");
let state: QueueState | null = null;
let timer: number | undefined;

const isSide = (value: string | undefined): value is Side =>
  value === "A" || value === "B";

function sideButton(slug: string, side: Side, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-secondary btn-sm queue-request";
  button.dataset.queueRequest = slug;
  button.dataset.requestSide = side;
  button.dataset.sideLabel = label;
  button.textContent = label;
  return button;
}

// Every side button, server-drawn or from the waiting list, follows the queue.
function renderButtons() {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-queue-request]",
  )) {
    const side = button.dataset.requestSide;
    if (!isSide(side)) continue;
    const view = sideButtonView(
      state,
      button.dataset.queueRequest ?? "",
      side,
      button.dataset.sideLabel ?? "",
    );
    if (button.textContent !== view.text) button.textContent = view.text;
    button.setAttribute("aria-pressed", String(view.pressed));
    button.disabled = view.disabled;
  }
}

function renderWaiting(topics: readonly WaitingTopic[]) {
  if (section && list) {
    const rows = waitingRows(topics);
    list.replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement("li");
        item.className = "queue-row";
        const copy = document.createElement("div");
        copy.className = "queue-row-copy";
        const title = document.createElement("a");
        title.className = "queue-row-title";
        title.href = `/topics/${encodeURIComponent(row.slug)}`;
        title.textContent = row.title;
        const meta = document.createElement("p");
        meta.className = "queue-row-meta";
        meta.textContent = waitingText(row.count, row.waitingLabel);
        copy.append(title, meta);
        const sides = document.createElement("div");
        sides.className = "queue-row-sides";
        sides.append(sideButton(row.slug, row.argueSide, row.argueLabel));
        item.append(copy, sides);
        return item;
      }),
    );
    section.hidden = rows.length === 0;
  }
  const bySlug = new Map(topics.map((topic) => [topic.slug, topic]));
  for (const row of document.querySelectorAll<HTMLElement>(
    "[data-queue-row]",
  )) {
    const target = row.querySelector<HTMLElement>("[data-queue-row-waiting]");
    const topic = bySlug.get(row.dataset.queueRow ?? "");
    if (target) target.textContent = topic ? rowWaitingText(topic) : "";
  }
  renderButtons();
}

async function refresh() {
  try {
    const { topics } = await api<{ topics: WaitingTopic[] }>(
      "/api/matchmaking/waiting",
      { timeout: 8000 },
    );
    renderWaiting(topics);
  } catch {
    // The list is a shortcut; the questions below still work without it.
  }
}

function schedule() {
  window.clearInterval(timer);
  timer = undefined;
  if (!document.hidden)
    timer = window.setInterval(() => void refresh(), REFRESH_MS);
}

document.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-queue-request]")
      : null;
  const side = button?.dataset.requestSide;
  if (!button || !isSide(side) || button.disabled) return;
  if (note) note.textContent = "";
  window.dispatchEvent(
    new CustomEvent("yap:queue-request", {
      detail: {
        topicSlug: button.dataset.queueRequest ?? "",
        side,
        source: button,
      },
    }),
  );
});
window.addEventListener("yap:matchmaking", (event) => {
  state = event.detail;
  renderButtons();
});
window.addEventListener("yap:queue-note", (event) => {
  if (note) note.textContent = event.detail;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
  schedule();
});

void refresh();
schedule();
