// The home as a list of debates (first-run plan PR 6, direction A, confirmed
// 2026-11-06): what is live, what starts within a day, who is waiting for an
// opponent, replays still taking answers and finished debates with their
// result. Pure and browser-safe, with no DOM access: the router builds the
// lists from the public debate reads, and frontend/home-list.ts adds the
// signed-in person's followed topics, the public waiting list and each
// debate's public turn windows, then renders the same view again.
import type { AvatarId } from "../identity/avatars.ts";
import type { Fraction } from "../a4/fraction-types.ts";
import type { PublicDebate } from "./public-types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** "Starting soon" looks this far ahead. */
export const SOON_HOURS = 24;
/**
 * Replay answers stay open until this long after a debate's live end: the
 * five-day close of account-wallet/debate-sandbox.ts (REVEAL_CLOSE_HOURS).
 * The browser replaces it with each debate's own close from its turn windows.
 */
export const ANSWER_CLOSE_HOURS = 120;
// How many debates each list keeps. Replays and finished debates each cost
// the browser one turn-window read, so those lists stay short.
const LIST_LIMIT = 12;
const REPLAY_LIMIT = 4;
const FINISHED_LIMIT = 4;
const WAITING_LIMIT = 5;

export type HomeKind = "live" | "soon" | "replay" | "finished";

/** The latest turn whose result is revealed, and the share who said yes. */
export interface HomeResult {
  turn: number;
  yes: number;
}

export interface HomeDebate {
  id: string;
  slug: string;
  href: string;
  kind: HomeKind;
  proposition: string;
  topic: { slug: string; title: string };
  /** Both speakers' names, or their side's label while nobody is named. */
  names: [string, string];
  /** Whether each speaker is named yet; an empty slot shows "?". */
  named: [boolean, boolean];
  /** Each speaker's avatar address; null shows initials (Decision 0014). */
  avatars: [string | null, string | null];
  demo: boolean;
  /** When a debate starting soon begins (ISO). */
  startsAt: string | null;
  /** When the live debate ended (ISO), for replays and finished debates. */
  endedAt: string | null;
  /** When a replay stops taking answers (ISO). */
  closesAt: string | null;
  /** A finished debate's latest revealed result, once the browser reads it. */
  result: HomeResult | null;
}

export interface HomeListData {
  available: boolean;
  /** The server's clock when the page was built (ISO). */
  now: string;
  /** Whether the live queue is on, so GET /api/matchmaking/waiting exists. */
  matchmaking: boolean;
  live: HomeDebate[];
  soon: HomeDebate[];
  replays: HomeDebate[];
  finished: HomeDebate[];
}

/** One topic from GET /api/matchmaking/waiting: counts only, never who. */
export interface WaitingTopic {
  slug: string;
  title: string;
  sideALabel: string;
  sideBLabel: string;
  waiting: { sideA: number; sideB: number };
}

/** People waiting on one side of a topic, and the side you would take. */
export interface WaitingRow {
  slug: string;
  title: string;
  count: number;
  waitingLabel: string;
  argueSide: "A" | "B";
  argueLabel: string;
}

const ended = (status: PublicDebate["status"]) =>
  status === "replay" || status === "finalized";

function homeDebate(
  debate: PublicDebate,
  kind: HomeKind,
  avatarUrl?: (id: AvatarId) => string,
): HomeDebate {
  const { speakerA, speakerB, topic } = debate;
  const endedAt = debate.liveEndedAt
    ? new Date(debate.liveEndedAt).toISOString()
    : null;
  return {
    id: debate.id,
    slug: debate.slug,
    href: `/debates/${encodeURIComponent(debate.slug)}`,
    kind,
    proposition: debate.proposition,
    topic: { slug: topic.slug, title: topic.title },
    names: [
      speakerA?.displayName ?? topic.sideALabel,
      speakerB?.displayName ?? topic.sideBLabel,
    ],
    named: [Boolean(speakerA), Boolean(speakerB)],
    avatars: [
      speakerA && avatarUrl ? avatarUrl(speakerA.avatarId) : null,
      speakerB && avatarUrl ? avatarUrl(speakerB.avatarId) : null,
    ],
    demo: debate.isDemo,
    startsAt: debate.scheduledAt
      ? new Date(debate.scheduledAt).toISOString()
      : null,
    endedAt,
    closesAt:
      kind === "replay" && endedAt
        ? new Date(
            Date.parse(endedAt) + ANSWER_CLOSE_HOURS * HOUR,
          ).toISOString()
        : null,
    result: null,
  };
}

