import type { OutlineSide } from "../src/features/outline/reducer.ts";
import type { TurnDetail } from "./debate-layout-model.js";
import type { SideLabel } from "./outline-panel.js";
import type { OutlineView } from "./outline-state.js";

// Decision 0012 on phones (first-run build plan PR 8): one line under the
// speakers with the argument being made now, from the same outline state the
// AI outline panel paints. The panel announces new arguments to screen
// readers; this line does not, so nothing is heard twice.

/** The live turn from the media snapshot, as `yap:turn` reports it. */
export type LiveTurn = Pick<
  TurnDetail,
  "eventStatus" | "state" | "activeSide" | "turnNumber"
>;

export interface NowLine {
  kind: "argument" | "counter" | "listening";
  /** "Counterargument · Maya · turn 5", or "Léo · turn 6" while listening. */
  kicker: string;
  label: string;
  /** The label's language: the speaker's, as in the panel. */
  lang: string;
}

/** The outline panel's text for the slot after the newest argument. */
export const LISTENING = "Listening for the next argument…";

/** "Maya" for "Maya Chen"; the side's label when the debater isn't named. */
export function speakerName(
  side: OutlineSide,
  sides: Record<OutlineSide, SideLabel>,
) {
  const { name, label } = sides[side];
  return name?.trim().split(/\s+/)[0] || label;
}

/**
 * The line for an outline view: the current turn's newest argument, or,
 * once the media reports a newer turn than the outline has reached, that
 * the outline is listening to its speaker. Nothing without a view (a replay
 * before it plays) or once the debate has ended.
 */
export function nowLine(
  view: OutlineView | null,
  turn: LiveTurn | null,
  sides: Record<OutlineSide, SideLabel>,
): NowLine | null {
  if (!view) return null;
  if (turn && (turn.eventStatus !== "live" || turn.state === "ended"))
    return null;
  const current = view.current;
  const newest = current?.arguments.at(-1);
  const speaking =
    turn?.turnNumber && turn.activeSide
      ? { turnNumber: turn.turnNumber, side: turn.activeSide }
      : null;
  if (
    speaking &&
    (!current || !newest || current.turnNumber < speaking.turnNumber)
  )
    return {
      kind: "listening",
      kicker: `${speakerName(speaking.side, sides)} · turn ${speaking.turnNumber}`,
      label: LISTENING,
      lang: "",
    };
  if (!current || !newest) return null;
  return {
    kind: newest.rebuts ? "counter" : "argument",
    kicker: `${newest.rebuts ? "Counterargument" : "Argument"} · ${speakerName(current.side, sides)} · turn ${current.turnNumber}`,
    label: newest.label,
    lang: current.language,
  };
}

/**
 * Paints the line into the page's `[data-outline-now]` element, touching
 * only what changed. It follows `yap:turn` itself; the outline module hands
 * it each view (null while a replay has no position yet).
 */
export function createNowLine(
  element: HTMLElement,
  sides: Record<OutlineSide, SideLabel>,
  events: Pick<Window, "addEventListener">,
  debateId: string,
) {
  const kicker = element.querySelector<HTMLElement>(
    "[data-outline-now-kicker]",
  )!;
  const label = element.querySelector<HTMLElement>("[data-outline-now-label]")!;
  let view: OutlineView | null = null;
  let turn: LiveTurn | null = null;
  function paint() {
    const line = nowLine(view, turn, sides);
    element.hidden = !line;
    if (!line) return;
    if (element.dataset.kind !== line.kind) element.dataset.kind = line.kind;
    if (kicker.textContent !== line.kicker) kicker.textContent = line.kicker;
    if (label.textContent !== line.label) label.textContent = line.label;
    if (line.lang) label.lang = line.lang;
    else label.removeAttribute("lang");
  }
  events.addEventListener("yap:turn", (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail !== "object") return;
    const next = detail as TurnDetail;
    if (next.debateId !== debateId) return;
    turn = next;
    paint();
  });
  return Object.freeze({
    show(next: OutlineView | null) {
      view = next;
      paint();
    },
  });
}
