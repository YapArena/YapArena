import { homepageMarkup } from "./homepage-view.ts";
import { accountMarkup } from "./account-web.ts";
import { siteHeaderMarkup, type SiteSection } from "./site-header-web.ts";
import type { PublicBotActivity } from "../a4/public-bots.ts";
import { publicHomepage, type HomeData } from "./homepage-model.ts";
import { renderVideoDebateCard } from "./video-card-web.ts";
import { renderFeaturedDebate } from "./featured-web.ts";
import { renderDebateWorkspace } from "./debate-web.ts";
import { asset, assetRevision } from "./assets.ts";
import {
  iconLinks,
  shareMetadata,
  siteFooterMarkup,
} from "./page-chrome-web.ts";
import { debateCard, statusLabels as labels, topicCard } from "./cards-web.ts";
import { avatarSlot, inscription, searchIcon } from "./kit-web.ts";
import { html, raw, type SafeHtml } from "../../platform/html.ts";
import type {
  PublicDebate,
  PublicList,
  PublicProfile,
  PublicTopic,
} from "./repository.ts";

const path = (value: string) => encodeURIComponent(value);

// The header marks the section a page belongs to, from its canonical path.
function sectionFor(canonical: string): SiteSection | null {
  const path = new URL(canonical, "https://yaparena.invalid").pathname;
  if (path === "/live") return "live";
  if (path === "/match") return "create";
  if (/^\/(debates|topics|people)(\/|$)/.test(path)) return "explore";
  return null;
}

function layout(
  title: string,
  description: string,
  canonical: string,
  content: SafeHtml,
  metadata: SafeHtml | "" = "",
  bodyClass = "",
  emailFirst = false,
  stylesheets: readonly string[] = [],
) {
  const home = bodyClass.startsWith("arena-market-home");
  const reference = bodyClass.includes("reference-home");
  const page = html`${siteHeaderMarkup(sectionFor(canonical))}${
    home
      ? content
      : html`<main id="main">${content}</main>${siteFooterMarkup()}`
  }`;
  return html`<!doctype html><html lang="en"${emailFirst ? " data-email-first" : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000"><title>${title} · YAP Arena</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}">${metadata}${iconLinks()}<link rel="stylesheet" href="${asset("site.css")}"><link rel="stylesheet" href="${asset("arena.css")}"><link rel="stylesheet" href="${asset("site-header.css")}">${stylesheets.map((name) => html`<link rel="stylesheet" href="${asset(name)}">`)}<script defer src="${asset("session-coordination.js")}"></script><script type="module" src="${asset("site-header.js")}"></script><script defer src="${asset("site.js")}"></script><script defer src="${asset("account-balance.js")}"></script>${reference ? "" : html`<script defer src="${asset("measurement.js")}"></script><script type="module" src="${asset("results-notice.js")}"></script>`}${home ? html`<link rel="stylesheet" href="${asset("homepage.css")}"><script defer src="${asset("homepage.bundle.js")}"></script>` : ""}</head><body class="${bodyClass}"><a class="skip-link" href="#main">Skip to content</a>${page}</body></html>`.toString();
}

// The kit's page head: a kicker, the title in Dydema with its emphasised
// words in a visit colour, and a lead (docs/site-design.md).
function pageHead(
  kicker: string,
  title: string,
  emphasis: string,
  lead: string,
) {
  return html`<header class="container page-head kit-reveal"><p class="kicker">${inscription(kicker)}</p><h1 class="page-title">${inscription(title, emphasis)}</h1><p class="page-lead">${lead}</p></header>`;
}

function listSearch(
  action: string,
  id: string,
  label: string,
  placeholder: string,
  query: string,
) {
  return html`<form class="list-search" action="${action}" method="get" role="search"><label class="sr-only" for="${id}">${label}</label><div class="search-pill">${searchIcon}<input class="input" id="${id}" name="q" maxlength="80" value="${query}" placeholder="${placeholder}" enterkeyhint="search"></div><button class="btn btn-secondary" type="submit">Search</button></form>`;
}

// An empty list: the emblem, today's words and a way back to everything.
function emptyList(title: string, text: string, href: string) {
  return html`<div class="state"><img class="state-emblem" src="${asset("landing/yaparena-emblem.png")}" width="2048" height="1715" alt="" loading="lazy" decoding="async"><h3>${inscription(title)}</h3><p>${text}</p><a class="btn btn-secondary" href="${href}">Clear search</a></div>`;
}