/**
 * Sorts the public debates into the home's lists. A scheduled debate shows
 * only while its start is ahead and within a day, so one whose start passed
 * never lingers as "upcoming". A replay takes answers until its close; after
 * that it is finished.
 */
export function homeList(
  sources: {
    live: readonly PublicDebate[];
    /** Scheduled and ready debates. */
    scheduled: readonly PublicDebate[];
    /** Replays and finalized debates. */
    ended: readonly PublicDebate[];
  },
  now: Date,
  {
    matchmaking = false,
    avatarUrl,
  }: { matchmaking?: boolean; avatarUrl?: (id: AvatarId) => string } = {},
): HomeListData {
  const at = now.getTime();
  const time = (value: Date | null) =>
    value ? new Date(value).getTime() : null;
  const closes = (debate: PublicDebate) => {
    const end = time(debate.liveEndedAt);
    return end === null ? null : end + ANSWER_CLOSE_HOURS * HOUR;
  };
  const soon = sources.scheduled
    .filter((debate) => {
      const start = time(debate.scheduledAt);
      return (
        (debate.status === "scheduled" || debate.status === "ready") &&
        start !== null &&
        start > at &&
        start <= at + SOON_HOURS * HOUR
      );
    })
    .sort((a, b) => time(a.scheduledAt)! - time(b.scheduledAt)!);
  const finishedEnded = sources.ended.filter((debate) => ended(debate.status));
  const replays = finishedEnded
    .filter((debate) => (closes(debate) ?? at) > at)
    .sort((a, b) => closes(a)! - closes(b)!);
  const finished = finishedEnded
    .filter((debate) => (closes(debate) ?? at) <= at)
    .sort(
      (a, b) =>
        (time(b.liveEndedAt) ?? -Infinity) - (time(a.liveEndedAt) ?? -Infinity),
    );
  return {
    available: true,
    now: now.toISOString(),
    matchmaking,
    live: sources.live
      .filter((debate) => debate.status === "live")
      .slice(0, LIST_LIMIT)
      .map((debate) => homeDebate(debate, "live", avatarUrl)),
    soon: soon
      .slice(0, LIST_LIMIT)
      .map((debate) => homeDebate(debate, "soon", avatarUrl)),
    replays: replays
      .slice(0, REPLAY_LIMIT)
      .map((debate) => homeDebate(debate, "replay", avatarUrl)),
    finished: finished
      .slice(0, FINISHED_LIMIT)
      .map((debate) => homeDebate(debate, "finished", avatarUrl)),
  };
}

/** The home with nothing on it, or (with available false) when it failed. */
export const emptyHomeList = (now: Date, available = true): HomeListData => ({
  available,
  now: now.toISOString(),
  matchmaking: false,
  live: [],
  soon: [],
  replays: [],
  finished: [],
});

/** The parts of GET /api/public/debates/:id/windows the home reads. */
export interface HomeWindows {
  serverNow: string;
  revealMode: "five_day" | "per_round";
  revealAt: string | null;
  windows: {
    turnNumber: number;
    state: "open" | "settled" | "void";
    pricing?: { share: Fraction | null } | null;
  }[];
}

// The share who said yes, rounded as the betting panel rounds it
// (percent() in frontend/stake-model.ts).
const percent = (share: Fraction | null | undefined) => {
  const d = share ? Number(share.d) : 0;
  return share && d ? Math.round((Number(share.n) / d) * 100) : null;
};

/** The latest turn with a revealed share, as "Turn 6: 58% said yes" shows it. */
export function latestResult(
  windows: HomeWindows["windows"],
): HomeResult | null {
  const revealed = windows
    .filter((window) => window.state === "settled")
    .map((window) => ({
      turn: window.turnNumber,
      yes: percent(window.pricing?.share),
    }))
    .filter((window): window is HomeResult => window.yes !== null)
    .sort((a, b) => b.turn - a.turn);
  return revealed[0] ?? null;
}

/**
 * Applies each debate's turn windows. A replay keeps taking answers only in
 * the five-day mode, with an open turn window, before its close; it then
 * shows that exact close. Any other replay is finished. Finished debates get
 * their latest revealed result. Debates without windows stay as they were.
 */
