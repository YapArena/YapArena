import type { HomeData, HomeIdea, HomeDebate } from "./homepage-model.ts";
import { emptyIdea } from "./homepage-model.ts";
import { chartGeometry, formatValue } from "./homepage-chart.ts";
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
export function followMarkup(m: HomeIdea, followed = false, detail = false) {
  const local = m.reference || m.demo;
  const remote = !local && Boolean(m.topicSlug);
  return html`<button class="ya-follow${remote ? " follow-button" : ""}" type="button" ${detail ? html`data-detail-follow="${m.id}"` : html`id="ya-follow"`} data-idea="${m.id}" ${m.topicSlug && !local ? html`data-follow-type="topics" data-follow-slug="${m.topicSlug}" data-follow-compact="true"` : ""} aria-pressed="${String(followed)}" ${!m.reference && !m.topicSlug ? "disabled" : ""}>${followed ? "✓ Following" : "+ Follow"}</button>${!remote ? "" : html`<span class="follow-message sr-only" role="status"></span>`}`;
}
export function argumentsMarkup(m: HomeIdea) {
  const entries = m.arguments.length
    ? m.arguments
    : [
        {
          stance: "for",
          text: "Arguments will appear when they are available.",
          rate: null,
        },
      ];
  const rows = entries.map(
    (a) =>
      html`<li class="ya-argument-item"><div class="ya-argument-stance ${a.stance === "against" ? "against" : ""}">${a.stance === "against" ? "COUNTERARGUMENT" : "FOR THE IDEA"}</div><p class="ya-argument-text">${a.text}</p><div class="ya-argument-endorsement"><span>Endorse this argument</span><strong>${formatValue(a.rate)}</strong></div><div class="ya-argument-meter" aria-hidden="true"><span style="width:${a.rate ?? 0}%"></span></div></li>`,
  );
  return html`<ul class="ya-argument-list">${rows}</ul><ul class="ya-argument-list" aria-hidden="true" inert>${rows}</ul>`;
}
export function sparkMarkup(m: HomeIdea) {
  if (!m.points.length)
    return html`<svg class="ya-spark" viewBox="0 0 86 35" role="img" aria-label="History unavailable"><path d="M1 18H85" stroke="var(--ya-line)" stroke-dasharray="3 4"/></svg>`;
  const lo = Math.min(...m.points) - 2,
    hi = Math.max(...m.points) + 2;
  const color = "var(--ya-chart)",
    endX = ((m.points.length - 1) * 84) / Math.max(1, m.points.length - 1) + 1,
    endY = 32 - ((m.points.at(-1)! - lo) / (hi - lo)) * 28;
  return html`<svg class="ya-spark" viewBox="0 0 86 35" role="img" aria-label="Sample endorsement trend"><polyline class="ya-spark-line" pathLength="1" points="${m.points.map((v, i) => (i * 84) / Math.max(1, m.points.length - 1) + 1 + "," + (32 - ((v - lo) / (hi - lo)) * 28)).join(" ")}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><g class="ya-endpoint" aria-hidden="true"><circle class="ya-endpoint-pulse" cx="${endX}" cy="${endY}" r="2" fill="${color}"/><circle cx="${endX}" cy="${endY}" r="2" fill="${color}"/></g></svg>`;
}
export function cardMarkup(m: HomeIdea, expanded = false) {
  return html`<a href="${m.href ?? "#idea-" + m.id}" class="ya-marketcard" data-expand="${m.id}" aria-expanded="${String(expanded)}"${expanded ? html` aria-controls="ya-detail"` : ""}><span class="ya-cardtop"><span>${m.cat}${m.activity ? " · Synthetic" : m.demo && !m.reference ? " · Demo" : ""}</span><span>● ${m.live} live</span></span><span class="ya-cardtitle">${m.title}</span><span class="ya-cardmetric"><span><strong>${formatValue(m.pct)}</strong> <span class="${down(m)}">${changeText(m)}</span></span>${sparkMarkup(m)}</span><span class="ya-cardlabel">Participant endorsement</span><span class="ya-cardbottom"><span>${volume(m)} · 24h</span><span>${m.activity ? "YES offer" : "YES fill"} ${price(m)}</span></span><span class="ya-cardhint"><span>${expanded ? "Close idea" : html`Explore idea & debates`}</span><span aria-hidden="true">${expanded ? "−" : "+"}</span></span></a>`;
}
const metricButtons = (detail = false, synthetic = false) =>
  html`<div class="ya-segments" aria-label="${detail ? "Expanded chart metric" : "Chart metric"}"><button type="button" data-${detail ? "detail-" : ""}metric="endorsement" aria-pressed="true">Endorsement</button><button type="button" data-${detail ? "detail-" : ""}metric="price" aria-pressed="false">${synthetic ? "Offered price" : "Execution price"}</button></div><div class="ya-segments" aria-label="${detail ? "Expanded chart period" : "Chart period"}">${["1D", "1W", "1M"].map((r) => html`<button type="button" data-${detail ? "detail-" : ""}range="${r}" aria-pressed="${String(r === "1D")}">${r}</button>`)}</div>`;
