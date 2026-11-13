// The betting panel's public window list, shared with the rest of the debate
// page as the yap:stake-windows event after each read (frontend/stake-panel.ts).
// Each page module loads on its own, so the first read can finish before a
// module that loads later starts listening. The latest read stays on window,
// and a module that starts after it begins from it. The signed-in viewer's own
// limits (yap:stake-rounds) are shared the same way for the price inspector.
import type { RevealedWindow } from "./window-chart-model.js";
import type { DebateEndorsement } from "../src/features/endorsement/types.ts";

type StakeWindows = WindowEventMap["yap:stake-windows"]["detail"];
type StakeRounds = WindowEventMap["yap:stake-rounds"]["detail"];

declare global {
  interface Window {
    yapStakeWindows?: StakeWindows;
    yapStakeRounds?: StakeRounds;
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

/** Decision 0015: the debate's last-answer figure and its reveal timing. */
export interface DebateEndorsementView {
  endorsement: DebateEndorsement | null;
  /** The figure through each counted turn, oldest first. */
  turns: DebateEndorsement[];
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
}

function endorsementView(detail: StakeWindows): DebateEndorsementView {
  return {
    endorsement: detail.endorsement ?? null,
    turns: detail.endorsementTurns ?? [],
    revealMode: detail.revealMode ?? "five_day",
    revealAt: detail.revealAt ?? null,
  };
}

/**
 * Calls `listener` with this debate's last-answer figure from each window
 * read, the latest one already shared first, exactly as onStakeWindows.
 */
export function onDebateEndorsement(
  debateId: string,
  listener: (view: DebateEndorsementView) => void,
) {
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId === debateId)
      listener(endorsementView(event.detail));
  });
  queueMicrotask(() => {
    const latest = window.yapStakeWindows;
    if (latest?.debateId === debateId) listener(endorsementView(latest));
  });
}

/** Tells the page the panel's latest window read failed. */
export function reportStakeWindowsFailure(debateId: string) {
  window.dispatchEvent(
    new CustomEvent("yap:stake-windows-failed", { detail: { debateId } }),
  );
}

/**
 * Calls `listener` with true when a window read for this debate fails, and
 * false when the next one arrives.
 */
export function onStakeWindowsStale(
  debateId: string,
  listener: (stale: boolean) => void,
) {
  window.addEventListener("yap:stake-windows-failed", (event) => {
    if (event.detail.debateId === debateId) listener(true);
  });
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId === debateId) listener(false);
  });
}

/** Sends this viewer's own limits to the page and keeps them for later modules. */
export function shareStakeRounds(detail: StakeRounds) {
  window.yapStakeRounds = detail;
  window.dispatchEvent(new CustomEvent("yap:stake-rounds", { detail }));
}

/**
 * Calls `listener` with this debate's own limits by window id: the latest
 * ones already shared, if any, once the calling module's code has run, then
 * every new read.
 */
export function onStakeRounds(
  debateId: string,
  listener: (limits: Record<string, string>) => void,
) {
  window.addEventListener("yap:stake-rounds", (event) => {
    if (event.detail.debateId === debateId) listener(event.detail.limits);
  });
  queueMicrotask(() => {
    const latest = window.yapStakeRounds;
    if (latest?.debateId === debateId) listener(latest.limits);
  });
}
