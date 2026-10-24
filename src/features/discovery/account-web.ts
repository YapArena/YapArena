import { html } from "../../platform/html.ts";

const icons = {
  person: html`<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>`,
  shield: html`<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`,
  bell: html`<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>`,
  lock: html`<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>`,
  coin: html`<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.6-1.2-1.6 0-2.6.8-2.6 2s1 1.7 2.7 2c1.7.3 2.7.9 2.7 2.1 0 1.3-1.1 2.1-2.7 2.1-1.2 0-2.2-.5-2.8-1.4M12 6.5V8m0 8v1.5"/>`,
  external: html`<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>`,
  download: html`<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>`,
  chart: html`<path d="M4 19h16M7 16v-4m5 4V8m5 8v-6"/>`,
};
const icon = (name: keyof typeof icons) =>
  html`<svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

const tabs = [
  ["profile", "person", "Profile"],
  ["security", "shield", "Sign-in & security"],
  ["notifications", "bell", "Notifications"],
  ["privacy", "lock", "Privacy & data"],
] as const;

const signedOut = html`<div id="signed-out" hidden>
      <div class="auth-layout">
        <aside class="auth-story">
          <span class="eyebrow accent">IDEAS UNDER PRESSURE</span>
          <h1>Every idea<br>deserves <em>a voice.</em></h1>
          <p>Follow the ideas that move you.<br>Make your mark when you’re ready.</p>
          <div class="auth-arena-art" aria-hidden="true"><svg viewBox="0 0 440 300" fill="none"><ellipse cx="220" cy="150" rx="145" ry="93" transform="rotate(-28 220 150)"/><ellipse cx="220" cy="150" rx="145" ry="93" transform="rotate(28 220 150)"/><circle cx="220" cy="150" r="53"/><path d="m195 183 50-66"/><circle cx="100" cy="86" r="7"/><circle cx="345" cy="213" r="5"/><circle cx="220" cy="30" r="3"/></svg><span>YOUR NEXT PERSPECTIVE STARTS HERE</span></div>
        </aside>
        <div class="auth-panel">
          <div class="auth-card account-sign-in" id="account-sign-in"><span class="eyebrow accent">SIGN IN OR CREATE AN ACCOUNT</span><h2>Join the arena</h2><div class="auth-sign-in-actions"><a class="button" href="/api/auth/login?connection=google&amp;return=%2Faccount" data-sign-in="google">Continue with Google</a><a class="button-secondary" href="/api/auth/login?connection=email&amp;return=%2Faccount" data-sign-in="email">Continue with email</a></div></div>
        </div>
      </div>
    </div>`;

const profilePanel = html`<section class="settings-panel" role="tabpanel" id="panel-profile" aria-labelledby="tab-profile" tabindex="-1">
          <div class="settings-card">
            <div class="settings-card-head"><div><h2>Public profile</h2><p>How you show up in debates, chat and search.</p></div></div>
            <div class="settings-banner" id="profile-state-box" hidden><p id="profile-state" role="status"></p><button class="button-secondary" type="button" id="profile-publish" hidden>Make it public</button></div>
            <form id="profile-form" class="settings-form" novalidate>
              <div class="settings-field">
                <div class="settings-label-row"><label for="profile-display-name">Username</label><span class="settings-count" data-count-for="profile-display-name" aria-hidden="true">0/80</span></div>
                <input id="profile-display-name" name="displayName" maxlength="80" autocomplete="name" required aria-describedby="profile-display-name-error">
                <p class="settings-error" id="profile-display-name-error" data-error-for="displayName" hidden></p>
              </div>
              <div class="settings-field">
                <div class="settings-label-row"><label for="profile-handle">Handle</label><span class="settings-lock">${icon("lock")}Permanent</span></div>
                <div class="settings-handle"><span aria-hidden="true">@</span><input id="profile-handle" name="handle" readonly aria-describedby="profile-handle-help"></div>
                <p class="settings-help" id="profile-handle-help">Handles never change, so links to you never break. <a id="profile-url" href="/account#profile"></a></p>
              </div>
              <div class="settings-field">
                <div class="settings-label-row"><label for="profile-bio">Bio</label><span class="settings-count" data-count-for="profile-bio" aria-hidden="true">0/500</span></div>
                <textarea id="profile-bio" name="bio" maxlength="500" rows="4" placeholder="A little about you and the ideas you care about." aria-describedby="profile-bio-error"></textarea>
                <p class="settings-error" id="profile-bio-error" data-error-for="bio" hidden></p>
              </div>
              <div class="settings-save"><p id="profile-save-status" role="status" aria-live="polite"></p><button class="button" type="submit" disabled>Save changes</button></div>
            </form>
          </div>
          <div class="settings-card">
            <div class="settings-card-head"><div><h2>Following</h2><p>People and topics you follow. Follow more from their public pages.</p></div></div>
            <ul id="follow-list" class="settings-list"></ul>
          </div>
        </section>`;

const securityPanel = html`<section class="settings-panel" role="tabpanel" id="panel-security" aria-labelledby="tab-security" tabindex="-1" hidden>
          <div class="settings-card">
            <div class="settings-card-head"><div><h2>Sign-in methods</h2><p>The ways you can sign in to this account.</p></div></div>
            <ul id="sign-in-methods" class="settings-methods"></ul>
            <p class="settings-help">Google and an email code for the same address both open this account. Signing out ends your session on this device only.</p>
          </div>
          <div class="settings-card">
            <div class="settings-card-head"><div><h2>Recent account activity</h2><p>Sign-ins and changes from the last 90 days.</p></div></div>
            <ul id="activity-list" class="settings-list settings-timeline"></ul>
            <a class="settings-link" href="/account/moderation">My reports and appeals<span aria-hidden="true">→</span></a>
          </div>
        </section>`;

const notificationsPanel = html`<section class="settings-panel" role="tabpanel" id="panel-notifications" aria-labelledby="tab-notifications" tabindex="-1" hidden>
          <div class="settings-card">
            <div class="settings-card-head"><div><h2>Notifications</h2><p>Updates about your debates, sign-ins and account.</p></div></div>
            <ul id="account-notifications" class="settings-list settings-notifications"></ul>
          </div>
        </section>`;

const privacyPanel = html`<section class="settings-panel" role="tabpanel" id="panel-privacy" aria-labelledby="tab-privacy" tabindex="-1" hidden>
          <div class="settings-card settings-row-card">
            <span class="settings-card-icon">${icon("chart")}</span>
            <div><h2>Usage measurement</h2><p>We only count page views and watch time if you allow it, and you can turn it off and delete that data anytime.</p></div>
            <button class="button-secondary" type="button" data-open-measurement>Measurement settings</button>
          </div>
          <div class="settings-card settings-row-card">
            <span class="settings-card-icon">${icon("download")}</span>
            <div><h2>Download your data</h2><p>A JSON file with your profile, sign-in methods, follows, notifications and account activity.</p></div>
            <a class="button-secondary" href="/api/me/export" download data-export>Download</a>
          </div>
        </section>`;

export function accountMarkup(asset: (name: string) => string) {
  return html`<link rel="stylesheet" href="${asset("account-auth.css")}">
  <section class="container account-shell">
    <div class="account-status-row"><a class="account-back" data-auth-return href="/debates">← Back to the arena</a><p id="account-notice" role="status" aria-live="polite">Checking your account…</p></div>
    ${signedOut}
    <div id="signed-in" hidden>
      <header class="settings-hero">
        <span class="settings-avatar" id="account-avatar" aria-hidden="true">${icon("person")}</span>
        <div class="settings-identity"><span class="eyebrow accent">SETTINGS</span><h1 id="account-display-name">Your account</h1><p><span id="account-handle"></span><span id="account-name"></span></p></div>
        <div class="settings-hero-actions"><a class="button-secondary" id="view-profile" href="/account#profile" hidden>${icon("external")}View profile</a><button class="button-secondary" id="sign-out" type="button">Sign out</button></div>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings">
          <div class="settings-tabs" role="tablist" aria-orientation="vertical">${tabs.map(
            ([id, name, label], index) =>
              html`<a class="settings-tab" role="tab" id="tab-${id}" href="#${id}" aria-controls="panel-${id}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}">${icon(name)}<span>${label}</span>${id === "notifications" ? html`<span class="settings-badge" id="notification-count" hidden></span>` : ""}</a>`,
          )}</div>
          <a class="settings-tab settings-tab-link" href="/coins">${icon("coin")}<span>Yap Coins</span><span class="settings-tab-arrow" aria-hidden="true">↗</span></a>
        </nav>
        <div class="settings-panels">
        ${profilePanel}
        ${securityPanel}
        ${notificationsPanel}
        ${privacyPanel}
        </div>
      </div>
    </div>
  </section>
  <script defer src="${asset("account.js")}"></script>`;
}
