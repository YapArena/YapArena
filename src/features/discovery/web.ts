import { homepageMarkup } from "./homepage-view.ts";
import { accountMarkup } from "./account-web.ts";
import { siteHeaderMarkup } from "./site-header-web.ts";
import type { PublicBotActivity } from "../a4/public-bots.ts";
import { publicHomepage, type HomeData } from "./homepage-model.ts";
import { renderVideoDebateCard } from "./video-card-web.ts";
import { renderFeaturedDebate } from "./featured-web.ts";
import { renderDebateWorkspace } from "./debate-web.ts";
import { asset, assetRevision } from "./assets.ts";
import { html, raw, type SafeHtml } from "../../platform/html.ts";
import type {
  PublicDebate,
  PublicList,
  PublicProfile,
  PublicTopic,
} from "./repository.ts";

const path = (value: string) => encodeURIComponent(value);
const date = (value: Date | null) =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "To be announced";

const labels: Record<PublicDebate["status"], string> = {
  draft: "Draft",
  accepted: "Accepted",
  scheduled: "Upcoming",
  ready: "Ready",
  live: "Live",
  ended: "Ended",
  replay: "Replay",
  void_review: "Under review",
  finalized: "Finalized",
  cancelled: "Cancelled",
};

function layout(
  title: string,
  description: string,
  canonical: string,
  content: SafeHtml,
  metadata: SafeHtml | "" = "",
  bodyClass = "",
  emailFirst = false,
) {
  const home = bodyClass.startsWith("arena-market-home");
  const reference = bodyClass.includes("reference-home");
  const page = html`${siteHeaderMarkup()}${
    home
      ? content
      : html`<main id="main">${content}</main><footer class="site-footer"><div class="container footer-inner"><span>YAP ARENA <span class="muted">/ Ideas under pressure.</span></span><span><a href="/topics">Topics</a> · <a href="/coins">Yap Coins</a> · <a href="/about">About</a> · Play money</span></div></footer>`
  }`;
  return html`<!doctype html><html lang="en"${emailFirst ? " data-email-first" : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} · YAP Arena</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}">${metadata}<link rel="stylesheet" href="${asset("site.css")}"><link rel="stylesheet" href="${asset("arena.css")}"><link rel="stylesheet" href="${asset("site-header.css")}"><script defer src="${asset("session-coordination.js")}"></script><script type="module" src="${asset("site-header.js")}"></script><script defer src="${asset("site.js")}"></script><script defer src="${asset("account-balance.js")}"></script>${reference ? "" : html`<script defer src="${asset("measurement.js")}"></script>`}${home ? html`<link rel="stylesheet" href="${asset("homepage.css")}"><script defer src="${asset("homepage.bundle.js")}"></script>` : ""}</head><body class="${bodyClass}"><a class="skip-link" href="#main">Skip to content</a>${page}</body></html>`.toString();
}

function badge(debate: PublicDebate) {
  return html`<span class="status status-${debate.status}">${labels[debate.status]}</span>${debate.isDemo ? html`<span class="demo-label">DEMO</span>` : ""}`;
}

function debateCard(debate: PublicDebate) {
  return html`<article class="debate-card"><div class="card-top">${badge(debate)}<span class="card-topic">${debate.topic.title}</span></div><h3><a href="/debates/${path(debate.slug)}">${debate.proposition}</a></h3><div class="card-sides"><span>${debate.topic.sideALabel}</span><span class="versus">VS</span><span>${debate.topic.sideBLabel}</span></div><div class="card-bottom"><span>${debate.status === "scheduled" ? date(debate.scheduledAt) : debate.status === "live" ? "Happening now" : "Debate archive"}</span><a class="text-link" href="/debates/${path(debate.slug)}">View debate <span aria-hidden="true">↗</span></a></div></article>`;
}

function topicCard(topic: PublicTopic) {
  return html`<article class="topic-card"><span class="eyebrow">TOPIC ${topic.isDemo ? "· DEMO" : ""}</span><h3><a href="/topics/${path(topic.slug)}">${topic.title}</a></h3><p>${topic.summary}</p><div class="topic-sides"><span>${topic.sideALabel}</span><span>${topic.sideBLabel}</span></div></article>`;
}

