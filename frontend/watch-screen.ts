// Decision 0016: on a phone, a debate is watched only in full screen. "Join
// as viewer" or "Play replay" opens it over the page; Back, Escape or the
// browser's back closes it, leaving a live debate or pausing a replay where it
// was. The full screen is the video surface itself, fixed over the page by
// CSS (public/arena.css, "Decision 0016 — full-screen shell"), with its own
// parts from the template's [data-watch-ui]. The rules are in
// frontend/watch-phone.ts; this module only applies them. Computers and
// tablets never open it.
import {
  closedWatch,
  currentPosition,
  keyLook,
  keyText,
  PHONE_WATCH_QUERY,
  turnSegments,
  watchClock,
  watchOrientation,
  watchReducer,
  type OwnPosition,
  type WatchAction,
  type WatchOrientation,
  type WatchSheet,
  type WatchState,
} from "./watch-phone.js";
import {
  openWindow,
  playingTurn,
  type Side,
  type TurnDetail,
} from "./debate-layout-model.js";
import type { PublicWindow, StakeSide } from "./stake-model.js";
import { onStakePositions, onStakeWindows } from "./stake-windows.js";
import { watchTurnResults } from "./turn-result-plate.js";
import { isTurnWindow } from "./turn-results-model.js";
import { mountReplaySplit } from "./replay-split.js";
import { mountPauseKey } from "./replay-pause.js";
import { replayBadgeWords, replayWatchMode } from "./replay-split-model.js";
import { mountTurnsSheet } from "./turns-sheet.js";

declare global {
  interface WindowEventMap {
    // The full screen opened or closed: debate-layout.ts moves chat into it.
    "yap:watch": CustomEvent<{
      debateId: string;
      open: boolean;
      orientation: WatchOrientation;
    }>;
  }
}

const arena = document.querySelector<HTMLElement>("[data-arena]");
const surface = arena?.querySelector<HTMLElement>("[data-arena-video]");
const ui = surface?.querySelector<HTMLElement>("[data-watch-ui]");
if (arena && surface && ui) start(arena, surface, ui);

