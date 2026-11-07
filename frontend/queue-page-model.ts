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

// ---- "+ Create": a new question, made public and queued in one step ---------------------------

/** The Create sheet's fields, as typed. */
export interface NewQuestion {
  title: string;
  summary: string;
  sideALabel: string;
  sideBLabel: string;
  category: string;
  side: Side | null;
}

const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * The topic's URL slug, from its question, in the form the server accepts
 * (`[a-z0-9][a-z0-9-]{2,79}`). A suffix makes a second try unique.
 */
export function slugFromTitle(title: string, suffix = "") {
  const tail = suffix ? `-${suffix}` : "";
  const base =
    plain(title)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80 - tail.length)
      .replace(/-+$/, "") || "question";
  const slug = `${base}${tail}`;
  return slug.length >= 3 ? slug : `${slug}-question`;
}

// Common words that would match almost every question.
const STOP_WORDS = new Set([
  "about",
  "become",
  "could",
  "every",
  "everyone",
  "from",
  "have",
  "into",
  "make",
  "more",
  "less",
  "should",
  "than",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
]);

/**
 * A query for today's topic search (`/api/public/topics?q=`, PostgreSQL's
 * web search syntax) that finds questions sharing any meaningful word: the
 * words of four letters or more, joined with "or", within the 80-character
 * limit. Empty when nothing is worth searching for.
 */
export function similarQuery(text: string) {
  const words = [
    ...new Set(
      plain(text)
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
    ),
  ];
  let query = "";
  for (const word of words) {
    const next = query ? `${query} or ${word}` : word;
    if (next.length > 80) break;
    query = next;
  }
  return query;
}

/** The server's limits for a topic, checked before sending; null when valid. */
export function newQuestionError(question: NewQuestion, joining: boolean) {
  const title = question.title.trim();
  const summary = question.summary.trim();
  const a = question.sideALabel.trim();
  const b = question.sideBLabel.trim();
  if (title.length < 5 || title.length > 140)
    return "Write a question of 5 to 140 characters.";
  if (summary.length < 10 || summary.length > 600)
    return "Say what the debate is about in 10 to 600 characters.";
  if (a.length < 2 || b.length < 2 || a.length > 80 || b.length > 80)
    return "Name both sides, 2 to 80 characters each.";
  if (a.toLowerCase() === b.toLowerCase())
    return "Give the two sides different names.";
  if (!question.category) return "Choose a category.";
  if (joining && !question.side) return "Choose the side you argue.";
  return null;
}