function pagination(base: string, list: PublicList<unknown>) {
  const previous = list.pagination.offset > 0;
  const next = list.pagination.hasMore;
  if (!previous && !next) return html``;
  const link = (offset: number, label: string) =>
    html`<a class="page-link" href="${listPath(base, list, offset)}">${label}</a>`;
  return html`<nav class="pagination" aria-label="Pagination">${previous ? link(Math.max(0, list.pagination.offset - list.pagination.limit), "← Previous") : html`<span></span>`}<span>Page ${Math.floor(list.pagination.offset / list.pagination.limit) + 1}</span>${next ? link(list.pagination.offset + list.pagination.limit, "Next →") : html`<span></span>`}</nav>`;
}

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
    `${origin}/`,
    homepageMarkup(data),
    "",
    `arena-market-home${data.reference ? " reference-home" : ""}`,
    emailFirst,
  );
}

export function renderLive(
  origin: string,
  debates: PublicDebate[],
  topics: PublicList<PublicTopic>,
) {
  const content = html`${renderFeaturedDebate(debates[0] ?? null, assetRevision)}<section class="container section"><div class="section-heading"><div><span class="eyebrow">01 / THE CONVERSATION</span><h2>Debates to watch</h2></div><a class="text-link" href="/debates">All debates <span aria-hidden="true">↗</span></a></div>${debates.length ? html`<div class="card-grid arena-video-grid">${debates.map((debate) => renderVideoDebateCard(debate, assetRevision))}</div>` : html`<div class="empty-state"><h3>No watchable debates yet.</h3><p>Live debates and ready replays will appear here.</p></div>`}</section><section class="container section"><div class="section-heading"><div><span class="eyebrow">02 / EXPLORE IDEAS</span><h2>Topics in play</h2></div><a class="text-link" href="/topics">All topics <span aria-hidden="true">↗</span></a></div>${topics.items.length ? html`<div class="card-grid">${topics.items.map(topicCard)}</div>` : html`<div class="empty-state"><h3>No public topics yet.</h3><p>Published topics will appear here when they are ready.</p></div>`}</section><section class="container note-band"><span class="eyebrow">ABOUT THIS PREVIEW</span><p>YAP Arena is under development. Demo listings are examples, not real events. Profiles, wallet sign-in, and follows are available. Live debate and replay require configured media. Yap Coins and labeled bot rounds are available when enabled; real funds are unavailable.</p></section>${debates.length ? html`<script type="module" src="${asset("hero-preview.js")}"></script>` : ""}`;
  return layout(
    "Live",
    "Discover public debates and topics on YAP Arena.",
    `${origin}/live`,
    content,
  );
}

export function renderDebates(
  origin: string,
  list: PublicList<PublicDebate>,
  query: string,
  status: string,
) {
  const filters = [
    "all",
    "scheduled",
    "ready",
    "live",
    "ended",
    "replay",
    "void_review",
    "finalized",
    "cancelled",
  ].map(
    (option) =>
      // raw() keeps the existing unescaped query separators byte-identical.
      // option is one of the fixed statuses above and encodeURIComponent
      // never emits & < > or ", so this fragment cannot leave the attribute.
      html`<a class="filter ${status === option ? "active" : ""}" ${status === option ? html`aria-current="page"` : ""} href="/debates${raw(`${option === "all" ? "" : `?status=${option}`}${query ? `${option === "all" ? "?" : "&"}q=${encodeURIComponent(query)}` : ""}`)}">${option === "all" ? "All" : labels[option as PublicDebate["status"]]}</a>`,
  );
  const base = `/debates${query || status !== "all" ? `?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(status !== "all" ? { status } : {}) })}` : ""}`;
  const content = html`<section class="container page-intro"><span class="eyebrow accent">THE DEBATE FLOOR</span><h1>Find your next<br><em>good argument.</em></h1><p>Upcoming conversations and public debate archives, all in one place.</p></section><section class="container section compact"><form class="search-form" action="/debates" method="get" role="search"><label for="debate-search">Search debates</label><div><input id="debate-search" name="q" maxlength="80" value="${query}" placeholder="Search propositions or topics"><button type="submit">Search ↗</button></div></form><nav class="filters" aria-label="Debate status">${filters}</nav>${list.items.length ? html`<div class="card-grid">${list.items.map(debateCard)}</div>` : html`<div class="empty-state"><h2>No debates found.</h2><p>Try another search or status filter. Only published debates appear here.</p></div>`}${pagination(base, list)}</section>`;
  return layout(
    "Debates",
    "Browse public debates by status and search term.",
    `${origin}${listPath(base, list)}`,
    content,
  );
}

