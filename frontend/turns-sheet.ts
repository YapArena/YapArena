// Decision 0016, point 6: the phone full screen's Turns sheet. The full
// screen owns the sheet and its "Turns" title; this fills its body from the
// answer panel's window list (frontend/stake-windows.ts), so it adds no
// request of its own. Like the bar on the video it never announces anything
// live, and on a replay it follows the yap:playback position. The rules are
// in frontend/turns-sheet-model.ts.
import type { BarLabels } from "./endorsement-bar-model.js";
import type { MicPastTurn } from "./mic-model.js";
import { onMic } from "./mic-state.js";
import type { PublicWindow } from "./stake-model.js";
import {
  onDebateEndorsement,
  onStakeWindows,
  type DebateEndorsementView,
} from "./stake-windows.js";
import { isTurnWindow, type Names } from "./turn-results-model.js";
import {
  turnsSheetView,
  type TurnSlot,
  type TurnsSheetView,
} from "./turns-sheet-model.js";

function text(tag: string, className: string, content: string) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function figurePart(view: TurnsSheetView) {
  const part = document.createElement("section");
  part.className = "turns-sheet-figure";
  part.append(text("h3", "turns-sheet-heading", view.heading));
  if (view.shares.length) {
    const shares = document.createElement("dl");
    shares.className = "turns-sheet-shares";
    for (const share of view.shares) {
      const row = document.createElement("div");
      row.dataset.answer = share.answer;
      row.append(
        text("dt", "turns-sheet-share-label", share.label),
        text("dd", "turns-sheet-share-value", `${share.percent}%`),
      );
      shares.append(row);
    }
    const track = document.createElement("span");
    track.className = "turns-sheet-track";
    track.setAttribute("aria-hidden", "true");
    track.style.setProperty("--yes-share", `${view.yesPercent}%`);
    track.append(text("span", "turns-sheet-fill", ""));
    part.append(shares, track);
  }
  const lines: [string, string | null][] = [
    ["turns-sheet-counts", view.counts],
    ["turns-sheet-change", view.change],
    ["turns-sheet-switches", view.switches],
    ["turns-sheet-status", view.status],
  ];
  for (const [className, line] of lines)
    if (line) part.append(text("p", className, line));
  return part;
}

function slotItem(slot: TurnSlot) {
  const item = document.createElement("li");
  item.className = "turns-sheet-slot";
  item.dataset.state = slot.state;
  if (slot.direction) item.dataset.direction = slot.direction;
  if (slot.current) item.dataset.current = "";
  item.style.setProperty("--bar-size", `${slot.size}px`);
  item.append(text("span", "turns-sheet-bar", ""));
  if (slot.state !== "later")
    item.append(text("span", "turns-sheet-value", slot.value));
  const who = text("span", "turns-sheet-who", "");
  who.append(
    text("b", "turns-sheet-number", String(slot.turnNumber)),
    text("span", "turns-sheet-initials", slot.who),
  );
  item.append(who);
  return item;
}

function turnsPart(view: TurnsSheetView) {
  const part = document.createElement("section");
  part.className = "turns-sheet-turns";
  part.append(text("h3", "turns-sheet-heading", view.turnsHeading));
  const chart = document.createElement("div");
  chart.className = "turns-sheet-chart";
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", view.turnsLabel);
  // A debate that isn't counted has only this part; say why it is empty.
  if (!view.slots.length) {
    if (view.status) part.append(text("p", "turns-sheet-status", view.status));
    return part;
  }
  const list = document.createElement("ol");
  list.className = "turns-sheet-bars";
  list.setAttribute("aria-hidden", "true");
  list.style.setProperty("--turns", String(view.slots.length));
  list.append(...view.slots.map(slotItem));
  chart.append(text("span", "turns-sheet-even", "50%"), list);
  part.append(chart);
  return part;
}

/**
 * Fills `body` with the Turns sheet and keeps it current until the returned
 * stop() is called. The debate, its speakers and its side labels come from
 * the page's arena, answer panel and last-answer bar.
 */
export function mountTurnsSheet(body: HTMLElement) {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    body.replaceChildren();
  };
  const arena = document.querySelector<HTMLElement>("[data-arena]");
  const debateId = arena?.dataset.debateId;
  if (!arena || !debateId) return stop;
  const panel = arena.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Names = {
    A: panel?.dataset.speakerA ?? "Speaker A",
    B: panel?.dataset.speakerB ?? "Speaker B",
  };
  // Only a debate whose figure counts has the bar, and its labels (D4).
  const bar = document.querySelector<HTMLElement>("[data-endorsement-bar]");
  const labels: BarLabels | null = bar
    ? {
        sideA: bar.dataset.sideA ?? "",
        sideB: bar.dataset.sideB ?? "",
        sideAIsYes: bar.dataset.sideAIsYes !== "false",
      }
    : null;
  const total = Number(arena.dataset.turnCount) || null;
  const status = arena.dataset.debateStatus;
  const replay = status === "replay" || status === "finalized";
  let figure: DebateEndorsementView | null = null;
  let windows: PublicWindow[] = [];
  let position: number | null = null;
  let micTurns: readonly MicPastTurn[] | undefined;
  let signature = "";
  function render() {
    const view = turnsSheetView({
      figure,
      labels,
      windows,
      total,
      names,
      position,
      now: Date.now(),
      micTurns,
    });
    // The replay reports its position about four times a second; only a
    // different view touches the page.
    const next = JSON.stringify(view);
    if (next === signature) return;
    signature = next;
    body.replaceChildren(
      ...(labels ? [figurePart(view)] : []),
      ...(!labels || view.slots.length ? [turnsPart(view)] : []),
    );
  }
  onDebateEndorsement(
    debateId,
    (next) => {
      figure = next;
      render();
    },
    controller.signal,
  );
  onStakeWindows(
    debateId,
    (next) => {
      windows = next.filter(isTurnWindow);
      render();
    },
    controller.signal,
  );
  onMic(
    debateId,
    (shared) => {
      micTurns = shared.mic?.turns;
      render();
    },
    controller.signal,
  );
  // Only the replay player sends this; a live debate shows every reveal.
  window.addEventListener(
    "yap:playback",
    (event) => {
      if (event.detail.debateId !== debateId || !replay) return;
      position = event.detail.positionSeconds;
      render();
    },
    { signal: controller.signal },
  );
  render();
  return stop;
}
