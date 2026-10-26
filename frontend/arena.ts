// This entry is served with type="module"; retain that parse mode during emission.
export {};

/* global document, window */
const arena = document.querySelector<HTMLElement>("[data-arena]")!;
if (arena) {
  const surface = arena.querySelector<HTMLElement>("[data-arena-video]")!;
  const expand = arena.querySelector<HTMLButtonElement>("[data-video-expand]")!;
  let previousFocus: HTMLElement | null | undefined;
  function resize(enlarged: boolean) {
    if (enlarged) previousFocus = document.activeElement as HTMLElement | null;
    surface.classList.toggle("is-expanded", enlarged);
    document.body.classList.toggle("arena-video-theater", enlarged);
    expand.setAttribute("aria-expanded", String(enlarged));
    expand.setAttribute(
      "aria-label",
      enlarged ? "Restore video size" : "Enlarge video",
    );
    expand.title = enlarged ? "Restore video size · Escape" : "Enlarge video";
    if (!enlarged && previousFocus?.isConnected)
      previousFocus.focus({ preventScroll: true });
  }
  expand.addEventListener("click", () =>
    resize(expand.getAttribute("aria-expanded") !== "true"),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && surface.classList.contains("is-expanded"))
      resize(false);
    if (event.key === "Tab" && surface.classList.contains("is-expanded")) {
      const nodes = [
        ...surface.querySelectorAll<HTMLElement>(
          "button,a[href],video[controls]",
        ),
      ].filter((node) => !node.hidden && node.getClientRects().length);
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)!.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]!.focus();
      }
    }
  });
  // Roving keyboard focus for both tab strips; panels retain their live DOM.
  for (const kind of ["order", "detail"]) {
    const buttons = [
      ...arena.querySelectorAll<HTMLButtonElement>(`[data-${kind}-tab]`),
    ];
    function select(button: HTMLButtonElement) {
      for (const item of buttons) {
        const active = item === button;
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
        arena.querySelector<HTMLElement>(
          `[data-${kind}-panel="${item.dataset[kind + "Tab"]}"]`,
        )!.hidden = !active;
      }
    }
    for (const [index, button] of buttons.entries()) {
      button.addEventListener("click", () => select(button));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        select(buttons[next]!);
        buttons[next]!.focus();
      });
    }
  }
  const connection = crypto.randomUUID();
  const media = arena.querySelector<HTMLElement>("[data-media-event]")!;
  const viewers = arena.querySelector<HTMLElement>("[data-arena-viewers]")!;
  const playback = arena.querySelector<HTMLElement>("[data-arena-playback]")!;
  const clock = (value: number) => {
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  let reporting = false,
    lastReport = 0;
  function playing() {
    return (
      !document.hidden &&
      [...media.querySelectorAll("video")].some(
        (v) => !v.paused && !v.ended && !v.hidden,
      )
    );
  }
  async function heartbeat(force = false) {
    if (arena.dataset.demo === "true") {
      viewers.textContent = "Demo · no live audience";
      return;
    }
    if (reporting || (!force && Date.now() - lastReport < 10000)) return;
    reporting = true;
    lastReport = Date.now();
    try {
      const response = await fetch(
        `/api/community/events/${arena.dataset.debateId}/presence`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection, active: playing() }),
        },
      );
      if (!response.ok) throw new Error("Presence unavailable");
      const result: { activePlaybackTabs: number } = await response.json();
      viewers.textContent = `${result.activePlaybackTabs.toLocaleString()} watching`;
    } catch {
      viewers.textContent = "Viewers unavailable";
    } finally {
      reporting = false;
    }
  }
  for (const event of ["play", "pause", "ended"])
    media.addEventListener(event, () => void heartbeat(), true);
  media.addEventListener(
    "timeupdate",
    (event) => {
      const video = event.target as HTMLVideoElement;
      if (
        video.matches?.("[data-media-replay-video]") &&
        Number.isFinite(video.duration)
      )
        playback.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    },
    true,
  );
  document.addEventListener("visibilitychange", () => void heartbeat(true));
  window.addEventListener("pagehide", () => {
    if (arena.dataset.demo === "true") return;
    navigator.sendBeacon(
      `/api/community/events/${arena.dataset.debateId}/presence`,
      new Blob([JSON.stringify({ connection, active: false })], {
        type: "application/json",
      }),
    );
  });
  setInterval(() => {
    if (!document.hidden) void heartbeat(true);
  }, 30000);
  void heartbeat(true);
}
