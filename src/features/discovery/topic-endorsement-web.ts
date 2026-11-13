// Decision 0015: the topic page's last-answer figure, how answers changed, and
// the figure's history after each revealed turn (docs/site-design.md#topic-history).
// The history chart is drawn here for a first paint and redrawn by
// frontend/topic-chart.ts, which reads the points from
// <template id="topic-endorsement-data">.
import type {
  EndorsementDebateResult,
  Switching,
} from "../endorsement/types.ts";
import type { TopicEndorsementView } from "../endorsement/topic-page.ts";
import { html } from "../../platform/html.ts";
import { inscription } from "./kit-web.ts";
import type { PublicTopic } from "./public-types.ts";
import {
  TOPIC_RANGES,
  accountsText,
  changeSince,
  topicEndorsementGeometry,
  wholePercent,
  yesShare,
  type TopicChartData,
} from "./topic-endorsement-chart.ts";

export type { TopicEndorsementView };

const count = (value: number) => value.toLocaleString("en-US");

/** A share of a whole, in whole percent; null without a whole. */
const share = (part: number, whole: number) =>
  whole > 0 ? Math.round((part * 100) / whole) : null;

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

/** "Final: 52% Yes · 140 accounts" under a counted debate's card. */
export function debateFinalLine(result: EndorsementDebateResult | undefined) {
  if (!result || result.accounts === 0) return "";
  return html`<p class="dcard-final">Final: <strong class="num">${wholePercent(yesShare(result))}%</strong> Yes · ${accountsText(result.accounts)}</p>`;
}

/** The sentences of "How answers changed" (D10). */
export function switchingText(s: Switching): string[] {
  const multi = s.multiAnswerAccounts;
  if (!multi) return ["No account has answered more than once yet."];
  const answered = `${accountsText(multi)} answered more than once`;
  if (!s.switchers) return [`${answered}; none changed answer.`];
  const lines = [
    `${answered}; ${share(s.switchers, multi)}% of them changed answer at least once (${share(s.stayed, multi)}% kept the new side, ${share(s.cameBack, multi)}% came back).`,
  ];
  const pairs = [
    s.pairs.within
      ? `${share(s.switches.within, s.pairs.within)}% within a debate`
      : "",
    s.pairs.between
      ? `${share(s.switches.between, s.pairs.between)}% between debates`
      : "",
  ].filter(Boolean);
  if (pairs.length) lines.push(`Changes per answer pair: ${pairs.join(", ")}.`);
  const changes = s.toYes + s.toNo;
  if (changes)
    lines.push(`${share(s.toYes, changes)}% of changes were toward Yes.`);
  return lines;
}

const rangeButtons = html`<div class="ya-segments" role="group" aria-label="Chart period">${TOPIC_RANGES.map((range, index) => html`<button type="button" data-range="${range}" aria-pressed="${String(index === 0)}">${range}</button>`)}</div>`;

/**
 * The figure, above the topic's debates. Without a revealed turn it says when
 * the figure starts.
 */
export function topicFigureMarkup(
  topic: PublicTopic,
  view: TopicEndorsementView,
) {
  const figure = view.figure;
  const head = html`<div class="section-head"><p class="kicker">${inscription("Last answers")}</p><h2 class="section-title" id="topic-endorsement-title">${inscription("Where viewers ended up")}</h2></div>`;
  if (!figure || figure.accounts === 0)
    return html`<section class="container page-section topic-endorsement" aria-labelledby="topic-endorsement-title" data-topic-endorsement>${head}<div class="card topic-figure"><p class="topic-figure-empty">The figure starts when a debate's first turn is revealed. Answers in 5-day debates are revealed 5 days after the debate ends.</p></div></section>`;
  const side = view.sideAIsYes
    ? html` (<strong>${topic.sideALabel}</strong>)`
    : "";
  const meta = [
    figure.lastDebate?.liveEndedAt
      ? `Last debate: ${longDate(figure.lastDebate.liveEndedAt)}`
      : "",
    `${count(figure.debatesCounted)} debate${figure.debatesCounted === 1 ? "" : "s"} counted`,
  ].filter(Boolean);
  return html`<section class="container page-section topic-endorsement" aria-labelledby="topic-endorsement-title" data-topic-endorsement>${head}<div class="topic-figure-grid"><div class="card topic-figure"><p class="topic-figure-lead">Of <strong class="num">${count(figure.accounts)}</strong> ${figure.accounts === 1 ? "account" : "accounts"}, <strong class="num">${wholePercent(yesShare(figure))}%</strong> last answered Yes${side}.</p><p class="topic-figure-note">Not a vote, a price or a forecast.</p><p class="topic-figure-meta">${meta.join(" · ")}</p></div><div class="card topic-changes"><h3 class="topic-changes-title">How answers changed</h3>${switchingText(figure.switching).map((line) => html`<p>${line}</p>`)}</div></div></section>`;
}

/**
 * The figure's history under the topic's debates, with the data its script
 * redraws from. Nothing before the first revealed turn.
 */
export function topicHistoryMarkup(view: TopicEndorsementView) {
  const data: TopicChartData = {
    points: view.history.map(
      ({ id, revealedAt, turnNumber, debate, yes, accounts }) => ({
        id,
        revealedAt,
        turnNumber,
        debate,
        yes,
        accounts,
      }),
    ),
  };
  const c = topicEndorsementGeometry(data.points, "All", 800);
  const latest = c.shown.at(-1);
  if (!latest) return "";
  return html`<section class="container page-section topic-history" aria-labelledby="topic-history-title" data-topic-history><div class="section-head"><p class="kicker">${inscription("After each revealed turn")}</p><h2 class="section-title" id="topic-history-title">${inscription("Endorsement history")}</h2></div><div class="card topic-chart-card"><div class="topic-chart-bar"><p class="topic-chart-legend"><i aria-hidden="true"></i><span>Yes</span> <strong class="num" id="ya-legend">${wholePercent(yesShare(latest))}%</strong></p><div class="topic-chart-tools">${rangeButtons}</div></div><svg id="ya-chart" class="ya-chart" role="img" aria-label="Topic figure after each revealed turn" viewBox="0 0 ${c.w} ${c.h}" data-latest-point="${latest.id}">${c.markup}</svg><p class="topic-chart-meta"><span id="ya-metric-label">Each point counts every account's last answer once a turn is revealed.</span> <span class="ya-change${changeSince(c.shown).startsWith("−") ? " down" : ""}" id="ya-change">${changeSince(c.shown)}</span></p></div><div id="ya-chart-tooltip" class="ya-chart-tooltip" role="tooltip" aria-hidden="true"><span data-tip-head></span><span><strong data-tip-value></strong> <span data-tip-rest></span></span></div></section><template id="topic-endorsement-data">${JSON.stringify(data)}</template>`;
}
