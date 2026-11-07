// The betting panel's public window list, shared with the rest of the debate
// page as the yap:stake-windows event after each read (frontend/stake-panel.ts).
// Each page module loads on its own, so the first read can finish before a
// module that loads later starts listening. The latest read stays on window,
// and a module that starts after it begins from it.
import type { RevealedWindow } from "./window-chart-model.js";

type StakeWindows = WindowEventMap["yap:stake-windows"]["detail"];

declare global {
  interface Window {
    yapStakeWindows?: StakeWindows;
  }
}

/** Sends a read to the page and keeps it for modules that start later. */
export function shareStakeWindows(detail: StakeWindows) {
  window.yapStakeWindows = detail;
  window.dispatchEvent(new CustomEvent("yap:stake-windows", { detail }));
}

/**
 * Calls `listener` with this debate's windows from each read: the latest one
 * already shared, if any, then every new one. The latest one comes once the
 * calling module's own code has run, so the listener can use everything the
 * module declares after this call.
 */
export function onStakeWindows(
  debateId: string,
  listener: (windows: RevealedWindow[]) => void,
) {
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId === debateId) listener(event.detail.windows);
  });
  queueMicrotask(() => {
    const latest = window.yapStakeWindows;
    if (latest?.debateId === debateId) listener(latest.windows);
  });
}