export function withWindows(
  data: HomeListData,
  windows: ReadonlyMap<string, HomeWindows>,
): HomeListData {
  const replays: HomeDebate[] = [];
  const moved: HomeDebate[] = [];
  for (const debate of data.replays) {
    const read = windows.get(debate.id);
    if (!read) {
      replays.push(debate);
      continue;
    }
    const open =
      read.revealMode === "five_day" &&
      read.revealAt !== null &&
      Date.parse(read.revealAt) > Date.parse(read.serverNow) &&
      read.windows.some((window) => window.state === "open");
    if (open) replays.push({ ...debate, closesAt: read.revealAt });
    else
      moved.push({
        ...debate,
        kind: "finished",
        closesAt: null,
        result: latestResult(read.windows),
      });
  }
  const finished = [
    ...moved,
    ...data.finished.map((debate) => {
      const read = windows.get(debate.id);
      return read ? { ...debate, result: latestResult(read.windows) } : debate;
    }),
  ].sort(
    (a, b) =>
      (b.endedAt ? Date.parse(b.endedAt) : -Infinity) -
      (a.endedAt ? Date.parse(a.endedAt) : -Infinity),
  );
  return { ...data, replays, finished };
}

/** A row for every side with someone waiting, in the server's order. */
export function waitingRows(topics: readonly WaitingTopic[]): WaitingRow[] {
  return topics.flatMap((topic) =>
    (["A", "B"] as const)
      .map((side) => ({
        side,
        count: side === "A" ? topic.waiting.sideA : topic.waiting.sideB,
      }))
      .filter(({ count }) => count > 0)
      .map(({ side, count }) => {
        const argueSide = side === "A" ? "B" : "A";
        return {
          slug: topic.slug,
          title: topic.title,
          count,
          waitingLabel: side === "A" ? topic.sideALabel : topic.sideBLabel,
          argueSide,
          argueLabel: argueSide === "A" ? topic.sideALabel : topic.sideBLabel,
        };
      }),
  );
}

/** What fills the top of the home, in the order of the decision page's #quiet. */
export type TopLabel =
  | "live-yours"
  | "yours"
  | "live-other"
  | "live"
  | "next"
  | "replay"
  | "finished";
export type TopSlot =
  | { kind: "debate"; label: TopLabel; debate: HomeDebate }
  | { kind: "waiting"; row: WaitingRow }
  | { kind: "start" };

/**
 * The top of the home is never empty: a live debate in a followed topic;
 * something soon (within a day) or a replay still taking answers in one; any
 * other live debate; the next debate within a day; a replay still taking
 * answers; someone waiting; a finished debate (one with its result first);
 * and only then "Start the first debate". Signed-out people and new accounts
 * follow nothing, so they start at the third step.
 */
export function topSlot(
  data: HomeListData,
  follows: ReadonlySet<string>,
  waiting: readonly WaitingRow[],
): TopSlot {
  const yours = (debate: HomeDebate) => follows.has(debate.topic.slug);
  const pick = (label: TopLabel, debate: HomeDebate | undefined) =>
    debate ? ({ kind: "debate", label, debate } as const) : null;
  return (
    pick("live-yours", data.live.find(yours)) ??
    pick("yours", data.soon.find(yours) ?? data.replays.find(yours)) ??
    pick(follows.size ? "live-other" : "live", data.live[0]) ??
    pick("next", data.soon[0]) ??
    pick("replay", data.replays[0]) ??
    (waiting[0] ? { kind: "waiting", row: waiting[0] } : null) ??
    pick(
      "finished",
      data.finished.find((debate) => debate.result) ?? data.finished[0],
    ) ?? { kind: "start" }
  );
}

/** The chips over the list (category chips join them with PR 5). */
export type HomeFilter = "all" | "soon" | "replays";
export const homeFilters: readonly HomeFilter[] = ["all", "soon", "replays"];

export type HomeSection =
  | {
      key: "live" | "soon" | "replays" | "finished";
      title: string;
      debates: HomeDebate[];
    }
  | { key: "waiting"; title: string; rows: WaitingRow[] };

export interface HomeView {
  filter: HomeFilter;
  /** The top slot; only All shows one. */
  top: TopSlot | null;
  /** More live debates under a live top slot, in the same section. */
  topRows: HomeDebate[];
  /** "Nothing live right now", over the top slot. */
  quiet: boolean;
  sections: HomeSection[];
  /** The filter's own empty note, when it shows nothing. */
  empty: "soon" | "replays" | null;
  counts: { soon: number; replays: number };
}

