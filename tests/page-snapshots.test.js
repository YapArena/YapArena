// Byte-for-byte snapshots of every server-rendered page. They guard markup
// refactors: an unexpected escaping or structure change fails here. Update
// deliberately: node --test --test-update-snapshots tests/page-snapshots.test.js
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  activity,
  debate,
  empty,
  homeLists,
  hostileDebate,
  hostileProfile,
  hostileText,
  hostileTopic,
  list,
  origin,
  profile,
  snapshot,
  topic,
} from "./page-fixtures.js";

// The asset revision is read once at import time; pin it so URLs are stable.
process.env.RENDER_GIT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const web = await import("../dist/features/discovery/web.js");
const community = await import("../dist/features/community/web.js");
const legal = await import("../dist/features/discovery/legal-web.js");
const { emptyEndorsementView, endorsementView } =
  await import("./endorsement-fixtures.js");
const profileB = {
  handle: "morgan-lee",
  displayName: "Morgan Lee",
  avatarId: "yap-frog",
};
const { renderMeasurementDashboard } =
  await import("../dist/features/measurement/web.js");

it("renders the home page", (t) => {
  for (const data of Object.values(homeLists))
    snapshot(t, web.renderHome(origin, data));
  snapshot(t, web.renderHome(origin, homeLists.busy, true));
});

it("renders the live page", (t) => {
  snapshot(t, web.renderLive(origin, [], empty));
  snapshot(
    t,
    web.renderLive(
      origin,
      [
        { ...debate, status: "live" },
        { ...hostileDebate, status: "replay", speakerA: null },
      ],
      list([topic, hostileTopic]),
    ),
  );
});

it("renders the coins and match pages", (t) => {
  snapshot(t, web.renderCoins(origin));
  snapshot(t, web.renderMatchmaking(origin));
  // Live topic queue on (Decision 0011).
  snapshot(t, web.renderMatchmaking(origin, true));
});

it("renders the debate list", (t) => {
  snapshot(t, web.renderDebates(origin, empty, "missing", "all"));
  snapshot(
    t,
    web.renderDebates(
      origin,
      list([debate, hostileDebate], { limit: 1, hasMore: true }),
      "",
      "all",
    ),
  );
  snapshot(
    t,
    web.renderDebates(
      origin,
      list([debate], { limit: 1, offset: 1 }),
      "city",
      "scheduled",
    ),
  );
  snapshot(
    t,
    web.renderDebates(origin, list([hostileDebate]), hostileText("q"), "live"),
  );
});

it("renders the topic list", (t) => {
  snapshot(t, web.renderTopics(origin, empty, "missing"));
  snapshot(
    t,
    web.renderTopics(origin, list([topic], { limit: 1, hasMore: true }), ""),
  );
  snapshot(
    t,
    web.renderTopics(
      origin,
      list([hostileTopic], { limit: 1, offset: 2 }),
      hostileText("q"),
    ),
  );
  // A category chosen with the chips (and kept by the top-bar search).
  snapshot(
    t,
    web.renderTopics(
      origin,
      list([topic], { limit: 1, offset: 1, hasMore: true }),
      hostileText("q"),
      "cities",
    ),
  );
});

it("renders a topic", (t) => {
  snapshot(t, web.renderTopic(origin, topic, empty));
  snapshot(
    t,
    web.renderTopic(
      origin,
      hostileTopic,
      list([hostileDebate, { ...debate, status: "ended" }], {
        limit: 2,
        offset: 2,
        hasMore: true,
      }),
    ),
  );
  // Live topic queue on (Decision 0011); the hostile labels prove escaping.
  snapshot(t, web.renderTopic(origin, hostileTopic, empty, true));
  // Decision 0015: with revealed turns, where viewers ended up, each counted
  // debate's final figure and the figure's history.
  snapshot(
    t,
    web.renderTopic(
      origin,
      hostileTopic,
      list([debate, hostileDebate]),
      false,
      endorsementView,
    ),
  );
  // Before the first reveal, and for a topic reviewed as "side A is not yes".
  snapshot(
    t,
    web.renderTopic(origin, hostileTopic, empty, false, emptyEndorsementView),
  );
  snapshot(
    t,
    web.renderTopic(origin, topic, empty, false, {
      ...endorsementView,
      sideAIsYes: false,
    }),
  );
});

