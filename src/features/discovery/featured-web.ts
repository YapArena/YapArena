// Live's featured debate (docs/site-design.md#live): a contained 16:9 stage
// with the words beside it, or the living emblem when nothing is live.
// frontend/hero-preview.ts drives the data-preview hooks.
import type { PublicDebate } from "./repository.ts";
import { livingEmblem } from "./emblem-web.ts";
import { inscription } from "./kit-web.ts";
import { personSlot } from "./avatar-web.ts";
import { html } from "../../platform/html.ts";

const versus = html`<span class="vs"><span class="sr-only">versus</span><span aria-hidden="true">VS</span></span>`;

export function renderFeaturedDebate(
  debate: PublicDebate | null,
  revision: string,
) {
  if (!debate)
    return html`<section class="live-feature live-feature-empty" aria-labelledby="featured-title"><div class="live-copy kit-reveal"><p class="kicker">${inscription("Ideas under pressure")}</p><h1 class="page-title" id="featured-title">${inscription("Every idea has", "another side.")}</h1><p class="page-lead">The next conversation is taking shape. Discover the debates and the people behind them.</p><div class="live-actions"><a class="btn btn-primary" href="/debates">Explore the arena</a></div></div>${livingEmblem()}</section>`;
  const live = debate.status === "live";
  const { speakerA, speakerB } = debate;
  return html`<section class="live-feature" data-featured-preview data-debate-preview data-event="${debate.id}" data-mode="${live ? "live" : "replay"}" data-live-source="/assets/hero-live.bundle.js?v=${revision}" data-hls-source="/assets/replay.bundle.js?v=${revision}" aria-labelledby="featured-title">
    <div class="live-stage">
      <span class="live-panes" aria-hidden="true"><span>${personSlot(speakerA, 96)}</span><span>${personSlot(speakerB, 96)}</span></span>
      <img class="live-still" data-preview-thumbnail src="/api/media/events/${debate.id}/thumbnail" alt="" aria-hidden="true" decoding="async">
      <div class="live-media" data-preview-media aria-hidden="true"><video data-preview-video muted autoplay playsinline loop preload="none" tabindex="-1" disablepictureinpicture></video><div class="live-media-live" data-preview-live></div></div>
      <a class="live-open" data-preview-open href="/debates/${encodeURIComponent(debate.slug)}" aria-label="Open debate: ${debate.proposition}" aria-describedby="featured-instruction"></a>
      <span class="tag${live ? " tag-live" : ""} live-stage-tag">${live ? html`<span class="live-pixel" aria-hidden="true"></span>Live now` : "Featured replay"}</span>
      <div class="live-controls"><span class="live-state" data-preview-status>Muted preview</span><button type="button" class="live-toggle" data-preview-toggle aria-label="Pause video preview" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path data-preview-toggle-icon d="M8 5v14M16 5v14"/></svg></button></div>
      <div class="live-intent" data-preview-intent aria-hidden="true"><span>Entering the arena</span><span class="live-intent-track"><span></span></span><small>Move away or press Esc to stay here</small></div>
    </div>
    <div class="live-copy"><p class="live-eyebrow"><span class="kicker">${inscription(live ? "Live now" : "Featured replay")}</span><span>${debate.topic.title}</span></p><h1 class="live-title" id="featured-title">${debate.proposition}</h1>${speakerA || speakerB ? html`<p class="dcard-people">${personSlot(speakerA, 24)}<span>${speakerA?.displayName ?? debate.topic.sideALabel}</span>${versus}${personSlot(speakerB, 24)}<span>${speakerB?.displayName ?? debate.topic.sideBLabel}</span></p>` : ""}<p class="tcard-sides live-sides"><span>${debate.topic.sideALabel}</span>${versus}<span>${debate.topic.sideBLabel}</span></p><div class="live-actions"><a class="btn btn-primary" href="/debates/${encodeURIComponent(debate.slug)}">Step into the debate</a></div><p id="featured-instruction" class="live-hint"><span class="live-hint-desktop">Stay on the video to step into the debate, or click to enter.</span><span class="live-hint-touch">Tap to step into the debate.</span></p></div>
  </section>`;
}
