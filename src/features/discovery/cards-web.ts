// The debate and topic cards of the site kit (docs/site-design.md#cards).
// Explore, Topics, topic pages and profiles list them; Home and Live follow.
import { html } from "../../platform/html.ts";
import { inscription } from "./kit-web.ts";
import { personSlot } from "./avatar-web.ts";
import type { PublicDebate, PublicTopic } from "./repository.ts";

export const statusLabels: Record<PublicDebate["status"], string> = {
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

const path = (value: string) => encodeURIComponent(value);

export const debateDate = (value: Date | null) =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "To be announced";

const versus = html`<span class="vs"><span class="sr-only">versus</span><span aria-hidden="true">VS</span></span>`;

const demoTag = (demo: boolean) =>
  demo ? html`<span class="tag tag-quiet">Demo</span>` : "";

export function statusTag(status: PublicDebate["status"]) {
  return status === "live"
    ? html`<span class="tag tag-live"><span class="live-pixel" aria-hidden="true"></span>${statusLabels.live}</span>`
    : html`<span class="tag">${statusLabels[status]}</span>`;
}

// A debate: a picture (the recording's still for replays, laid over both
// speakers' panes, which show whenever there is no still), then the topic, the
// proposition and both speakers. The whole card is the link. The media router
// serves stills for replays and finalized debates only; frontend/site.ts hides
// one that fails to load.
export function debateCard(debate: PublicDebate) {
  const { speakerA, speakerB, topic } = debate;
  const still = debate.status === "replay" || debate.status === "finalized";
  const stamp =
    debate.status === "scheduled"
      ? debateDate(debate.scheduledAt)
      : debate.status === "live"
        ? "Happening now"
        : "Debate archive";
  const nameA = speakerA?.displayName ?? topic.sideALabel;
  const nameB = speakerB?.displayName ?? topic.sideBLabel;
  return html`<article class="dcard"><div class="dcard-thumb"><span class="dcard-panes" aria-hidden="true"><span class="dcard-pane">${personSlot(speakerA, 48)}</span><span class="dcard-pane">${personSlot(speakerB, 48)}</span></span>${still ? html`<img class="dcard-still" src="/api/media/events/${debate.id}/thumbnail" alt="" loading="lazy" decoding="async">` : ""}${statusTag(debate.status)}<span class="dcard-stamp">${stamp}</span></div><div class="dcard-body"><p class="dcard-meta"><span>${topic.title}</span>${demoTag(debate.isDemo)}</p><h3 class="dcard-title"><a href="/debates/${path(debate.slug)}">${debate.proposition}</a></h3><p class="dcard-people">${personSlot(speakerA, 24)}<span>${nameA}</span>${versus}${personSlot(speakerB, 24)}<span>${nameB}</span></p></div></article>`;
}

// A topic: the title in Forum, the summary (three lines at most) and its two
// sides. The whole card is the link.
export function topicCard(topic: PublicTopic) {
  return html`<article class="tcard card"><p class="dcard-meta"><span class="tcard-kicker">${inscription("Topic")}</span>${demoTag(topic.isDemo)}</p><h3 class="tcard-title"><a href="/topics/${path(topic.slug)}">${topic.title}</a></h3><p class="tcard-summary">${topic.summary}</p><p class="tcard-sides"><span>${topic.sideALabel}</span>${versus}<span>${topic.sideBLabel}</span></p></article>`;
}
