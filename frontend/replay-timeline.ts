// The replay's timeline split into turns, under the video (direction BC1's
// replay board): each turn's segment fills as it plays, and choosing one
// plays the replay from that turn's start. It reads the window list the
// betting panel shares and the replay player's yap:playback position, and
// changes the player only by seeking (replay-seek.ts).
/* global document, window */
import { seekReplay } from "./replay-seek.js";
import {
  isTurnWindow,
  segmentLabel,
  timelineSegments,
  turnColumns,
  type Names,
  type TurnColumn,
} from "./turn-results-model.js";

const arena = document.querySelector<HTMLElement>("[data-arena]");
const timeline = arena?.querySelector<HTMLElement>("[data-replay-timeline]");
if (arena && timeline) {
  const debateId = arena.dataset.debateId!;
  const list = timeline.querySelector<HTMLOListElement>(
    "[data-replay-timeline-list]",
  )!;
  const panel = arena.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Names = {
    A: panel?.dataset.speakerA ?? "Speaker A",
    B: panel?.dataset.speakerB ?? "Speaker B",
  };
  let columns: TurnColumn[] = [];
  let position: number | null = null;
  let signature = "";
  const items = new Map<number, HTMLElement>();

  function build() {
    const focused = (
      document.activeElement as HTMLElement | null
    )?.closest<HTMLElement>("[data-timeline-turn]")?.dataset.timelineTurn;
    items.clear();
    list.replaceChildren(
      ...columns.map((column) => {
        const item = document.createElement("li");
        item.className = "arena-timeline-turn";
        item.dataset.timelineTurn = String(column.turnNumber);
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", segmentLabel(column, names));
        button.disabled = column.recording === null;
        const track = document.createElement("span");
        track.className = "arena-timeline-track";
        track.setAttribute("aria-hidden", "true");
        // The track's gradient shows how much has played.
        const thumb = document.createElement("span");
        thumb.className = "arena-timeline-thumb";
        track.append(thumb);
        button.append(track);
        item.append(button);
        items.set(column.turnNumber, item);
        return item;
      }),
    );
    if (focused)
      items
        .get(Number(focused))
        ?.querySelector("button")
        ?.focus({ preventScroll: true });
  }
  function paint() {
    const segments = timelineSegments(columns, position);
    const stop =
      segments.find((segment) => segment.playing)?.turnNumber ??
      segments.find((segment) => segment.playable)?.turnNumber;
    for (const segment of segments) {
      const item = items.get(segment.turnNumber)!;
      const button = item.querySelector("button")!;
      item.style.setProperty("--progress", segment.progress.toFixed(4));
      item.toggleAttribute("data-playing", segment.playing);
      item.toggleAttribute("data-played", segment.progress >= 1);
      if (segment.playing) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      if (!list.contains(document.activeElement))
        button.tabIndex = segment.turnNumber === stop ? 0 : -1;
    }
  }
  function render() {
    // The timeline needs the turns' places in the recording. Until then it
    // keeps its space, unseen, so the video doesn't move when it shows.
    timeline!.toggleAttribute(
      "data-waiting",
      !columns.some((column) => column.recording),
    );
    const next = JSON.stringify(
      columns.map((column) => [
        column.turnNumber,
        column.side,
        column.recording,
      ]),
    );
    if (next !== signature) {
      signature = next;
      build();
    }
    paint();
  }
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId !== debateId) return;
    columns = turnColumns(
      event.detail.windows.filter(isTurnWindow),
      null,
      null,
      false,
    );
    render();
  });
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    position = event.detail.positionSeconds;
    if (columns.length) paint();
  });
  list.addEventListener("click", (event) => {
    const turn = (event.target as Element).closest<HTMLElement>(
      "[data-timeline-turn]",
    )?.dataset.timelineTurn;
    const span = columns.find(
      (column) => column.turnNumber === Number(turn),
    )?.recording;
    if (span) seekReplay(span.startSeconds);
  });
  // One tab stop; the arrow keys move between turns (a toolbar's pattern).
  list.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...list.querySelectorAll("button")].filter(
      (button) => !button.disabled,
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(
              0,
              Math.min(
                buttons.length - 1,
                index + (event.key === "ArrowLeft" ? -1 : 1),
              ),
            );
    for (const button of buttons) button.tabIndex = -1;
    buttons[next]!.tabIndex = 0;
    buttons[next]!.focus();
  });
}