export function renderTopics(
  origin: string,
  list: PublicList<PublicTopic>,
  query: string,
) {
  const base = `/topics${query ? `?q=${encodeURIComponent(query)}` : ""}`;
  const content = html`<section class="container page-intro"><span class="eyebrow accent">THE IDEA INDEX</span><h1>Find the question<br><em>worth asking.</em></h1><p>Each topic frames two sides of an ongoing conversation.</p></section><section class="container section compact"><form class="search-form" action="/topics" method="get" role="search"><label for="topic-search">Search topics</label><div><input id="topic-search" name="q" maxlength="80" value="${query}" placeholder="Search an idea"><button type="submit">Search ↗</button></div></form>${list.items.length ? html`<div class="card-grid">${list.items.map(topicCard)}</div>` : html`<div class="empty-state"><h2>No topics found.</h2><p>Try another search. Published topics will appear here.</p></div>`}${pagination(base, list)}</section>`;
  return layout(
    "Topics",
    "Explore public topics on YAP Arena.",
    `${origin}${listPath(base, list)}`,
    content,
  );
}

export function renderTopic(
  origin: string,
  topic: PublicTopic,
  debates: PublicList<PublicDebate>,
) {
  const content = html`<section class="container detail-intro" data-measure-topic="${topic.id}"><a class="back-link" href="/topics">← All topics</a><span class="eyebrow accent">TOPIC ${topic.isDemo ? "· DEMO" : ""}</span><h1>${topic.title}</h1><button class="follow-button" type="button" data-follow-type="topics" data-follow-slug="${topic.slug}" aria-pressed="false">Follow topic</button><span class="follow-message" role="status" aria-live="polite"></span><p class="lead">${topic.summary}</p><div class="side-panel"><div><span class="eyebrow">SIDE A</span><strong>${topic.sideALabel}</strong></div><span class="versus">VS</span><div><span class="eyebrow">SIDE B</span><strong>${topic.sideBLabel}</strong></div></div></section><section class="container section"><div class="section-heading"><div><span class="eyebrow">ON THIS TOPIC</span><h2>Debates</h2></div></div>${debates.items.length ? html`<div class="card-grid">${debates.items.map(debateCard)}</div>` : html`<div class="empty-state"><h3>No public debates on this topic yet.</h3></div>`}${pagination(`/topics/${path(topic.slug)}`, debates)}</section>`;
  return layout(
    topic.title,
    topic.summary,
    `${origin}${listPath(`/topics/${path(topic.slug)}`, debates)}`,
    content,
  );
}

export function renderDebate(
  origin: string,
  debate: PublicDebate,
  a4Enabled = false,
  activity?: PublicBotActivity | null,
  liveOutline?: { state: unknown },
) {
  return layout(
    debate.proposition,
    `Watch and participate in the debate: ${debate.proposition}`,
    `${origin}/debates/${path(debate.slug)}`,
    renderDebateWorkspace(debate, a4Enabled, asset, activity, liveOutline),
    "",
    "arena-page",
  );
}

export function renderProfile(
  origin: string,
  profile: PublicProfile,
  debates: PublicList<PublicDebate>,
) {
  const content = html`<section class="container detail-intro"><a class="back-link" href="/debates">← All debates</a><span class="eyebrow accent">PARTICIPANT ${profile.isDemo ? "· DEMO" : ""}</span><h1>${profile.displayName}</h1><p class="handle">@${profile.handle}</p><button class="follow-button" type="button" data-follow-type="people" data-follow-slug="${profile.handle}" aria-pressed="false">Follow person</button><span class="follow-message" role="status" aria-live="polite"></span><p class="lead">${profile.bio ? profile.bio : "No public bio yet."}</p></section><section class="container section"><div class="section-heading"><div><span class="eyebrow">PUBLIC APPEARANCES</span><h2>Debates</h2></div></div>${debates.items.length ? html`<div class="card-grid">${debates.items.map(debateCard)}</div>` : html`<div class="empty-state"><h3>No public debates yet.</h3></div>`}${pagination(`/people/${path(profile.handle)}`, debates)}</section>`;
  return layout(
    profile.displayName,
    profile.bio ?? `Public profile for ${profile.displayName}.`,
    `${origin}${listPath(`/people/${path(profile.handle)}`, debates)}`,
    content,
  );
}

