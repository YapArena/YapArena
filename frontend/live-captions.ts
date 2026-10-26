import type { Room } from "livekit-client";

// Decision 0012: live captions under the video. The transcriber agent sends
// each caption on LiveKit's transcription text stream topic; a segment's
// later streams replace its earlier text, and the final one fixes it. The
// server is not involved.

export const TRANSCRIPTION_TOPIC = "lk.transcription";
export interface CaptionSegment {
  id: string;
  text: string;
  final: boolean;
  language: string | undefined;
}
export interface CaptionState {
  finals: readonly CaptionSegment[];
  interim: CaptionSegment | null;
}
export const emptyCaptions: CaptionState = Object.freeze({
  finals: [],
  interim: null,
});

/** Applies one caption update; keeps the last few finals and one interim. */
export function applyCaption(
  state: CaptionState,
  segment: CaptionSegment,
  keep = 3,
): CaptionState {
  const text = segment.text.replace(/\s+/g, " ").trim();
  const finals = state.finals.filter((item) => item.id !== segment.id);
  if (!text)
    return {
      finals,
      interim: state.interim?.id === segment.id ? null : state.interim,
    };
  const next = { ...segment, text };
  if (segment.final)
    return {
      finals: [...finals, next].slice(-keep),
      interim: state.interim?.id === segment.id ? null : state.interim,
    };
  return { finals, interim: next };
}

/** The visible line: the latest words, cut at a word boundary. */
export function captionText(state: CaptionState, maxChars = 160) {
  const words = [...state.finals, ...(state.interim ? [state.interim] : [])]
    .map((item) => item.text)
    .join(" ");
  if (words.length <= maxChars) return words;
  const cut = words.length - maxChars,
    tail = words.slice(cut);
  // Keep a word that starts exactly at the cut; drop a partial one.
  const start = words[cut - 1] === " " ? 0 : tail.indexOf(" ") + 1;
  return `…${tail.slice(start)}`;
}

export function captionLanguage(state: CaptionState) {
  return (state.interim ?? state.finals.at(-1))?.language;
}

interface CaptionDocument {
  readonly hidden: boolean;
  querySelector<E extends Element = Element>(selector: string): E | null;
  addEventListener(type: "visibilitychange", listener: () => void): void;
}
interface CaptionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const preference = "yap:live-captions";

/**
 * Binds the captions container, when the page has one. Painting waits for an
 * animation frame and stops while the tab is hidden; the latest line is
 * painted on return.
 */
export function createCaptions({
  document: page = globalThis.document as CaptionDocument | undefined,
  storage,
  frame = (callback: () => void) => requestAnimationFrame(callback),
}: {
  document?: CaptionDocument | undefined;
  storage?: CaptionStorage | undefined;
  frame?: (callback: () => void) => unknown;
} = {}) {
  if (!page) return undefined;
  if (!storage)
    try {
      storage = globalThis.localStorage;
    } catch {
      // Reading localStorage can throw when site data is blocked.
    }
  const container = page.querySelector<HTMLElement>("[data-live-captions]");
  const line = container?.querySelector<HTMLElement>(
    "[data-live-captions-text]",
  );
  const toggle = container?.querySelector<HTMLButtonElement>(
    "[data-live-captions-toggle]",
  );
  if (!container || !line || !toggle) return undefined;
  let state = emptyCaptions;
  let pending = false;
  let enabled = true;
  try {
    enabled = storage?.getItem(preference) !== "off";
  } catch {
    // Storage can be unavailable; captions then default to on.
  }
  const paintToggle = () => {
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = enabled ? "Captions on" : "Captions off";
    if (enabled) delete container.dataset.captionsOff;
    else container.dataset.captionsOff = "";
  };
  const paint = () => {
    pending = false;
    if (page.hidden) return;
    const text = captionText(state);
    if (line.textContent !== text) line.textContent = text;
    const language = captionLanguage(state);
    if (language) line.lang = language;
    else line.removeAttribute("lang");
  };
  const schedule = () => {
    if (pending || page.hidden) return;
    pending = true;
    frame(paint);
  };
  page.addEventListener("visibilitychange", schedule);
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    paintToggle();
    try {
      storage?.setItem(preference, enabled ? "on" : "off");
    } catch {
      // A per-viewer convenience only.
    }
  });
  paintToggle();
  const rooms = new WeakSet<Room>();
  const update = (segment: CaptionSegment) => {
    state = applyCaption(state, segment);
    schedule();
  };
  return Object.freeze({
    update,
    clear() {
      state = emptyCaptions;
      schedule();
    },
    get state() {
      return state;
    },
    /** Shows the line and listens to this Room's transcription streams. */
    attach(room: Pick<Room, "registerTextStreamHandler">) {
      if (rooms.has(room as Room)) return;
      rooms.add(room as Room);
      container.hidden = false;
      room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader) => {
        const attributes = reader.info.attributes ?? {};
        const id = attributes["lk.segment_id"] ?? reader.info.id;
        const final = attributes["lk.transcription_final"] === "true";
        const language = attributes["yap.language"];
        void (async () => {
          let text = "";
          try {
            for await (const chunk of reader) {
              text += chunk;
              update({ id, text, final: false, language });
            }
          } catch {
            // An interrupted stream keeps the text received so far.
          }
          update({ id, text, final, language });
        })();
      });
    },
  });
}
