// "Results by turn" (direction BC1's replay board): one bar per turn around
// a dashed 50% line, the chosen turn filled, the playing turn outlined, and a
// line above the bars for the turn being looked at. a4-inline.ts feeds it the
// turn windows; the rules are in turn-results-model.ts.
/* global document */
import { firstName } from "./debate-layout-model.js";
import {
  barLabel,
  barScale,
  barShape,
  captionParts,
  percents,
  phoneColumns,
  rowLine,
  type Names,
  type TurnColumn,
} from "./turn-results-model.js";

/** "MC" for "Maya Chen", as on the scoreboard's avatars. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

export interface TurnBarsView {
  columns: readonly TurnColumn[];
  names: Names;
  /** The chosen turn, filled; the caption's turn when none is looked at. */
  selected: number | null;
  /** The replay's playing turn, outlined. */
  playing: number | null;
  /** The caption when no turn is chosen. */
  note: string;
}

export function createTurnBars(
  root: HTMLElement,
  choose: (column: TurnColumn) => void,
  // Phones show the turns as rows, and only those with a result.
  phone: Pick<MediaQueryList, "matches" | "addEventListener"> = matchMedia(
    "(max-width: 599px)",
  ),
) {
  const box = root.querySelector<HTMLElement>("[data-turn-bars]")!;
  const list = box.querySelector<HTMLOListElement>("[data-turn-bar-list]")!;
  const caption = root.querySelector<HTMLElement>("[data-turn-caption]")!;
  let view: TurnBarsView | null = null;
  // The last view asked for, before the phone list drops turns.
  let requested: TurnBarsView | null = null;
  let signature = "";
  // The turn under the pointer or keyboard focus, shown in the caption.
  let looked: number | null = null;
  const buttons = new Map<number, HTMLButtonElement>();

  const text = (tag: string, className: string, content: string) => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
  };
  function showCaption() {
    if (!view) return;
    const turn = looked ?? view.selected;
    const column = view.columns.find((item) => item.turnNumber === turn);
    if (!column) {
      caption.replaceChildren(
        text("span", "arena-turn-caption-note", view.note),
      );
      return;
    }
    const parts = captionParts(column, view.names);
    caption.replaceChildren(
      text("span", "arena-turn-caption-lead", parts.lead),
      ...(parts.label
        ? [
            document.createTextNode(" "),
            text("strong", "arena-turn-caption-label", `“${parts.label}”`),
          ]
        : []),
      document.createTextNode(" "),
      text("span", "arena-turn-caption-result", parts.result),
    );
  }
  // The roving tab stop: the chosen turn, else the playing one, else the last.
  function focusTarget() {
    if (!view) return null;
    const turns = view.columns.map((column) => column.turnNumber);
    return [view.selected, view.playing, turns.at(-1)].find(
      (turn) => turn != null && turns.includes(turn),
    );
  }
  function paint() {
    if (!view) return;
    const tabStop = focusTarget();
    for (const column of view.columns) {
      const button = buttons.get(column.turnNumber)!;
      const item = button.parentElement!;
      const playing = column.turnNumber === view.playing;
      const selected = column.turnNumber === view.selected;
      item.toggleAttribute("data-selected", selected);
      item.toggleAttribute("data-playing", playing);
      button.setAttribute("aria-pressed", String(selected));
      if (playing) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.setAttribute("aria-label", barLabel(column, view.names, playing));
      button.tabIndex = column.turnNumber === tabStop ? 0 : -1;
    }
    showCaption();
  }
  function build(columns: readonly TurnColumn[], names: Names) {
    const focused = (
      document.activeElement as HTMLElement | null
    )?.closest<HTMLElement>("[data-turn-bar]")?.dataset.turnBar;
    const scale = barScale(columns);
    buttons.clear();
    list.replaceChildren(
      ...columns.map((column) => {
        const item = document.createElement("li");
        item.className = "arena-turn-bar";
        item.dataset.turnBar = String(column.turnNumber);
        item.dataset.state = column.state;
        const shape = barShape(column, scale);
        // A phone row's bar is split at the yes share.
        if (column.yes !== null)
          item.style.setProperty("--yes", `${percents(column.yes).yes}%`);
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-describedby", "arena-turns-hint");
        const plot = document.createElement("span");
        plot.className = "arena-turn-bar-plot";
        plot.setAttribute("aria-hidden", "true");
        if (shape) {
          item.dataset.direction = shape.direction;
          item.style.setProperty("--bar-size", `${shape.size}px`);
          plot.append(
            text("span", "arena-turn-bar-fill", ""),
            text("span", "arena-turn-bar-value", shape.value),
          );
        }
        const who = document.createElement("span");
        who.className = "arena-turn-bar-who";
        who.setAttribute("aria-hidden", "true");
        who.append(
          text("b", "arena-turn-bar-number", String(column.turnNumber)),
          text(
            "span",
            "arena-turn-bar-name",
            column.side ? firstName(names[column.side]) : "",
          ),
          // Narrow charts have room for initials only.
          text(
            "span",
            "arena-turn-bar-initials",
            column.side ? initials(names[column.side]) : "",
          ),
          text("span", "arena-turn-bar-playing", "playing"),
        );
        // Phones: the speaker and the turn's arguments under the bar.
        const line = text(
          "span",
          "arena-turn-bar-line",
          rowLine(column, names),
        );
        line.setAttribute("aria-hidden", "true");
        button.append(plot, who, line);
        item.append(button);
        buttons.set(column.turnNumber, button);
        return item;
      }),
    );
    if (focused) buttons.get(Number(focused))?.focus({ preventScroll: true });
  }
  const turnOf = (target: EventTarget | null) => {
    const turn = (target as Element | null)?.closest<HTMLElement>(
      "[data-turn-bar]",
    )?.dataset.turnBar;
    return turn ? Number(turn) : null;
  };
  function look(turn: number | null) {
    if (turn === looked) return;
    looked = turn;
    showCaption();
  }
  list.addEventListener("click", (event) => {
    const turn = turnOf(event.target);
    const column = view?.columns.find((item) => item.turnNumber === turn);
    if (column) choose(column);
  });
  list.addEventListener("pointerover", (event) => look(turnOf(event.target)));
  list.addEventListener("pointerleave", () =>
    look(
      list.contains(document.activeElement)
        ? turnOf(document.activeElement)
        : null,
    ),
  );
  list.addEventListener("focusin", (event) => look(turnOf(event.target)));
  list.addEventListener("focusout", (event) => {
    if (!list.contains(event.relatedTarget as Node | null)) look(null);
  });
  list.addEventListener("keydown", (event) => {
    // Phones stack the turns as rows, so Up and Down move between them too.
    const keys = phone.matches
      ? ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]
      : ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!view || !keys.includes(event.key)) return;
    const turns = view.columns.map((column) => column.turnNumber);
    const index = turns.indexOf(turnOf(event.target) ?? -1);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? turns.length - 1
          : Math.max(
              0,
              Math.min(
                turns.length - 1,
                index +
                  (event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 1),
              ),
            );
    const button = buttons.get(turns[next]!)!;
    for (const item of buttons.values()) item.tabIndex = -1;
    button.tabIndex = 0;
    button.focus();
  });

  phone.addEventListener("change", () => {
    if (requested) render(requested);
  });
  function render(asked: TurnBarsView) {
    requested = asked;
    const next = phone.matches
      ? { ...asked, columns: phoneColumns(asked.columns) }
      : asked;
    const nextSignature = JSON.stringify([next.columns, next.names]);
    view = next;
    box.hidden = !next.columns.length;
    if (nextSignature !== signature) {
      signature = nextSignature;
      build(next.columns, next.names);
    }
    paint();
  }

  return {
    render,
    hide() {
      box.hidden = true;
      view = null;
      requested = null;
      signature = "";
      looked = null;
      buttons.clear();
      list.replaceChildren();
      caption.replaceChildren();
    },
  };
}