export function renderAbout(origin: string) {
  const content = html`<section class="container page-intro"><span class="eyebrow accent">ABOUT YAP ARENA</span><h1>Make room for<br><em>the other side.</em></h1><p>YAP Arena is building a home for live debates and the ideas that connect them.</p></section><section class="container about-copy"><h2>What you can explore now</h2><p>This public preview shows published topics, debate listings, and participant profiles. Sign in to pick your handle and follow people or topics. Listings marked Demo are fictional examples used to develop and test the product.</p><p>Live video and replay are available in a configured local prototype. A listing’s status does not prove that video is available or that a result has been determined. Yap Coins and labeled bot rounds are available when enabled. Real funds remain unavailable.</p><h2 id="measurement">Optional usage measurement</h2><p>We ask before recording discovery pages, watch time, replay starts, matching, follows, reports, or return visits. If you allow it, we use a random browser cookie, not your wallet address, and may associate events with your signed-in account to separate founder-affiliated activity. We do not store search text, chat text, IP addresses, or wallet addresses in product events. Use Measurement settings in the footer to turn it off and delete your measurements. Raw events and watch sessions are retained for up to 90 days; an unused consent expires after 180 days. Debate completion is counted from public event state without a browser identifier.</p><a class="button" href="/debates">Explore debates ↗</a></section>`;
  return layout(
    "About",
    "About YAP Arena's public preview.",
    `${origin}/about`,
    content,
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

export function renderMatchmaking(origin: string) {
  const content = html`<section class="container page-intro"><span class="eyebrow accent">DEBATE MATCHING</span><h1>Find the<br><em>other side.</em></h1><p>Create a topic, challenge a person, or join an open match request. A request becomes an event when two speakers agree to its proposition, sides, and start time.</p></section><section class="container section compact match-page"><p id="match-notice" class="notice" role="status" aria-live="polite">Checking your account…</p><div id="match-signed-out" hidden class="information-card"><p>Sign in with a public profile to open or join a debate.</p><a class="button" href="/account?next=%2Fmatch">Sign in ↗</a></div><div id="match-signed-in" hidden><div class="match-grid"><section class="information-card"><span class="eyebrow">01 / START A TOPIC</span><h2>Define both sides</h2><form id="topic-create" class="stack-form"><label>URL slug<input name="slug" pattern="[a-z0-9][a-z0-9-]{2,79}" maxlength="80" required></label><label>Title<input name="title" minlength="5" maxlength="140" required></label><label>Summary<textarea name="summary" minlength="10" maxlength="600" required></textarea></label><label>Side A label<input name="sideALabel" minlength="2" maxlength="80" required></label><label>Side B label<input name="sideBLabel" minlength="2" maxlength="80" required></label><button class="button" type="submit">Create private draft ↗</button></form><ul id="my-topics" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">02 / OPEN A REQUEST</span><h2>Set the proposition</h2><form id="request-create" class="stack-form"><label>Type<select name="kind"><option value="queue">Open matchmaking</option><option value="direct">Direct challenge</option></select></label><label>Published topic slug<input name="topicSlug" pattern="[a-z0-9][a-z0-9-]{2,79}" required></label><label>Proposition<input name="proposition" minlength="10" maxlength="240" required></label><label>Your side<select name="requestedSide"><option value="A">Side A</option><option value="B">Side B</option></select></label><label>Opponent handle for direct challenges<input name="targetHandle" pattern="[a-z0-9][a-z0-9-]{2,39}"></label><label>Proposed start, your local time<input name="scheduledAt" type="datetime-local" required></label><button class="button" type="submit">Open request ↗</button></form><p class="form-note">The same platform rules apply to every event. Start times must be 1 hour to 90 days ahead.</p></section></div><div class="match-grid"><section class="information-card"><span class="eyebrow">OPEN QUEUE</span><h2>Join a debate</h2><ul id="open-queue" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">YOUR REQUESTS</span><h2>Challenges and queue</h2><ul id="my-requests" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">YOUR EVENTS</span><h2>Debate lifecycle</h2><ul id="my-events" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">NOTIFICATIONS</span><h2>Updates</h2><ul id="match-notifications" class="account-list"></ul></section></div></div></section><script defer src="${asset("matching.js")}"></script>`;
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

export function renderUnavailable() {
  return layout(
    "Temporarily unavailable",
    "YAP Arena is temporarily unavailable.",
    "/",
    html`<section class="container page-intro"><span class="eyebrow accent">TEMPORARILY UNAVAILABLE</span><h1>We lost the thread<br><em>for a moment.</em></h1><p>Please try again shortly.</p><a class="button" href="/">Try again ↗</a></section>`,
  );
}

export function renderCoins(origin: string) {
  return layout(
    "Yap Coins",
    "Your Yap Coins balance, plus play-money Bots mode rounds.",
    `${origin}/coins`,
    html`<link rel="stylesheet" href="${asset("account-auth.css")}"><section class="container coin-wallet-shell"><div class="coin-wallet-intro"><span class="eyebrow accent">YOUR WALLET</span><h1>Yap <em>Coins.</em></h1><p>The coins you use in debates. Buying and withdrawing aren’t open yet.</p></div><section id="account-wallet" class="coin-wallet" aria-labelledby="coin-wallet-title"><div class="coin-wallet-head"><span class="coin-wallet-symbol" aria-hidden="true">Y</span><h2 id="coin-wallet-title">Your balance</h2><span class="coin-wallet-rate">100 YC = 1 USDC</span></div><p data-coin-wallet-status role="status" aria-live="polite">Checking your balance…</p><div class="coin-wallet-signed-out" data-coin-wallet-signed-out hidden><p>Sign in to see your balance.</p><a class="button" href="/account?next=%2Fcoins">Sign in</a></div><section id="account-wallet-progress" class="wallet-money-summary" aria-label="Withdrawal balance and grant progress" hidden></section><dl class="account-balances" data-coin-wallet-balances hidden><div><dt>Available</dt><dd data-funds="available">—</dd></div><div><dt>Reserved</dt><dd data-funds="reserved">—</dd></div><div><dt>Pending</dt><dd data-funds="pending">—</dd></div><div><dt>Promotional</dt><dd data-funds="promotional">—</dd></div></dl></section></section><section class="container page-intro a4-intro"><span class="eyebrow accent">BOTS MODE · PLAY MONEY</span><h2>Your position.<br><em>Your limit.</em></h2><p>Endorse an idea and choose a binding purchase ceiling. A shared offer is drawn after commitment. Settlement follows the unweighted YES endorsement share, including orders that never execute.</p><p>Bots mode uses separate play coins with no cash value. They never convert to Yap Coins.</p></section><section class="container section compact" data-a4><p data-a4-notice class="notice" role="status" aria-live="polite">Checking your account…</p><div data-a4-login hidden><a class="button" href="/account?next=%2Fcoins">Sign in to use Bots mode →</a></div><div data-a4-content hidden><div class="a4-grid"><section class="information-card"><span class="eyebrow">START OR JOIN</span><h2>Choose your round</h2><form data-a4-create class="stack-form"><label>Debate<select name="debateId" required></select></label><label><input type="checkbox" data-a4-publish> Share my settled Bots + you and Bots-only aggregate results on public charts</label><label>Mode<select name="mode"><option value="mixed">Bots mode + you</option><option value="observer">Bots only · observer</option><option value="human">Human-only round</option></select></label><p>Bot runs are private sandboxes with their own play balances. Observer runs cannot accept people. YES endorses the displayed proposition; NO rejects it.</p><details><summary>Round settings</summary><div class="stack-form"><label>Bot population<input name="population" type="number" min="1" max="1000" value="500"></label><label>Belief preset<select name="preset"><option value="heterogeneous">Heterogeneous · behavioral stress fixture</option><option value="reference">Homogeneous · reference fixture</option></select></label><label>Exploration epsilon<select name="epsilon"><option value="50000">0.05</option><option value="0">0</option><option value="1000000">1 · full exploration</option></select></label><label>Premium fee<select name="feeBps"><option value="0">No fee</option><option value="500">Experimental 5%</option></select></label><label>Bot contracts<input name="quantity" type="number" min="1" max="100" value="1"></label><label>Periods<select name="periods"><option value="1">Single round</option><option value="3">3 · delayed reveal</option><option value="10">10 · delayed reveal</option></select></label><label>Round duration in seconds<input name="roundSeconds" type="number" min="10" max="3600" value="60"></label><label>Initial bot acceleration<select name="speed"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label>Replay seed · bot-only observer runs<input name="seed" maxlength="80" pattern="[a-zA-Z0-9_-]{1,80}" placeholder="Random if empty"></label></div></details><button class="button" type="submit">Start a new run →</button></form><label>Existing runs<select data-a4-runs><option value="">Select a run</option></select></label><button type="button" data-a4-list>Refresh runs</button></section><section class="information-card"><span class="eyebrow">YOUR PLAY COINS</span><h2 data-a4-balance>Balance</h2><p data-a4-reserved></p><button type="button" data-a4-refill>Get daily play coins</button><p data-a4-funding-policy>Play credits follow the current issuance policy. Multiple wallets share one account allowance.</p><div data-a4-run-summary></div><div data-a4-controls hidden class="a4-controls"><button type="button" data-a4-control="run">Run</button><button type="button" data-a4-control="pause">Pause</button><button type="button" data-a4-control="step">Step / lock next</button><label>Processing speed<select data-a4-speed><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><button type="button" data-a4-control="archive">Archive / new run</button><p>Step locks the next open round immediately. Pause stops opening future windows; existing cutoffs and final reveal time still apply. Speed changes processing, not locked terms.</p></div><form data-a4-submit class="stack-form" hidden><h3>Make a binding submission</h3><label>Your position<select name="side"><option value="YES">YES · endorse the proposition</option><option value="NO">NO · reject the proposition</option></select></label><label>Maximum purchase price in Yap Coins<input name="ceiling" type="text" inputmode="decimal" value="0.50" pattern="(0([.][0-9]{1,6})?|1([.]0{1,6})?)" required></label><label>Number of contracts<input name="quantity" type="number" min="1" max="100" value="10" required></label><p>For NO, a ceiling of 0.78 means a YES-scale floor of 0.22. Quantity determines exposure, not voting weight. No revisions or cancellations after commitment.</p><button class="button" type="submit">Review exact commitment →</button></form></section></div><section class="information-card a4-history"><div class="section-heading"><h2>Rounds and receipts</h2><button type="button" data-a4-refresh>Refresh</button></div><p>Shared prices are random offers, not sentiment or probability of truth. Pending payouts and sealed diagnostics remain hidden until reveal.</p><div data-a4-rounds></div><div class="a4-controls"><button type="button" data-a4-book-prev>Previous orders</button><button type="button" data-a4-book-next>Next orders</button></div><details><summary>Private balance history</summary><div data-a4-history></div><button type="button" data-a4-history-more>More history</button></details><details><summary>Research assumptions and diagnostics</summary><p>Heterogeneous bots use fresh broad private beliefs each period. This is a behavioral UX stress test, not a coherent Bayesian proof. The homogeneous preset preserves the 0.22 / 0.34 analytical reference. Finite populations can reward deviations. No guaranteed truthfulness, Sybil resistance or event winner is claimed.</p><p><a href="${asset("a4-research.json")}">Read reproducible finite counterfactual results</a>. The audit recomputes medians, acceptance and settlement with fixed quantity, paired random draws and independent confirmation.</p></details></section></div></section><dialog data-a4-review class="information-card" aria-labelledby="a4-review-title"><h2 id="a4-review-title">Review Yap Coins commitment</h2><div data-a4-terms></div><p data-a4-review-notice role="status" aria-live="polite"></p><button type="button" data-a4-commit class="button">Commit these exact terms</button><button type="button" data-a4-cancel>Back</button></dialog><script type="module" src="${asset("a4.js")}"></script><script type="module" src="${asset("account-coins.js")}"></script>`,
  );
}
