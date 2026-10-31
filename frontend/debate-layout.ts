// The debate page's layout behaviour (direction BC1,
// docs/debate-page-design.md): the scoreboard's speaking state and turn, the
// Outline | Chat tabs, the phone answer sheet and the visit's chat colours.
// It only reads the media, panel and chat state; it changes none of it.
import { inscribe } from "../src/features/discovery/inscribe.ts";
import { COLORED_WORDS, pickHeadlineColors } from "./landing-colors.js";
import {
  liveTurnView,
  openWindow,
  playingTurn,
  replayTurnView,
  type Side,
  type TurnDetail,
  type TurnView,
} from "./debate-layout-model.js";
import type { PublicWindow } from "./stake-model.js";
import type { RevealedWindow } from "./window-chart-model.js";

// The panel sends its whole public window list; the chart's event type
// names only the fields the chart reads.
const isTurnWindow = (window: RevealedWindow): window is PublicWindow =>
  "opensAt" in window && "side" in window;

const arena = document.querySelector<HTMLElement>("[data-arena]");
if (arena) {
  const debateId = arena.dataset.debateId!;
  const status = arena.dataset.debateStatus;
  const total = Number(arena.dataset.turnCount) || null;
  const panel = arena.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Record<Side, string> = {
    A: panel?.dataset.speakerA ?? "Speaker A",
    B: panel?.dataset.speakerB ?? "Speaker B",
  };

  // The visit's five landing colours, for chat author names (and the turn
  // clock's ember).
  const colors = pickHeadlineColors();
  COLORED_WORDS.forEach((word, index) =>
    arena.style.setProperty(`--visit-${index}`, colors[word].css),
  );
  arena.style.setProperty("--visit-yappers", colors.yappers.css);

  // Dydema Capitals text: capitals with U shown as V for the eye, the real
  // spelling for screen readers.
  function inscribed(target: HTMLElement | null, text: string) {
    if (!target || target.dataset.text === text) return;
    target.dataset.text = text;
    if (!text) {
      target.replaceChildren();
      return;
    }
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = text;
    const shown = document.createElement("span");
    shown.className = "ins";
    shown.setAttribute("aria-hidden", "true");
    shown.textContent = inscribe(text.toLowerCase());
    target.replaceChildren(spoken, shown);
  }
  const hole = arena.querySelector<HTMLElement>("[data-turn-hole]");
  const label = arena.querySelector<HTMLElement>("[data-turn-label]");
  const summary = arena.querySelector<HTMLElement>("[data-turn-summary]");
  const cardStates = {
    A: arena.querySelector<HTMLElement>(
      '.arena-side[data-side="A"] [data-side-state]',
    ),
    B: arena.querySelector<HTMLElement>(
      '.arena-side[data-side="B"] [data-side-state]',
    ),
  };
  function apply(view: TurnView) {
    if (view.activeSide) arena!.dataset.activeSide = view.activeSide;
    else delete arena!.dataset.activeSide;
    for (const side of ["A", "B"] as const) {
      const node = cardStates[side];
      if (node && node.textContent !== view.states[side])
        node.textContent = view.states[side];
    }
    inscribed(hole, view.hole);
    inscribed(label, view.label);
    if (summary && summary.textContent !== view.summary)
      summary.textContent = view.summary;
  }

  let turn: TurnDetail | null = null;
  let windows: readonly PublicWindow[] = [];
  let position: number | null = null;
  function render() {
    if (status === "replay" || status === "finalized") {
      if (position === null) return;
      const view = replayTurnView(playingTurn(windows, position), total);
      if (view) apply(view);
      return;
    }
    const offset = turn?.serverOffset ?? 0;
    const window =
      turn?.turnNumber == null
        ? openWindow(windows, Date.now() + offset)
        : null;
    const view = liveTurnView(turn, window, names, total);
    if (view) apply(view);
  }
  window.addEventListener("yap:turn", (event) => {
    if (event.detail.debateId !== debateId) return;
    turn = event.detail;
    render();
  });
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId !== debateId) return;
    windows = event.detail.windows.filter(isTurnWindow);
    render();
  });
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    position = event.detail.positionSeconds;
    render();
  });
  // Without a media snapshot, the open turn window says who speaks; windows
  // open and close on their own clock.
  if (status === "live")
    setInterval(() => {
      if (!document.hidden && !turn) render();
    }, 1000);

  // The insight panel's tabs (WAI tabs pattern): AI outline, Results and
  // About in the rail, plus Chat when chat leaves the video: below 1200px,
  // and whenever the video is too small to leave room for chat over it
  // (under 800 × 480, about 1280 × 900 windows and smaller).
  const tablist = arena.querySelector<HTMLElement>("[data-arena-tabs]");
  const insight = arena.querySelector<HTMLElement>("[data-insight]");
  const chat = arena.querySelector<HTMLElement>("#arena-chat");
  const surface = arena.querySelector<HTMLElement>("[data-arena-video]");
  const chatHome = chat?.nextElementSibling ?? null;
  const narrow = matchMedia("(max-width: 1199px)");
  const fits = (width: number, height: number) => {
    const rem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return width >= 50 * rem && height >= 30 * rem;
  };
  const start = surface?.getBoundingClientRect();
  let roomy = start ? fits(start.width, start.height) : true;
  const inPanel = () => narrow.matches || !roomy;
  if (tablist && insight) {
    const tabs = [
      ...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    const chatTab = tabs.find((tab) => tab.id === "arena-tab-chat");
    const unseenLabel =
      tablist.querySelector<HTMLElement>("[data-chat-unseen]");
    const messages = arena.querySelector<HTMLElement>(
      "[data-community-messages]",
    );
    let unseen = 0;
    const panelOf = (tab: HTMLButtonElement) =>
      document.getElementById(tab.getAttribute("aria-controls")!);
    const usable = () => tabs.filter((tab) => !tab.hidden);
    function showUnseen() {
      if (unseenLabel)
        unseenLabel.textContent = unseen ? ` · ${unseen} new` : "";
    }
    function select(tab: HTMLButtonElement, focus = false) {
      for (const item of tabs) {
        const selected = item === tab;
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = selected ? 0 : -1;
      }
      arena!.dataset.tab = tab.id.replace("arena-tab-", "");
      if (arena!.dataset.tab === "chat") {
        unseen = 0;
        showUnseen();
      }
      if (focus) tab.focus();
    }
    // Chat sits over a large enough video from 1200px, else in the panel.
    function sync() {
      const panel = inPanel();
      if (chat && chatTab) {
        chatTab.hidden = !panel;
        const target = panel ? insight : surface;
        if (target && chat.parentElement !== target) {
          if (panel) tablist!.after(chat);
          else surface!.insertBefore(chat, chatHome);
        }
      }
      for (const tab of tabs) panelOf(tab)?.setAttribute("role", "tabpanel");
      if (chat && !panel) chat.removeAttribute("role");
      const selected = tabs.find(
        (tab) => tab.getAttribute("aria-selected") === "true" && !tab.hidden,
      );
      select(selected ?? usable()[0]!);
    }
    tablist.addEventListener("click", (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>(
        '[role="tab"]',
      );
      if (tab) select(tab);
    });
    tablist.addEventListener("keydown", (event) => {
      const list = usable();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      const next =
        event.key === "ArrowRight"
          ? list[(index + 1) % list.length]
          : event.key === "ArrowLeft"
            ? list[(index - 1 + list.length) % list.length]
            : event.key === "Home"
              ? list[0]
              : event.key === "End"
                ? list.at(-1)
                : undefined;
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
    // "Chat · N new" counts messages that arrive while chat is a hidden tab.
    // The first batch is the chat's history, not news.
    let history = true;
    if (messages)
      new MutationObserver((records) => {
        if (history) {
          history = false;
          return;
        }
        if (!inPanel() || arena!.dataset.tab === "chat") return;
        for (const record of records)
          if (record.nextSibling === null)
            for (const node of record.addedNodes)
              if (
                node instanceof HTMLElement &&
                node.classList.contains("community-message")
              )
                unseen++;
        showUnseen();
      }).observe(messages, { childList: true });
    narrow.addEventListener("change", sync);
    // The video's size doesn't depend on where chat is, so this can't loop.
    if (surface)
      new ResizeObserver(([entry]) => {
        const next = fits(entry!.contentRect.width, entry!.contentRect.height);
        if (next === roomy) return;
        roomy = next;
        sync();
      }).observe(surface);
    sync();
  }

  // Wide screens: chat over the video, which the viewer can hide (like
  // Twitch's and Kick's overlay chat). The choice is kept on this device.
  const chatToggle =
    arena.querySelector<HTMLButtonElement>("[data-chat-toggle]");
  if (chatToggle && surface) {
    const key = "yaparena-chat-overlay";
    const showChat = (shown: boolean) => {
      if (shown) delete surface.dataset.chat;
      else surface.dataset.chat = "hidden";
      chatToggle.setAttribute("aria-pressed", String(shown));
      chatToggle.title = shown ? "Hide chat" : "Show chat";
    };
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      // Storage can be unavailable; chat then shows.
    }
    showChat(stored !== "hidden");
    chatToggle.addEventListener("click", () => {
      const shown = chatToggle.getAttribute("aria-pressed") !== "true";
      showChat(shown);
      try {
        localStorage.setItem(key, shown ? "shown" : "hidden");
      } catch {
        // A per-device convenience only.
      }
    });
  }

  // Phones: picking Yes or No opens the pinned answer bar as a sheet. Back
  // or Escape closes it and returns focus to the answer picked.
  const phone = matchMedia("(max-width: 599px)");
  if (panel) {
    let picked: HTMLButtonElement | null = null;
    const close = () => {
      if (!("sheet" in panel.dataset)) return;
      delete panel.dataset.sheet;
      (
        panel.querySelector<HTMLButtonElement>(
          '[data-stake-side][aria-pressed="true"]',
        ) ?? picked
      )?.focus();
    };
    panel.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest("[data-sheet-close]")) {
        close();
        return;
      }
      const side = target.closest<HTMLButtonElement>("[data-stake-side]");
      if (side && !side.disabled && phone.matches) {
        picked = side;
        panel.dataset.sheet = "";
      }
    });
    panel.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !panel.querySelector("dialog[open]") &&
        "sheet" in panel.dataset
      ) {
        event.preventDefault();
        close();
      }
    });
    phone.addEventListener("change", () => {
      if (!phone.matches) delete panel.dataset.sheet;
    });
  }

  // The chat's "⋯" menu closes on Escape or a click elsewhere.
  const more = arena.querySelector<HTMLDetailsElement>("[data-chat-more]");
  if (more) {
    more.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !more.open) return;
      event.preventDefault();
      more.open = false;
      more.querySelector("summary")?.focus();
    });
    document.addEventListener("click", (event) => {
      if (more.open && !more.contains(event.target as Node)) more.open = false;
    });
    // The menu ends just above the composer, whatever the lines under it
    // take, so the composer stays reachable while the menu is open.
    const form = chat?.querySelector<HTMLElement>("[data-community-chat-form]");
    more.addEventListener("toggle", () => {
      if (!more.open || !chat || !form) return;
      const below =
        chat.getBoundingClientRect().bottom - form.getBoundingClientRect().top;
      chat.style.setProperty("--chat-menu-bottom", `${Math.ceil(below) + 8}px`);
    });
  }
}
