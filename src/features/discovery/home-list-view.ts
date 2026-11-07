// /home as a list of debates (docs/site-design.md#home), on the site kit.
// The server renders it with what every reader sees; frontend/home-list.ts
// renders the feed again with the reader's followed topics, the waiting list
// and each debate's turn windows, so both use these functions.
import { html, type SafeHtml } from "../../platform/html.ts";
import {
  closesText,
  endedText,
  homeFilters,
  resultText,
  startsText,
  waitingText,
  type HomeDebate,
  type HomeFilter,
  type HomeListData,
  type HomeSection,
  type HomeView,
  type TopLabel,
  type TopSlot,
  type WaitingRow,
} from "./home-list-model.ts";
import { avatarSlot, inscription } from "./kit-web.ts";

const livePixel = html`<span class="live-pixel" aria-hidden="true"></span>`;
const arrow = html`<span aria-hidden="true">→</span>`;

const topTitles: Record<TopLabel, string> = {
  "live-yours": "Live in your topics",
  yours: "From your topics",
  "live-other": "Live in other topics",
  live: "Live now",
  next: "Next debate",
  replay: "You can still answer",
  finished: "Latest result",
};

const filterNames: Record<HomeFilter, string> = {
  all: "All",
  soon: "Soon",
  replays: "Replays",
};

// The topic page's queue card names each side's label with this id, so a
// waiting row lands on the side to take.
const sideHref = (row: WaitingRow) =>
  `/topics/${encodeURIComponent(row.slug)}#queue-side-${row.argueSide.toLowerCase()}`;

// "Argue for" takes side A, "Argue against" side B, as the topic's stances.
const argueName = (row: WaitingRow) =>
  row.argueSide === "A" ? "Argue for" : "Argue against";

const countdown = (kind: "start" | "close", iso: string, now: number) =>
  html`<time class="num" datetime="${iso}" data-home-countdown="${kind}">${kind === "start" ? startsText(iso, now) : closesText(iso, now)}</time>`;

// Each speaker's Pixel Yapper, their initials without one, or "?" while
// nobody is named, as the site's debate cards show them.
const slot = (debate: HomeDebate, side: 0 | 1, size: number) =>
  avatarSlot(
    debate.named[side] ? debate.names[side] : undefined,
    size,
    debate.avatars[side] ?? undefined,
  );
const pair = (debate: HomeDebate, size: number) =>
  html`<span class="home-pair">${slot(debate, 0, size)}${slot(debate, 1, size)}</span>`;

const people = (debate: HomeDebate) =>
  html`${debate.kind === "live" ? livePixel : ""}<span>${debate.names[0]} vs ${debate.names[1]} · ${debate.topic.title}</span>${debate.demo ? html` <span class="tag tag-quiet">Demo</span>` : ""}`;

// When it happens, or how long answers stay open, or how it ended.
function timing(debate: HomeDebate, now: number) {
  if (debate.kind === "replay" && debate.closesAt)
    return html`Answers close ${countdown("close", debate.closesAt, now)}`;
  if (debate.kind === "finished")
    return html`${endedText(debate.endedAt, now)}${debate.result ? html`${debate.endedAt ? " · " : ""}<strong class="home-result">${resultText(debate.result)}</strong>` : ""}`;
  return html``;
}

// One way in per debate: Watch, or Answer while a replay takes answers. A
// debate starting soon shows its countdown instead.
function action(debate: HomeDebate, now: number, primary = false) {
  const button = (text: string) =>
    html`<span class="btn ${primary ? "btn-primary" : "btn-outline"} btn-sm home-action">${text}</span>`;
  if (debate.kind === "soon" && debate.startsAt)
    return html`<span class="home-when">${countdown("start", debate.startsAt, now)}</span>`;
  return button(debate.kind === "replay" ? "Answer" : "Watch");
}

function debateRow(debate: HomeDebate, now: number) {
  const when = timing(debate, now);
  return html`<li><a class="home-row" href="${debate.href}" data-home-key="${debate.id}">${pair(debate, 36)}<span class="home-row-copy"><span class="home-row-title">${debate.proposition}</span><span class="home-row-meta">${people(debate)}</span>${when.toString() ? html`<span class="home-row-meta">${when}</span>` : ""}</span>${action(debate, now)}</a></li>`;
}

function waitingRow(row: WaitingRow) {
  return html`<li><a class="home-row" href="${sideHref(row)}" data-home-key="waiting:${row.slug}:${row.argueSide}"><span class="home-count num" aria-hidden="true">${row.count}</span><span class="home-row-copy"><span class="home-row-title">${row.title}</span><span class="home-row-meta">${waitingText(row.count, row.waitingLabel)}</span><span class="home-row-meta">Take the other side: ${row.argueLabel}</span></span><span class="btn btn-outline btn-sm home-action">${argueName(row)}</span></a></li>`;
}

function section(part: HomeSection, now: number) {
  const id = `home-${part.key}-title`;
  return html`<section class="home-section" aria-labelledby="${id}" data-home-section="${part.key}"><h2 class="home-section-title" id="${id}">${part.key === "live" ? livePixel : ""}${inscription(part.title)}</h2><ul class="home-rows">${"rows" in part ? part.rows.map(waitingRow) : part.debates.map((debate) => debateRow(debate, now))}</ul></section>`;
}