function start(arena: HTMLElement, surface: HTMLElement, ui: HTMLElement) {
  const one = <T extends HTMLElement = HTMLElement>(selector: string) =>
    ui.querySelector<T>(selector);
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
  const phone = matchMedia(PHONE_WATCH_QUERY);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;

  const stage = one<HTMLButtonElement>("[data-watch-stage]")!;
  const chatToggle = one<HTMLButtonElement>("[data-watch-chat-toggle]")!;
  const barSlot = one("[data-watch-bar]");
  const bar = surface.querySelector<HTMLElement>("[data-endorsement-bar]");
  const card = surface.querySelector<HTMLElement>("[data-endorsement-card]");
  const sheets = new Map<WatchSheet, HTMLElement>();
  for (const name of ["turns", "more"] as const) {
    const sheet = one(`[data-watch-sheet="${name}"]`);
    if (sheet) sheets.set(name, sheet);
  }
  const clock = one("[data-watch-clock]")!;
  const clockTime = one("[data-watch-clock-time]")!;
  const clockTurn = one("[data-watch-clock-turn]")!;
  const segments = one("[data-watch-segments]")!;
  const tagStates = {
    A: one('.watch-tag[data-side="A"] [data-watch-tag-state]'),
    B: one('.watch-tag[data-side="B"] [data-watch-tag-state]'),
  };
  const toast = one("[data-watch-toast]")!;
  const watchStatus = one("[data-watch-status]")!;
  const watchSound = one<HTMLButtonElement>("[data-watch-sound]")!;
  const mediaStatus = arena.querySelector<HTMLElement>("[data-media-status]");
  const mediaSound =
    arena.querySelector<HTMLButtonElement>("[data-media-sound]");
  const leave = arena.querySelector<HTMLButtonElement>("[data-media-leave]");
  const replayVideo = arena.querySelector<HTMLVideoElement>(
    "[data-media-replay-video]",
  );
  const keys = [...ui.querySelectorAll<HTMLButtonElement>("[data-watch-key]")];
  const stakeSide = (side: StakeSide) =>
    panel?.querySelector<HTMLButtonElement>(`[data-stake-side="${side}"]`) ??
    null;

  let state: WatchState = closedWatch;
  // Where focus goes back to: the page's button that opened the full screen,
  // the control that opened a sheet, the key that opened the answer sheet.
  let opener: HTMLElement | null = null;
  let sheetOpener: HTMLElement | null = null;
  let keyOpener: HTMLButtonElement | null = null;
  let timer = 0;
  const turnsBody = one("[data-turns-sheet-body]");
  let stopTurns: (() => void) | null = null;

  // ---- Open, close and what they change on the page ----
  function orientation() {
    return watchOrientation(window.innerWidth, window.innerHeight);
  }
  function announce(open: boolean) {
    window.dispatchEvent(
      new CustomEvent("yap:watch", {
        detail: { debateId, open, orientation: orientation() },
      }),
    );
  }
  function apply(next: WatchState) {
    const previous = state;
    state = next;
    if (next.open) {
      arena!.dataset.watch = "open";
      arena!.dataset.watchOrientation = orientation();
      arena!.dataset.watchControls = next.controls ? "shown" : "hidden";
      arena!.dataset.watchChat = next.chat ? "open" : "closed";
    } else
      for (const name of [
        "watch",
        "watchOrientation",
        "watchControls",
        "watchChat",
        "watchPhase",
        "watchNext",
      ])
        delete arena!.dataset[name];
    stage.setAttribute(
      "aria-label",
      next.controls ? "Hide controls" : "Show controls",
    );
    stage.setAttribute("aria-expanded", String(next.controls));
    chatToggle.setAttribute("aria-pressed", String(next.chat));
    chatToggle.setAttribute(
      "aria-label",
      next.chat ? "Hide chat" : "Show chat",
    );
    if (next.sheet === "more" && previous.sheet !== "more") lendToMore();
    if (previous.sheet === "more" && next.sheet !== "more") returnFromMore();
    for (const [name, sheet] of sheets) sheet.hidden = next.sheet !== name;
    // The Turns sheet's body follows the window reads only while it shows.
    if (next.sheet === "turns" && !stopTurns && turnsBody)
      stopTurns = mountTurnsSheet(turnsBody);
    else if (next.sheet !== "turns" && stopTurns) {
      stopTurns();
      stopTurns = null;
    }
    // A sheet takes focus when it opens and gives it back when it closes.
    if (next.sheet && next.sheet !== previous.sheet)
      sheets
        .get(next.sheet)
        ?.querySelector<HTMLElement>("[data-watch-sheet-close]")
        ?.focus();
    else if (!next.sheet && previous.sheet && next.open) {
      const target = sheetOpener?.isConnected ? sheetOpener : stage;
      sheetOpener = null;
      if (!ui.contains(document.activeElement) || isHiddenFocus())
        target.focus({ preventScroll: true });
    }
  }
  const dispatch = (action: WatchAction) => apply(watchReducer(state, action));

  // D7: the ··· sheet shows the page's own Outline, About, positions, "Get
  // ready" defaults, maximum price and review switch. Each element moves
  // into its slot while the sheet is open, keeping its listeners and state,
  // and goes back to a marker at its place on the page when it closes.
  const lent = [
    ["outline", arena.querySelector<HTMLElement>("#arena-outline")],
    ["about", arena.querySelector<HTMLElement>("#arena-about")],
    [
      "positions",
      panel?.querySelector<HTMLElement>("[data-stake-positions-wrap]"),
    ],
    ["ready", panel?.querySelector<HTMLElement>("[data-stake-ready]")],
    ["advanced", panel?.querySelector<HTMLElement>("[data-stake-advanced]")],
    [
      "review",
      panel
        ?.querySelector<HTMLElement>("[data-stake-review-choice]")
        ?.closest<HTMLElement>("label"),
    ],
  ] as const;
  const markers = new Map<HTMLElement, Comment>();
  function lendToMore() {
    for (const [name, element] of lent) {
      const slot = one(`[data-more-slot="${name}"]`);
      if (!element || !slot || markers.has(element)) continue;
      const marker = document.createComment(`watch-more ${name}`);
      element.before(marker);
      markers.set(element, marker);
      slot.append(element);
    }
  }
  function returnFromMore() {
    for (const [element, marker] of markers) marker.replaceWith(element);
    markers.clear();
  }

  function open(from: HTMLElement | null) {
    if (state.open || !phone.matches) return;
    opener = from;
    apply(watchReducer(state, { type: "open" }));
    root.classList.add("watch-open");
    surface!.setAttribute("role", "dialog");
    surface!.setAttribute("aria-modal", "true");
    surface!.setAttribute("aria-labelledby", "watch-question");
    // D1: the last-answer bar and its card sit in the dock, above Yes/No.
    if (bar && card && barSlot) barSlot.append(bar, card);
    try {
      history.pushState({ ...history.state, yapWatch: debateId }, "");
    } catch {
      // Without a history entry, the browser's back leaves the page.
    }
    announce(true);
    syncReplay();
    tick();
    timer = window.setInterval(tick, 250);
    stage.focus({ preventScroll: true });
  }

  // `stop`: leave the live debate or pause the replay (Back, Escape). A
  // window that stops being a phone keeps playing in the page instead.
  function close(stop: boolean, fromHistory = false) {
    if (!state.open) return;
    if (stop) {
      if (leave && !leave.hidden) leave.click();
      if (replayVideo && !replayVideo.paused) replayVideo.pause();
    }
    apply(watchReducer(state, { type: "close" }));
    syncReplay();
    window.clearInterval(timer);
    root.classList.remove("watch-open");
    surface!.removeAttribute("role");
    surface!.removeAttribute("aria-modal");
    surface!.removeAttribute("aria-labelledby");
    surface!.inert = false;
    if (bar && card) ui!.before(bar, card);
    card?.setAttribute("hidden", "");
    if (panel && "sheet" in panel.dataset) delete panel.dataset.sheet;
    announce(false);
    if (!fromHistory && history.state?.yapWatch === debateId) history.back();
    // Back to the button that opened it, which shows again on the page.
    const fallback = arena!.querySelector<HTMLElement>(
      replay ? "[data-media-replay]" : "[data-media-viewer]",
    );
    const target = opener?.isConnected && !opener.hidden ? opener : fallback;
    opener = null;
    if (stop && target && !target.hidden) target.focus({ preventScroll: true });
  }

  // "Join as viewer" and "Play replay" open the full screen on a phone. So
  // does a replay that starts some other way (a turn on the timeline).
  arena.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-media-viewer], [data-media-replay]",
    );
    if (button && phone.matches) open(button);
  });
  replayVideo?.addEventListener("play", () => {
    if (phone.matches && !state.open) open(null);
  });
  phone.addEventListener("change", () => {
    if (!phone.matches) close(false);
  });

  // Point 7: the viewer's own turn results pop on the plate layer. It
  // watches from page start on a phone, so a result revealed while the full
  // screen is closed counts as seen and never pops later.
  const plateLayer = one("[data-watch-plate]");
  let stopPlate: (() => void) | null = null;
  function syncPlate() {
    if (phone.matches && plateLayer && !stopPlate)
      stopPlate = watchTurnResults(plateLayer, { debateId });
    else if (!phone.matches && stopPlate) {
      stopPlate();
      stopPlate = null;
    }
  }
  syncPlate();
  phone.addEventListener("change", syncPlate);
  window.addEventListener("resize", () => {
    if (state.open && arena.dataset.watchOrientation !== orientation()) {
      arena.dataset.watchOrientation = orientation();
      syncReplay();
      announce(true);
    }
  });

  // ---- A replay: the split cameras and the pause key ----
  // Vertical, side A's and side B's parts of the one recording are drawn into
  // the two camera boxes (frontend/replay-split.ts) while the video keeps the
  // sound and the time unseen; horizontal shows the recording as it is. D9:
  // the pause key is a replay's only control. It replaces the native
  // controls and shows and hides with the other tap controls; a live debate
  // never has it.
  const pauseKey = one<HTMLButtonElement>("[data-watch-pause]");
  const camA = one('[data-watch-cam="A"]');
  const camB = one('[data-watch-cam="B"]');
  // The top pill says just "Replay", whatever the replay's status, beside
  // the playback time; the page's own pill keeps its words.
  const badge = surface.querySelector<HTMLElement>(
    ".arena-video-status .arena-broadcast-badge",
  );
  const pageBadge = badge?.textContent ?? "";
  let unmountPause: (() => void) | null = null;
  let unmountSplit: (() => void) | null = null;
  function syncReplay() {
    if (!replay || !replayVideo) return;
    const mode = replayWatchMode({
      open: state.open,
      orientation: orientation(),
      layout: replayVideo.dataset.replayLayout,
    });
    if (mode && pauseKey && !unmountPause) {
      pauseKey.hidden = false;
      unmountPause = mountPauseKey(pauseKey, replayVideo);
    } else if (!mode && unmountPause) {
      unmountPause();
      unmountPause = null;
      if (pauseKey) pauseKey.hidden = true;
    }
    if (mode === "split" && !unmountSplit && camA && camB) {
      const canvasA = document.createElement("canvas");
      const canvasB = document.createElement("canvas");
      camA.prepend(canvasA);
      camB.prepend(canvasB);
      const stop = mountReplaySplit({ video: replayVideo, canvasA, canvasB });
      unmountSplit = () => {
        stop();
        canvasA.remove();
        canvasB.remove();
      };
    } else if (mode !== "split" && unmountSplit) {
      unmountSplit();
      unmountSplit = null;
    }
    // Where each camera box holds one side, the listener's camera dims.
    if (mode) arena!.dataset.watchReplay = mode;
    else delete arena!.dataset.watchReplay;
    const words = replayBadgeWords(mode, pageBadge);
    if (badge && badge.textContent !== words) badge.textContent = words;
  }
  // The recording's layout arrives with the replay grant.
  replayVideo?.addEventListener("loadedmetadata", syncReplay);
  window.addEventListener("popstate", () => {
    if (state.open) close(true, true);
  });

  // ---- The controls ----
  stage.addEventListener("click", () => dispatch({ type: "tap" }));
  one("[data-watch-back]")?.addEventListener("click", () => close(true));
  chatToggle.addEventListener("click", () => dispatch({ type: "chat" }));
  for (const button of ui.querySelectorAll<HTMLButtonElement>(
    "[data-watch-open]",
  ))
    button.addEventListener("click", () => {
      sheetOpener = button;
      dispatch({
        type: "sheet",
        sheet: button.dataset.watchOpen === "more" ? "more" : "turns",
      });
    });
  for (const button of ui.querySelectorAll<HTMLButtonElement>(
    "[data-watch-sheet-close]",
  ))
    button.addEventListener("click", () => dispatch({ type: "close-sheet" }));

  // Share: the system share sheet where there is one, else the chat menu's
  // "Copy event link", whose result shows here for a moment.
  const communityStatus = arena.querySelector<HTMLElement>(
    "[data-community-status]",
  );
  let toastTimer = 0;
  function showToast(text: string) {
    toast.textContent = text;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.textContent = "";
    }, 2400);
  }
  one("[data-watch-share]")?.addEventListener("click", () => {
    const url = window.location.origin + window.location.pathname;
    if (typeof navigator.share === "function") {
      navigator
        .share({ title: document.title, url })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          copyLink();
        });
      return;
    }
    copyLink();
  });
  function copyLink() {
    const copy = arena!.querySelector<HTMLButtonElement>(
      "[data-community-share]",
    );
    if (!copy || !communityStatus) return;
    const before = communityStatus.textContent;
    const watcher = new MutationObserver(() => {
      if (communityStatus.textContent === before) return;
      watcher.disconnect();
      showToast(communityStatus.textContent ?? "");
    });
    watcher.observe(communityStatus, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.setTimeout(() => watcher.disconnect(), 3000);
    copy.click();
  }

  // The media's status line and "Enable sound" live under the page's video;
  // the full screen shows the line while no picture plays, and its own sound
  // button presses the page's.
  if (mediaStatus) {
    const copyStatus = () => {
      watchStatus.textContent = mediaStatus.textContent;
    };
    new MutationObserver(copyStatus).observe(mediaStatus, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    copyStatus();
  }
  if (mediaSound) {
    const copySound = () => {
      watchSound.hidden = mediaSound.hidden;
    };
    new MutationObserver(copySound).observe(mediaSound, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    copySound();
    watchSound.addEventListener("click", () => mediaSound.click());
  }

  // ---- Yes and No: the page's answer flow ----
  let windows: PublicWindow[] = [];
  let positions: Record<string, OwnPosition> = {};
  let turn: TurnDetail | null = null;
  let position: number | null = null;
  onStakeWindows(debateId, (shared) => {
    windows = shared.filter(isTurnWindow);
    renderKeys();
  });
  onStakePositions(debateId, (next) => {
    positions = next;
    renderKeys();
  });
  window.addEventListener("yap:turn", (event) => {
    if (event.detail.debateId !== debateId) return;
    turn = event.detail;
    tick();
  });
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    position = event.detail.positionSeconds;
    tick();
  });
  let keySignature = "";
  function renderKeys() {
    const placed = currentPosition({
      windows,
      positions,
      eventStatus: replay ? status : (turn?.eventStatus ?? status),
      now: Date.now() + (turn?.serverOffset ?? 0),
      positionSeconds: position,
    });
    const looks = keys.map((key) => {
      const side: StakeSide = key.dataset.watchKey === "NO" ? "NO" : "YES";
      const source = stakeSide(side);
      const disabled = !source || source.disabled || placed !== null;
      return {
        key,
        disabled,
        // After placing, the keys only say what was placed. They stay
        // focusable, so the answer sheet can give focus back to "Yes · 25".
        focusable: placed !== null,
        look: keyLook(side, placed, disabled),
        text: keyText(side, placed),
      };
    });
    const signature = JSON.stringify(
      looks.map(({ disabled, focusable, look, text }) => [
        disabled,
        focusable,
        look,
        text,
      ]),
    );
    if (signature === keySignature) return;
    keySignature = signature;
    for (const { key, disabled, focusable, look, text } of looks) {
      key.disabled = disabled && !focusable;
      if (disabled && focusable) key.setAttribute("aria-disabled", "true");
      else key.removeAttribute("aria-disabled");
      key.dataset.look = look;
      key.textContent = text;
    }
  }
  for (const side of ["YES", "NO"] as const) {
    const source = stakeSide(side);
    if (source)
      new MutationObserver(renderKeys).observe(source, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
  }
  for (const key of keys)
    key.addEventListener("click", () => {
      if (key.getAttribute("aria-disabled") === "true") return;
      const source = stakeSide(key.dataset.watchKey === "NO" ? "NO" : "YES");
      if (!source || source.disabled) return;
      keyOpener = key;
      source.click();
    });
  // The answer sheet (frontend/debate-layout.ts) opens over the full screen,
  // which waits under it, and gives focus back to the key when it closes.
  if (panel)
    new MutationObserver(() => {
      if (!state.open) return;
      const sheet = "sheet" in panel.dataset;
      surface!.inert = sheet;
      if (sheet) {
        surface!.removeAttribute("aria-modal");
        // The panel focuses its ticket or "Sign in to answer" before the
        // sheet shows them; once it shows, focus goes in if it isn't there.
        requestAnimationFrame(() => {
          if (!("sheet" in panel.dataset)) return;
          if (panel.contains(document.activeElement)) return;
          const signIn = panel.querySelector<HTMLElement>(
            "[data-stake-signin]:not([hidden]) a",
          );
          (
            signIn ??
            panel.querySelector<HTMLElement>(
              "[data-stake-ticket]:not([hidden]) input",
            ) ??
            panel.querySelector<HTMLElement>("[data-sheet-close]")
          )?.focus({ preventScroll: true });
        });
      } else {
        surface!.setAttribute("aria-modal", "true");
        const target =
          keyOpener && !keyOpener.disabled ? keyOpener : (keys[0] ?? stage);
        keyOpener = null;
        (target.disabled ? stage : target).focus({ preventScroll: true });
      }
    }).observe(panel, { attributes: true, attributeFilter: ["data-sheet"] });

  // ---- The clock on the seam, the turn bar and the name tags ----
  let clockSignature = "";
  function tick() {
    renderKeys();
    if (!state.open) return;
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
    });
    arena!.dataset.watchPhase = view.phase;
    if (view.nextSide) arena!.dataset.watchNext = view.nextSide;
    else delete arena!.dataset.watchNext;
    clock.dataset.warn = String(view.warn);
    clock.style.setProperty("--spent", `${(view.spent * 100).toFixed(2)}%`);
    const signature = JSON.stringify([
      view.phase,
      view.text,
      view.turnNumber,
      view.nextName,
      view.word,
      view.label,
    ]);
    if (signature === clockSignature) return;
    clockSignature = signature;
    clockTime.textContent =
      view.phase === "running"
        ? view.text
        : view.phase === "between"
          ? view.nextName
          : view.word;
    clockTurn.textContent =
      view.turnNumber === null
        ? ""
        : view.total
          ? `${view.turnNumber} / ${view.total}`
          : `Turn ${view.turnNumber}`;
    if (view.label) clock.setAttribute("aria-label", view.label);
    else clock.removeAttribute("aria-label");
    const parts = turnSegments(view);
    segments.replaceChildren(
      ...parts.map((part) => {
        const segment = document.createElement("span");
        segment.className = "watch-segment";
        if (part.done) segment.dataset.done = "";
        segment.style.setProperty("--fill", `${part.fill * 100}%`);
        return segment;
      }),
    );
    segments.setAttribute(
      "aria-label",
      view.turnNumber && view.total
        ? `Turn ${view.turnNumber} of ${view.total}`
        : "Turns",
    );
    for (const side of ["A", "B"] as const) {
      const node = tagStates[side];
      if (!node) continue;
      node.textContent =
        view.phase === "running" && arena!.dataset.activeSide === side
          ? ", speaking"
          : view.nextSide === side
            ? ", next"
            : "";
    }
  }

  // ---- Keyboard: Escape and a focus trap ----
  function isHiddenFocus() {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      ui!.contains(active) &&
      !active.checkVisibility({ visibilityProperty: true })
    );
  }
  const answerSheetOpen = () => Boolean(panel && "sheet" in panel.dataset);
  document.addEventListener("keydown", (event) => {
    if (!state.open || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    if (answerSheetOpen()) {
      // The panel closes its own sheet on Escape when focus is in it.
      if (event.key === "Escape" && !panel!.contains(document.activeElement)) {
        event.preventDefault();
        panel!.querySelector<HTMLElement>("[data-sheet-close]")?.click();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.sheet) dispatch({ type: "close-sheet" });
      else close(true);
      return;
    }
    if (event.key !== "Tab") return;
    const layer = state.sheet ? sheets.get(state.sheet)! : surface!;
    const focusable = [
      ...layer.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])",
      ),
    ].filter(
      (node) =>
        !(node as HTMLButtonElement).disabled &&
        node.checkVisibility({ visibilityProperty: true }),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !layer.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !layer.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
}
