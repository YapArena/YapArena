// A watchable debate on Live: the kit's debate card (cards-web.ts) with a
// muted preview in its picture and the words under it, never over the video.
// frontend/hero-preview.ts drives the data-preview hooks.
import type { PublicDebate } from "./repository.ts";
import { statusTag } from "./cards-web.ts";
import { avatarSlot } from "./kit-web.ts";
import { html } from "../../platform/html.ts";

const versus = html`<span class="vs"><span class="sr-only">versus</span><span aria-hidden="true">VS</span></span>`;

export function renderVideoDebateCard(debate: PublicDebate, revision: string) {
  const live = debate.status === "live";
  const { speakerA, speakerB, topic } = debate;
  return html`<article class="dcard live-card" data-card-preview data-debate-preview data-event="${debate.id}" data-mode="${live ? "live" : "replay"}" data-live-source="/assets/hero-live.bundle.js?v=${revision}" data-hls-source="/assets/replay.bundle.js?v=${revision}">
    <div class="dcard-thumb">
      <span class="dcard-panes" aria-hidden="true"><span class="dcard-pane">${avatarSlot(speakerA?.displayName, 48)}</span><span class="dcard-pane">${avatarSlot(speakerB?.displayName, 48)}</span></span>
      <img class="live-still" data-preview-thumbnail src="/api/media/events/${debate.id}/thumbnail" alt="" aria-hidden="true" loading="lazy" decoding="async">
      <div class="live-media" data-preview-media aria-hidden="true"><video data-preview-video muted autoplay playsinline loop preload="none" tabindex="-1" disablepictureinpicture></video><div class="live-media-live" data-preview-live></div></div>
      ${statusTag(live ? "live" : "replay")}
      <div class="live-card-controls"><span class="sr-only" data-preview-status>Preview paused</span><button type="button" class="live-toggle" data-preview-toggle aria-label="Play video preview" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path data-preview-toggle-icon d="m8 5 11 7-11 7Z"/></svg></button></div>
    </div>
    <div class="dcard-body"><p class="dcard-meta"><span>${topic.title}</span>${debate.isDemo ? html`<span class="tag tag-quiet">Demo</span>` : ""}</p><h3 class="dcard-title"><a data-preview-open href="/debates/${encodeURIComponent(debate.slug)}">${debate.proposition}</a></h3><p class="dcard-people">${avatarSlot(speakerA?.displayName, 24)}<span>${speakerA?.displayName ?? topic.sideALabel}</span>${versus}${avatarSlot(speakerB?.displayName, 24)}<span>${speakerB?.displayName ?? topic.sideBLabel}</span></p></div>
  </article>`;
}