/** Everything the list shows for one filter, with nothing listed twice. */
export function homeView(
  data: HomeListData,
  follows: ReadonlySet<string>,
  waiting: readonly WaitingTopic[],
  filter: HomeFilter = "all",
): HomeView {
  const counts = {
    soon: data.soon.length,
    replays: data.replays.length + data.finished.length,
  };
  const keep = <T extends HomeSection>(section: T) =>
    ("debates" in section ? section.debates : section.rows).length
      ? [section]
      : [];
  if (filter === "soon")
    return {
      filter,
      top: null,
      topRows: [],
      quiet: false,
      sections: keep({
        key: "soon",
        title: "Starting soon",
        debates: data.soon,
      }),
      empty: data.soon.length ? null : "soon",
      counts,
    };
  if (filter === "replays")
    return {
      filter,
      top: null,
      topRows: [],
      quiet: false,
      sections: [
        ...keep({
          key: "replays",
          title: "Replays you can still answer",
          debates: data.replays,
        }),
        ...keep({
          key: "finished",
          title: "Finished debates",
          debates: data.finished,
        }),
      ],
      empty: counts.replays ? null : "replays",
      counts,
    };
  const rows = waitingRows(waiting);
  const top = topSlot(data, follows, rows);
  const shown = top.kind === "debate" ? top.debate.id : null;
  const rest = (debates: HomeDebate[]) =>
    debates.filter((debate) => debate.id !== shown);
  const live = rest(data.live);
  // A live top slot is the first of the live debates: the others follow it
  // under the same title. Under a followed topic's live debate, the others
  // keep their own section.
  const liveTop =
    top.kind === "debate" &&
    (top.label === "live" || top.label === "live-other");
  const otherTopics =
    follows.size > 0 &&
    live.length > 0 &&
    !live.some((debate) => follows.has(debate.topic.slug));
  return {
    filter,
    top,
    topRows: liveTop ? live : [],
    quiet: !data.live.length && top.kind !== "start",
    sections: [
      ...keep({
        key: "live",
        title: otherTopics ? "Live in other topics" : "Live now",
        debates: liveTop ? [] : live,
      }),
      ...keep({
        key: "soon",
        title: "Starting soon",
        debates: rest(data.soon),
      }),
      ...keep({
        key: "waiting",
        title: "Someone's waiting",
        rows: rows
          .filter((row) => top.kind !== "waiting" || row !== top.row)
          .slice(0, WAITING_LIMIT),
      }),
      ...keep({
        key: "replays",
        title: "Replays you can still answer",
        debates: rest(data.replays),
      }),
      ...keep({
        key: "finished",
        title: "Finished debates",
        debates: rest(data.finished),
      }),
    ],
    empty: null,
    counts,
  };
}

/** A countdown to a start: "in 35 min", "in 2 h 14", or "Starting now". */
export function startsText(startsAt: string, now: number) {
  const left = Date.parse(startsAt) - now;
  if (left <= 0) return "Starting now";
  const minutes = Math.ceil(left / MINUTE);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** How long a replay keeps taking answers: "in 4 days", "in 30 h", "in 12 min". */
export function closesText(closesAt: string, now: number) {
  const left = Date.parse(closesAt) - now;
  if (left <= 0) return "now";
  const hours = Math.floor(left / HOUR);
  if (hours >= 48) return `in ${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `in ${hours} h`;
  return `in ${Math.max(1, Math.ceil(left / MINUTE))} min`;
}

/** When a debate ended: "Ended 3 h ago", "Ended 2 days ago", "Ended Oct 30". */
export function endedText(endedAt: string | null, now: number) {
  if (!endedAt) return "";
  const ago = Math.max(0, now - Date.parse(endedAt));
  if (ago < HOUR)
    return `Ended ${Math.max(1, Math.floor(ago / MINUTE))} min ago`;
  if (ago < 24 * HOUR) return `Ended ${Math.floor(ago / HOUR)} h ago`;
  const days = Math.floor(ago / (24 * HOUR));
  if (days < 14) return `Ended ${days} ${days === 1 ? "day" : "days"} ago`;
  return `Ended ${new Date(endedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** "1 person waiting to argue Free transit", as the Queue tab words it. */
export const waitingText = (count: number, label: string) =>
  `${count} ${count === 1 ? "person" : "people"} waiting to argue ${label}`;

/** "Turn 6: 58% said yes", in the site's words for a turn's result. */
export const resultText = (result: HomeResult) =>
  `Turn ${result.turn}: ${result.yes}% said yes`;
