// Decision 0015: the topic page's figure, its copy and the history chart's
// geometry (ordinal x, ranges counted back from the latest point, tooltip).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountsText,
  changeSince,
  pointText,
  rangePoints,
  topicEndorsementGeometry,
  TOPIC_RANGES,
} from "../dist/features/discovery/topic-endorsement-chart.js";
import {
  debateFinalLine,
  switchingText,
  topicFigureMarkup,
  topicHistoryMarkup,
} from "../dist/features/discovery/topic-endorsement-web.js";
import { renderTopic } from "../dist/features/discovery/web.js";
import {
  emptyEndorsementView,
  endorsementView,
  history,
  noSwitching,
  switching,
} from "./endorsement-fixtures.js";
import { debate, hostileTopic, list, origin, topic } from "./page-fixtures.js";

describe("the topic figure's history chart", () => {
  it("offers All first, then 1D, 1W and 1M", () => {
    assert.deepEqual(TOPIC_RANGES, ["All", "1D", "1W", "1M"]);
  });

  it("counts each range back from the latest point, keeping its debate", () => {
    assert.deepEqual(
      rangePoints(history, "All").map((p) => p.id),
      ["1", "2", "3", "4", "5", "6", "7"],
    );
    // The last debate's three points share one reveal instant.
    assert.deepEqual(
      rangePoints(history, "1D").map((p) => p.id),
      ["5", "6", "7"],
    );
    // Nov 5 18:01 is within a week of Nov 12 14:00.
    assert.equal(rangePoints(history, "1W").length, 7);
    assert.deepEqual(
      rangePoints(history.slice(2), "1W").map((p) => p.id),
      ["3", "4", "5", "6", "7"],
    );
    assert.equal(rangePoints(history, "1M").length, 7);
    // A short range still shows every point of the latest debate.
    const spread = history.map((p, i) => ({
      ...p,
      revealedAt: new Date(Date.UTC(2026, 10, 1 + i * 2)).toISOString(),
      debate: i < 3 ? history[0].debate : history[6].debate,
    }));
    assert.deepEqual(
      rangePoints(spread, "1D").map((p) => p.id),
      ["4", "5", "6", "7"],
    );
    // A hidden debate keeps its points but no run to extend.
    const hidden = history.map((p) => ({ ...p, debate: null }));
    assert.deepEqual(
      rangePoints(hidden, "1D").map((p) => p.id),
      ["5", "6", "7"],
    );
    // Points without accounts have no share.
    assert.deepEqual(
      rangePoints([{ ...history[0], yes: 0, accounts: 0 }, history[1]], "All")
        .length,
      1,
    );
    assert.deepEqual(rangePoints([], "1W"), []);
  });

  it("places points by position, not by time", () => {
    const c = topicEndorsementGeometry(history, "All", 800, 240);
    assert.equal(c.shown.length, 7);
    const plot = c.w - c.left - c.right;
    c.shown.forEach((_, i) =>
      assert.ok(Math.abs(c.x(i) - (c.left + (i / 6) * plot)) < 1e-9),
    );
    assert.equal(c.nearest(c.left - 50), 0);
    assert.equal(c.nearest(c.x(3) + 2), 3);
    assert.equal(c.nearest(c.w + 50), 6);
    const svg = String(c.markup);
    assert.match(svg, /<title>Topic figure after each revealed turn<\/title>/);
    assert.equal((svg.match(/class="ya-guide"/g) ?? []).length, 5);
    assert.match(svg, /class="ya-linepath"/);
    assert.match(svg, /data-chart-hover-marker/);
    assert.match(svg, /data-chart-hit/);
    // The guides span the shares with a 3 point margin, within 0–100.
    assert.equal(c.y(37), c.h - c.bottom);
    assert.equal(c.y(55), c.top);
    // Five dates under the line: the points' own.
    assert.deepEqual(
      [...svg.matchAll(/text-anchor="(start|middle|end)">([^<]+)</g)].map(
        (m) => m[2],
      ),
      ["Nov 5", "Nov 6", "Nov 6", "Nov 12", "Nov 12"],
    );
    // Within one day the labels are times.
    const day = String(topicEndorsementGeometry(history, "1D").markup);
    assert.match(day, /text-anchor="end">14:00</);
  });

  it("draws one point at the right end and nothing without points", () => {
    const one = topicEndorsementGeometry([history[0]], "All", 400);
    assert.equal(one.x(0), one.w - one.right);
    assert.equal(one.nearest(10), 0);
    assert.match(String(one.markup), /text-anchor="end">Nov 5</);
    const none = topicEndorsementGeometry([], "All", 100);
    assert.equal(none.w, 190);
    assert.equal(none.shown.length, 0);
    assert.doesNotMatch(String(none.markup), /ya-linepath/);
  });

  it("names the turn, its debate and the figure then", () => {
    assert.deepEqual(pointText(history[6]), {
      head: `Nov 12 · Turn 3 · ${history[6].debate.title}`,
      value: "47%",
      rest: "Yes · 3,491 accounts",
      label: `Nov 12 · Turn 3 · ${history[6].debate.title}: 47% Yes · 3,491 accounts`,
    });
    assert.equal(
      pointText({ ...history[0], debate: null, yes: 1, accounts: 1 }).head,
      "Nov 5 · Turn 1",
    );
    assert.equal(accountsText(1), "1 account");
    assert.equal(accountsText(1200), "1,200 accounts");
  });

  it("says how far the figure moved since the first point shown", () => {
    assert.equal(changeSince(history), "+7 pts since Nov 5");
    assert.equal(changeSince(history, 1), "+12 pts since Nov 5");
    assert.equal(changeSince(history.slice(4)), "No change since Nov 12");
    assert.equal(changeSince([history[1], history[0]]), "−12 pts since Nov 5");
    assert.equal(
      changeSince([
        { ...history[0], yes: 50 },
        { ...history[0], yes: 51 },
      ]),
      "+1 pt since Nov 5",
    );
    assert.equal(changeSince([history[0]]), "");
    assert.equal(changeSince([]), "");
  });
});

