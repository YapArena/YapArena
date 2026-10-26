import type { Room } from "livekit-client";
import type {
  OutlineCatchUp,
  OutlineSnapshot,
} from "../src/features/outline/public-types.ts";
import type { OutlineSide } from "../src/features/outline/reducer.ts";
import { createCaptions } from "./live-captions.js";
import { createOutlinePanel, type SideLabel } from "./outline-panel.js";
import {
  OUTLINE_TOPIC,
  applyCatchUp,
  applyVersion,
  emptyView,
  fromSnapshot,
  parseOutlineMessage,
  type OutlineView,
} from "./outline-state.js";

// Decision 0012: the debate page's live captions and AI outline follow the
// page's LiveKit Room. media-entry.ts loads this module as a split chunk only
// when the page has these containers, and hands it each Room it connects.
// Live outline versions arrive over LiveKit: no HTTP request per update. A
// page that has not joined the video opens a data-only connection (no track
// subscriptions) through the viewer-token endpoint, and only if LiveKit is
// unavailable does it fall back to the 'outline' room signal and a re-read.

interface Bootstrap {
  debateId: string;
  live: boolean;
  sides: Record<OutlineSide, SideLabel>;
  state: OutlineSnapshot | null;
}
/** The parts of a LiveKit Room the outline uses. */
type DataRoom = Pick<Room, "on" | "disconnect" | "localParticipant">;
export interface OutlineDependencies {
  fetchJson(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<number>;
  /** Opens a data-only LiveKit connection, or throws if unavailable. */
  connectData(debateId: string): Promise<DataRoom>;
  events: Pick<Window, "addEventListener">;
  random(): number;
  setTimer(callback: () => void, ms: number): unknown;
  visible(): boolean;
}

const browserDependencies = (): OutlineDependencies => ({
  async fetchJson(path) {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`outline read ${response.status}`);
    return response.json();
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.status;
  },
  async connectData(debateId) {
    const response = await fetch(`/api/media/events/${debateId}/viewer-token`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`viewer token ${response.status}`);
    const grant = (await response.json()) as { token: string; url: string };
    const { Room: LiveRoom } = await import("livekit-client");
    const room = new LiveRoom({ adaptiveStream: false, dynacast: false });
    await room.connect(grant.url, grant.token, { autoSubscribe: false });
    return room;
  },
  events: window,
  random: Math.random,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  visible: () => !document.hidden,
});

const speakerSide = (room: DataRoom): OutlineSide | null => {
  const local = room.localParticipant;
  if (!local.identity.startsWith("speaker-")) return null;
  try {
    const side = (JSON.parse(local.metadata || "{}") as { side?: unknown })
      .side;
    return side === "A" || side === "B" ? side : null;
  } catch {
    return null;
  }
};

/** Waits this long for the page's own Room before opening a data-only one. */
export const DATA_ONLY_DELAY_MS = 3000;
/** Spreads fallback re-reads so a room's viewers do not read at once. */
export const FALLBACK_SPREAD_MS = 3000;

export function createLiveOutline(
  root: HTMLElement,
  dependencies: OutlineDependencies = browserDependencies(),
  panelOptions: Partial<Parameters<typeof createOutlinePanel>[0]> = {},
) {
  const template = root.querySelector<HTMLTemplateElement>(
    "[data-live-outline-state]",
  );
  const bootstrap = JSON.parse(template!.content.textContent!) as Bootstrap;
  const { debateId } = bootstrap;
  let view: OutlineView = bootstrap.state
    ? fromSnapshot(bootstrap.state)
    : emptyView;
  let catching: Promise<void> | undefined;
  let mediaRoom: DataRoom | undefined;
  let dataRoom: DataRoom | undefined;
  let fallback = false;
  const attached = new WeakSet<object>();
  const panel = createOutlinePanel({
    root,
    sides: bootstrap.sides,
    onFlag(turnNumber, itemId) {
      void dependencies
        .post(`/api/debates/${debateId}/outline/flags`, { turnNumber, itemId })
        .then((status) => {
          if (status !== 201) return;
          view = { ...view, flags: new Set([...view.flags, itemId]) };
          panel.show(view);
        });
    },
    ...panelOptions,
  });
  panel.show(view);

  function catchUp() {
    catching ??= dependencies
      .fetchJson(
        `/api/public/debates/${debateId}/outline?after=${view.version}`,
      )
      .then((answer) => {
        const result = applyCatchUp(
          view,
          answer as OutlineCatchUp | OutlineSnapshot,
        );
        view = result.view;
        panel.show(view);
        panel.announce(result.added);
      })
      .catch(() => {
        // The next message, signal or connection tries again.
      })
      .finally(() => {
        catching = undefined;
      });
    return catching;
  }
  function receive(payload: Uint8Array) {
    const next = parseOutlineMessage(payload, debateId);
    if (!next) return;
    const result = applyVersion(view, next);
    if (result.kind === "gap") void catchUp();
    if (result.kind !== "applied") return;
    view = result.view;
    panel.show(view);
    panel.announce(result.added);
  }
  function listen(room: DataRoom) {
    if (attached.has(room)) return;
    attached.add(room);
    room.on("dataReceived", (payload, _participant, _kind, topic) => {
      if (topic === OUTLINE_TOPIC) receive(payload);
    });
    // Versions published before this connection are fetched once.
    void catchUp();
  }
  async function openDataOnly() {
    if (mediaRoom || dataRoom || !dependencies.visible()) return;
    try {
      const room = await dependencies.connectData(debateId);
      if (mediaRoom) {
        await room.disconnect();
        return;
      }
      dataRoom = room;
      fallback = false;
      listen(room);
    } catch {
      fallback = true;
    }
  }
  dependencies.events.addEventListener("yap:room-signal", (event) => {
    const topics = event.detail.topics;
    if (topics.includes("outline") && (fallback || !(mediaRoom ?? dataRoom)))
      dependencies.setTimer(
        () => void catchUp(),
        dependencies.random() * FALLBACK_SPREAD_MS,
      );
    // The debate may have gone live after the page loaded.
    if (topics.includes("media") && !mediaRoom && !dataRoom)
      dependencies.setTimer(() => void openDataOnly(), DATA_ONLY_DELAY_MS);
  });
  if (bootstrap.live)
    dependencies.setTimer(() => void openDataOnly(), DATA_ONLY_DELAY_MS);

  return Object.freeze({
    /** The page joined the debate's room (as viewer or speaker). */
    attach(room: DataRoom) {
      mediaRoom = room;
      panel.setSpeaker(speakerSide(room));
      listen(room);
      if (dataRoom) {
        const extra = dataRoom;
        dataRoom = undefined;
        void extra.disconnect();
      }
    },
    get view() {
      return view;
    },
  });
}

export function startLiveOutline(
  debateId: string,
  page: Pick<Document, "querySelector"> | undefined = globalThis.document,
) {
  void debateId;
  const captions = createCaptions();
  const root = page?.querySelector<HTMLElement>("[data-live-outline]");
  const outline = root ? createLiveOutline(root) : undefined;
  return (room: Room) => {
    captions?.attach(room);
    outline?.attach(room);
  };
}