it("renders a debate", (t) => {
  for (const status of [
    "scheduled",
    "live",
    "replay",
    "finalized",
    "cancelled",
    "void_review",
  ])
    snapshot(t, web.renderDebate(origin, { ...debate, status }));
  snapshot(
    t,
    web.renderDebate(origin, {
      ...debate,
      isDemo: true,
      scheduledAt: null,
      speakerA: null,
      speakerB: {
        handle: "morgan-lee",
        displayName: "Morgan Lee",
        avatarId: "yap-frog",
      },
      sponsor: { name: "Example Sponsor", disclosure: "Sponsored listing" },
    }),
  );
  snapshot(t, web.renderDebate(origin, hostileDebate, true, activity));
  snapshot(t, web.renderDebate(origin, debate, true, null));
  // Live topic queue on (Decision 0011): the banner container above the video.
  snapshot(t, web.renderDebate(origin, debate, false, null, true));
  // Decision 0015: the last-answer bar on the video, with turn windows on, for
  // a debate asking its topic's question; plain Yes and No once the founder
  // reviews the topic as "side A is not yes".
  const counted = { ...debate, proposition: debate.topic.title };
  const withBar = (value) =>
    web.renderDebate(
      origin,
      value,
      false,
      null,
      false,
      undefined,
      undefined,
      true,
    );
  snapshot(t, withBar({ ...counted, status: "live" }));
  snapshot(t, withBar({ ...counted, status: "replay", sideAIsYes: false }));
  // Decision 0018: the mic's tab, panel, band and phone sheet on a debate
  // that can still run one; a replay only loads the script. Decision 0017:
  // "How results work" explains forecast duels with the duel switch on.
  const withMic = (value, duels = false) =>
    web.renderDebate(
      origin,
      value,
      false,
      null,
      false,
      undefined,
      undefined,
      false,
      true,
      duels,
    );
  snapshot(t, withMic({ ...debate, status: "live", speakerB: profileB }, true));
  snapshot(t, withMic({ ...debate, status: "replay" }));
});

it("shows the mic only on a debate that can still run one, with the switch on", () => {
  const page = (status, mic, duels = false) =>
    String(
      web.renderDebate(
        origin,
        { ...debate, status, speakerB: profileB },
        false,
        null,
        false,
        undefined,
        undefined,
        false,
        mic,
        duels,
      ),
    );
  for (const status of ["scheduled", "live"]) {
    const on = page(status, true);
    assert.match(on, /data-mic="true"/);
    assert.match(on, /id="arena-tab-mic"[^>]* hidden>Mic/);
    assert.match(on, /id="arena-mic" data-mic-panel/);
    assert.match(on, /data-watch-open="mic"[^>]* hidden>/);
    assert.match(on, /data-watch-sheet="mic"/);
    assert.match(on, /data-mic-band hidden/);
    assert.match(on, /data-mic-incoming aria-hidden="true" hidden/);
    assert.match(on, /assets\/mic\.css/);
    assert.match(on, /assets\/mic\.js/);
    // Each debater's first name heads their list, with its own Ask key.
    assert.match(on, /id="mic-camp-A"><span>For Alex</);
    assert.match(on, /id="mic-camp-B"><span>For Morgan</);
    assert.match(on, /data-mic-ask-open hidden>Ask Morgan</);
    // The phone full screen's invitation names both.
    assert.match(
      on,
      /data-mic-invite hidden>.*Ask Alex or Morgan your question/,
    );
    const off = page(status, false);
    for (const part of ["data-mic", "arena-tab-mic", "mic.css", "mic.js"])
      assert.equal(off.includes(part), false, part);
  }
  // A replay names its mic turns from the script and shows no list.
  const replay = page("replay", true);
  assert.match(replay, /data-mic="true"/);
  assert.match(replay, /assets\/mic\.js/);
  for (const part of ["arena-tab-mic", "data-mic-panel", "mic.css"])
    assert.equal(replay.includes(part), false, part);
  // The right panel's order: Chat (where it is a tab), Mic, Results, About.
  const live = page("live", true);
  const at = (tab) => live.indexOf(`id="arena-tab-${tab}"`);
  assert.ok(at("chat") < at("mic"));
  assert.ok(at("mic") < at("results"));
  assert.ok(at("results") < at("about"));
});

it("puts the debaters and the clock over the video, and the viewer's results with the results", () => {
  const page = String(
    web.renderDebate(origin, { ...debate, status: "live", speakerB: profileB }),
  );
  // A name tag for each debater and a timer, inside the video surface.
  const surface = page.slice(
    page.indexOf("data-arena-video"),
    page.indexOf('class="media-status-row"'),
  );
  assert.match(surface, /data-stage-tag="A">.*Alex Public/);
  assert.match(surface, /data-stage-tag="B">.*Morgan Lee/);
  assert.match(surface, /data-stage-clock role="timer"/);
  assert.match(page, /assets\/stage-hud\.js/);
  // The viewer's own results and positions sit in Results, not under Yes
  // and No.
  const panel = page.slice(
    page.indexOf("data-stake-panel"),
    page.indexOf("data-insight"),
  );
  assert.equal(panel.includes("data-stake-results"), false);
  assert.equal(panel.includes("data-stake-positions-wrap"), false);
  const results = page.slice(page.indexOf('id="arena-results"'));
  assert.ok(results.includes("data-stake-results"));
  assert.ok(results.includes("data-stake-positions-wrap"));
});

it("marks the page to start watching as it opens only with the switch on", () => {
  const page = (autoWatch) =>
    String(
      web.renderDebate(
        origin,
        { ...debate, status: "live" },
        false,
        null,
        false,
        undefined,
        undefined,
        false,
        false,
        false,
        autoWatch,
      ),
    );
  assert.match(page(true), / data-media-autowatch /);
  assert.equal(page(false).includes("data-media-autowatch"), false);
  assert.equal(
    String(web.renderDebate(origin, debate)).includes("data-media-autowatch"),
    false,
  );
});