// A list with nothing on it yet, inside a page about one topic or person.
const quietState = (title: string, text = "") =>
  html`<div class="state state-quiet"><h3>${inscription(title)}</h3>${text ? html`<p>${text}</p>` : ""}</div>`;

const followButton = (type: "topics" | "people", slug: string) =>
  html`<div class="follow-row"><button class="follow-button btn btn-outline btn-sm" type="button" data-follow-type="${type}" data-follow-slug="${slug}" aria-pressed="false">Follow ${type === "topics" ? "topic" : "person"}</button><span class="follow-message" role="status" aria-live="polite"></span></div>`;

const backLink = (href: string, text: string) =>
  html`<a class="back-link" href="${href}"><span aria-hidden="true">←</span> ${text}</a>`;

function pagination(base: string, list: PublicList<unknown>) {
  const previous = list.pagination.offset > 0;
  const next = list.pagination.hasMore;
  if (!previous && !next) return html``;
  const link = (offset: number, label: SafeHtml) =>
    html`<a class="page-link btn btn-secondary btn-sm" href="${listPath(base, list, offset)}">${label}</a>`;
  return html`<nav class="pagination" aria-label="Pagination">${previous ? link(Math.max(0, list.pagination.offset - list.pagination.limit), html`<span aria-hidden="true">←</span> Previous`) : html`<span></span>`}<span>Page ${Math.floor(list.pagination.offset / list.pagination.limit) + 1}</span>${next ? link(list.pagination.offset + list.pagination.limit, html`Next <span aria-hidden="true">→</span>`) : html`<span></span>`}</nav>`;
}

// The kit's stylesheet for list pages, and the headline font they show first.
const listStyles = ["explore.css"] as const;
const headlineFont = html`<link rel="preload" href="/assets/landing/fonts/headline.woff2" as="font" type="font/woff2" crossorigin>`;

