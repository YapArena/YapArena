// The home's debate list (src/features/discovery/home-list-view.ts). The
// server renders what every reader sees; this adds the reader's followed
// topics, who is waiting in the live queue and each replay's and finished
// debate's turn windows, then renders the feed again, once. It also runs the
// chips, the countdowns and the closable intro.
import {
  homeView,
  homeFilters,
  closesText,
  startsText,
  withWindows,
  type HomeFilter,
  type HomeListData,
  type HomeWindows,
  type WaitingTopic,
} from "../src/features/discovery/home-list-model.ts";
import {
  filterLabel,
  homeFeedMarkup,
} from "../src/features/discovery/home-list-view.ts";
import type { CollectionPage, FollowEntry } from "./account-types.js";
// session-coordination.js creates the page's session store (window.yapSession,
// frontend/lib/session.ts) before this module runs. It is read from there:
// bundling lib/session.ts here would leave its own sibling import pointing at
// the wrong address.

/* global window, document, localStorage, CSS */
// Selectors below come from the server-rendered markup in home-list-view.ts;
// non-null assertions state its guarantees.
const root = document.querySelector<HTMLElement>("[data-home-list]");
const template = document.getElementById(
  "home-list-data",
) as HTMLTemplateElement | null;

// The intro stays closed on this device once closed (Cookie Policy).
const INTRO_KEY = "yaparena-home-intro";
const COUNTDOWN_MS = 15_000;

function introClosed() {
  try {
    return localStorage.getItem(INTRO_KEY) === "closed";
  } catch {
    // Storage can be unavailable; the intro then shows.
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const body: T = await response.json();
  return body;
}

if (root && template) {
  const initial: HomeListData = JSON.parse(template.content.textContent!);
  // Countdowns follow the server's clock, as the page was built.
  const offset = Date.parse(initial.now) - Date.now();
  const now = () => Date.now() + offset;
  const feed = root.querySelector<HTMLElement>("[data-home-feed]")!;
  const status = root.querySelector<HTMLElement>("[data-home-status]")!;
  const intro = root.querySelector<HTMLElement>("[data-home-intro]")!;
  const chips = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-home-filter]"),
  ];
  let data = initial;
  let follows = new Set<string>();
  let waiting: WaitingTopic[] = [];
  let filter: HomeFilter = "all";

  function render() {
    const view = homeView(data, follows, waiting, filter);
    const focused =
      document.activeElement?.closest<HTMLElement>("[data-home-key]")?.dataset
        .homeKey;
    feed.innerHTML = homeFeedMarkup(view, now(), data.matchmaking).toString();
    for (const chip of chips) {
      const name = chip.dataset.homeFilter as HomeFilter;
      chip.textContent = filterLabel(name, view);
      chip.setAttribute("aria-pressed", String(name === filter));
    }
    if (focused)
      feed
        .querySelector<HTMLElement>(`[data-home-key="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
  }

  function tick() {
    for (const time of feed.querySelectorAll<HTMLTimeElement>(
      "time[data-home-countdown]",
    ))
      time.textContent =
        time.dataset.homeCountdown === "start"
          ? startsText(time.dateTime, now())
          : closesText(time.dateTime, now());
  }

  // Your topics are the ones you follow; signed out, there are none.
  async function readFollows() {
    const user = window.yapSession
      ? await window.yapSession.me().catch(() => null)
      : undefined;
    if (user === null) return new Set<string>();
    const page = await readJson<CollectionPage<FollowEntry>>(
      "/api/me/follows?limit=50",
    );
    return new Set(
      page.items
        .filter((item) => item.targetType === "topic")
        .map((item) => item.slug),
    );
  }

  async function readWaiting() {
    if (!data.matchmaking) return [];
    return (
      await readJson<{ topics: WaitingTopic[] }>("/api/matchmaking/waiting")
    ).topics;
  }

  // Each replay and finished debate's public turn windows: whether a replay
  // still takes answers, and a finished debate's latest result.
  async function readWindows() {
    const debates = [...data.replays, ...data.finished];
    const reads = await Promise.allSettled(
      debates.map((debate) =>
        readJson<HomeWindows>(
          `/api/public/debates/${encodeURIComponent(debate.id)}/windows`,
        ),
      ),
    );
    const windows = new Map<string, HomeWindows>();
    reads.forEach((read, index) => {
      if (read.status === "fulfilled")
        windows.set(debates[index]!.id, read.value);
    });
    return windows;
  }

  intro.hidden = introClosed();
  intro
    .querySelector<HTMLButtonElement>("[data-home-intro-close]")!
    .addEventListener("click", () => {
      intro.hidden = true;
      try {
        localStorage.setItem(INTRO_KEY, "closed");
      } catch {
        // A per-device convenience only.
      }
      chips[0]?.focus();
    });

  root.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>(
      "[data-home-filter]",
    );
    if (!chip) return;
    const next = chip.dataset.homeFilter as HomeFilter;
    if (!homeFilters.includes(next) || next === filter) return;
    filter = next;
    render();
    status.textContent = `Showing ${chip.textContent}.`;
  });

  let timer = window.setInterval(tick, COUNTDOWN_MS);
  window.addEventListener("pagehide", () => window.clearInterval(timer));
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    tick();
    timer = window.setInterval(tick, COUNTDOWN_MS);
  });

  void Promise.allSettled([readFollows(), readWaiting(), readWindows()]).then(
    ([followed, queue, windows]) => {
      if (followed.status === "fulfilled") follows = followed.value;
      if (queue.status === "fulfilled") waiting = queue.value;
      if (windows.status === "fulfilled" && windows.value.size)
        data = withWindows(data, windows.value);
      // An account that follows topics is past its first visit.
      if (follows.size) intro.hidden = true;
      if (follows.size || waiting.length || data !== initial) render();
    },
  );
}
