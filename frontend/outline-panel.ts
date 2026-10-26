import type {
  OutlineArgument,
  OutlineSide,
  TurnOutline,
} from "../src/features/outline/reducer.ts";
import type { TurnSummary } from "../src/features/outline/public-types.ts";
import type { OutlineView } from "./outline-state.js";

// Decision 0012: the "AI outline" panel. Keyed by argument and point ID, it
// touches only the text that changed, paints once per animation frame and not
// at all while the tab is hidden, and highlights a change with a CSS
// animation (none under reduced motion). Screen readers hear new arguments
// only, at most every ten seconds.

export interface SideLabel {
  name: string | null;
  label: string;
}
interface PanelDocument {
  readonly hidden: boolean;
  createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
  ): HTMLElementTagNameMap[K];
  addEventListener(type: "visibilitychange", listener: () => void): void;
}
export const ANNOUNCE_EVERY_MS = 10_000;

export function sideText(
  side: OutlineSide,
  sides: Record<OutlineSide, SideLabel>,
) {
  const { name, label } = sides[side];
  return name ? `${name} (${label})` : label;
}

export function createOutlinePanel({
  root,
  sides,
  document: page = document,
  frame = (callback: () => void) => requestAnimationFrame(callback),
  now = () => Date.now(),
  setTimer = (callback: () => void, ms: number): unknown =>
    setTimeout(callback, ms),
  onFlag,
}: {
  root: HTMLElement;
  sides: Record<OutlineSide, SideLabel>;
  document?: PanelDocument;
  frame?: (callback: () => void) => unknown;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  onFlag?: (turnNumber: number, itemId: string) => void;
}) {
  const turnLabel = root.querySelector<HTMLElement>(
    "[data-live-outline-turn]",
  )!;
  const list = root.querySelector<HTMLOListElement>(
    "[data-live-outline-arguments]",
  )!;
  const earlier = root.querySelector<HTMLDetailsElement>(
    "[data-live-outline-earlier]",
  )!;
  const earlierList = root.querySelector<HTMLOListElement>(
    "[data-live-outline-turns]",
  )!;
  const live = root.querySelector<HTMLElement>("[data-live-outline-announce]")!;
  let view: OutlineView | null = null;
  let painted: OutlineView | null = null;
  let pending = false;
  let speaker: OutlineSide | null = null;
  let lastAnnounced = -Infinity;
  let queued: string[] = [];
  let announceTimer: unknown;

  const flash = (element: HTMLElement) => {
    element.classList.remove("is-changed");
    // Restart the animation; animationend removes the class again.
    void element.offsetWidth;
    element.classList.add("is-changed");
  };
  const setText = (element: HTMLElement, text: string) => {
    if (element.textContent === text) return false;
    element.textContent = text;
    return true;
  };
  function flagButton(turnNumber: number, id: string, owner: OutlineSide) {
    const button = page.createElement("button");
    button.type = "button";
    button.className = "live-outline-flag";
    button.textContent = "Flag as a mistake";
    button.dataset.flag = id;
    button.dataset.side = owner;
    button.hidden = speaker !== owner;
    button.addEventListener("click", () => onFlag?.(turnNumber, id));
    return button;
  }
  function flaggedMark() {
    const mark = page.createElement("span");
    mark.className = "live-outline-flagged";
    mark.textContent = "Flagged by the speaker as a mistake";
    return mark;
  }
  function syncFlag(
    holder: HTMLElement,
    turnNumber: number,
    id: string,
    owner: OutlineSide,
    flags: ReadonlySet<string>,
  ) {
    const flagged = flags.has(id);
    let mark = holder.querySelector<HTMLElement>(
      ":scope > .live-outline-flagged",
    );
    if (flagged && !mark) holder.append((mark = flaggedMark()));
    if (!flagged && mark) mark.remove();
    let button = holder.querySelector<HTMLButtonElement>(
      ":scope > .live-outline-flag",
    );
    if (!flagged && !button)
      holder.append((button = flagButton(turnNumber, id, owner)));
    if (flagged && button) button.remove();
    if (button) button.hidden = speaker !== owner;
  }
  function argumentNode(item: OutlineArgument) {
    const node = page.createElement("li");
    node.className = "live-outline-argument";
    node.dataset.id = item.id;
    node.addEventListener("animationend", () =>
      node.classList.remove("is-changed"),
    );
    const head = page.createElement("p");
    head.className = "live-outline-label";
    const text = page.createElement("span");
    text.className = "live-outline-label-text";
    const rebuts = page.createElement("span");
    rebuts.className = "live-outline-rebuts";
    rebuts.hidden = true;
    head.append(text, rebuts);
    const points = page.createElement("ul");
    points.className = "live-outline-points";
    node.append(head, points);
    return node;
  }
  function labelOf(
    id: string,
    current: TurnOutline,
    turns: readonly TurnSummary[],
  ) {
    for (const turn of turns)
      for (const item of turn.arguments) if (item.id === id) return item.label;
    return current.arguments.find((item) => item.id === id)?.label ?? null;
  }
  function paintCurrent(current: TurnOutline | null, next: OutlineView) {
    if (!current) {
      setText(turnLabel, "Appears when a debater speaks");
      list.replaceChildren();
      return;
    }
    setText(
      turnLabel,
      `Turn ${current.turnNumber} · ${sideText(current.side, sides)}`,
    );
    list.lang = current.language;
    const existing = new Map<string, HTMLLIElement>();
    for (const child of Array.from(list.children) as HTMLLIElement[])
      if (child.dataset.id) existing.set(child.dataset.id, child);
    if (painted?.current?.turnNumber !== current.turnNumber) existing.clear();
    const keep = new Set<Element>();
    for (const item of current.arguments) {
      const node = existing.get(item.id) ?? argumentNode(item);
      keep.add(node);
      const head = node.querySelector<HTMLElement>(".live-outline-label")!;
      const changed = setText(
        head.querySelector<HTMLElement>(".live-outline-label-text")!,
        item.label,
      );
      const rebuts = head.querySelector<HTMLElement>(".live-outline-rebuts")!;
      const target = item.rebuts
        ? labelOf(item.rebuts, current, next.turns)
        : null;
      rebuts.hidden = !target;
      setText(rebuts, target ? `Rebuts: ${target}` : "");
      syncFlag(head, current.turnNumber, item.id, current.side, next.flags);
      const points = node.querySelector<HTMLUListElement>(
        ".live-outline-points",
      )!;
      const pointNodes = new Map<string, HTMLLIElement>();
      for (const child of Array.from(points.children) as HTMLLIElement[])
        if (child.dataset.id) pointNodes.set(child.dataset.id, child);
      let pointChanged = false;
      const keepPoints = new Set<Element>();
      for (const point of item.points) {
        let pointNode = pointNodes.get(point.id);
        if (!pointNode) {
          pointNode = page.createElement("li");
          pointNode.dataset.id = point.id;
          const span = page.createElement("span");
          span.className = "live-outline-point-text";
          pointNode.append(span);
          pointNode.addEventListener("animationend", () =>
            pointNode!.classList.remove("is-changed"),
          );
        }
        keepPoints.add(pointNode);
        if (
          setText(
            pointNode.querySelector<HTMLElement>(".live-outline-point-text")!,
            point.text,
          ) &&
          painted
        ) {
          flash(pointNode);
          pointChanged = true;
        }
        syncFlag(
          pointNode,
          current.turnNumber,
          point.id,
          current.side,
          next.flags,
        );
        points.append(pointNode);
      }
      for (const child of Array.from(points.children))
        if (!keepPoints.has(child)) child.remove();
      if (changed && painted && !pointChanged) flash(node);
      list.append(node);
    }
    for (const child of Array.from(list.children))
      if (!keep.has(child)) child.remove();
  }
  function paintEarlier(turns: readonly TurnSummary[]) {
    earlier.hidden = !turns.length;
    if (painted && painted.turns === turns) return;
    earlierList.replaceChildren(
      ...[...turns].reverse().map((turn) => {
        const item = page.createElement("li");
        item.lang = turn.language;
        const title = page.createElement("p");
        title.className = "live-outline-earlier-turn";
        title.textContent = `Turn ${turn.turnNumber} · ${sideText(turn.side, sides)}`;
        const labels = page.createElement("ul");
        for (const argument of turn.arguments) {
          const label = page.createElement("li");
          label.textContent = argument.label;
          labels.append(label);
        }
        item.append(title, labels);
        return item;
      }),
    );
  }
  function paint() {
    pending = false;
    if (page.hidden || !view) return;
    paintCurrent(view.current, view);
    paintEarlier(view.turns);
    painted = view;
  }
  const schedule = () => {
    if (pending || page.hidden) return;
    pending = true;
    frame(paint);
  };
  page.addEventListener("visibilitychange", schedule);
  function announce() {
    announceTimer = undefined;
    if (!queued.length) return;
    lastAnnounced = now();
    live.textContent =
      queued.length === 1
        ? `New argument: ${queued[0]}`
        : `New arguments: ${queued.join("; ")}`;
    queued = [];
  }
  return Object.freeze({
    show(next: OutlineView) {
      view = next;
      schedule();
    },
    /** Queues new argument labels for screen readers, throttled. */
    announce(labels: readonly string[]) {
      if (!labels.length) return;
      queued.push(...labels);
      if (announceTimer !== undefined) return;
      const wait = lastAnnounced + ANNOUNCE_EVERY_MS - now();
      if (wait <= 0) announce();
      else announceTimer = setTimer(announce, wait);
    },
    /** The signed-in debater's side, whose own items get a flag button. */
    setSpeaker(side: OutlineSide | null) {
      speaker = side;
      for (const button of Array.from(
        root.querySelectorAll<HTMLButtonElement>(".live-outline-flag"),
      ))
        button.hidden = button.dataset.side !== side;
    },
  });
}
