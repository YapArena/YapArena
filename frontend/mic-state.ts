// Decision 0018: the debate's mic, shared with the rest of the debate page as
// the yap:mic event after each read (frontend/mic.ts reads it). Page modules
// load on their own, so the latest read stays on window and a module that
// starts later begins from it, exactly as the window list does
// (frontend/stake-windows.ts). On a page without the mic nothing is ever
// shared, and every listener keeps the page as it was.
import type { MicOwn, MicPublic } from "./mic-model.js";

export interface MicShared {
  debateId: string;
  /** The public list; null when the server has no mic for this debate. */
  mic: MicPublic | null;
  /** The signed-in viewer's own pledges and mics; null signed out or unread. */
  own: MicOwn | null;
  signedIn: boolean;
}

declare global {
  interface Window {
    yapMic?: MicShared;
  }
  interface WindowEventMap {
    "yap:mic": CustomEvent<MicShared>;
  }
}

/** Sends a read to the page and keeps it for modules that start later. */
export function shareMic(detail: MicShared) {
  window.yapMic = detail;
  window.dispatchEvent(new CustomEvent("yap:mic", { detail }));
}

/**
 * Calls `listener` with this debate's mic from each read: the latest one
 * already shared, if any, once the calling module's own code has run, then
 * every new one. Aborting `signal` stops it.
 */
export function onMic(
  debateId: string,
  listener: (shared: MicShared) => void,
  signal?: AbortSignal,
) {
  window.addEventListener(
    "yap:mic",
    (event) => {
      if (event.detail.debateId === debateId) listener(event.detail);
    },
    { signal },
  );
  queueMicrotask(() => {
    const latest = window.yapMic;
    if (latest?.debateId === debateId && !signal?.aborted) listener(latest);
  });
}