function listPath(
  base: string,
  list: PublicList<unknown>,
  offset = list.pagination.offset,
) {
  const parameters = new URLSearchParams();
  if (list.pagination.limit !== 12)
    parameters.set("limit", String(list.pagination.limit));
  if (offset > 0) parameters.set("offset", String(offset));
  if (!parameters.size) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${parameters}`;
}

export function renderHome(
  origin: string,
  data: HomeData = publicHomepage([], []),
  emailFirst = false,
) {
  return layout(
    "Where ideas move",
    "Follow an idea. Hear both sides. Take a position.",
    `${origin}/home`,
    homepageMarkup(data),
    shareMetadata({
      origin,
      title: "YAP Arena",
      description: "Follow an idea. Hear both sides. Take a position.",
      url: `${origin}/home`,
    }),
    `arena-market-home${data.reference ? " reference-home" : ""}`,
    emailFirst,
  );
}

export function renderLive(
  origin: string,
  debates: PublicDebate[],
  topics: PublicList<PublicTopic>,
) {
  const content = html`${renderFeaturedDebate(debates[0] ?? null, assetRevision)}<section class="container section"><div class="section-heading"><div><span class="eyebrow">01 / THE CONVERSATION</span><h2>Debates to watch</h2></div><a class="text-link" href="/debates">All debates <span aria-hidden="true">↗</span></a></div>${debates.length ? html`<div class="card-grid arena-video-grid">${debates.map((debate) => renderVideoDebateCard(debate, assetRevision))}</div>` : html`<div class="empty-state"><h3>No watchable debates yet.</h3><p>Live debates and ready replays will appear here.</p></div>`}</section><section class="container section"><div class="section-heading"><div><span class="eyebrow">02 / EXPLORE IDEAS</span><h2>Topics in play</h2></div><a class="text-link" href="/topics">All topics <span aria-hidden="true">↗</span></a></div>${topics.items.length ? html`<div class="card-grid">${topics.items.map(topicCard)}</div>` : html`<div class="empty-state"><h3>No public topics yet.</h3><p>Published topics will appear here when they are ready.</p></div>`}</section><section class="container note-band"><span class="eyebrow">ABOUT YAP ARENA</span><p>YAP Arena hosts live video debates you can watch, replay or join. Yap Coins are play money with no cash value, and real funds are unavailable. Listings marked Demo are examples, not real events.</p></section>${debates.length ? html`<script type="module" src="${asset("hero-preview.js")}"></script>` : ""}`;
  return layout(
    "Live",
    "Discover public debates and topics on YAP Arena.",
    `${origin}/live`,
    content,
    shareMetadata({
      origin,
      title: "Live debates",
      description: "Discover public debates and topics on YAP Arena.",
      url: `${origin}/live`,
    }),
    "",
    false,
    // The topic cards; the rest of Live moves onto the kit next.
    listStyles,
  );
}

export function renderDebates(
  origin: string,
  list: PublicList<PublicDebate>,
  query: string,
  status: string,
) {
  // raw() keeps the existing unescaped query separators byte-identical.
  // option is one of the fixed statuses and encodeURIComponent never emits
  // & < > or ", so this fragment cannot leave the attribute.
  const href = (option: string) =>
    html`/debates${raw(`${option === "all" ? "" : `?status=${option}`}${query ? `${option === "all" ? "?" : "&"}q=${encodeURIComponent(query)}` : ""}`)}`;
  const current = (option: string) =>
    status === option ? html` aria-current="page"` : "";
  const label = (option: string) =>
    option === "all" ? "All" : labels[option as PublicDebate["status"]];
  // All, Live, Upcoming and Replay as chips; the rarer statuses under More,
  // which shows the one in use.
  const chips = ["all", "live", "scheduled", "replay"].map(
    (option) =>
      html`<a class="chip"${current(option)} href="${href(option)}">${label(option)}</a>`,
  );
  const more = ["ready", "ended", "void_review", "finalized", "cancelled"];
  const moreCurrent = more.includes(status);
  const filters = html`<nav class="list-filters" aria-label="Debate status"><div class="chips">${chips}</div><details class="more-chip" data-menu><summary class="chip${moreCurrent ? " is-current" : ""}"><span class="sr-only">More statuses${moreCurrent ? ":" : ""}</span><span${moreCurrent ? "" : html` aria-hidden="true"`}>${moreCurrent ? label(status) : "More"}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="more-menu">${more.map((option) => html`<a${current(option)} href="${href(option)}">${label(option)}</a>`)}</div></details></nav>`;
  const base = `/debates${query || status !== "all" ? `?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(status !== "all" ? { status } : {}) })}` : ""}`;
  const content = html`${pageHead("The debate floor", "Find your next", "good argument.", "Upcoming conversations and public debate archives, all in one place.")}<section class="container list-section" aria-labelledby="debates-results"><h2 class="sr-only" id="debates-results">Debates</h2><div class="list-tools">${listSearch("/debates", "debate-search", "Search debates", "Search propositions or topics", query)}${filters}</div>${list.items.length ? html`<div class="list-grid">${list.items.map(debateCard)}</div>` : emptyList("No debates found.", "Try another search or status filter. Only published debates appear here.", "/debates")}${pagination(base, list)}</section>`;
  const canonical = `${origin}${listPath(base, list)}`;
  return layout(
    "Debates",
    "Browse public debates by status and search term.",
    canonical,
    content,
    html`${shareMetadata({
      origin,
      title: "Debates",
      description: "Browse public debates by status and search term.",
      url: canonical,
    })}${headlineFont}`,
    "",
    false,
    listStyles,
  );
}

export function renderTopics(
  origin: string,
  list: PublicList<PublicTopic>,
  query: string,
) {
  const base = `/topics${query ? `?q=${encodeURIComponent(query)}` : ""}`;
  const content = html`${pageHead("The idea index", "Find the question", "worth asking.", "Each topic frames two sides of an ongoing conversation.")}<section class="container list-section" aria-labelledby="topics-results"><h2 class="sr-only" id="topics-results">Topics</h2><div class="list-tools">${listSearch("/topics", "topic-search", "Search topics", "Search an idea", query)}</div>${list.items.length ? html`<div class="list-grid">${list.items.map(topicCard)}</div>` : emptyList("No topics found.", "Try another search. Published topics will appear here.", "/topics")}${pagination(base, list)}</section>`;
  const canonical = `${origin}${listPath(base, list)}`;
  return layout(
    "Topics",
    "Explore public topics on YAP Arena.",
    canonical,
    content,
    html`${shareMetadata({
      origin,
      title: "Topics",
      description: "Explore public topics on YAP Arena.",
      url: canonical,
    })}${headlineFont}`,
    "",
    false,
    listStyles,
  );
}

// Both sides of a topic in one card. With the queue on (Decision 0011), each
// side has its own button; when someone queues on the other side, both get
// 30 seconds to accept. frontend/matchmaking.ts drives the data-queue hooks.
function sidesCard(topic: PublicTopic, matchmaking: boolean) {
  const side = (key: "A" | "B", label: string) => {
    const id = `queue-side-${key.toLowerCase()}`;
    return html`<div class="queue-side"><p class="kicker">${inscription(`Side ${key}`)}</p><p class="side-label" id="${id}">${label}</p>${matchmaking ? html`<button class="btn btn-secondary queue-button" type="button" data-queue-side="${key}" data-side-label="${label}" aria-describedby="${id}">Queue for this side</button>` : ""}</div>`;
  };
  const sides = html`<div class="queue-sides">${side("A", topic.sideALabel)}<span class="vs queue-vs"><span class="sr-only">versus</span><span aria-hidden="true">VS</span></span>${side("B", topic.sideBLabel)}</div>`;
  if (!matchmaking)
    return html`<section class="card queue-card" aria-label="The two sides">${sides}</section>`;
  return html`<section class="card queue-card" data-queue-topic="${topic.slug}" aria-labelledby="queue-heading"><div class="queue-head"><p class="kicker">${inscription("Debate it live")}</p><h2 class="queue-title" id="queue-heading">${inscription("Take a side and get matched")}</h2><p class="queue-help">Pick your side. When someone queues on the other side, you both get 30 seconds to accept, then the debate starts.</p></div>${sides}<div class="queue-notes"><p data-queue-waiting aria-live="polite"></p><p data-queue-note role="status"></p></div></section>`;
}

export function renderTopic(
  origin: string,
  topic: PublicTopic,
  debates: PublicList<PublicDebate>,
  matchmaking = false,
) {
  const content = html`<div class="container topic-hero" data-measure-topic="${topic.id}"><div class="topic-copy">${backLink("/topics", "All topics")}<p class="kicker">${inscription(`Topic${topic.isDemo ? " · Demo" : ""}`)}</p><h1 class="title-serif">${topic.title}</h1><p class="page-lead">${topic.summary}</p>${followButton("topics", topic.slug)}</div>${sidesCard(topic, matchmaking)}</div><section class="container page-section" aria-labelledby="topic-debates"><div class="section-head"><p class="kicker">${inscription("On this topic")}</p><h2 class="section-title" id="topic-debates">${inscription("Debates")}</h2></div>${debates.items.length ? html`<div class="list-grid">${debates.items.map(debateCard)}</div>` : quietState("No public debates on this topic yet.", matchmaking ? "Queue on a side to start the first one." : "")}${pagination(`/topics/${path(topic.slug)}`, debates)}</section>`;
  const canonical = `${origin}${listPath(`/topics/${path(topic.slug)}`, debates)}`;
  return layout(
    topic.title,
    topic.summary,
    canonical,
    content,
    html`${shareMetadata({
      origin,
      title: topic.title,
      description: topic.summary,
      url: canonical,
    })}${headlineFont}`,
    "",
    false,
    listStyles,
  );
}

export function renderDebate(
  origin: string,
  debate: PublicDebate,
  a4Enabled = false,
  activity?: PublicBotActivity | null,
  matchmaking = false,
  liveOutline?: { state: unknown },
) {
  const canonical = `${origin}/debates/${path(debate.slug)}`;
  return layout(
    debate.proposition,
    `Watch and participate in the debate: ${debate.proposition}`,
    canonical,
    renderDebateWorkspace(
      debate,
      a4Enabled,
      asset,
      activity,
      matchmaking,
      liveOutline,
    ),
    // The share tags, then the headline font, preloaded exactly as the landing
    // does, at the unversioned URL site.css resolves, so it downloads once.
    html`${shareMetadata({
      origin,
      title: debate.proposition,
      description: `${debate.topic.title}: ${debate.topic.sideALabel} vs ${debate.topic.sideBLabel}. Watch the video debate on YAP Arena.`,
      url: canonical,
    })}<link rel="preload" href="/assets/landing/fonts/headline.woff2" as="font" type="font/woff2" crossorigin>`,
    "arena-page",
  );
}

export function renderProfile(
  origin: string,
  profile: PublicProfile,
  debates: PublicList<PublicDebate>,
) {
  const content = html`<div class="container person">${backLink("/debates", "All debates")}<header class="person-hero">${avatarSlot(profile.displayName)}<div class="person-id"><p class="kicker">${inscription(`Participant${profile.isDemo ? " · Demo" : ""}`)}</p><h1 class="title-serif">${profile.displayName}</h1><p class="person-handle">@${profile.handle}</p><p class="person-bio${profile.bio ? "" : " muted"}">${profile.bio ? profile.bio : "No public bio yet."}</p>${followButton("people", profile.handle)}</div></header></div><section class="container page-section" aria-labelledby="appearances"><div class="section-head"><p class="kicker">${inscription("Public appearances")}</p><h2 class="section-title" id="appearances">${inscription("Debates")}</h2></div>${debates.items.length ? html`<div class="list-grid">${debates.items.map(debateCard)}</div>` : quietState("No public debates yet.")}${pagination(`/people/${path(profile.handle)}`, debates)}</section>`;
  const description =
    profile.bio ?? `Public profile for ${profile.displayName}.`;
  const canonical = `${origin}${listPath(`/people/${path(profile.handle)}`, debates)}`;
  return layout(
    profile.displayName,
    description,
    canonical,
    content,
    html`${shareMetadata({
      origin,
      title: `${profile.displayName} (@${profile.handle})`,
      description,
      url: canonical,
    })}${headlineFont}`,
    "",
    false,
    listStyles,
  );
}

export function renderAbout(origin: string) {
  const content = html`<section class="container page-intro"><span class="eyebrow accent">ABOUT YAP ARENA</span><h1>Make room for<br><em>the other side.</em></h1><p>YAP Arena is a home for live debates and the ideas that connect them.</p></section><section class="container about-copy"><h2>What you can do</h2><p>Browse topics, watch live video debates and replays, and see who is debating. Sign in to pick your handle, follow people and topics, and queue on a side to debate someone live. Listings marked Demo are fictional examples.</p><p>A listing’s status does not guarantee that video is available or that a result has been decided. Yap Coins are play money with no cash value. Bot activity is synthetic and labeled. Real funds are unavailable.</p><h2 id="measurement">Cookies and usage measurement</h2><p>We set an analytics cookie only if you accept it in the cookie banner. It counts discovery pages, watch time, replay starts, matching, follows, reports and return visits, and may be linked to your signed-in account to separate founder-affiliated activity. We don't store search text, chat text or IP addresses in these measurements. Use Cookie settings in the footer to turn it off and delete your measurements. Raw events and watch sessions are kept for up to 90 days; an unused consent expires after 180 days. Debate completion is counted from public event state without a browser identifier. See the <a href="/cookies">Cookie Policy</a>.</p><a class="button" href="/debates">Explore debates ↗</a></section>`;
  return layout(
    "About",
    "What YAP Arena is and how it works.",
    `${origin}/about`,
    content,
    shareMetadata({
      origin,
      title: "About YAP Arena",
      description: "What YAP Arena is and how it works.",
      url: `${origin}/about`,
    }),
  );
}

