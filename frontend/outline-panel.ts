import type {
  OutlinePoint,
  OutlineSide,
  TurnOutline,
} from "../src/features/outline/reducer.ts";
import type { TurnSummary } from "../src/features/outline/public-types.ts";
import type { OutlineView } from "./outline-state.js";

// Decision 0012: the "AI outline" panel. Each argument is a card, like the
// landing's argument cards; a card opens to show its points and the
// arguments it rebuts or that rebut it, which open each other in turn. The
// current turn comes first, then earlier turns, newest first. Keyed by
// argument and point ID, it touches only the text that changed, paints once
// per animation frame and not at all while the tab is hidden, and highlights
// a change with a CSS animation (none under reduced motion). Screen readers
// hear new arguments only, at most every ten seconds.

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
  const earlier = root.querySelector<HTMLElement>(
    "[data-live-outline-earlier]",
  )!;
  const earlierList = root.querySelector<HTMLOListElement>(
    "[data-live-outline-turns]",
  )!;
  const live = root.querySelector<HTMLElement>("[data-live-outline-announce]")!;
  let view: OutlineView | null = null;
  let painted: OutlineView | null = null;
  let pending = false;
  let stale = false;
  let speaker: OutlineSide | null = null;
  let lastAnnounced = -Infinity;
  let queued: string[] = [];
  let announceTimer: unknown;
  /** Cards the viewer opened, kept open through repaints and turn changes. */
  const opened = new Set<string>();
  /**
   * Points as this page last saw them live, by argument ID. Earlier turns
   * arrive as labels only, so their cards show points only if this page saw
   * that turn live.
   */
  const seenPoints = new Map<string, readonly OutlinePoint[]>();

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
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
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
  /** The flagged mark goes in `markHolder`, the flag button in `holder`. */
  function syncFlag(
    holder: HTMLElement,
    turnNumber: number,
    id: string,
    owner: OutlineSide,
    flags: ReadonlySet<string>,
    markHolder: HTMLElement = holder,
  ) {
    const flagged = flags.has(id);
    let mark = markHolder.querySelector<HTMLElement>(
      ":scope > .live-outline-flagged",
    );
    if (flagged && !mark) markHolder.append((mark = flaggedMark()));
    if (!flagged && mark) mark.remove();
    let button = holder.querySelector<HTMLButtonElement>(
      ":scope > .live-outline-flag",
    );
    if (!flagged && !button)
      holder.append((button = flagButton(turnNumber, id, owner)));
    if (flagged && button) button.remove();
    if (button) button.hidden = speaker !== owner;
  }

  const part = (node: HTMLElement, name: string) =>
    node.querySelector<HTMLElement>(`:scope .live-outline-${name}`)!;
  function syncOpen(node: HTMLElement) {
    const open =
      node.dataset.expandable === "true" && opened.has(node.dataset.id!);
    node
      .querySelector(".live-outline-toggle")
      ?.setAttribute("aria-expanded", String(open));
    part(node, "more").hidden = !open;
    if (open) node.dataset.open = "";
    else delete node.dataset.open;
  }
  function setOpen(node: HTMLElement, open: boolean) {
    if (open) opened.add(node.dataset.id!);
    else opened.delete(node.dataset.id!);
    syncOpen(node);
  }
  /**
   * A card opens only when it has more to show; one that doesn't has no
   * button, so it isn't announced as one.
   */
  function setExpandable(node: HTMLElement, expandable: boolean) {
    const label = part(node, "label");
    const text = part(node, "label-text");
    let toggle = label.querySelector<HTMLButtonElement>(".live-outline-toggle");
    if (expandable && !toggle) {
      toggle = page.createElement("button");
      toggle.type = "button";
      toggle.className = "live-outline-toggle";
      toggle.setAttribute("aria-controls", part(node, "more").id);
      toggle.addEventListener("click", () =>
        setOpen(node, !opened.has(node.dataset.id!)),
      );
      label.prepend(toggle);
      toggle.append(text);
    }
    if (!expandable && toggle) {
      label.prepend(text);
      toggle.remove();
    }
    node.dataset.expandable = String(expandable);
    syncOpen(node);
  }
  /**
   * Opens, shows and focuses another argument's card. A link's target is
   * always on the page and, being linked, always opens.
   */
  function jump(id: string) {
    const target = root.querySelector<HTMLElement>(
      `.live-outline-argument[data-id="${id}"]`,
    )!;
    setOpen(target, true);
    target.scrollIntoView({ block: "nearest" });
    target
      .querySelector<HTMLElement>(".live-outline-toggle")!
      .focus({ preventScroll: true });
    flash(target);
  }
  function jumpButton(id: string, label: string) {
    const button = page.createElement("button");
    button.type = "button";
    button.className = "live-outline-jump";
    button.dataset.jump = id;
    button.textContent = label;
    button.addEventListener("click", () => jump(id));
    return button;
  }
  function cardNode(id: string) {
    const node = page.createElement("li");
    node.className = "live-outline-argument";
    node.dataset.id = id;
    node.addEventListener("animationend", (event) => {
      if (event.target === node) node.classList.remove("is-changed");
    });
    const head = page.createElement("div");
    head.className = "live-outline-card";
    const kicker = page.createElement("p");
    kicker.className = "live-outline-kicker";
    const label = page.createElement("p");
    label.className = "live-outline-label";
    const text = page.createElement("span");
    text.className = "live-outline-label-text";
    label.append(text);
    const foot = page.createElement("p");
    foot.className = "live-outline-foot";
    head.append(kicker, label, foot);
    const more = page.createElement("div");
    more.className = "live-outline-more";
    more.id = `live-outline-more-${id}`;
    more.hidden = true;
    const rebuts = page.createElement("p");
    rebuts.className = "live-outline-rebuts";
    rebuts.hidden = true;
    const points = page.createElement("ul");
    points.className = "live-outline-points";
    const replies = page.createElement("p");
    replies.className = "live-outline-replies";
    replies.hidden = true;
    const actions = page.createElement("p");
    actions.className = "live-outline-actions";
    more.append(points, rebuts, replies, actions);
    node.append(head, more);
    node.dataset.expandable = "false";
    return node;
  }
  function labelOf(
    id: string,
    current: TurnOutline | null,
    turns: readonly TurnSummary[],
  ) {
    for (const turn of turns)
      for (const item of turn.arguments) if (item.id === id) return item.label;
    return current?.arguments.find((item) => item.id === id)?.label ?? null;
  }
  /** Who rebuts each argument, across every turn on the page. */
  function repliesOf(
    current: TurnOutline | null,
    turns: readonly TurnSummary[],
  ) {
    const replies = new Map<string, { id: string; label: string }[]>();
    const add = (item: {
      id: string;
      label: string;
      rebuts: string | null;
    }) => {
      if (!item.rebuts) return;
      const list = replies.get(item.rebuts) ?? [];
      list.push({ id: item.id, label: item.label });
      replies.set(item.rebuts, list);
    };
    for (const turn of turns) turn.arguments.forEach(add);
    current?.arguments.forEach(add);
    return replies;
  }
  /**
   * Fills a card's kicker, label, links and footer; returns whether the
   * label changed. Points are filled by the caller.
   */
  function fillCard(
    node: HTMLElement,
    item: { id: string; label: string; rebuts: string | null },
    pointCount: number,
    links: {
      current: TurnOutline | null;
      turns: readonly TurnSummary[];
      replies: Map<string, { id: string; label: string }[]>;
    },
  ) {
    node.dataset.kind = item.rebuts ? "counter" : "argument";
    setText(part(node, "kicker"), item.rebuts ? "Counterargument" : "Argument");
    const changed = setText(part(node, "label-text"), item.label);
    const rebuts = part(node, "rebuts");
    const target = item.rebuts
      ? labelOf(item.rebuts, links.current, links.turns)
      : null;
    rebuts.hidden = !target;
    if (target && rebuts.dataset.target !== `${item.rebuts}:${target}`) {
      rebuts.dataset.target = `${item.rebuts}:${target}`;
      const lead = page.createElement("span");
      lead.className = "live-outline-link-lead";
      lead.textContent = "Rebuts";
      rebuts.replaceChildren(lead, jumpButton(item.rebuts!, target));
    }
    const replies = links.replies.get(item.id) ?? [];
    const repliesNode = part(node, "replies");
    repliesNode.hidden = !replies.length;
    const key = replies.map((reply) => `${reply.id}:${reply.label}`).join("|");
    if (repliesNode.dataset.replies !== key) {
      repliesNode.dataset.replies = key;
      const lead = page.createElement("span");
      lead.className = "live-outline-link-lead";
      lead.textContent = "Rebutted by";
      repliesNode.replaceChildren(
        lead,
        ...replies.map((reply) => jumpButton(reply.id, reply.label)),
      );
    }
    const counts = [
      pointCount ? plural(pointCount, "point", "points") : "",
      replies.length ? plural(replies.length, "rebuttal", "rebuttals") : "",
    ].filter(Boolean);
    const foot = part(node, "foot");
    foot.hidden = !counts.length;
    setText(foot, counts.join(" · "));
    return changed;
  }
  function paintPoints(
    node: HTMLElement,
    points: readonly OutlinePoint[],
    flags: {
      turnNumber: number;
      side: OutlineSide;
      set: ReadonlySet<string>;
    } | null,
    flashing = false,
  ) {
    const holder = part(node, "points");
    const pointNodes = new Map<string, HTMLLIElement>();
    for (const child of Array.from(holder.children) as HTMLLIElement[])
      if (child.dataset.id) pointNodes.set(child.dataset.id, child);
    let pointChanged = false;
    const keepPoints = new Set<Element>();
    for (const point of points) {
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
        flashing
      ) {
        flash(pointNode);
        pointChanged = true;
      }
      if (flags)
        syncFlag(pointNode, flags.turnNumber, point.id, flags.side, flags.set);
      holder.append(pointNode);
    }
    for (const child of Array.from(holder.children))
      if (!keepPoints.has(child)) child.remove();
    holder.hidden = !points.length;
    return pointChanged;
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
    // Changes flash only within a turn already on screen: not on the first
    // paint, and not when a new turn starts.
    const sameTurn = painted?.current?.turnNumber === current.turnNumber;
    if (!sameTurn) existing.clear();
    const keep = new Set<Element>();
    const links = {
      current,
      turns: next.turns,
      replies: repliesOf(current, next.turns),
    };
    for (const item of current.arguments) {
      seenPoints.set(item.id, item.points);
      const node = (existing.get(item.id) ??
        cardNode(item.id)) as HTMLLIElement;
      keep.add(node);
      const changed = fillCard(node, item, item.points.length, links);
      syncFlag(
        part(node, "actions"),
        current.turnNumber,
        item.id,
        current.side,
        next.flags,
        part(node, "card"),
      );
      const pointChanged = paintPoints(
        node,
        item.points,
        {
          turnNumber: current.turnNumber,
          side: current.side,
          set: next.flags,
        },
        sameTurn,
      );
      setExpandable(
        node,
        Boolean(
          item.points.length ||
          !part(node, "rebuts").hidden ||
          !part(node, "replies").hidden ||
          (speaker === current.side && !next.flags.has(item.id)),
        ),
      );
      // A change inside a closed card shows on the card itself.
      if (sameTurn && (changed || (pointChanged && !("open" in node.dataset))))
        flash(node);
      list.append(node);
    }
    for (const child of Array.from(list.children))
      if (!keep.has(child)) child.remove();
  }
  /** Earlier turns' cards and their arguments, for in-place link updates. */
  let earlierCards: {
    node: HTMLElement;
    argument: TurnSummary["arguments"][number];
  }[] = [];
  function paintEarlier(next: OutlineView) {
    const turns = next.turns;
    earlier.hidden = !turns.length;
    if (stale || !painted || painted.turns !== turns) {
      earlierCards = [];
      earlierList.replaceChildren(
        ...[...turns].reverse().map((turn) => {
          const item = page.createElement("li");
          item.className = "live-outline-group";
          item.lang = turn.language;
          const title = page.createElement("p");
          title.className = "live-outline-earlier-turn";
          title.textContent = `Turn ${turn.turnNumber} · ${sideText(turn.side, sides)}`;
          const cards = page.createElement("ol");
          cards.className = "live-outline-arguments";
          for (const argument of turn.arguments) {
            const node = cardNode(argument.id);
            paintPoints(node, seenPoints.get(argument.id) ?? [], null);
            part(node, "actions").remove();
            earlierCards.push({ node, argument });
            cards.append(node);
          }
          item.append(title, cards);
          return item;
        }),
      );
    }
    // Links change as the current turn rebuts earlier arguments.
    const links = {
      current: next.current,
      turns,
      replies: repliesOf(next.current, turns),
    };
    for (const { node, argument } of earlierCards) {
      const points = seenPoints.get(argument.id)?.length ?? 0;
      fillCard(node, argument, points, links);
      setExpandable(
        node,
        Boolean(
          points ||
          !part(node, "rebuts").hidden ||
          !part(node, "replies").hidden,
        ),
      );
    }
  }
  function paint() {
    pending = false;
    if (page.hidden || !view) return;
    paintCurrent(view.current, view);
    paintEarlier(view);
    painted = view;
    stale = false;
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
      // Their own cards open to show the flag button.
      stale = true;
      schedule();
    },
  });
}
