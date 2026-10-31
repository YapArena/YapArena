import type { PublicDebate } from "./repository.ts";
import type { PublicBotActivity } from "../a4/public-bots.ts";
import { html } from "../../platform/html.ts";
import { inscribe } from "./inscribe.ts";

const icon = (name: "expand" | "send" | "chat" | "more" | "play" | "back") => {
  const paths = {
    expand: html`<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>`,
    send: html`<path d="M5 12h14M13 6l6 6-6 6"/>`,
    chat: html`<path d="M4 5h16v11H9l-5 4z"/>`,
    more: html`<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>`,
    play: html`<path d="M7 4l13 8-13 8z"/>`,
    back: html`<path d="M15 6l-6 6 6 6"/>`,
  };
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};

// Text set in Dydema Capitals, as on the landing (docs/landing-page.md):
// visible capitals with U shown as V, hidden from screen readers, and the real
// spelling for them.
const inscription = (text: string) =>
  html`<span class="sr-only">${text}</span><span class="ins" aria-hidden="true">${inscribe(text.toLowerCase())}</span>`;

const initials = (name: string | undefined) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// Start times are shown in Eastern time, like the Yap Coins daily claim.
function startParts(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const day = `${part("month")} ${part("day")}`;
  return {
    day,
    full: `${day} · ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`,
  };
}

