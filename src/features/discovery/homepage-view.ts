// /home on the site kit (docs/wide-homepage.md, docs/site-design.md): a
// trending idea card with its outcomes, arguments and chart, a rail with what
// is live and the popular ideas, then Ideas in motion. The browser controller
// (frontend/homepage.ts) re-renders these fragments as the view changes.
import type { HomeData, HomeIdea, HomeDebate } from "./homepage-model.ts";
import { chartGeometry, formatValue } from "./homepage-chart.ts";
import { avatarSlot, inscription, searchIcon } from "./kit-web.ts";
import { pixelMark } from "./pixel-mark.ts";
import { html } from "../../platform/html.ts";

const volume = (m: HomeIdea) =>
  m.vol === null ? "—" : m.vol.toFixed(1) + "k YC";
const price = (m: HomeIdea) =>
  m.price === null ? "—" : m.price.toFixed(2) + " YC";
export const changeText = (m: HomeIdea, today = false) =>
  m.delta === null
    ? ""
    : (m.delta >= 0 ? "↗ " : "↘ ") +
      Math.abs(m.delta) +
      " pp" +
      (today ? " today" : "");
const down = (m: HomeIdea) => ((m.delta ?? 0) < 0 ? "down" : "");
const mark = (m: HomeIdea, size: number) => pixelMark("idea-" + m.id, size);
const chevron = (direction: "left" | "right") =>
  html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}"></path></svg>`;
const versus = html`<span class="vs"><span class="sr-only">versus</span><span aria-hidden="true">VS</span></span>`;
const livePixel = html`<span class="live-pixel" aria-hidden="true"></span>`;
// The idea's own page, or, for sample ideas, its panel in the grid.
const ideaLink = (m: HomeIdea) =>
  m.href
    ? html`href="${m.href}"`
    : html`href="#idea-${m.id}" data-open-idea="${m.id}"`;
const metricLabel = (m: HomeIdea) =>
  m.reference
    ? "Participant endorsement · latest closed round"
    : m.activity
      ? "Synthetic bots + shared participants · settled round"
      : "Topic endorsement history unavailable";

// The trending card's follow control is a bookmark; the expanded idea keeps a
// labelled button. Both keep the shared follow hooks (frontend/site.ts).
export function followMarkup(m: HomeIdea, followed = false, detail = false) {
  const local = m.reference || m.demo;
  const remote = !local && Boolean(m.topicSlug);
  const hooks = html`${detail ? html`data-detail-follow="${m.id}"` : html`id="ya-follow"`} data-idea="${m.id}" ${m.topicSlug && !local ? html`data-follow-type="topics" data-follow-slug="${m.topicSlug}" ${detail ? html`data-follow-compact="true"` : html`data-follow-icon="true"`}` : ""} aria-pressed="${String(followed)}" ${!m.reference && !m.topicSlug ? "disabled" : ""}`;
  const status = remote
    ? html`<span class="follow-message sr-only" role="status"></span>`
    : "";
  if (detail)
    return html`<button class="ya-follow btn btn-outline btn-sm${remote ? " follow-button" : ""}" type="button" ${hooks}>${followed ? "✓ Following" : "+ Follow"}</button>${status}`;
  return html`<button class="ya-follow ya-bookmark${remote ? " follow-button" : ""}" type="button" ${hooks} aria-label="${followed ? "Following this idea" : "Follow this idea"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"></path></svg></button>${status}`;
}

// "Behind the position": up to three arguments as short rows.
export function argumentsMarkup(m: HomeIdea) {
  const rows = m.arguments
    .slice(0, 3)
    .map(
      (a) =>
        html`<li class="trend-arg${a.stance === "against" ? " is-counter" : ""}"><p class="trend-arg-meta"><strong>${a.stance === "against" ? "Counterargument" : "For the idea"}</strong>${a.rate === null ? "" : html` · <span class="num">${formatValue(a.rate)}</span> endorse`}</p><p class="trend-arg-text">${a.text}</p></li>`,
    );
  return html`<section class="trend-args" aria-labelledby="ya-args-title"><h3 class="trend-args-title" id="ya-args-title">${inscription("Behind the position")}</h3>${rows.length ? html`<ul class="trend-arg-list">${rows}</ul>` : html`<p class="trend-args-none">Arguments will appear when they are available.</p>`}</section>`;
}