export function renderAccount(origin: string, liveOutline = false) {
  return layout(
    "Account",
    "Your profile, security and Yap Coins.",
    `${origin}/account`,
    accountMarkup(asset, liveOutline),
    "",
    "account-page",
    true,
  );
}

// Decision 0011: a direct challenge, now or at one to three proposed times.
const challengeCard = html`<section class="information-card"><span class="eyebrow">02 / CHALLENGE A PERSON</span><h2>Pick an opponent</h2><form id="challenge-create" class="stack-form"><label>Opponent<input name="targetHandle" list="people-options" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search by handle or name" required></label><datalist id="people-options"></datalist><label>Published topic slug<input name="topicSlug" pattern="[a-z0-9][a-z0-9-]{2,79}" required></label><label>Proposition<input name="proposition" minlength="10" maxlength="240" required></label><label>Your side<select name="requestedSide"><option value="A">Side A</option><option value="B">Side B</option></select></label><fieldset class="choice-group"><legend>When</legend><label><input type="radio" name="mode" value="now" checked> Now</label><label><input type="radio" name="mode" value="scheduled"> Propose times</label></fieldset><div class="challenge-times" data-challenge-times hidden><label>First choice, your local time<input name="time1" type="datetime-local"></label><label>Second choice (optional)<input name="time2" type="datetime-local"></label><label>Third choice (optional)<input name="time3" type="datetime-local"></label></div><button class="button" type="submit">Send challenge ↗</button></form><p class="form-note">Now: if they're online, they have 2 minutes to answer; otherwise the challenge waits for them. Proposed times must be 1 hour to 90 days ahead. Unanswered challenges expire after 7 days.</p></section>`;

