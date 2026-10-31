import { html } from "../../platform/html.ts";

export function siteHeaderMarkup() {
  return html`<header class="site-header" data-site-header data-session="checking">
    <div class="container nav arena-nav">
      <a class="brand" href="/home" aria-label="YAP Arena home"><svg class="arena-brand-symbol" viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="20" rx="13" ry="16" transform="rotate(30 20 20)"/><path d="M9 35 31 5"/></svg><span>YAP ARENA</span></a>
      <nav aria-label="Main navigation"><a href="/live">Live</a><a href="/debates">Explore</a><a href="/match">Create</a></nav>
      <form class="arena-header-search" action="/debates" method="get" role="search"><label class="sr-only" for="header-search">Search debates</label><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="header-search" type="search" name="q" maxlength="80" placeholder="Search debates…"><button type="submit" class="sr-only">Search</button></form>
      <div class="arena-header-account">
        <span data-header-checking class="header-session-loading" role="status"><span class="sr-only">Checking your account…</span></span>
        <div class="header-auth-actions" data-header-guest hidden><a class="header-signup" href="/account" data-header-sign-in>Sign in</a></div>
        <button class="header-retry" type="button" data-header-retry hidden>Retry account</button>
        <div class="header-member-actions" data-header-member hidden>
          <details class="arena-wallet-menu"><summary aria-label="Yap Coins balance and actions"><span class="header-balance-label">Balance</span><strong data-header-balance>—</strong><span class="arena-chevron" aria-hidden="true">⌄</span></summary><div class="arena-wallet-popover"><strong data-header-balance-heading>Your Yap Coins</strong><span data-header-reserved>Checking balance…</span><a href="/coins" data-header-balances-link>Balances &amp; activity →</a></div></details>
          <details class="header-user-menu"><summary class="arena-avatar" data-header-account aria-label="Open account menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg></summary><div class="header-user-popover"><span class="header-menu-caption" data-header-identity><span>YOUR ACCOUNT</span></span><a href="/account#profile" data-header-profile-link>Your profile</a><a href="/account">Settings</a><a href="/coins">Yap Coins</a><button type="button" data-header-logout>Sign out <span aria-hidden="true">↗</span></button></div></details>
        </div>
        <noscript><div class="header-auth-actions"><a class="header-login" href="/api/auth/login?connection=google">Continue with Google</a><a class="header-signup" href="/api/auth/login?connection=email">Continue with email</a></div></noscript>
      </div>
      <p class="sr-only" role="status" data-header-status></p>
    </div>
  </header>`;
}