export function sparkMarkup(m: HomeIdea) {
  if (!m.points.length) return html``;
  const lo = Math.min(...m.points) - 2,
    hi = Math.max(...m.points) + 2;
  const point = (v: number, i: number) =>
    `${(i * 84) / Math.max(1, m.points.length - 1) + 1},${32 - ((v - lo) / (hi - lo)) * 28}`;
  return html`<svg class="ya-spark" viewBox="0 0 86 35" role="img" aria-label="Endorsement trend, now ${formatValue(m.points.at(-1)!)}"><polyline class="ya-spark-line" pathLength="1" points="${m.points.map(point).join(" ")}" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}

const noRounds = html`<span class="ya-cardnone"><strong>No rounds yet</strong> · Participant endorsement appears after the first closed round.</span>`;

export function cardMarkup(m: HomeIdea, expanded = false) {
  return html`<a href="${m.href ?? "#idea-" + m.id}" class="ya-marketcard" data-expand="${m.id}" aria-expanded="${String(expanded)}"${expanded ? html` aria-controls="ya-detail"` : ""}><span class="ya-cardtop"><span class="ya-cardcat">${mark(m, 24)}<span>${m.cat}${m.activity ? " · Synthetic" : m.demo && !m.reference ? " · Demo" : ""}</span></span><span class="ya-cardlive${m.live ? " is-live" : ""}">${m.live ? livePixel : ""}${m.live} live</span></span><span class="ya-cardtitle">${m.title}</span>${m.pct === null ? noRounds : html`<span class="ya-cardmetric"><span><strong class="num">${formatValue(m.pct)}</strong> <span class="ya-change ${down(m)}">${changeText(m)}</span></span>${sparkMarkup(m)}</span><span class="ya-cardlabel">Participant endorsement</span><span class="ya-cardbottom"><span class="num">${volume(m)} · 24h</span><span class="num">${m.activity ? "YES offer" : "YES fill"} ${price(m)}</span></span>`}<span class="ya-cardhint"><span>${expanded ? "Close idea" : html`Explore idea & debates`}</span><span aria-hidden="true">${expanded ? "−" : "+"}</span></span></a>`;
}

const metricButtons = (detail = false) =>
  html`<div class="ya-segments" role="group" aria-label="${detail ? "Expanded chart metric" : "Chart metric"}"><button type="button" data-${detail ? "detail-" : ""}metric="endorsement" aria-pressed="true">Endorsement</button><button type="button" data-${detail ? "detail-" : ""}metric="price" aria-pressed="false">Price</button></div><div class="ya-segments" role="group" aria-label="${detail ? "Expanded chart period" : "Chart period"}">${["1D", "1W", "1M"].map((r) => html`<button type="button" data-${detail ? "detail-" : ""}range="${r}" aria-pressed="${String(r === "1D")}">${r}</button>`)}</div>`;

export function chartMarkup(m: HomeIdea, detail = false) {
  const c = chartGeometry(m, "endorsement", "1D", 800, detail);
  return html`<svg id="ya-${detail ? "detail-" : ""}chart" class="ya-chart" role="img" aria-label="${m.reference ? "Sample participant endorsement over completed rounds" : m.activity ? "Synthetic simulation endorsement history" : "Idea history unavailable"}" viewBox="0 0 ${c.w} ${c.h}">${c.markup}</svg>`;
}

// For and Against with their share, or one block until the first round closes.
function outcomesMarkup(m: HomeIdea) {
  if (m.pct === null)
    return html`<div class="trend-none"><p class="trend-none-title">${inscription("No rounds yet")}</p><p>Participant endorsement appears after the first closed round.</p></div>`;
  return html`<ul class="trend-outcomes" aria-label="Participant endorsement, latest closed round"><li><i class="oc-mark oc-yes" aria-hidden="true"></i><span>For the idea</span><strong class="num" id="ya-value">${formatValue(m.pct)}</strong></li><li><i class="oc-mark oc-no" aria-hidden="true"></i><span>Against</span><strong class="num" id="ya-against">${formatValue(100 - m.pct)}</strong></li></ul><p class="trend-meta"><span id="ya-metric-label">${metricLabel(m)}</span> <span class="ya-change ${down(m)}" id="ya-change">${changeText(m, true)}</span></p>`;
}