describe("the topic page's last-answer figure", () => {
  it("states the figure, its last debate and how many debates count", () => {
    const section = String(topicFigureMarkup(topic, endorsementView));
    assert.match(section, /aria-labelledby="topic-endorsement-title"/);
    assert.match(
      section,
      /Of <strong class="num">3,491<\/strong> accounts, <strong class="num">47%<\/strong> last answered Yes \(<strong>For<\/strong>\)\./,
    );
    assert.match(section, /Not a vote, a price or a forecast\./);
    assert.match(section, /Last debate: Nov 7, 2026 · 14 debates counted/);
    assert.match(section, /How answers changed/);
  });

  it("drops the side label when side A is not the yes side (D4)", () => {
    const section = String(
      topicFigureMarkup(topic, { ...endorsementView, sideAIsYes: false }),
    );
    assert.match(section, /last answered Yes\./);
    assert.doesNotMatch(section, /\(<strong>For<\/strong>\)/);
  });

  it("escapes the side label and words the edge cases", () => {
    const section = String(
      topicFigureMarkup(hostileTopic, {
        ...endorsementView,
        figure: {
          ...endorsementView.figure,
          yes: 1,
          accounts: 1,
          lastDebate: null,
          debatesCounted: 1,
        },
      }),
    );
    assert.doesNotMatch(section, /<b>/);
    assert.match(section, /Side A &lt;b&gt;&amp;amp;&lt;\/b&gt;/);
    assert.match(section, /Of <strong class="num">1<\/strong> account,/);
    assert.match(section, /<p class="topic-figure-meta">1 debate counted<\/p>/);
  });

  it("says when the figure starts before a turn is revealed", () => {
    const section = String(topicFigureMarkup(topic, emptyEndorsementView));
    assert.match(
      section,
      /The figure starts when a debate's first turn is revealed\. Answers in 5-day debates are revealed 5 days after the debate ends\./,
    );
    assert.equal(topicHistoryMarkup(emptyEndorsementView), "");
  });

  it("words how answers changed (D10)", () => {
    assert.deepEqual(switchingText(switching), [
      "412 accounts answered more than once; 18% of them changed answer at least once (12% kept the new side, 6% came back).",
      "Changes per answer pair: 4% within a debate, 9% between debates.",
      "60% of changes were toward Yes.",
    ]);
    assert.deepEqual(switchingText(noSwitching), [
      "No account has answered more than once yet.",
    ]);
    assert.deepEqual(
      switchingText({ ...noSwitching, multiAnswerAccounts: 1 }),
      ["1 account answered more than once; none changed answer."],
    );
    assert.deepEqual(
      switchingText({
        ...switching,
        pairs: { within: 0, between: 200 },
        switches: { within: 0, between: 30 },
        toYes: 0,
        toNo: 30,
      }).slice(1),
      [
        "Changes per answer pair: 15% between debates.",
        "0% of changes were toward Yes.",
      ],
    );
  });

  it("adds a final line to counted debates only", () => {
    assert.equal(debateFinalLine(undefined), "");
    assert.equal(
      debateFinalLine({ ...endorsementView.debates[0], accounts: 0, yes: 0 }),
      "",
    );
    assert.equal(
      String(debateFinalLine(endorsementView.debates[0])),
      '<p class="dcard-final">Final: <strong class="num">52%</strong> Yes · 140 accounts</p>',
    );
    const page = renderTopic(
      origin,
      topic,
      list([debate, { ...debate, id: "other", slug: "other-debate" }]),
      false,
      endorsementView,
    );
    assert.equal((page.match(/class="dcard-final"/g) ?? []).length, 1);
  });

  it("embeds the history points for the page's script", () => {
    const section = String(topicHistoryMarkup(endorsementView));
    assert.match(section, /id="ya-legend">47%</);
    assert.match(section, /data-range="All" aria-pressed="true">All</);
    assert.match(section, /data-range="1M" aria-pressed="false">1M</);
    assert.match(
      section,
      /role="img" aria-label="Topic figure after each revealed turn"/,
    );
    assert.match(section, /data-latest-point="7"/);
    assert.match(section, /id="ya-change">\+7 pts since Nov 5</);
    assert.match(section, /<template id="topic-endorsement-data">/);
    const json = section
      .split('<template id="topic-endorsement-data">')[1]
      .split("</template>")[0]
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    assert.deepEqual(JSON.parse(json), { points: history });
    // A fall marks the change line.
    const down = String(
      topicHistoryMarkup({
        ...endorsementView,
        history: [history[1], history[0]],
      }),
    );
    assert.match(down, /class="ya-change down" id="ya-change">−12 pts/);
  });
});
