// Byte-for-byte snapshots of every server-rendered page. They guard markup
// refactors: an unexpected escaping or structure change fails here. Update
// deliberately: node --test --test-update-snapshots tests/page-snapshots.test.js
import { it } from "node:test";
import {
  activity,
  debate,
  empty,
  homes,
  hostileDebate,
  hostileProfile,
  hostileText,
  hostileTopic,
  list,
  origin,
  profile,
  publicHome,
  snapshot,
  topic,
} from "./page-fixtures.js";

// The asset revision is read once at import time; pin it so URLs are stable.
process.env.RENDER_GIT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const web = await import("../dist/features/discovery/web.js");
const community = await import("../dist/features/community/web.js");
const { renderMeasurementDashboard } =
  await import("../dist/features/measurement/web.js");

it("renders the home page", (t) => {
  snapshot(t, web.renderHome(origin));
  for (const data of Object.values(homes))
    snapshot(t, web.renderHome(origin, data));
  snapshot(t, web.renderHome(origin, publicHome, true));
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
      speakerB: { handle: "morgan-lee", displayName: "Morgan Lee" },
      sponsor: { name: "Example Sponsor", disclosure: "Sponsored listing" },
    }),
  );
  snapshot(t, web.renderDebate(origin, hostileDebate, true, activity));
  snapshot(t, web.renderDebate(origin, debate, true, null));
  // Live topic queue on (Decision 0011): the banner container above the video.
  snapshot(t, web.renderDebate(origin, debate, false, null, true));
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

it("renders the 400, 404 and 500 pages", (t) => {
  snapshot(t, web.renderInvalidRequest(origin));
  snapshot(t, web.renderNotFound(origin));
  snapshot(t, web.renderUnavailable());
});