export function renderDebateWorkspace(
  debate: PublicDebate,
  enabled: boolean,
  asset: (name: string) => string,
  activity?: PublicBotActivity | null,
  matchmaking = false,
  // Decision 0012: live captions and the AI outline, when enabled.
  liveOutline?: { state: unknown },
) {
  const replay = debate.status === "replay" || debate.status === "finalized";
  const live = debate.status === "live";
  const upcoming = debate.status === "scheduled" || debate.status === "ready";
  const mode = replay
    ? debate.status === "finalized"
      ? "Finalized replay"
      : "Replay"
    : live
      ? "Live"
      : debate.status === "scheduled"
        ? "Upcoming"
        : debate.status === "cancelled"
          ? "Cancelled"
          : debate.status.replaceAll("_", " ");
  const title = debate.proposition;
  const id = debate.id;
  const slug = encodeURIComponent(debate.slug);
  const timing = debate.timing ?? null;
  const start = debate.scheduledAt
    ? startParts(new Date(debate.scheduledAt))
    : null;

  // The video's empty state before the media starts and after it ends.
  const stageTitle = upcoming
    ? start
      ? `Starts ${start.full}`
      : "The stage is set"
    : live
      ? "The debate is live"
      : replay
        ? "Watch the replay"
        : debate.status === "ended"
          ? "Debate ended"
          : mode;
  const stageLine = upcoming
    ? "Video appears here when the debate begins."
    : live
      ? ""
      : replay
        ? ""
        : debate.status === "ended"
          ? ""
          : "This debate isn't taking place.";
  // The centre of the scoreboard: the turn clock (PR 2 draws the emblem
  // around it), a word when no turn is running, and the turn below it.
  const hole = upcoming
    ? (start?.day ?? "Soon")
    : replay
      ? "Replay"
      : live
        ? ""
        : "Closed";
  const turnTotal = timing
    ? `${timing.turnCount} turn${timing.turnCount === 1 ? "" : "s"}`
    : "";

  const card = (side: "A" | "B") => {
    const profile = side === "A" ? debate.speakerA : debate.speakerB;
    const label =
      side === "A" ? debate.topic.sideALabel : debate.topic.sideBLabel;
    return html`<div class="arena-side" data-side="${side}"><span class="arena-avatar" aria-hidden="true">${initials(profile?.displayName)}</span><span class="arena-side-who">${profile ? html`<a class="arena-side-name" href="/people/${encodeURIComponent(profile.handle)}">${profile.displayName}</a>` : html`<span class="arena-side-name">Speaker to be announced</span>`}<span class="arena-side-meta">${profile ? html`<span class="arena-side-handle">@${profile.handle}</span>` : ""}<span class="arena-side-state" data-side-state></span></span></span><span class="arena-side-pill">${label}</span></div>`;
  };
  // Over each debater's video: a frame that lights up while they have the
  // floor, and their name and handle, shown on hover. The scoreboard names
  // them for screen readers.
  const frame = (side: "A" | "B") => {
    const profile = side === "A" ? debate.speakerA : debate.speakerB;
    return html`<div class="arena-frame" data-side="${side}">${profile ? html`<p class="arena-frame-tag"><span class="arena-frame-name">${profile.displayName}</span><span class="arena-frame-handle">@${profile.handle}</span></p>` : ""}</div>`;
  };

  return html`<div class="arena-workspace" data-arena data-a4-inline="${id}" data-bot-history="${String(enabled)}" data-debate-id="${id}" data-demo="${String(debate.isDemo)}" data-debate-status="${debate.status}" data-emblem="${asset("landing/yaparena-emblem.png")}"${timing ? html` data-turn-count="${timing.turnCount}" data-turn-seconds="${timing.turnSeconds}"` : ""}>
    ${matchmaking ? html`<div class="queue-banner" data-queue-banner role="status" aria-live="polite" hidden></div>` : ""}<section class="arena-watch" aria-label="${replay ? "Debate replay" : "Debate broadcast"}" data-media-event="${id}" data-media-replay-player="${asset("replay.bundle.js")}"><span class="sr-only">LIVE DEBATE & REPLAY</span>
      <div class="arena-video-slot"><div class="arena-video-surface" data-arena-video>
        <div class="arena-video-overlay arena-video-topic"><h1>${title}</h1><span>${debate.topic.title}</span></div>
        <div class="arena-video-overlay arena-video-status"><span class="arena-broadcast-badge${live ? " is-live" : ""}">${live ? html`<span class="arena-live-dot" aria-hidden="true"></span>` : ""}${mode}</span>${debate.isDemo ? html`<span class="arena-demo">Demo</span>` : ""}<span class="arena-watch-count" title="Active playback tabs on this staging instance" data-arena-viewers>— watching</span><span class="arena-watch-time" data-arena-playback></span></div>
        <div class="arena-video-empty">${upcoming || replay || debate.status === "ended" ? html`<img class="arena-emblem" src="${asset("landing/yaparena-emblem.png")}" alt="" width="2048" height="1715" decoding="async">` : ""}<p class="arena-stage-title">${inscription(stageTitle)}</p><p class="arena-stage-line"${live ? html` data-turn-summary` : ""}>${stageLine}</p><div class="arena-stage-actions"><button type="button" class="arena-primary" data-media-viewer hidden>${icon("play")}Join as viewer</button><button type="button" class="arena-primary" data-media-replay hidden>${icon("play")}Play replay</button></div>${replay && timing ? html`<p class="arena-stage-line">${turnTotal} · ${clock(timing.turnCount * timing.turnSeconds)}</p>` : ""}</div>
        <div class="media-videos" data-media-videos role="group" aria-label="Live debate video"></div><div class="arena-frames" aria-hidden="true">${frame("A")}${frame("B")}</div>
        <video data-media-replay-video controls playsinline crossorigin="anonymous" preload="none" hidden><track kind="captions" src="/api/media/events/${id}/captions.vtt" srclang="en" label="English captions"></video>
        <section class="arena-chat live-chat" id="arena-chat" data-community-event="${id}" data-community-demo="${String(debate.isDemo)}" data-community-chat-panel aria-labelledby="community-chat-title"><div class="live-chat-heading"><h2 id="community-chat-title">${inscription("Chat")}</h2><span class="live-chat-connection" data-community-connection role="status" aria-live="polite">Connecting…</span><details class="chat-more" data-chat-more><summary aria-label="Like, share or report this debate">${icon("more")}</summary><div class="chat-more-panel"><div class="community-toolbar"><button type="button" data-community-like aria-pressed="false">Like this event</button><span data-community-likes>0 likes</span><button type="button" data-community-share>Copy event link</button><button type="button" data-community-refresh>Check chat now</button></div><p><a href="/debates/${slug}/qr.svg" target="_blank" rel="noopener">Event QR code ↗</a> · <a href="/overlay/${slug}" target="_blank" rel="noopener">Broadcast overlay ↗</a></p><p>Likes and chat show interest only. They are not votes or official event support.</p><form data-community-report-form><label for="community-report-reason">Reason</label><select id="community-report-reason" name="reasonCode" required><option value="">Choose a reason</option><option value="harassment">Harassment</option><option value="hate">Hate</option><option value="threat">Threat</option><option value="spam">Spam</option><option value="privacy">Privacy</option><option value="other">Other</option></select><label for="community-report-detail">What happened?</label><textarea id="community-report-detail" name="detail" minlength="10" maxlength="500" rows="3" required></textarea><button type="submit">Submit private report</button></form><a href="/account/moderation">My reports and appeals</a></div></details></div><p class="live-chat-state" data-community-chat-state role="status" aria-live="polite"></p><button type="button" class="chat-older" data-community-older hidden>Load earlier messages</button><ol class="community-messages" data-community-messages aria-label="Event chat messages" tabindex="0"></ol><button type="button" class="chat-new" data-community-new hidden></button><form data-community-chat-form><label class="sr-only" for="community-chat-body">Message this event</label><div class="arena-chat-compose"><textarea aria-describedby="community-chat-help" id="community-chat-body" name="body" maxlength="500" rows="1" placeholder="Say something…" required></textarea><button type="submit" aria-label="Send message">${icon("send")}</button></div><p class="form-help" id="community-chat-help">Published profile required. Enter sends · Shift+Enter adds a line.</p><p data-community-cooldown aria-live="off"></p><p class="sr-only" data-community-announcement role="status" aria-live="polite"></p><p data-community-send-status role="status" aria-live="polite"></p></form><p class="chat-status" role="status" aria-live="polite" data-community-status>Loading community activity…</p></section>
        <button type="button" class="arena-chat-toggle" data-chat-toggle aria-pressed="true" aria-controls="arena-chat" title="Hide chat">${icon("chat")}<span class="sr-only">Show chat over the video</span></button>
        <button type="button" class="arena-video-expand" data-video-expand aria-label="Enlarge video" aria-expanded="false" title="Enlarge video">${icon("expand")}</button>
      </div></div>${liveOutline ? html`<link rel="stylesheet" href="${asset("live-outline.css")}">` : ""}${liveOutline && !replay ? html`<div class="live-captions" data-live-captions hidden><p class="live-captions-text" data-live-captions-text></p><button type="button" class="live-captions-toggle" data-live-captions-toggle aria-pressed="true">Captions</button></div>` : ""}
      <div class="media-status-row"><p data-media-status role="status" aria-live="polite">Checking media availability…</p><p data-media-microphone role="status" aria-live="polite" hidden></p></div>
      <div class="media-actions"><button type="button" data-media-speaker hidden>Check camera and join as speaker</button><button type="button" data-media-sound hidden>Enable sound</button><button type="button" data-media-mute aria-pressed="false" hidden>Mute microphone</button><button type="button" data-media-leave hidden>Leave live debate</button></div>
      <details class="media-operator" data-media-operator hidden><summary>Operator controls</summary><label>Reason for action<input data-media-reason maxlength="500" minlength="5" placeholder="Describe the action or incident"></label><div class="media-actions"><button type="button" data-media-action="start">Start</button><button type="button" data-media-action="pause">Pause</button><button type="button" data-media-action="resume">Resume</button><button type="button" data-media-action="end">End</button><button type="button" data-media-action="replay">Publish replay</button></div><label>Reviewed WebVTT captions<textarea data-media-captions rows="5" maxlength="200000" placeholder="WEBVTT"></textarea></label><button type="button" data-media-captions-submit>Publish captions</button></details>
      <div class="arena-scoreboard" data-scoreboard><p class="sr-only" role="status" aria-live="polite" data-turn-announce></p>${card("A")}<div class="arena-turn"><div class="arena-turn-face"><strong class="arena-clock" data-media-clock aria-live="off"></strong><span class="arena-turn-hole" data-turn-hole>${hole ? inscription(hole) : ""}</span></div><span class="arena-turn-label" data-turn-label>${turnTotal && !live ? inscription(turnTotal) : ""}</span></div>${card("B")}</div>
    </section>
    <aside class="arena-rail" aria-label="Your answer, the AI outline and results">
      <section class="stake-panel" data-stake-panel data-debate-id="${id}" data-debate-slug="${debate.slug}" data-debate-status="${debate.status}" data-speaker-a="${debate.speakerA?.displayName ?? "Speaker A"}" data-speaker-b="${debate.speakerB?.displayName ?? "Speaker B"}" data-side-a="${debate.topic.sideALabel}" data-side-b="${debate.topic.sideBLabel}" data-scheduled-at="${debate.scheduledAt ? new Date(debate.scheduledAt).toISOString() : ""}" aria-labelledby="stake-question"><button type="button" class="stake-sheet-close" data-sheet-close>${icon("back")}Back</button><div class="stake-turn" data-stake-turn hidden><strong class="stake-turn-title" data-stake-turn-title></strong><p class="stake-meta" data-stake-meta></p><span class="stake-clock" data-stake-clock></span><div class="stake-progress" data-stake-progress role="progressbar" aria-label="Time left to answer this turn" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div><p class="stake-status" data-stake-status role="status" aria-live="polite">Checking this debate's Yap Coins rounds…</p><h2 class="stake-question" id="stake-question">${inscription("Do you agree?")}</h2><p class="stake-proposition">${debate.proposition}</p><div class="stake-sides" role="group" aria-label="Your answer"><button type="button" class="stake-side stake-yes" data-stake-side="YES" aria-pressed="false" disabled>Yes</button><button type="button" class="stake-side stake-no" data-stake-side="NO" aria-pressed="false" disabled>No</button></div><button type="button" class="stake-repeat" data-stake-repeat hidden></button><form class="stake-ready" data-stake-ready aria-labelledby="stake-ready-title" hidden><h3 id="stake-ready-title">${inscription("Get ready")}</h3><p>Save your usual size and read on this device. The ticket opens with them when the debate starts; you still confirm each answer.</p><fieldset class="stake-size"><legend>Size · each contract pays 0–1 YC</legend><div class="stake-chips">${[5, 10, 25, 50, 100].map((size) => html`<button type="button" data-stake-ready-size="${size}" aria-pressed="${String(size === 10)}">${size}</button>`)}</div><label class="stake-size-input">Contracts<input name="size" inputmode="numeric" value="10" autocomplete="off" required></label></fieldset><label class="stake-read">Your usual read: what share will say yes?<span class="stake-read-row"><input type="range" name="read" min="1" max="99" step="1" value="50"><output data-stake-ready-read-out>50%</output></span></label><button type="submit" class="stake-ready-save">Save on this device</button><p class="stake-ready-note" data-stake-ready-note role="status" aria-live="polite"></p></form><form class="stake-ticket" data-stake-ticket hidden><fieldset class="stake-size"><legend>Size · each contract pays 0–1 YC</legend><div class="stake-chips">${[5, 10, 25, 50, 100].map((size) => html`<button type="button" data-stake-size="${size}" aria-pressed="${String(size === 10)}">${size}</button>`)}</div><label class="stake-size-input">Contracts<input name="size" inputmode="numeric" value="10" autocomplete="off" required></label></fieldset><label class="stake-read" data-stake-read-wrap>What share will say yes this turn?<span class="stake-read-row"><input type="range" name="read" min="1" max="99" step="1" value="50"><output data-stake-read-out>50%</output></span></label><p class="stake-ceiling" data-stake-ceiling></p><details class="stake-advanced" data-stake-advanced><summary>Set a maximum price instead</summary><label>Maximum price per contract (0.01–0.99 YC)<input name="ceiling" inputmode="decimal" autocomplete="off" placeholder="0.50"></label></details><dl class="stake-terms"><div><dt>Reserved now</dt><dd data-stake-term="reserved"></dd></div><div><dt>Most you can lose</dt><dd data-stake-term="lose"></dd></div><div><dt>You get back</dt><dd data-stake-term="back"></dd></div><div><dt>Fee</dt><dd>None</dd></div><div><dt>Results</dt><dd data-stake-term="results"></dd></div></dl><label class="stake-review-choice"><input type="checkbox" data-stake-review-choice> Review in a pop-up before placing</label><p class="stake-error" data-stake-error role="alert"></p><button type="submit" class="stake-confirm" data-stake-confirm></button><p class="stake-final">Final once placed. Yap Coins are play money with no cash value.</p></form><div class="stake-receipt" data-stake-receipt hidden></div><p class="stake-balance" data-stake-balance></p><p class="stake-signin" data-stake-signin hidden><a href="/account?next=${encodeURIComponent("/debates/" + debate.slug)}">Sign in to answer →</a></p><section class="stake-results" data-stake-results aria-labelledby="stake-results-title" hidden><h3 id="stake-results-title" data-stake-results-title></h3><ul data-stake-results-list></ul></section><details class="stake-positions" data-stake-positions-wrap hidden><summary>Your positions <span data-stake-positions-count></span></summary><ul data-stake-positions></ul></details><dialog class="information-card stake-review" data-stake-review aria-labelledby="stake-review-title"><h2 id="stake-review-title">Review your position</h2><dl class="stake-terms" data-stake-review-terms></dl><p>Final once placed. You can't edit or cancel it.</p><div class="stake-review-actions"><button type="button" class="button" data-stake-review-place>Place it</button><button type="button" data-stake-review-back>Back</button></div></dialog></section>
      <section class="arena-insight" data-insight aria-label="AI outline, results and about"><div class="arena-tabs" role="tablist" aria-label="Show" data-arena-tabs>${liveOutline ? html`<button type="button" role="tab" id="arena-tab-outline" aria-controls="arena-outline" aria-selected="true">AI outline</button>` : ""}<button type="button" role="tab" id="arena-tab-chat" aria-controls="arena-chat" aria-selected="false" tabindex="-1">Chat<span data-chat-unseen></span></button><button type="button" role="tab" id="arena-tab-results" aria-controls="arena-results" aria-selected="${String(!liveOutline)}"${liveOutline ? html` tabindex="-1"` : ""}>Results</button><button type="button" role="tab" id="arena-tab-about" aria-controls="arena-about" aria-selected="false" tabindex="-1">About</button></div>
${
  liveOutline
    ? html`<section class="live-outline" id="arena-outline" data-live-outline${live ? html` data-outline-live` : ""} aria-labelledby="live-outline-title"><header class="live-outline-head"><h2 id="live-outline-title">${inscription("AI outline")}</h2></header><div class="live-outline-body" tabindex="0" aria-label="AI outline, newest turn first"><div class="live-outline-group live-outline-now"><p class="live-outline-turn" data-live-outline-turn>Appears when a debater speaks</p><ol class="live-outline-arguments live-outline-current" data-live-outline-arguments></ol></div><div class="live-outline-earlier" data-live-outline-earlier hidden><h3 class="sr-only">Earlier turns</h3><ol data-live-outline-turns></ol></div></div><p class="live-outline-note">Written by AI from the live transcript, in the speaker’s language. It can be wrong; debaters can flag mistakes.</p><p class="sr-only" role="status" aria-live="polite" data-live-outline-announce></p><template data-live-outline-state>${JSON.stringify(
        {
          debateId: id,
          live,
          replay,
          sides: {
            A: {
              name: debate.speakerA?.displayName ?? null,
              label: debate.topic.sideALabel,
            },
            B: {
              name: debate.speakerB?.displayName ?? null,
              label: debate.topic.sideBLabel,
            },
          },
          state: liveOutline.state,
        },
      )}</template></section>`
    : ""
}
      <section class="arena-results" id="arena-results" aria-labelledby="arena-results-title"><div class="arena-chart-panel"><h2 class="arena-section-title" id="arena-results-title">${inscription("Results by turn")}</h2><div class="arena-graph-main" data-arena-graph-main><div class="arena-chart-top"><div class="arena-round-state"><span data-arena-round-label>Round history</span><span class="arena-state-chip" data-arena-round-state>${replay ? "replay" : "waiting"}</span></div><span data-arena-countdown aria-live="off">Waiting for a round</span><div class="arena-volume"><span>Coins traded in these rounds</span><strong data-arena-volume>— Yap Coins</strong><small data-arena-participants>Revealed answers</small></div></div><p class="arena-chart-question">Share of people who said yes to:</p><h3 id="arena-chart-title">“${title}”</h3><div class="arena-chart-wrap" data-arena-chart><div class="arena-chart-plot"><svg class="arena-chart" viewBox="0 0 720 330" role="group" aria-labelledby="endorsement-chart-title endorsement-chart-desc"><title id="endorsement-chart-title">Share of yes answers by round</title><desc id="endorsement-chart-desc">Yes and no shares appear once each round’s results are revealed.</desc><defs><linearGradient id="arena-yes-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f7f7f7" stop-opacity=".28"/><stop offset="100%" stop-color="#f7f7f7" stop-opacity="0"/></linearGradient><linearGradient id="arena-no-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff536c" stop-opacity=".16"/><stop offset="100%" stop-color="#ff536c" stop-opacity="0"/></linearGradient></defs><g class="arena-chart-grid">${[0, 25, 50, 75, 100].map((p) => html`<line x1="46" x2="652" y1="${284 - p * 2.5}" y2="${284 - p * 2.5}"/><text x="34" y="${289 - p * 2.5}" text-anchor="end">${p}%</text>`)}</g><g data-chart-series></g><g data-chart-ticks></g><g data-chart-badges pointer-events="none"></g><g data-chart-cursor pointer-events="none"></g></svg><div class="arena-chart-empty" data-chart-empty>${enabled ? "No revealed results or shared bot history for this debate yet." : "Results appear here once a turn's Yap Coins results are revealed."}</div></div><section class="arena-price-inspector" aria-labelledby="arena-price-title"><svg class="arena-price-scale" viewBox="0 0 720 104" role="img" aria-labelledby="arena-price-scale-title"><title id="arena-price-scale-title">Typical limits and drawn price, shown once results are revealed</title><line x1="46" x2="652" y1="28" y2="28" class="arena-price-track"/><g data-price-drawing></g>${[0, 25, 50, 75, 100].map((p) => html`<line x1="${46 + p * 6.06}" x2="${46 + p * 6.06}" y1="48" y2="53" class="arena-price-tick"/><text x="${46 + p * 6.06}" y="91" text-anchor="middle">${p === 100 ? "1 YC" : p ? (p / 100).toFixed(2) : "0"}</text>`)}</svg><div class="arena-price-heading"><h4 id="arena-price-title">Price and typical limits</h4><div class="arena-price-navigation"><button type="button" data-price-previous aria-label="Previous settled round" disabled>←</button><label class="sr-only" for="arena-price-round">Inspect a settled round</label><select id="arena-price-round" data-price-round disabled><option value="">No settled rounds</option></select><button type="button" data-price-next aria-label="Next settled round" disabled>→</button></div></div><p class="arena-price-context" data-price-context>Choose a round to see its drawn price.</p><div class="arena-offer-values"><div><span>Drawn Yes price</span><strong data-price-yes>—</strong></div><div><span>No price</span><strong data-price-no>—</strong></div></div><p class="arena-price-explanation" data-price-explanation>Typical limits stay hidden until a turn’s results are revealed.</p><p class="arena-price-legend"><span class="lavender">● Typical limits / drawn price</span><span class="yes">│ Final yes share</span></p></section></div><div class="arena-chart-footer"><div class="arena-chart-key"><span class="yes">● YES</span><span class="no">● NO</span></div><span class="arena-sync" data-arena-sync>Revealed results · updates automatically</span></div><p class="arena-chart-help">Hover, touch or use arrow keys to inspect a round and its argument. Results stay hidden until they’re revealed.</p></div></div><section class="arena-arguments" data-shared-arguments hidden><h2>Behind the position <small>Synthetic argument endorsements</small></h2><div data-shared-argument-list></div></section></section>
      <section class="arena-about arena-info-card" id="arena-about" aria-labelledby="arena-info-title"><h2 class="arena-section-title" id="arena-info-title">${inscription("About this debate")}</h2><p class="arena-about-lead">A ${replay ? "recorded" : "public"} debate on <a href="/topics/${encodeURIComponent(debate.topic.slug)}">${debate.topic.title}</a> · ${debate.isDemo ? "Synthetic demo" : "Public debate"}</p><div class="arena-about-grid"><dl class="arena-info"><div><dt>Debate</dt><dd>${mode}</dd></div><div><dt>Scheduled</dt><dd>${start ? start.full : "To be announced"}</dd></div><div><dt>Rules version</dt><dd>${debate.rulesVersion}</dd></div><div><dt>How results work</dt><dd>Each turn, a Yes contract pays the share of people who said yes, and a No contract the share who said no. Every answer counts once, whatever its size.</dd></div></dl><div class="arena-sentiment"><h3>Latest result <small data-arena-sentiment-caption>Latest revealed round</small></h3><div class="arena-sentiment-bar" role="img" aria-label="No settled endorsement share yet" data-arena-sentiment-bar data-empty="true"><span></span></div><div class="arena-sentiment-values"><strong class="yes" data-arena-yes>—</strong><strong class="no" data-arena-no>—</strong></div><p data-arena-scope>Human rounds and private bot sandboxes are shown separately.</p></div></div><p class="arena-info-note">The chart shows each turn's share of yes answers once its results are revealed.${enabled ? " Before that, it shows labeled practice rounds played by bots." : ""}</p>${enabled ? html`<p class="arena-bots-link"><a href="/coins?debate=${id}">Practice with bots →</a></p>` : ""}<p class="arena-about-links"><a href="/debates/${slug}/qr.svg" target="_blank" rel="noopener">Event QR code ↗</a> · <a href="/overlay/${slug}" target="_blank" rel="noopener">Broadcast overlay ↗</a> · <a href="/account/moderation">My reports and appeals</a></p><p class="arena-about-links arena-site-links"><a href="/topics">Topics</a> · <a href="/coins">Yap Coins</a> · <a href="/about">About YAP Arena</a></p><p class="arena-disclosure">Yap Coins are play money with no cash value.${enabled ? html`<br>Bot activity is synthetic and labeled.` : ""}</p></section></section>
    </aside>
    <script type="module" src="${asset("a4-inline.js")}"></script>
    ${activity ? html`<template data-shared-bootstrap>${JSON.stringify(activity)}</template>` : ""}<script type="module" src="${asset("arena.js")}"></script><script type="module" src="${asset("stake-panel.js")}"></script><script type="module" src="${asset("media.bundle.js")}"></script><script type="module" src="${asset("community.js")}"></script><script type="module" src="${asset("debate-layout.js")}"></script><script type="module" src="${asset("turn-clock.js")}"></script>
  </div>`;
}