// The top slot: one card with a white button (the kit's one per screen).
function topCard(top: TopSlot, now: number, matchmaking: boolean) {
  if (top.kind === "start")
    return html`<a class="card home-feature" href="${matchmaking ? "/topics" : "/match"}" data-home-key="start"><span class="home-feature-text">${matchmaking ? "Open a topic and queue on a side. You are matched with someone on the other side in seconds." : "Create a topic, then challenge someone to debate it."}</span><span class="home-feature-foot"><span class="btn btn-primary btn-sm home-action">${matchmaking ? "Pick a topic" : "Create a topic"}</span></span></a>`;
  if (top.kind === "waiting") {
    const row = top.row;
    return html`<a class="card home-feature" href="${sideHref(row)}" data-home-key="waiting:${row.slug}:${row.argueSide}"><span class="home-feature-head"><span class="home-count num" aria-hidden="true">${row.count}</span><span class="home-feature-title">${row.title}</span></span><span class="home-row-meta">${waitingText(row.count, row.waitingLabel)}</span><span class="home-feature-foot"><span class="home-row-meta">Take the other side: ${row.argueLabel}</span><span class="btn btn-primary btn-sm home-action">${argueName(row)}</span></span></a>`;
  }
  const debate = top.debate;
  const tag =
    debate.kind === "live"
      ? html`<span class="tag tag-live">${livePixel}Live</span>`
      : debate.kind === "soon" && debate.startsAt
        ? html`<span class="home-countdown">${countdown("start", debate.startsAt, now)}</span>`
        : html`<span class="tag">Replay</span>`;
  return html`<a class="card home-feature" href="${debate.href}" data-home-key="${debate.id}"><span class="home-feature-head">${pair(debate, 48)}${tag}</span><span class="home-feature-title">${debate.proposition}</span><span class="home-row-meta">${people(debate)}</span><span class="home-feature-foot"><span class="home-row-meta">${timing(debate, now)}</span>${debate.kind === "soon" ? html`<span class="btn btn-primary btn-sm home-action">Watch</span>` : action(debate, now, true)}</span></a>`;
}

const topTitle = (top: TopSlot) =>
  top.kind === "debate"
    ? topTitles[top.label]
    : top.kind === "waiting"
      ? "Someone's waiting"
      : "Start the first debate";

const emptyNotes = {
  soon: html`<div class="state state-quiet home-empty"><h2>${inscription("Nothing starts in the next 24 hours.")}</h2><a class="text-link" href="/debates?status=scheduled">All upcoming debates ${arrow}</a></div>`,
  replays: html`<div class="state state-quiet home-empty"><h2>${inscription("No replays yet.")}</h2></div>`,
};

/** The part of the page that changes with the chips and the reader's data. */
export function homeFeedMarkup(
  view: HomeView,
  now: number,
  matchmaking: boolean,
): SafeHtml {
  return html`${view.quiet ? html`<p class="home-quiet"><span class="home-quiet-mark" aria-hidden="true"></span>Nothing live right now. Live debates show here first.</p>` : ""}${view.top ? html`<section class="home-section home-top" aria-labelledby="home-top-title"><h2 class="home-section-title" id="home-top-title">${view.top.kind === "debate" && view.top.debate.kind === "live" ? livePixel : ""}${inscription(topTitle(view.top))}</h2>${topCard(view.top, now, matchmaking)}${view.topRows.length ? html`<ul class="home-rows">${view.topRows.map((debate) => debateRow(debate, now))}</ul>` : ""}</section>` : ""}${view.sections.map((part) => section(part, now))}${view.empty ? emptyNotes[view.empty] : ""}<a class="text-link home-more" href="/debates">All debates ${arrow}</a>`;
}

/** The chips' names, with the number each one shows. */
export function filterLabel(filter: HomeFilter, view: HomeView) {
  return filter === "all"
    ? filterNames.all
    : `${filterNames[filter]} · ${view.counts[filter]}`;
}

/** The whole home: the intro, the chips and the feed, with the data the browser re-renders from. */
export function homeListMarkup(data: HomeListData, view: HomeView): SafeHtml {
  if (!data.available)
    return html`<div class="container home-list"><h1 class="sr-only">Yap Arena</h1><div class="state home-state"><h2>${inscription("Discovery temporarily unavailable.")}</h2><p>Try again shortly.</p><div class="home-state-actions"><a class="btn btn-secondary" href="/home">Try again</a><a class="btn btn-outline" href="/topics">Explore topics</a></div></div></div>`;
  const now = Date.parse(data.now);
  return html`<div class="container home-list" data-home-list><h1 class="sr-only">Yap Arena</h1><div class="home-intro" data-home-intro><p>Live video debates. Say whether you agree during each turn's 60-second window.</p><button class="home-intro-close" type="button" data-home-intro-close aria-label="Close the introduction"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></div><div class="chips home-chips" role="group" aria-label="Show">${homeFilters.map((filter) => html`<button class="chip" type="button" data-home-filter="${filter}" aria-pressed="${String(filter === view.filter)}">${filterLabel(filter, view)}</button>`)}</div><div class="home-feed" data-home-feed>${homeFeedMarkup(view, now, data.matchmaking)}</div><p class="sr-only" role="status" data-home-status></p></div><template id="home-list-data">${JSON.stringify(data)}</template>`;
}
