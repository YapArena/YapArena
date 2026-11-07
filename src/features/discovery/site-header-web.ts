import { asset, avatarTemplate } from "./assets.ts";
import { html, type SafeHtml } from "../../platform/html.ts";
import { inscribe } from "./inscribe.ts";

/** The header's destinations; the current one is marked (docs/site-design.md). */
export type SiteSection = "live" | "queue" | "explore" | "create";

const sections: [SiteSection, string, string][] = [
  ["live", "/live", "Live"],
  ["queue", "/queue", "Queue"],
  ["explore", "/debates", "Explore"],
  ["create", "/match", "Create"],
];

const searchIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`;
const personIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>`;
// Three tiles in the visit's colours; the balance's small pixel coin.
const coin = html`<span class="header-coin" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;

/** The bottom tabs' destinations: Home and the header's four. */
export type SiteTab = "home" | SiteSection;

// 24 px icons drawn in the text colour. Home is the YAP Arena ring, upright
// like the emblem; Queue is two speech bubbles, the second filled.
const tabIcons: Record<SiteTab, SafeHtml> = {
  home: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1.5 12a10.5 8.8 0 1 0 21 0a10.5 8.8 0 1 0-21 0zM4.8 13.5a7.2 5.9 0 1 0 14.4 0a7.2 5.9 0 1 0-14.4 0z"/></svg>`,
  live: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  queue: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.5h8a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5H8.2L5 15.2v-2.7h-.5A2.5 2.5 0 0 1 2 10V6a2.5 2.5 0 0 1 2.5-2.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M11.5 10.5h8a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5h-.5v2.7l-3.2-2.7h-4.3A2.5 2.5 0 0 1 9 17v-4a2.5 2.5 0 0 1 2.5-2.5z" fill="currentColor" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  explore: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M16 16l4.6 4.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  create: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};
const tabs: [SiteTab, string, string][] = [
  ["home", "/home", "Home"],
  ...sections,
];

// Phones only (public/site-header.css): the main navigation as icon tabs with
// their names, fixed to the bottom of the screen. Wider screens keep the
// header's navigation and never show these.
export function siteTabBarMarkup(current: SiteTab | null = null) {
  return html`<nav class="site-tabbar" aria-label="Main navigation">${tabs.map(
    ([key, href, label]) =>
      html`<a href="${href}"${key === current ? html` aria-current="page"` : ""}>${tabIcons[key]}<span>${label}</span></a>`,
  )}</nav>`;
}

/** A search of the page's own list, kept with the page's filters. */
export interface PageSearch {
  /** The list page the search reloads, such as /debates or /topics. */
  action: string;
  /** "Search debates": the field's label and placeholder. */
  label: string;
  query: string;
  /** The filters in use, as query parameters a new search keeps. */
  filters: readonly (readonly [name: string, value: string])[];
}

export interface SiteHeaderOptions {
  /** On phones, this page's name replaces the logo in the middle of the top row. */
  title?: string | null;
  /** On phones, this search field takes the middle of the top row instead. */
  search?: PageSearch | null;
}

// Explore's search bar (first-run plan): phones only, in the middle of the top
// row. It searches the page's own list with its filters, which the page's
// search field, hidden on phones, would otherwise do (public/explore.css).
function pageSearchMarkup({ action, label, query, filters }: PageSearch) {
  return html`<form class="site-page-search" action="${action}" method="get" role="search">${filters.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}<label class="sr-only" for="top-search">${label}</label>${searchIcon}<input id="top-search" type="search" name="q" maxlength="80" value="${query}" placeholder="${label}" enterkeyhint="search"><button type="submit" class="sr-only">Search</button></form>`;
}

// One grid: logo, nav, search and account on one row; on phones the top row
// holds the account button, the logo, the page's name or its search, and the
// balance, and the nav moves to its own tab row under it
// (public/site-header.css).
export function siteHeaderMarkup(
  current: SiteSection | null = null,
  { title = null, search = null }: SiteHeaderOptions = {},
) {
  const nav = sections.map(
    ([key, href, label]) =>
      html`<a href="${href}"${key === current ? html` aria-current="page"` : ""}>${label}</a>`,
  );
  // The page's own heading names it for screen readers; this copy is visual.
  const pageTitle =
    title && !search
      ? html`<p class="site-page-title ins" aria-hidden="true">${inscribe(title.toLowerCase())}</p>`
      : "";
  const middle = search
    ? html` data-page-search`
    : title
      ? html` data-page-title`
      : "";
  return html`<header class="site-header" data-site-header data-session="checking" data-avatar-src="${avatarTemplate}"${middle}>
    <div class="container site-header-grid">
      <a class="site-logo" href="/home"><img src="${asset("landing/yaparena-logo.png")}" width="575" height="151" alt="YAP Arena home"></a>${pageTitle}${search ? pageSearchMarkup(search) : ""}
      <nav class="site-nav" aria-label="Main navigation">${nav}</nav>
      <form class="arena-header-search" action="/debates" method="get" role="search" data-header-search><label class="sr-only" for="header-search">Search debates</label>${searchIcon}<input id="header-search" type="search" name="q" maxlength="80" placeholder="Search debates…"><button type="submit" class="sr-only">Search</button></form>
      <a class="header-search-toggle" href="/debates#debate-search" data-header-search-toggle aria-label="Search debates"><span class="icon-search">${searchIcon}</span><svg class="icon-close" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></a>
      <div class="arena-header-account">
        <span data-header-checking class="header-session-loading" role="status"><span class="header-loader" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="sr-only">Checking your account…</span></span>
        <div class="header-auth-actions" data-header-guest hidden><a class="header-signup" href="/account" data-header-sign-in>Sign in</a></div>
        <button class="header-retry" type="button" data-header-retry hidden>Retry account</button>
        <div class="header-member-actions" data-header-member hidden>
          <details class="arena-wallet-menu"><summary aria-label="Yap Coins balance and actions">${coin}<strong data-header-balance>—</strong></summary><div class="arena-wallet-popover"><strong data-header-balance-heading>Your Yap Coins</strong><strong class="header-balance-amount" data-header-balance-copy aria-hidden="true">—</strong><span data-header-reserved>Checking balance…</span><span class="header-play-money">Play money · no cash value</span><a href="/coins" data-header-balances-link>Balances &amp; activity →</a></div></details>
          <details class="header-user-menu"><summary class="arena-avatar" data-header-account aria-label="Open account menu"><span class="header-avatar" data-header-avatar>${personIcon}</span></summary><div class="header-user-popover"><span class="header-menu-caption" data-header-identity><span>YOUR ACCOUNT</span></span><a href="/account#profile" data-header-profile-link>Your profile</a><a href="/account">Settings</a><a href="/coins">Yap Coins</a><button type="button" data-header-logout>Sign out <span aria-hidden="true">↗</span></button></div></details>
        </div>
        <noscript><div class="header-auth-actions"><a class="header-login" href="/api/auth/login?connection=google">Continue with Google</a><a class="header-signup" href="/api/auth/login?connection=email">Continue with email</a></div></noscript>
      </div>
      <p class="sr-only" role="status" data-header-status></p>
    </div>
  </header>`;
}