it("explains results by the rule a debate's windows settle under", () => {
  const page = (status, duels) =>
    String(
      web.renderDebate(
        origin,
        { ...debate, status },
        false,
        null,
        false,
        undefined,
        undefined,
        false,
        false,
        duels,
      ),
    );
  const a4 = /data-results-rule="a4">Each turn, a Yes contract/;
  const duelsShown =
    /data-results-rule="duels">Each turn, you answer Yes or No/;
  assert.match(page("live", false), a4);
  assert.match(page("live", false), /data-results-rule="duels" hidden>/);
  assert.match(page("live", true), duelsShown);
  assert.match(page("live", true), /data-results-rule="a4" hidden>/);
  assert.match(page("scheduled", true), duelsShown);
  // The phone's hint about the price draw goes with A4 windows.
  assert.match(page("live", true), /data-price-hint hidden>/);
  assert.match(page("live", false), /data-price-hint> · tap a turn/);
  // A replay keeps A4's words until the page reads its windows' rule.
  assert.match(page("replay", true), a4);
});

it("shows the last-answer bar only for a counted debate with turn windows on", () => {
  const counted = {
    ...debate,
    status: "live",
    proposition: debate.topic.title,
  };
  const page = (value, bar) =>
    web.renderDebate(
      origin,
      value,
      false,
      null,
      false,
      undefined,
      undefined,
      bar,
    );
  const shown = page(counted, true);
  assert.match(shown, /data-endorsement-bar/);
  assert.match(shown, /endorsement-bar\.js/);
  assert.match(shown, /data-side-a="For" data-side-b="Against"/);
  assert.doesNotMatch(shown, /data-side-a-is-yes/);
  // Turn windows off, or a debate asking its own question: no bar, no script.
  for (const hidden of [page(counted, false), page(debate, true)]) {
    assert.doesNotMatch(hidden, /data-endorsement-bar|endorsement-bar\.js/);
    assert.doesNotMatch(hidden, /counts each account's last answer/);
  }
  // D2: the About card no longer has a latest result bar.
  assert.doesNotMatch(shown, /arena-sentiment|Latest result/);
  assert.match(
    page({ ...counted, sideAIsYes: false }, true),
    /data-side-a-is-yes="false"/,
  );
});

it("renders a profile", (t) => {
  snapshot(t, web.renderProfile(origin, profile, empty));
  snapshot(
    t,
    web.renderProfile(
      origin,
      hostileProfile,
      list([hostileDebate], { limit: 1, hasMore: true }),
    ),
  );
  snapshot(t, web.renderProfile(origin, { ...profile, bio: null }, empty));
});

it("renders the about and account pages", (t) => {
  snapshot(t, web.renderAbout(origin));
  snapshot(t, web.renderAccount(origin));
  // The Debating card and its consent wording (live outline on).
  snapshot(t, web.renderAccount(origin, true));
});

it("renders community moderation and the broadcast overlay", (t) => {
  for (const emailFirst of [false, true]) {
    snapshot(t, community.renderMyModeration(emailFirst));
    snapshot(t, community.renderModeration(emailFirst));
  }
  // Fixture from tests/site-header.test.js.
  snapshot(
    t,
    community.renderOverlay({
      proposition: "A public fixture",
      status: "live",
      topicTitle: "Topic",
      sideALabel: "For",
      sideBLabel: "Against",
    }),
  );
  snapshot(
    t,
    community.renderOverlay({
      proposition: hostileText("Proposition"),
      status: "replay",
      topicTitle: hostileText("Topic"),
      sideALabel: hostileText("For"),
      sideBLabel: hostileText("Against"),
      speakerA: hostileText("Speaker A"),
      speakerB: null,
    }),
  );
});

it("renders the measurement dashboard", (t) => {
  // Fixture from tests/site-header.test.js.
  snapshot(
    t,
    renderMeasurementDashboard({ windowDays: 28, events: [], watch: [] }, []),
  );
  snapshot(
    t,
    renderMeasurementDashboard(
      {
        windowDays: 28,
        events: [
          {
            eventType: "discovery_view",
            affiliation: "independent",
            count: 12,
          },
          { eventType: "replay_started", affiliation: "founder", count: 3 },
        ],
        watch: [
          { mode: "live", affiliation: "independent", watchedSeconds: 600 },
          { mode: "replay", affiliation: "unclassified", watchedSeconds: 59 },
        ],
      },
      [
        {
          handle: "alex-public",
          affiliation: "founder",
          reason: hostileText("Reason"),
          updatedAt: new Date("2026-10-01T17:00:00Z"),
        },
      ],
      true,
    ),
  );
});

it("renders the privacy, terms and cookie pages", (t) => {
  snapshot(t, legal.renderPrivacy(origin));
  snapshot(t, legal.renderTerms(origin));
  snapshot(t, legal.renderCookies(origin));
});

it("renders the 400, 404 and 500 pages", (t) => {
  snapshot(t, web.renderInvalidRequest(origin));
  snapshot(t, web.renderNotFound(origin));
  snapshot(t, web.renderUnavailable());
});