export function renderMatchmaking(origin: string, matchmaking = false) {
  const content = html`<section class="container page-intro"><span class="eyebrow accent">DEBATE MATCHING</span><h1>Find the<br><em>other side.</em></h1><p>${matchmaking ? "Create a topic or challenge a person. To debate right now, open a topic and queue on a side. A challenge becomes an event when both speakers agree to its proposition, sides, and start time." : "Create a topic, challenge a person, or join an open match request. A request becomes an event when two speakers agree to its proposition, sides, and start time."}</p></section><section class="container section compact match-page"><p id="match-notice" class="notice" role="status" aria-live="polite">Checking your account…</p><div id="match-signed-out" hidden class="information-card"><p>Sign in with a public profile to open or join a debate.</p><a class="button" href="/account?next=%2Fmatch">Sign in ↗</a></div><div id="match-signed-in" hidden><div class="match-grid"><section class="information-card"><span class="eyebrow">01 / START A TOPIC</span><h2>Define both sides</h2><form id="topic-create" class="stack-form"><label>URL slug<input name="slug" pattern="[a-z0-9][a-z0-9-]{2,79}" maxlength="80" required></label><label>Title<input name="title" minlength="5" maxlength="140" required></label><label>Summary<textarea name="summary" minlength="10" maxlength="600" required></textarea></label><label>Side A label<input name="sideALabel" minlength="2" maxlength="80" required></label><label>Side B label<input name="sideBLabel" minlength="2" maxlength="80" required></label><button class="button" type="submit">Create private draft ↗</button></form><ul id="my-topics" class="account-list"></ul></section>${matchmaking ? challengeCard : html`<section class="information-card"><span class="eyebrow">02 / OPEN A REQUEST</span><h2>Set the proposition</h2><form id="request-create" class="stack-form"><label>Type<select name="kind"><option value="queue">Open matchmaking</option><option value="direct">Direct challenge</option></select></label><label>Published topic slug<input name="topicSlug" pattern="[a-z0-9][a-z0-9-]{2,79}" required></label><label>Proposition<input name="proposition" minlength="10" maxlength="240" required></label><label>Your side<select name="requestedSide"><option value="A">Side A</option><option value="B">Side B</option></select></label><label>Opponent handle for direct challenges<input name="targetHandle" pattern="[a-z0-9][a-z0-9-]{2,39}"></label><label>Proposed start, your local time<input name="scheduledAt" type="datetime-local" required></label><button class="button" type="submit">Open request ↗</button></form><p class="form-note">The same platform rules apply to every event. Start times must be 1 hour to 90 days ahead.</p></section>`}</div><div class="match-grid">${matchmaking ? html`<section class="information-card"><span class="eyebrow">DEBATE NOW</span><h2>Live queue</h2><p>Open a <a href="/topics">topic</a> and queue on a side. You are matched with someone on the other side in seconds.</p></section>` : html`<section class="information-card"><span class="eyebrow">OPEN QUEUE</span><h2>Join a debate</h2><ul id="open-queue" class="account-list"></ul></section>`}<section class="information-card"><span class="eyebrow">YOUR ${matchmaking ? "CHALLENGES" : "REQUESTS"}</span><h2>${matchmaking ? "Answer or follow up" : "Challenges and queue"}</h2><ul id="my-requests" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">YOUR EVENTS</span><h2>Debate lifecycle</h2><ul id="my-events" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">NOTIFICATIONS</span><h2>Updates</h2><ul id="match-notifications" class="account-list"></ul></section></div></div></section><script defer src="${asset("matching.js")}"></script>`;
  return layout(
    "Match",
    "Create topics and arrange debates on YAP Arena.",
    `${origin}/match`,
    content,
  );
}

