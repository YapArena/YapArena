import { asset, avatarTemplate } from "./assets.ts";
import { html } from "../../platform/html.ts";
import { inscribe } from "./inscribe.ts";

/** The header's destinations; the current one is marked (docs/site-design.md). */
export type SiteSection = "live" | "explore" | "create";

const sections: [SiteSection, string, string][] = [
  ["live", "/live", "Live"],
  ["explore", "/debates", "Explore"],
  ["create", "/match", "Create"],
];

const searchIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`;
const personIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>`;
// Three tiles in the visit's colours; the balance's small pixel coin.
const coin = html`<span class="header-coin" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;

export interface SiteHeaderOptions {
  /** On phones, this page's name replaces the logo in the middle of the top row. */
  title?: string | null;
}

// One grid: logo, nav, search and account on one row; on phones the top row
// holds the account button, the logo or the page's name and the balance, and
// the nav moves to its own tab row under it (public/site-header.css).
export function siteHeaderMarkup(
  current: SiteSection | null = null,
  { title = null }: SiteHeaderOptions = {},
) {
  const nav = sections.map(
    ([key, href, label]) =>
      html`<a href="${href}"${key === current ? html` aria-current="page"` : ""}>${label}</a>`,
  );
  // The page's own heading names it for screen readers; this copy is visual.
  const pageTitle = title
    ? html`<p class="site-page-title ins" aria-hidden="true">${inscribe(title.toLowerCase())}</p>`
    : "";
  return html`<header class="site-header" data-site-header data-session="checking" data-avatar-src="${avatarTemplate}"${title ? html` data-page-title` : ""}>
    <div class="container site-header-grid">
      <a class="site-logo" href="/home"><img src="${asset("landing/yaparena-logo.png")}" width="575" height="151" alt="YAP Arena home"></a>${pageTitle}
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