export function chartMarkup(m: HomeIdea, detail = false) {
  const c = chartGeometry(m, "endorsement", "1D", 800, detail);
  return html`<svg id="ya-${detail ? "detail-" : ""}chart" class="ya-chart" role="img" aria-label="${m.reference ? "Sample participant endorsement over completed rounds" : m.activity ? "Synthetic simulation endorsement history" : "Idea history unavailable"}" viewBox="0 0 ${c.w} ${c.h}">${c.markup}</svg>`;
}
export function featureMarkup(m: HomeIdea, followed = false) {
  return html`<div class="ya-feature-top"><div class="ya-eyebrow"><span class="ya-dot"></span><span id="ya-category">${m.cat} · Trending</span></div>${followMarkup(m, followed)}</div><h2 id="ya-title">${m.title}</h2><div class="ya-metricrow"><div><div><span class="ya-big" id="ya-value">${formatValue(m.pct)}</span><span class="ya-change ${down(m)}" id="ya-change">${changeText(m, true)}</span></div><div class="ya-metric-label" id="ya-metric-label">${m.reference ? "Participant endorsement · latest closed round" : m.activity ? "Synthetic bots + shared participants · settled round" : "Topic endorsement history unavailable"}</div></div><div class="ya-smallstats"><div><span>24h volume</span><strong id="ya-volume">${volume(m)}</strong></div><div><span>Latest round</span><strong id="ya-people">${m.people === null ? "—" : m.people + (m.activity ? " endorsements" : " people")}</strong></div><div><span>${m.activity ? "Shared YES offer" : "Last YES fill"}</span><strong id="ya-price">${price(m)}</strong></div></div></div><div class="ya-chartbar">${metricButtons(false, Boolean(m.activity))}</div>${chartMarkup(m)}<div class="ya-chart-footer"><button type="button" class="ya-event" id="ya-chart-debate" ${m.reference || m.debates.length ? "" : "disabled"}>${m.reference ? "↗ Explore the debate at 14:00" : "↗ Explore this idea’s debates"}</button><span>${m.reference ? "Current round hidden until close" : m.activity ? "Synthetic results · Pending rounds hidden" : "No topic market history available"}</span></div>`;
}
export function detailMarkup(m: HomeIdea, followed = false) {
  const replay = m.debates.filter((d) => d.kind === "replay").length;
  return html`<section class="ya-detail" id="ya-detail" aria-label="Expanded idea: ${m.title}"><div class="ya-detail-inner"><div class="ya-detail-head"><div><div class="ya-eyebrow">${m.cat} / Idea market</div><h2>${m.href ? html`<a href="${m.href}">${m.title}</a>` : m.title}</h2></div><div class="ya-detail-actions">${followMarkup(m, followed, true)}<button type="button" class="ya-close" data-detail-close="true" aria-label="Close expanded idea">×</button></div></div><div class="ya-detail-stats"><div><span id="ya-detail-value" class="ya-big">${formatValue(m.pct)}</span><span id="ya-detail-change" class="ya-change ${down(m)}">${changeText(m, true)}</span><div id="ya-detail-label" class="ya-metric-label">${m.reference ? "Participant endorsement · latest closed round" : m.activity ? "Synthetic bots + shared participants · settled round" : "Topic endorsement history unavailable"}</div></div><div class="ya-detail-stat"><small>24h volume</small>${volume(m)}</div><div class="ya-detail-stat"><small>Latest round</small>${m.people === null ? "—" : m.people + " participants"}</div><div class="ya-detail-stat"><small>Debates</small>${m.live} live · ${replay} replays</div></div><div class="ya-detail-chartbar">${metricButtons(true, Boolean(m.activity))}</div>${chartMarkup(m, true)}<div class="ya-detail-foot"><span>${m.reference ? "● Completed rounds" : m.activity ? "● Shared synthetic history" : "Topic history unavailable"}</span><span>${m.reference ? "Current round hidden until close · Sample data" : m.activity ? "Seeded bots, opted-in mixed and observer rounds" : "Published live debates and ready recordings"}</span></div></div><div class="ya-debates-area"><div class="ya-debates-heading"><h3>The debates behind this idea</h3><div class="ya-segments" aria-label="Debate type"><button type="button" data-debate-filter="all" aria-pressed="true">All</button><button type="button" data-debate-filter="live" aria-pressed="false">Live · ${m.live}</button><button type="button" data-debate-filter="replay" aria-pressed="false">Replays · ${replay}</button></div></div><div class="ya-debate-grid" id="ya-debate-grid">${debatesMarkup(m)}</div><div class="ya-player-preview" id="ya-player-preview" hidden></div></div></section>`;
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
      html`<${d.href ? html`a href="${d.href}"` : html`button type="button"`} class="ya-debatecard" ${d.href ? "" : html`data-open-debate="${d.id}" aria-pressed="${String(active === d.id)}"`}><span class="ya-thumbnail ${d.kind === "replay" ? "ya-replay" : ""}"><span class="ya-thumb-top"><span class="${d.kind === "live" ? "ya-badge-live" : "ya-badge-replay"}">${d.kind === "live" ? "● LIVE" : d.kind === "replay" ? "↺ REPLAY" : "UPCOMING"}</span><span>${d.stamp}</span></span><span class="ya-thumb-people"><span class="ya-thumb-person">${d.names[2]}</span><span>VS</span><span class="ya-thumb-person">${d.names[3]}</span></span></span><span class="ya-debatecopy"><strong>${d.title}</strong><small>${d.names[0]} vs. ${d.names[1]}</small><small>${d.meta}</small><span class="ya-debate-cta"><span>${d.kind === "live" ? "Open live debate" : d.kind === "replay" ? "Open replay" : "View debate"}</span><span aria-hidden="true">↗</span></span></span></${d.href ? "a" : "button"}>`,
  );
  return cards.length
    ? html`${cards}`
    : html`<p class="ya-empty">No playable debates in this view yet.</p>`;
}
export function sideMarkup(m: HomeIdea, side = "live", position = "YES") {
  const d = m.debates[0];
  if (!m.reference)
    return html`<div class="ya-side-title">In the arena <span class="ya-live">${d ? d.kind.toUpperCase() : "UPCOMING"}</span></div><div class="ya-arena"><div class="ya-speaker"><div class="ya-person">${d?.names[2] ?? "A"}</div>${d?.names[0] ?? "Speaker A"}<small>FOR THE IDEA</small></div><span class="ya-vs">VS</span><div class="ya-speaker"><div class="ya-person ya-against">${d?.names[3] ?? "B"}</div>${d?.names[1] ?? "Speaker B"}<small>AGAINST</small></div></div><div class="ya-debate-title">${d?.title ?? m.short}</div><div class="ya-audience">${d ? "Published " + d.kind : "No playable debate yet"}</div><a class="ya-primary" href="${d?.href ?? m.href ?? "/debates"}">${d ? "Explore debate" : "Explore topic"} <span aria-hidden="true">↗</span></a><a class="ya-secondary" href="${d?.href ?? "/match"}">${d ? "Enter round" : "Create a debate"}</a><div class="ya-round"><span>Participation</span><strong>${d ? "Open the debate" : "Not open"}</strong></div><p class="ya-note">${m.activity ? "Synthetic simulation · Includes shared bot-only and Bots + you results." : "Topic-level market data is unavailable. Debate participation uses its own published rules."}</p>`;
  if (side === "debate")
    return html`<button type="button" class="ya-back" data-action="live">← Back to arena</button><div class="ya-side-title">The debate <span class="ya-live">ROUND 04</span></div><div class="ya-debate-title">${m.short}</div><div class="ya-argument"><small>FOR · Jordan D.</small>${m.yes}</div><div class="ya-argument against"><small>AGAINST · Sam R.</small>${m.no}</div><button class="ya-primary" data-action="trade" type="button">Take a position</button><p class="ya-note">Sample arguments · Opening the debate keeps the market in view.</p>`;
  if (side === "trade")
    return html`<button type="button" class="ya-back" data-action="live">← Back to arena</button><div class="ya-side-title">Enter the round <span class="ya-live">YAP COINS</span></div><div class="ya-debate-title">${m.title}</div><div class="ya-field">Your position<div class="ya-position"><button type="button" data-position="YES" aria-pressed="${String(position === "YES")}">YES</button><button type="button" data-position="NO" aria-pressed="${String(position === "NO")}">NO</button></div></div><label class="ya-field">Expected YES endorsement (%)<input id="ya-expectation" type="number" value="55" min="0" max="100" step="1" required></label><label class="ya-field">Number of contracts<input id="ya-quantity" type="number" value="10" min="1" max="1000" step="1" required></label><button class="ya-primary" type="button" data-action="review">Preview position</button><div id="ya-review" aria-live="polite"></div><p class="ya-note">Interaction preview only. No order is submitted.</p>`;
  return html`<div class="ya-side-title">In the arena <span class="ya-live"><span class="ya-dot"></span>LIVE</span></div><div class="ya-arena"><div class="ya-speaker"><div class="ya-person">JD</div>Jordan D.<small>FOR THE IDEA</small></div><span class="ya-vs">VS</span><div class="ya-speaker"><div class="ya-person ya-against">SR</div>Sam R.<small>AGAINST</small></div></div><div class="ya-debate-title">${m.short}</div><div class="ya-audience">${m.viewers} watching · Round 04</div><button class="ya-primary" data-action="debate" type="button">Explore debate <span aria-hidden="true">↗</span></button><button class="ya-secondary" data-action="trade" type="button">Enter round</button><div class="ya-round"><span>Participation</span><strong>Round open</strong></div>`;
}
export function playerMarkup(m: HomeIdea, d: HomeDebate) {
  return html`<div class="ya-player-head"><div><div class="ya-eyebrow">${d.kind === "live" ? "Live debate" : "Replay"} · ${d.stamp}</div><strong>${d.title}</strong></div><button type="button" class="ya-close" data-player-close="true" aria-label="Close debate preview">×</button></div><div class="ya-argument-pair"><div class="ya-argument"><small>FOR · ${d.names[0]}</small>${m.yes}</div><div class="ya-argument against"><small>AGAINST · ${d.names[1]}</small>${m.no}</div></div><div class="ya-player-footer"><span>Concept preview · Sample arguments${d.kind === "replay" ? " · Recording not attached" : ""}</span>${d.kind === "live" ? html`<button type="button" class="ya-secondary" data-inline-enter="true">Enter this round</button>` : ""}</div><div class="ya-inline-round" id="ya-inline-round" hidden><div class="ya-inline-fields"><label class="ya-field">Your position<select id="ya-inline-position" class="ya-sort"><option>YES</option><option>NO</option></select></label><label class="ya-field">Expected YES endorsement (%)<input type="number" id="ya-inline-expectation" value="55" min="0" max="100" required></label><label class="ya-field">Number of contracts<input type="number" id="ya-inline-quantity" value="10" min="1" max="1000" step="1" required></label></div><button type="button" class="ya-primary" data-inline-review="true">Preview position</button><div id="ya-inline-review" aria-live="polite"></div></div>`;
}