export function renderNotFound(origin: string) {
  return layout(
    "Page not found",
    "This page could not be found.",
    `${origin}/`,
    html`<section class="container page-intro"><span class="eyebrow accent">404 / NO SUCH PAGE</span><h1>Nothing here<br><em>yet.</em></h1><p>The page may have moved or is not public.</p><a class="button" href="/debates">Browse debates ↗</a></section>`,
  );
}

// A search, filter or page number in the link could not be read.
export function renderInvalidRequest(origin: string) {
  return layout(
    "Invalid link",
    "This link has a search, filter or page number that is not valid.",
    `${origin}/debates`,
    html`<section class="container page-intro"><span class="eyebrow accent">400 / INVALID LINK</span><h1>Check the<br><em>link.</em></h1><p>Its search, filter or page number is not valid.</p><a class="button" href="/debates">Browse debates ↗</a></section>`,
  );
}

export function renderUnavailable() {
  return layout(
    "Temporarily unavailable",
    "YAP Arena is temporarily unavailable.",
    "/",
    html`<section class="container page-intro"><span class="eyebrow accent">TEMPORARILY UNAVAILABLE</span><h1>We lost the thread<br><em>for a moment.</em></h1><p>Please try again shortly.</p><a class="button" href="/">Try again ↗</a></section>`,
  );
}

