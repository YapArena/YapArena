// Computers and tablets (founder, 2026-11-25): the turn clock sits over the
// video, a small ring on the seam between the two cameras, with each
// debater's name tag in a top corner, instead of the panel under the video.
// This module runs the clock with the phone full screen's rules
// (frontend/watch-phone.ts); frontend/debate-layout.ts marks who is
// speaking. A phone hides it all and keeps its own page and full screen.
import {
  openWindow,
  playingTurn,
  type Side,
  type TurnDetail,
} from "./debate-layout-model.js";
import type { MicPublic } from "./mic-model.js";
import { onMic } from "./mic-state.js";
import type { PublicWindow } from "./stake-model.js";
import { onStakeWindows } from "./stake-windows.js";
import { isTurnWindow } from "./turn-results-model.js";
import { clockTurnText, PHONE_WATCH_QUERY, watchClock } from "./watch-phone.js";

const arena = document.querySelector<HTMLElement>("[data-arena]");
const clock = arena?.querySelector<HTMLElement>("[data-stage-clock]");
if (arena && clock) {
  const debateId = arena.dataset.debateId ?? "";
  const status = arena.dataset.debateStatus ?? "";
  const replay = status === "replay" || status === "finalized";
  const total = Number(arena.dataset.turnCount) || null;
  const turnSeconds = Number(arena.dataset.turnSeconds) || 60;
  const panel = arena.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Record<Side, string> = {
    A: panel?.dataset.speakerA ?? "Speaker A",
    B: panel?.dataset.speakerB ?? "Speaker B",
  };
  const time = clock.querySelector<HTMLElement>("[data-stage-clock-time]")!;
  const turnText = clock.querySelector<HTMLElement>("[data-stage-clock-turn]")!;
  const announce = arena.querySelector<HTMLElement>("[data-turn-announce]");
  const ticket = arena.querySelector<HTMLElement>("[data-stake-ticket]");
  const phone = matchMedia(PHONE_WATCH_QUERY);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let turn: TurnDetail | null = null;
  let windows: PublicWindow[] = [];
  let position: number | null = null;
  let mic: MicPublic | null = null;
  let signature = "";
  let warned: number | null = null;
  function tick() {
    if (phone.matches || document.hidden) return;
    const now = Date.now();
    const view = watchClock({
      turn,
      window: turn ? null : openWindow(windows, now),
      playing:
        replay && position !== null ? playingTurn(windows, position) : null,
      replay,
      now,
      turnSeconds,
      total,
      names,
      reduced: reducedMotion.matches,
      mic,
    });
    clock!.dataset.phase = view.phase;
    clock!.dataset.warn = String(view.warn);
    clock!.style.setProperty("--spent", `${(view.spent * 100).toFixed(2)}%`);
    // "10 seconds left to answer", once a turn, while the bar takes answers.
    if (
      view.phase === "running" &&
      view.warn &&
      !replay &&
      view.turnNumber !== warned &&
      ticket &&
      !ticket.hidden
    ) {
      warned = view.turnNumber;
      if (announce) announce.textContent = "10 seconds left to answer.";
    }
    const next = JSON.stringify([
      view.phase,
      view.text,
      view.turnNumber,
      view.total,
      view.nextName,
      view.word,
      view.label,
      view.mic,
    ]);
    if (next === signature) return;
    signature = next;
    time.textContent =
      view.phase === "running"
        ? view.text
        : view.phase === "between"
          ? view.nextName
          : view.word;
    turnText.textContent = clockTurnText(view);
    if (view.label) clock!.setAttribute("aria-label", view.label);
    else clock!.removeAttribute("aria-label");
  }

  window.addEventListener("yap:turn", (event) => {
    if (event.detail.debateId !== debateId) return;
    turn = event.detail;
    tick();
  });
  onStakeWindows(debateId, (shared) => {
    windows = shared.filter(isTurnWindow);
    tick();
  });
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    position = event.detail.positionSeconds;
    tick();
  });
  onMic(debateId, (shared) => {
    mic = shared.mic;
    tick();
  });
  phone.addEventListener("change", tick);
  document.addEventListener("visibilitychange", tick);
  window.setInterval(tick, 250);
  tick();
}