export function tickerMarkup(ideas: HomeIdea[]) {
  if (!ideas.some((m) => m.reference)) {
    const entries = (copy = false) =>
      ideas.map((m) => {
        const tag = copy ? "span" : "button";
        return html`<${tag}${copy ? "" : html` type="button"`} class="ya-tick" data-select="${m.id}" title="${m.title}"><strong>${m.title}</strong><span class="${(m.delta ?? 0) < 0 ? "ya-down" : ""}">${formatValue(m.pct)} ${changeText(m)}</span></${tag}>`;
      });
    return html`<div class="ya-ticker ya-ticker-marquee" data-static="${String(ideas.length < 2)}" aria-label="Changes in participant endorsement">${ideas.length ? html`<div class="ya-ticker-track"><div class="ya-ticker-group">${entries()}</div>${ideas.length < 2 ? "" : html`<div class="ya-ticker-group" aria-hidden="true">${entries(true)}</div>`}</div>` : ""}</div>`;
  }
  const labels = [
    "OPEN-SOURCE AI",
    "4-DAY WEEK",
    "NUCLEAR ENERGY",
    "BASIC INCOME",
  ];
  return html`<div class="ya-ticker" aria-label="Changes in participant endorsement">${ideas
    .slice(0, 4)
    .map(
      (m, i) =>
        html`<button type="button" class="ya-tick" data-select="${m.id}"><strong>${m.reference ? labels[i] : m.title}</strong><span class="${(m.delta ?? 0) < 0 ? "ya-down" : ""}">${formatValue(m.pct)} ${changeText(m)}</span></button>`,
    )}</div>`;
}
export function dotsMarkup(ideas: HomeIdea[], selected: string) {
  return html`${ideas.map(
    (m) =>
      html`<button type="button" class="ya-carousel-dot" data-trending="${m.id}" aria-label="Show ${m.title}" aria-current="${String(m.id === selected)}"><span class="ya-dot-track" aria-hidden="true"><span class="ya-dot-fill"></span></span></button>`,
  )}`;
}
export function filtersMarkup(data: HomeData) {
  const categories = data.reference
    ? ["Technology", "Society", "Economy", "Climate"]
    : [...new Set(data.ideas.map((m) => m.cat))];
  return html`${["All", ...categories].map(
    (c) =>
      html`<button class="ya-filter" data-filter="${c}" aria-pressed="${String(c === "All")}" type="button">${c === "All" ? "All ideas" : c}</button>`,
  )}`;
}
export function homepageMarkup(data: HomeData) {
  const first = data.ideas[0] ?? emptyIdea;
  return html`<div id="ya-market-v4" data-reference="${String(data.reference)}">
${tickerMarkup(data.ideas)}
  <main id="main" class="ya-content">
    ${data.reference ? html`<div class="ya-heading"><div><h1>Where ideas move.</h1><p>Follow an idea. Hear both sides. Take a position.</p></div><span class="ya-concept">Concept · Sample data</span></div>` : html`<h1 class="sr-only">Yap Arena</h1>`}
    <section class="ya-carousel" id="ya-carousel" aria-label="Trending ideas" aria-roledescription="carousel">
    <div class="ya-carousel-window" id="ya-carousel-window"><div class="ya-layout" id="ya-trending-slide" aria-roledescription="slide" aria-label="${data.ideas.length ? "1" : "0"} of ${data.ideas.length}: ${first.title}">
      <aside class="ya-arguments" id="ya-arguments" aria-label="Arguments behind the trending idea"><div class="ya-arguments-head"><h3>Behind the position</h3><button type="button" class="ya-arguments-toggle cursor-interaction" id="ya-arguments-toggle" aria-label="Pause argument flow" aria-pressed="false">Ⅱ</button></div><div class="ya-arguments-window" tabindex="0" role="region" aria-label="Argument stream. Scroll or use arrow keys to browse."><div class="ya-argument-track" id="ya-argument-track" data-idea="${first.id}">${argumentsMarkup(first)}</div></div><div class="ya-arguments-foot">${data.reference ? "Independent endorsement · Sample data" : first.activity ? "Independent endorsements · Synthetic bots" : "Argument endorsements unavailable"}</div></aside>
      <section class="ya-feature" aria-label="Selected idea">${featureMarkup(first, data.following.includes(first.id))}</section>
      <aside class="ya-side" id="ya-side" aria-label="Debate and participation">${sideMarkup(first)}</aside>
    </div>
    </div><div class="ya-carousel-controls"><div class="ya-carousel-dots" id="ya-carousel-dots" aria-label="Choose trending idea">${dotsMarkup(data.ideas, first.id)}</div><div class="ya-carousel-nav"><span class="ya-carousel-count" id="ya-carousel-count">${data.ideas.length ? "1" : "0"} / ${data.ideas.length}</span><button type="button" class="cursor-interaction" data-carousel="previous" aria-label="Previous trending idea">←</button><button type="button" class="cursor-interaction" data-carousel="pause" id="ya-carousel-pause" aria-label="Pause trending rotation" aria-pressed="false">Ⅱ</button><button type="button" class="cursor-interaction" data-carousel="next" aria-label="Next trending idea">→</button></div></div></section>
    <section class="ya-discovery" aria-label="Discover ideas"><div class="ya-sectionhead"><h3 id="ya-grid-title">Ideas in motion</h3><select class="ya-sort cursor-interaction" id="ya-sort" aria-label="Sort ideas"><option value="active">Most active</option><option value="moves">Biggest shifts</option></select></div><div class="ya-discovery-tools"><div class="ya-view-tabs" aria-label="Ideas view"><button type="button" data-nav="all" aria-pressed="true">All ideas</button><button type="button" data-nav="following" aria-pressed="false">Following</button></div><form class="ya-idea-search" action="/topics" method="get" role="search" aria-label="Search ideas"><label class="sr-only" for="ya-search">Search ideas</label><input id="ya-search" name="q" type="search" placeholder="Search ideas…" maxlength="80"></form></div><div class="ya-filters" aria-label="Idea categories">${filtersMarkup(data)}</div><div class="ya-grid" id="ya-grid">${data.ideas.length ? data.ideas.map((m) => cardMarkup(m)) : html`<p class="ya-empty">${data.available ? "No public ideas yet." : "Discovery temporarily unavailable. Try again shortly."} <a href="/topics">Explore topics</a>.</p>`}</div></section>
    <footer class="ya-footer${data.reference ? "" : " footer-inner"}"><span>Endorsement = share of participants choosing YES in the latest closed round.</span><span>${data.reference ? "YC = Yap Coins · All activity is illustrative" : html`Synthetic activity is labeled · <a href="/live">Watch debates</a> · <a href="/coins">Yap Coins</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>`}</span></footer>
    <div id="ya-chart-tooltip" class="ya-chart-tooltip" role="tooltip" aria-hidden="true"><strong></strong></div>
    <div id="ya-status" aria-live="polite" class="sr-only"></div>
  <noscript><p class="ya-note">Idea links open their public topic pages. Enable JavaScript for inline charts, filters and previews.</p></noscript></main>
</div>
<template id="ya-home-data">${JSON.stringify(data)}</template>`;
}