const upcoming = (iso: string) => {
  const date = new Date(iso);
  return `Starts ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
};
const debateWhen = (m: HomeIdea, d: HomeDebate) =>
  d.kind === "live"
    ? html`<span class="trend-live">${livePixel}Live${m.viewers ? ` · ${m.viewers} watching` : " now"}</span>`
    : d.kind === "replay"
      ? "Replay ready"
      : d.startsAt
        ? upcoming(d.startsAt)
        : "Upcoming";

// Volume and the latest round, the debaters and one way into the debate.
function footerMarkup(m: HomeIdea) {
  const d = m.debates[0];
  const stats =
    m.vol === null
      ? html`<span>${m.live ? `${m.live} live` : "No rounds yet"}</span>`
      : html`<span class="num">${volume(m)} Vol</span><span>· ${m.people === null ? "—" : m.people + (m.activity ? " endorsements" : " people")}</span><span class="trend-fill">· ${m.activity ? "Shared YES offer" : "Last YES fill"} <span class="num">${price(m)}</span></span>`;
  const cta = d?.href
    ? html`href="${d.href}"`
    : m.href
      ? html`href="${m.href}"`
      : html`href="#idea-${m.id}" data-open-idea="${m.id}"`;
  return html`<footer class="trend-foot"><p class="trend-stats">${stats}</p><div class="trend-arena">${d ? html`<p class="trend-match"><span class="trend-people">${avatarSlot(d.names[0], 24)}<span>${d.names[0]}</span>${versus}${avatarSlot(d.names[1], 24)}<span>${d.names[1]}</span></span><span class="trend-when">${debateWhen(m, d)}</span></p>` : ""}<a class="btn btn-primary btn-sm trend-cta" ${cta}>${d ? "Explore debate" : "Explore topic"}</a></div><p class="trend-signin"><a href="/account">Sign in to take part</a></p></footer>`;
}

// The trending slide's content; the slide element itself stays in place.
export function trendMarkup(m: HomeIdea, followed = false) {
  return html`<header class="trend-head">${mark(m, 48)}<div class="trend-heading"><p class="trend-cat" id="ya-category">${inscription(`${m.cat} · Trending`)}</p><h2 class="trend-title" id="ya-title">${m.href ? html`<a href="${m.href}">${m.title}</a>` : m.title}</h2></div>${followMarkup(m, followed)}</header><div class="trend-body"><div class="trend-left">${outcomesMarkup(m)}${argumentsMarkup(m)}</div><div class="trend-right"><div class="trend-chartbar"><p class="trend-legend"><i aria-hidden="true"></i><span id="ya-legend-name">Endorsement</span> <strong class="num" id="ya-legend">${formatValue(m.pct)}</strong></p><div class="trend-tools">${metricButtons()}</div></div>${chartMarkup(m)}</div></div>${footerMarkup(m)}`;
}

export function detailMarkup(m: HomeIdea, followed = false) {
  const replay = m.debates.filter((d) => d.kind === "replay").length;
  return html`<section class="ya-detail" id="ya-detail" aria-label="Expanded idea: ${m.title}"><div class="ya-detail-inner"><div class="ya-detail-head"><div><p class="ya-eyebrow">${m.cat} / Idea market</p><h3>${m.href ? html`<a href="${m.href}">${m.title}</a>` : m.title}</h3></div><div class="ya-detail-actions">${followMarkup(m, followed, true)}<button type="button" class="ya-close" data-detail-close="true" aria-label="Close expanded idea">×</button></div></div><div class="ya-detail-stats"><div><span id="ya-detail-value" class="ya-big num">${formatValue(m.pct)}</span><span id="ya-detail-change" class="ya-change ${down(m)}">${changeText(m, true)}</span><div id="ya-detail-label" class="ya-metric-label">${metricLabel(m)}</div></div><div class="ya-detail-stat"><small>24h volume</small><span class="num">${volume(m)}</span></div><div class="ya-detail-stat"><small>Latest round</small><span class="num">${m.people === null ? "—" : m.people + " participants"}</span></div><div class="ya-detail-stat"><small>Debates</small>${m.live} live · ${replay} replays</div></div><div class="ya-detail-chartbar">${metricButtons(true)}</div>${chartMarkup(m, true)}<div class="ya-detail-foot"><span>${m.reference ? "Completed rounds" : m.activity ? "Shared synthetic history" : "Topic history unavailable"}</span><span>${m.reference ? "Current round hidden until close · Sample data" : m.activity ? "Seeded bots, opted-in mixed and observer rounds" : "Published live debates and ready recordings"}</span></div></div><div class="ya-debates-area"><div class="ya-debates-heading"><h4>The debates behind this idea</h4><div class="ya-segments" role="group" aria-label="Debate type"><button type="button" data-debate-filter="all" aria-pressed="true">All</button><button type="button" data-debate-filter="live" aria-pressed="false">Live · ${m.live}</button><button type="button" data-debate-filter="replay" aria-pressed="false">Replays · ${replay}</button></div></div><div class="ya-debate-grid" id="ya-debate-grid">${debatesMarkup(m)}</div><div class="ya-player-preview" id="ya-player-preview" hidden></div></div></section>`;
}

export function debatesMarkup(
  m: HomeIdea,
  filter = "all",
  active: string | null = null,
) {
  const entries = m.debates.filter(
    (d) => filter === "all" || d.kind === filter,
  );
  const cards = entries.map(
    (d) =>
      html`<${d.href ? html`a href="${d.href}"` : html`button type="button"`} class="ya-debatecard" ${d.href ? "" : html`data-open-debate="${d.id}" aria-pressed="${String(active === d.id)}"`}><span class="ya-thumbnail"><span class="tag${d.kind === "live" ? " tag-live" : ""}">${d.kind === "live" ? livePixel : ""}${d.kind === "live" ? "Live" : d.kind === "replay" ? "Replay" : "Upcoming"}</span><span class="ya-thumb-people" aria-hidden="true">${avatarSlot(d.names[0], 48)}${avatarSlot(d.names[1], 48)}</span></span><span class="ya-debatecopy"><strong>${d.title}</strong><small>${d.names[0]} vs. ${d.names[1]}</small><small>${d.meta}</small><span class="ya-debate-cta"><span>${d.kind === "live" ? "Open live debate" : d.kind === "replay" ? "Open replay" : "View debate"}</span><span aria-hidden="true">→</span></span></span></${d.href ? "a" : "button"}>`,
  );
  return cards.length
    ? html`${cards}`
    : html`<p class="ya-empty">No playable debates in this view yet.</p>`;
}

export function playerMarkup(m: HomeIdea, d: HomeDebate) {
  return html`<div class="ya-player-head"><div><p class="ya-eyebrow">${d.kind === "live" ? "Live debate" : "Replay"} · ${d.stamp}</p><strong>${d.title}</strong></div><button type="button" class="ya-close" data-player-close="true" aria-label="Close debate preview">×</button></div><div class="ya-argument-pair"><div class="ya-argument"><small>FOR · ${d.names[0]}</small>${m.yes}</div><div class="ya-argument against"><small>AGAINST · ${d.names[1]}</small>${m.no}</div></div><div class="ya-player-footer"><span>Concept preview · Sample arguments${d.kind === "replay" ? " · Recording not attached" : ""}</span>${d.kind === "live" ? html`<button type="button" class="btn btn-secondary btn-sm" data-inline-enter="true">Enter this round</button>` : ""}</div><div class="ya-inline-round" id="ya-inline-round" hidden><div class="ya-inline-fields"><label class="ya-field">Your position<select id="ya-inline-position" class="input"><option>YES</option><option>NO</option></select></label><label class="ya-field">Expected YES endorsement (%)<input class="input" type="number" id="ya-inline-expectation" value="55" min="0" max="100" required></label><label class="ya-field">Number of contracts<input class="input" type="number" id="ya-inline-quantity" value="10" min="1" max="1000" step="1" required></label></div><button type="button" class="btn btn-primary btn-sm" data-inline-review="true">Preview position</button><div id="ya-inline-review" aria-live="polite"></div></div>`;
}

// The current idea is three lit pixels in the visit's colours.
export function dotsMarkup(ideas: HomeIdea[], selected: string) {
  return html`${ideas.map(
    (m) =>
      html`<button type="button" class="ya-carousel-dot" data-trending="${m.id}" aria-label="Show ${m.title}" aria-current="${String(m.id === selected)}"><span class="ya-dot-pixels" aria-hidden="true"><i></i><i></i><i></i></span></button>`,
  )}`;
}

// Previous and next, named after the neighbouring ideas.
export function navMarkup(ideas: HomeIdea[], selected: string) {
  const i = Math.max(
    0,
    ideas.findIndex((m) => m.id === selected),
  );
  const previous = ideas[(i + ideas.length - 1) % ideas.length];
  const next = ideas[(i + 1) % ideas.length];
  const disabled = ideas.length < 2 ? " disabled" : "";
  return html`<button type="button" class="ya-nav-pill" data-carousel="previous" aria-label="Previous idea: ${previous?.title ?? ""}"${disabled}>${chevron("left")}<span>${previous?.title ?? ""}</span></button><button type="button" class="ya-nav-pill" data-carousel="next" aria-label="Next idea: ${next?.title ?? ""}"${disabled}><span>${next?.title ?? ""}</span>${chevron("right")}</button>`;
}

// What is live now, one invitation and the ideas with the most coins traded.
export function railMarkup(data: HomeData) {
  const live = data.ideas
    .flatMap((m) =>
      m.debates.filter((d) => d.kind === "live").map((d) => ({ m, d })),
    )
    .at(0);
  const popular = [...data.ideas]
    .sort((a, b) => (b.vol ?? -1) - (a.vol ?? -1) || b.live - a.live)
    .slice(0, 5);
  const watch = live?.d.href
    ? html`href="${live.d.href}"`
    : live
      ? ideaLink(live.m)
      : "";
  return html`${live ? html`<section class="card rail-live" aria-labelledby="ya-live-title"><p class="rail-live-top"><span class="tag tag-live">${livePixel}Live</span>${live.m.viewers ? html`<span>${live.m.viewers} watching</span>` : ""}</p><h2 class="rail-live-title" id="ya-live-title"><a ${watch}>${live.d.title}</a></h2><p class="rail-live-people">${live.d.names[0]} vs ${live.d.names[1]}</p><a class="btn btn-secondary btn-sm" ${watch} aria-label="Watch: ${live.d.title}">Watch</a></section>` : ""}<section class="card rail-promo rail-promo-member" aria-labelledby="ya-promo-member"><h2 class="rail-title" id="ya-promo-member">${inscription("Take a side")}</h2><p>Open a topic and queue on a side. You are matched with someone on the other side in seconds.</p><a class="btn btn-secondary btn-sm" href="/topics">Browse topics</a></section><section class="card rail-promo rail-promo-guest" aria-labelledby="ya-promo-guest"><h2 class="rail-title" id="ya-promo-guest">${inscription("Join the arena")}</h2><p>Sign in to follow ideas, take a side and debate live.</p><a class="btn btn-secondary btn-sm" href="/account">Sign in</a></section><section class="rail-popular" aria-labelledby="ya-popular-title"><h2 class="rail-title" id="ya-popular-title">${inscription("Popular ideas")}</h2><ol class="rail-popular-list">${popular.map((m, i) => html`<li><a ${ideaLink(m)}><span class="rail-rank num">${i + 1}</span><span class="rail-pop"><span class="rail-pop-name">${m.title}</span><span class="rail-pop-vol">${m.vol !== null ? html`<span class="num">${volume(m)}</span> · 24h` : m.live ? html`${livePixel}${m.live} live` : "No rounds yet"}</span></span>${chevron("right")}</a></li>`)}</ol></section><a class="btn btn-outline rail-all" href="#ya-ideas">Explore all ideas</a>`;
}

export function filtersMarkup(data: HomeData) {
  const categories = data.reference
    ? ["Technology", "Society", "Economy", "Climate"]
    : [...new Set(data.ideas.map((m) => m.cat))];
  return html`${["All", ...categories].map(
    (c) =>
      html`<button class="chip ya-filter" data-filter="${c}" aria-pressed="${String(c === "All")}" type="button">${c === "All" ? "All ideas" : c}</button>`,
  )}`;
}

// No ideas at all: the kit's empty or error state instead of the page.
function emptyMarkup(data: HomeData) {
  return data.available
    ? html`<div class="state home-state"><h2>${inscription("No public ideas yet.")}</h2><p>Published topics and their debates will appear here.</p><a class="btn btn-secondary" href="/topics">Explore topics</a></div>`
    : html`<div class="state home-state"><h2>${inscription("Discovery temporarily unavailable.")}</h2><p>Try again shortly.</p><div class="home-state-actions"><a class="btn btn-secondary" href="/home">Try again</a><a class="btn btn-outline" href="/topics">Explore topics</a></div></div>`;
}

export function homepageMarkup(data: HomeData) {
  const first = data.ideas[0];
  const heading = data.reference
    ? html`<div class="ya-heading"><div><h1>Where ideas move.</h1><p>Follow an idea. Hear both sides. Take a position.</p></div><span class="tag ya-concept">Concept · Sample data</span></div>`
    : html`<h1 class="sr-only">Yap Arena</h1>`;
  if (!first)
    return html`<div id="ya-market-v4" data-reference="${String(data.reference)}"><main id="main" class="ya-content container">${heading}${emptyMarkup(data)}</main></div>`;
  return html`<div id="ya-market-v4" data-reference="${String(data.reference)}">
  <main id="main" class="ya-content container">
    ${heading}
    <div class="home-top">
    <section class="ya-carousel" id="ya-carousel" aria-label="Trending ideas" aria-roledescription="carousel">
    <div class="ya-carousel-window" id="ya-carousel-window"><article class="card trend" id="ya-trending-slide" aria-roledescription="slide" aria-label="1 of ${data.ideas.length}: ${first.title}">${trendMarkup(first, data.following.includes(first.id))}</article></div>
    <div class="ya-carousel-controls"><div class="ya-carousel-dots" id="ya-carousel-dots" role="group" aria-label="Choose trending idea">${dotsMarkup(data.ideas, first.id)}</div><div class="ya-carousel-nav" id="ya-carousel-nav">${navMarkup(data.ideas, first.id)}</div></div>
    </section>
    <aside class="home-rail" id="ya-rail" aria-label="Live now and popular ideas">${railMarkup(data)}</aside>
    </div>
    <section class="ya-discovery" id="ya-ideas" aria-labelledby="ya-grid-title"><div class="ya-sectionhead"><h2 class="section-title" id="ya-grid-title" tabindex="-1">${inscription("Ideas in motion")}</h2><label class="sr-only" for="ya-sort">Sort ideas</label><select class="input ya-sort" id="ya-sort"><option value="active">Most active</option><option value="moves">Biggest shifts</option></select></div><div class="ya-discovery-tools"><div class="ya-view-tabs ya-segments" role="group" aria-label="Ideas view"><button type="button" data-nav="all" aria-pressed="true">All ideas</button><button type="button" data-nav="following" aria-pressed="false">Following</button></div><div class="chips ya-filters" role="group" aria-label="Idea categories">${filtersMarkup(data)}</div><form class="ya-idea-search search-pill" action="/topics" method="get" role="search" aria-label="Search ideas">${searchIcon}<label class="sr-only" for="ya-search">Search ideas</label><input class="input" id="ya-search" name="q" type="search" placeholder="Search ideas…" maxlength="80"></form></div><div class="ya-grid" id="ya-grid">${data.ideas.map((m) => cardMarkup(m))}</div><p class="ya-endnote">Endorsement = share of participants choosing YES in the latest closed round. ${data.reference ? "YC = Yap Coins · All activity is illustrative." : "Synthetic activity is labeled."}</p></section>
    <div id="ya-chart-tooltip" class="ya-chart-tooltip" role="tooltip" aria-hidden="true"><span data-tip-date></span> <strong></strong></div>
    <div id="ya-status" aria-live="polite" class="sr-only"></div>
  <noscript><p class="ya-endnote">Idea links open their public topic pages. Enable JavaScript for inline charts, filters and previews.</p></noscript></main>
</div>
<template id="ya-home-data">${JSON.stringify(data)}</template>`;
}