// /coins (founder D3, D4): the balance, open positions, the daily claim and
// history. Purchases and withdrawals appear only where a deployment enables
// their simulation, and Bots mode only while A4 is enabled.
export function renderCoins(origin: string, bots = false) {
  return layout(
    "Yap Coins",
    "Your Yap Coins balance, positions and history.",
    `${origin}/coins`,
    html`<link rel="stylesheet" href="${asset("account-auth.css")}"><section class="container coin-wallet-shell"><div class="coin-wallet-intro"><span class="eyebrow accent">YOUR WALLET</span><h1>Yap <em>Coins.</em></h1><p>The coins you use to answer “Do you agree?” in each speaking turn of a live debate. Play money · no cash value.</p></div><section id="account-wallet" class="coin-wallet" aria-labelledby="coin-wallet-title"><div class="coin-wallet-head"><span class="coin-wallet-symbol" aria-hidden="true">Y</span><h2 id="coin-wallet-title">Your balance</h2></div><p data-coin-wallet-status role="status" aria-live="polite">Checking your balance…</p><div class="coin-wallet-signed-out" data-coin-wallet-signed-out hidden><p>Sign in to see your balance.</p><a class="button" href="/account?next=%2Fcoins">Sign in</a></div><dl class="account-balances" data-coin-wallet-balances hidden><div><dt>Available</dt><dd data-funds="available">—</dd></div><div><dt>In open positions</dt><dd data-funds="held">—</dd></div></dl></section></section>${bots ? html`<section class="container page-intro a4-intro"><span class="eyebrow accent">BOTS MODE · PLAY MONEY</span><h2>Your position.<br><em>Your limit.</em></h2><p>Practice against bots: answer yes or no and set the most you’ll pay per contract. A price is drawn after everyone answers, and each contract pays the share of answers on its side, counting every answer once.</p><p>Bots mode uses separate play coins with no cash value. They never convert to Yap Coins.</p></section><section class="container section compact" data-a4><p data-a4-notice class="notice" role="status" aria-live="polite">Checking your account…</p><div data-a4-login hidden><a class="button" href="/account?next=%2Fcoins">Sign in to use Bots mode →</a></div><div data-a4-content hidden><div class="a4-grid"><section class="information-card"><span class="eyebrow">START OR JOIN</span><h2>Choose your round</h2><form data-a4-create class="stack-form"><label>Debate<select name="debateId" required></select></label><label><input type="checkbox" data-a4-publish> Share my settled Bots + you and Bots-only aggregate results on public charts</label><label>Mode<select name="mode"><option value="mixed">Bots mode + you</option><option value="observer">Bots only · observer</option></select></label><p>Bot runs are private sandboxes with their own play balances. Observer runs cannot accept people. YES endorses the displayed proposition; NO rejects it.</p><details><summary>Round settings</summary><div class="stack-form"><label>Bot population<input name="population" type="number" min="1" max="1000" value="500"></label><label>Bot views<select name="preset"><option value="heterogeneous">Bots with varied views</option><option value="reference">Bots with the same view</option></select></label><label>Random answers<select name="epsilon"><option value="50000">Sometimes (5%)</option><option value="0">Never</option><option value="1000000">Always</option></select></label><label>Fee<select name="feeBps"><option value="0">No fee</option><option value="500">5% of each price</option></select></label><label>Bot contracts<input name="quantity" type="number" min="1" max="100" value="1"></label><label>Periods<select name="periods"><option value="1">Single round</option><option value="3">3 · delayed reveal</option><option value="10">10 · delayed reveal</option></select></label><label>Round duration in seconds<input name="roundSeconds" type="number" min="10" max="3600" value="60"></label><label>Initial bot acceleration<select name="speed"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label>Replay seed · bot-only observer runs<input name="seed" maxlength="80" pattern="[a-zA-Z0-9_-]{1,80}" placeholder="Random if empty"></label></div></details><button class="button" type="submit">Start a new run →</button></form><label>Existing runs<select data-a4-runs><option value="">Select a run</option></select></label><button type="button" data-a4-list>Refresh runs</button></section><section class="information-card"><span class="eyebrow">YOUR PLAY COINS</span><h2 data-a4-balance>Balance</h2><p data-a4-reserved></p><button type="button" data-a4-refill hidden>Get daily play coins for this run</button><p data-a4-funding-policy>Bots mode play coins come with each run.</p><div data-a4-run-summary></div><div data-a4-controls hidden class="a4-controls"><button type="button" data-a4-control="run">Run</button><button type="button" data-a4-control="pause">Pause</button><button type="button" data-a4-control="step">Step / lock next</button><label>Processing speed<select data-a4-speed><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><button type="button" data-a4-control="archive">Archive / new run</button><p>Step locks the next open round immediately. Pause stops opening future windows; existing cutoffs and final reveal time still apply. Speed changes processing, not locked terms.</p></div><form data-a4-submit class="stack-form" hidden><h3>Make a binding submission</h3><label>Your position<select name="side"><option value="YES">YES · endorse the proposition</option><option value="NO">NO · reject the proposition</option></select></label><label>Maximum purchase price in Yap Coins<input name="ceiling" type="text" inputmode="decimal" value="0.50" pattern="(0([.][0-9]{1,6})?|1([.]0{1,6})?)" required></label><label>Number of contracts<input name="quantity" type="number" min="1" max="100" value="10" required></label><p>For NO, a ceiling of 0.78 means a YES-scale floor of 0.22. Quantity determines exposure, not voting weight. No revisions or cancellations after commitment.</p><button class="button" type="submit">Review exact commitment →</button></form></section></div><section class="information-card a4-history"><div class="section-heading"><h2>Rounds and receipts</h2><button type="button" data-a4-refresh>Refresh</button></div><p>Drawn prices are random, not a measure of opinion or of who is right. Results stay hidden until each round is revealed.</p><div data-a4-rounds></div><div class="a4-controls"><button type="button" data-a4-book-prev>Previous orders</button><button type="button" data-a4-book-next>Next orders</button></div><details><summary>Private balance history</summary><div data-a4-history></div><button type="button" data-a4-history-more>More history</button></details><details><summary>How the bots answer</summary><p>Bots with varied views each get a fresh opinion every round; bots with the same view share one. Practice results don’t predict how people will answer.</p><p><a href="${asset("a4-research.json")}">Download the simulation results (JSON)</a>.</p></details></section></div></section><dialog data-a4-review class="information-card" aria-labelledby="a4-review-title"><h2 id="a4-review-title">Review your answer</h2><div data-a4-terms></div><p data-a4-review-notice role="status" aria-live="polite"></p><button type="button" data-a4-commit class="button">Commit these exact terms</button><button type="button" data-a4-cancel>Back</button></dialog><script type="module" src="${asset("a4.js")}"></script>` : ""}<script type="module" src="${asset("account-coins.js")}"></script>`,
  );
}
