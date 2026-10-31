// The debate page's turn clock (direction BC1, docs/debate-page-design.md):
// the landing emblem between the two debaters' cards, draining clockwise
// over the speaker's turn. Live, it follows the media snapshot's deadline
// (`yap:turn`), recomputed every frame, so a page opened mid-turn is right;
// on a replay it follows the turn that's playing. One animation frame loop
// runs only while a turn runs, the tab is visible and the clock is on screen,
// and the canvas is redrawn only when the drawn tiles change.
import {
  createEmblem,
  emblemTiles,
  type EmblemColors,
} from "./pixel-emblem.js";
import {
  clockFrame,
  frameKey,
  tileLook,
  timerLabel,
  type ClockState,
} from "./turn-clock-logic.js";
import { playingTurn, type TurnDetail } from "./debate-layout-model.js";
import type { PublicWindow } from "./stake-model.js";
import type { RevealedWindow } from "./window-chart-model.js";

const isTurnWindow = (window: RevealedWindow): window is PublicWindow =>
  "opensAt" in window && "side" in window;

const arena = document.querySelector<HTMLElement>("[data-arena]");
const face = arena?.querySelector<HTMLElement>(".arena-turn-face");
const clock = face?.querySelector<HTMLElement>("[data-media-clock]");
if (arena && face && clock) {
  const debateId = arena.dataset.debateId!;
  const status = arena.dataset.debateStatus;
  const turnSeconds = Number(arena.dataset.turnSeconds) || 60;
  const announce = arena.querySelector<HTMLElement>("[data-turn-announce]");
  const ticket = arena.querySelector<HTMLElement>("[data-stake-ticket]");
  const canvas = document.createElement("canvas");
  canvas.className = "arena-ring";
  canvas.setAttribute("aria-hidden", "true");
  face.prepend(canvas);
  clock.setAttribute("role", "timer");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let turn: TurnDetail | null = null;
  let windows: readonly PublicWindow[] = [];
  let position: number | null = null;
  let inView = true;
  let emblem: ReturnType<typeof createEmblem> | null = null;
  let drawn = "";
  let labelled = "";
  let request = 0;
  let warnedTurn: number | null = null;

  function colors(): EmblemColors {
    const style = getComputedStyle(arena!);
    return {
      lit: "#f8f8f8",
      warn: style.getPropertyValue("--warning").trim() || "#ff8a5c",
      ember:
        style.getPropertyValue("--visit-yappers").trim() || "rgb(27 174 211)",
      spent: "#ffffff",
      rest: "#ffffff",
    };
  }
  // What the clock shows now, and the turn it belongs to.
  function current(): { state: ClockState; turnNumber: number | null } {
    const reduced = reducedMotion.matches;
    if (status === "replay" || status === "finalized") {
      const playing = position === null ? null : playingTurn(windows, position);
      return playing
        ? {
            state: {
              phase: "running",
              left: playing.left,
              total: turnSeconds,
              reduced,
            },
            turnNumber: playing.turnNumber,
          }
        : {
            state: { phase: "rest", left: 0, total: turnSeconds, reduced },
            turnNumber: null,
          };
    }
    if (
      turn?.eventStatus === "live" &&
      turn.state === "running" &&
      turn.turnDeadlineAt
    )
      return {
        state: {
          phase: "running",
          left:
            (Date.parse(turn.turnDeadlineAt) -
              (Date.now() + turn.serverOffset)) /
            1000,
          total: turnSeconds,
          reduced,
        },
        turnNumber: turn.turnNumber,
      };
    return {
      state: { phase: "rest", left: 0, total: turnSeconds, reduced },
      turnNumber: null,
    };
  }
  function paint() {
    request = 0;
    if (!emblem || document.hidden || !inView) return;
    const { state, turnNumber } = current();
    const frame = clockFrame(state);
    const running = state.phase === "running";
    if (running && frame.warn) face!.dataset.ending = "";
    else delete face!.dataset.ending;
    canvas.style.opacity = String(frame.pulse);
    const key = `${frameKey(frame)}:${state.reduced ? 1 : 0}`;
    if (key !== drawn) {
      drawn = key;
      emblem.draw(
        (tile) => tileLook(tile.angle, frame, state.reduced),
        colors(),
      );
    }
    const label = running ? timerLabel(state.left, turnNumber) : "";
    if (label !== labelled) {
      labelled = label;
      if (label) clock!.setAttribute("aria-label", label);
      else clock!.removeAttribute("aria-label");
    }
    // "10 seconds left to answer", once a turn, only with the ticket open.
    if (
      running &&
      status === "live" &&
      frame.warn &&
      turnNumber !== warnedTurn &&
      ticket &&
      !ticket.hidden
    ) {
      warnedTurn = turnNumber;
      if (announce) announce.textContent = "10 seconds left to answer.";
    }
    if (running) request = requestAnimationFrame(paint);
  }
  function schedule() {
    if (!request) request = requestAnimationFrame(paint);
  }

  window.addEventListener("yap:turn", (event) => {
    if (event.detail.debateId !== debateId) return;
    turn = event.detail;
    schedule();
  });
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId !== debateId) return;
    windows = event.detail.windows.filter(isTurnWindow);
    schedule();
  });
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    position = event.detail.positionSeconds;
    schedule();
  });
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", () => {
    drawn = "";
    schedule();
  });
  new IntersectionObserver(([entry]) => {
    inView = Boolean(entry?.isIntersecting);
    schedule();
  }).observe(face);
  new ResizeObserver(() => {
    if (emblem?.resize()) drawn = "";
    schedule();
  }).observe(canvas);

  // The landing's emblem image, usually already cached.
  void emblemTiles(arena.dataset.emblem!).then((tiles) => {
    emblem = createEmblem(canvas, { mode: "countdown", tiles });
    schedule();
  });
}
