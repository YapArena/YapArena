// What the Queue tab shows (frontend/queue-page.ts), as pure functions. The
// server decides every queue outcome (Decision 0011); these only describe it.
import { isQueued, type QueueState, type Side } from "./matchmaking-logic.js";

/** One topic from GET /api/matchmaking/waiting: counts only, never who. */
export interface WaitingTopic {
  slug: string;
  title: string;
  sideALabel: string;
  sideBLabel: string;
  waiting: { sideA: number; sideB: number };
}

/** A "Someone's waiting" row: people on one side, and the side to take. */
export interface WaitingRow {
  slug: string;
  title: string;
  count: number;
  waitingLabel: string;
  argueSide: Side;
  argueLabel: string;
}

const other = (side: Side): Side => (side === "A" ? "B" : "A");

/** Rows for every side with someone waiting, in the server's order. */
export function waitingRows(topics: readonly WaitingTopic[]): WaitingRow[] {
  return topics.flatMap((topic) =>
    (["A", "B"] as const)
      .map((side) => ({
        side,
        count: side === "A" ? topic.waiting.sideA : topic.waiting.sideB,
      }))
      .filter(({ count }) => count > 0)
      .map(({ side, count }) => ({
        slug: topic.slug,
        title: topic.title,
        count,
        waitingLabel: side === "A" ? topic.sideALabel : topic.sideBLabel,
        argueSide: other(side),
        argueLabel: other(side) === "A" ? topic.sideALabel : topic.sideBLabel,
      })),
  );
}

/** "1 person waiting to argue Free transit", "2 people waiting to argue…". */
export function waitingText(count: number, label: string) {
  return `${count} ${count === 1 ? "person" : "people"} waiting to argue ${label}`;
}

/** The short note on a question's row in "All questions". */
export function rowWaitingText(topic: WaitingTopic) {
  const parts = [
    topic.waiting.sideA ? `${topic.waiting.sideA} for ${topic.sideALabel}` : "",
    topic.waiting.sideB ? `${topic.waiting.sideB} for ${topic.sideBLabel}` : "",
  ].filter(Boolean);
  return parts.length ? `Waiting now: ${parts.join(" · ")}` : "";
}

/**
 * A side button, as the topic page draws its own: your side reads "Leave
 * queue" and is pressed; while you are in a queue the other buttons are off,
 * since the server allows one queue at a time.
 */
export function sideButtonView(
  state: QueueState | null,
  slug: string,
  side: Side,
  label: string,
) {
  const ticket = isQueued(state) ? state?.ticket : null;
  const mine = Boolean(
    ticket && ticket.topicSlug === slug && ticket.side === side,
  );
  return {
    text: mine ? "Leave queue" : label,
    pressed: mine,
    disabled: Boolean(ticket && !mine),
  };
}
