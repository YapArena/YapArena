import { siteHeaderMarkup } from "../discovery/site-header-web.ts";
import { asset } from "../discovery/assets.ts";
import { iconLinks, siteFooterMarkup } from "../discovery/page-chrome-web.ts";
import { html, type SafeHtml } from "../../platform/html.ts";
import type { createCommunityRepository } from "./repository.ts";

type PublicEvent = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof createCommunityRepository>["publicEvent"]>
  >
>;

function shell(title: string, content: SafeHtml, emailFirst: boolean) {
  return html`<!doctype html><html lang="en"${emailFirst ? " data-email-first" : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · YAP Arena</title>${iconLinks()}<link rel="stylesheet" href="${asset("site.css")}"><link rel="stylesheet" href="${asset("site-header.css")}"><script defer src="${asset("session-coordination.js")}"></script><script defer src="${asset("site.js")}"></script><script defer src="${asset("account-balance.js")}"></script><script type="module" src="${asset("site-header.js")}"></script><script type="module" src="${asset("community.js")}"></script></head><body><a class="skip-link" href="#main">Skip to content</a>${siteHeaderMarkup()}<main id="main" class="container section">${content}</main>${siteFooterMarkup()}</body></html>`.toString();
}

export function renderMyModeration(emailFirst = false) {
  return shell(
    "My moderation",
    html`<section data-community-mine><h1>My reports and appeals</h1><p>Reports are private. If your chat was removed or your community access was restricted, you can appeal within 30 days.</p><button type="button" data-community-refresh>Refresh</button><p role="status" aria-live="polite" data-community-status>Loading your cases…</p><div data-community-list></div></section>`,
    emailFirst,
  );
}

export function renderModeration(emailFirst = false) {
  return shell(
    "Moderation review",
    html`<section data-community-moderation><h1>Moderation review</h1><p>Review reports and appeals. Actions here affect community activity only.</p><label>Case status <select data-community-case-filter><option value="open">Open</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option></select></label><button type="button" data-community-refresh>Refresh</button><p role="status" aria-live="polite" data-community-status>Loading cases…</p><div class="community-review-grid"><section><h2>Reports</h2><div data-community-cases></div></section><section><h2>Open appeals</h2><div data-community-appeals></div></section></div></section>`,
    emailFirst,
  );
}

export function renderOverlay(event: PublicEvent) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${event.proposition} · Broadcast overlay</title><link rel="stylesheet" href="${asset("site.css")}"></head><body class="overlay-page"><main class="broadcast-overlay" aria-label="Debate broadcast information"><span class="eyebrow">YAP ARENA · ${event.status.toUpperCase()}</span><h1>${event.proposition}</h1><p>${event.topicTitle}</p><div class="overlay-speakers"><span>${event.speakerA ?? event.sideALabel}</span><span aria-hidden="true">VS</span><span>${event.speakerB ?? event.sideBLabel}</span></div><small>Event information only. No winner or official support is shown.</small></main></body></html>`.toString();
}
