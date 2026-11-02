import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  debateCard,
  statusTag,
  topicCard,
} from "../dist/features/discovery/cards-web.js";
import {
  avatarSlot,
  initials,
  inscription,
} from "../dist/features/discovery/kit-web.js";
import {
  renderDebates,
  renderProfile,
  renderTopic,
} from "../dist/features/discovery/web.js";

const origin = "https://arena.example";
const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "public-topic",
  title: "Public topic",
  summary: "A question worth debating.",
  sideALabel: "For",
  sideBLabel: "Against",
  isDemo: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};
const debate = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "public-debate",
  proposition: "Should we <debate> this?",
  status: "scheduled",
  rulesVersion: "preview-1",
  scheduledAt: new Date("2026-10-01T17:00:00Z"),
  liveStartedAt: null,
  liveEndedAt: null,
  isDemo: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  topic: {
    slug: topic.slug,
    title: topic.title,
    sideALabel: topic.sideALabel,
    sideBLabel: topic.sideBLabel,
  },
  speakerA: { handle: "alex-public", displayName: "Alex Public" },
  speakerB: null,
  sponsor: null,
};
const profile = {
  id: "22222222-2222-4222-8222-222222222222",
  handle: "alex-public",
  displayName: "Alex Public",
  bio: null,
  isDemo: true,
};
const empty = {
  items: [],
  pagination: { limit: 12, offset: 0, hasMore: false },
};

describe("site kit markup", () => {
  it("inscribes Dydema text for the eye and keeps the real spelling for screen readers", () => {
    assert.equal(
      String(inscription("Public appearances")),
      '<span class="sr-only">Public appearances</span><span class="ins" aria-hidden="true">pvblic appearances</span>',
    );
    assert.equal(
      String(inscription("Find your next", "good argument.")),
      '<span class="sr-only">Find your next good argument.</span><span class="ins" aria-hidden="true">find yovr next <em>good argvment.</em></span>',
    );
  });

  it("puts initials in square avatar slots", () => {
    assert.equal(initials("Alex Public Speaker"), "AP");
    assert.equal(initials(null), "?");
    assert.equal(initials("  "), "?");
    assert.match(
      String(avatarSlot("Ben", 24)),
      /^<span class="avatar-slot" style="--avatar-size:24px" aria-hidden="true"><span class="avatar-initials">B<\/span><\/span>$/,
    );
    assert.doesNotMatch(String(avatarSlot("Ben")), /style=/);
  });
});

describe("debate and topic cards", () => {
  it("shows an upcoming debate's speakers on their panes, with the date and no still", () => {
    const card = String(debateCard(debate));
    assert.match(card, /^<article class="dcard">/);
    assert.doesNotMatch(card, /thumbnail/);
    assert.match(card, /<span class="tag">Upcoming<\/span>/);
    assert.match(
      card,
      /<span class="dcard-stamp">Oct 1, 2026, 5:00 PM UTC<\/span>/,
    );
    assert.match(
      card,
      /<h3 class="dcard-title"><a href="\/debates\/public-debate">Should we &lt;debate&gt; this\?<\/a><\/h3>/,
    );
    // A missing speaker keeps the side's name and an unknown avatar.
    assert.match(
      card,
      /<span class="avatar-initials">AP<\/span><\/span><span>Alex Public<\/span>/,
    );
    assert.match(
      card,
      /<span class="avatar-initials">\?<\/span><\/span><span>Against<\/span>/,
    );
    assert.match(
      card,
      /<span class="sr-only">versus<\/span><span aria-hidden="true">VS<\/span>/,
    );
    assert.doesNotMatch(card, /Demo/);
    assert.match(
      String(debateCard({ ...debate, scheduledAt: null })),
      /To be announced/,
    );
  });

  it("lays replays over the recording's still and marks live debates", () => {
    const live = String(
      debateCard({ ...debate, status: "live", isDemo: true }),
    );
    // Live debates have no still yet: the media router serves none.
    assert.doesNotMatch(live, /dcard-still/);
    assert.match(
      String(debateCard({ ...debate, status: "finalized" })),
      /<img class="dcard-still" src="\/api\/media\/events\/33333333-3333-4333-8333-333333333333\/thumbnail" alt="" loading="lazy" decoding="async">/,
    );
    assert.match(
      live,
      /<span class="tag tag-live"><span class="live-pixel" aria-hidden="true"><\/span>Live<\/span><span class="dcard-stamp">Happening now<\/span>/,
    );
    assert.match(live, /<span class="tag tag-quiet">Demo<\/span>/);
    const replay = String(debateCard({ ...debate, status: "replay" }));
    assert.match(replay, /dcard-still/);
    assert.match(replay, /Debate archive/);
    assert.doesNotMatch(
      String(debateCard({ ...debate, status: "ended" })),
      /dcard-still/,
    );
    assert.equal(
      String(statusTag("void_review")),
      '<span class="tag">Under review</span>',
    );
  });

  it("links a topic card and sets its sides on one line", () => {
    const card = String(topicCard({ ...topic, isDemo: true }));
    assert.match(card, /^<article class="tcard card">/);
    assert.match(
      card,
      /<h3 class="tcard-title"><a href="\/topics\/public-topic">Public topic<\/a><\/h3>/,
    );
    assert.match(
      card,
      /<p class="tcard-summary">A question worth debating\.<\/p>/,
    );
    assert.match(
      card,
      /<p class="tcard-sides"><span>For<\/span><span class="vs">.*<\/span><span>Against<\/span><\/p>/,
    );
    assert.match(card, /tag-quiet">Demo/);
  });
});

describe("Explore, topic and profile pages", () => {
  it("keeps four status chips and puts the rest under More", () => {
    const all = renderDebates(origin, { ...empty, items: [debate] }, "", "all");
    assert.match(
      all,
      /<link rel="stylesheet" href="\/assets\/explore\.css\?v=[^"]+">/,
    );
    assert.match(
      all,
      /<link rel="preload" href="\/assets\/landing\/fonts\/headline\.woff2"/,
    );
    const chips = [
      ...all.matchAll(
        /<a class="chip"( aria-current="page")? href="([^"]+)">([^<]+)<\/a>/g,
      ),
    ];
    assert.deepEqual(
      chips.map(([, current, href, label]) => [label, href, Boolean(current)]),
      [
        ["All", "/debates", true],
        ["Live", "/debates?status=live", false],
        ["Upcoming", "/debates?status=scheduled", false],
        ["Replay", "/debates?status=replay", false],
      ],
    );
    assert.match(
      all,
      /<summary class="chip"><span class="sr-only">More statuses<\/span><span aria-hidden="true">More<\/span>/,
    );
    assert.match(all, /<details class="more-chip" data-menu>/);
    for (const label of [
      "Ready",
      "Ended",
      "Under review",
      "Finalized",
      "Cancelled",
    ])
      assert.match(
        all,
        new RegExp(`<a href="/debates\\?status=[a-z_]+">${label}</a>`),
      );
    assert.match(all, /<div class="list-grid"><article class="dcard">/);

    // A rarer status names itself on the More chip, which shows it pressed.
    const ended = renderDebates(origin, empty, "city", "ended");
    assert.match(
      ended,
      /<summary class="chip is-current"><span class="sr-only">More statuses:<\/span><span>Ended<\/span>/,
    );
    assert.match(
      ended,
      /<a aria-current="page" href="\/debates\?status=ended&q=city">Ended<\/a>/,
    );
    assert.match(ended, /<a class="chip" href="\/debates\?q=city">All<\/a>/);
    assert.match(
      ended,
      /<input class="input" id="debate-search" name="q" maxlength="80" value="city"/,
    );
    assert.match(ended, /<h3><span class="sr-only">No debates found\.<\/span>/);
    assert.match(
      ended,
      /<a class="btn btn-secondary" href="\/debates">Clear search<\/a>/,
    );
  });

  it("puts both sides in one card, with queue buttons only when the queue is on", () => {
    const plain = renderTopic(origin, topic, empty);
    assert.match(
      plain,
      /<section class="card queue-card" aria-label="The two sides">/,
    );
    assert.doesNotMatch(
      plain,
      /data-queue|Queue for this side|Queue on a side/,
    );
    assert.match(plain, /<h1 class="title-serif">Public topic<\/h1>/);
    assert.match(
      plain,
      /<a class="back-link" href="\/topics"><span aria-hidden="true">←<\/span> All topics<\/a>/,
    );
    assert.match(
      plain,
      /<button class="follow-button btn btn-outline btn-sm" type="button" data-follow-type="topics" data-follow-slug="public-topic" aria-pressed="false">Follow topic<\/button><span class="follow-message"/,
    );
    const queue = renderTopic(origin, topic, empty, true);
    assert.match(
      queue,
      /<section class="card queue-card" data-queue-topic="public-topic" aria-labelledby="queue-heading">/,
    );
    assert.match(
      queue,
      /data-queue-side="B" data-side-label="Against" aria-describedby="queue-side-b">Queue for this side/,
    );
    assert.match(
      queue,
      /<div class="queue-notes"><p data-queue-waiting aria-live="polite"><\/p><p data-queue-note role="status"><\/p><\/div>/,
    );
    assert.match(
      queue,
      /No public debates on this topic yet\.[\s\S]*<p>Queue on a side to start the first one\.<\/p>/,
    );
  });

  it("shows a person's initials beside their name, and a quiet note without a bio", () => {
    const page = renderProfile(origin, profile, empty);
    assert.match(
      page,
      /<header class="person-hero"><span class="avatar-slot" aria-hidden="true"><span class="avatar-initials">AP<\/span><\/span>/,
    );
    assert.match(page, /<span class="sr-only">Participant · Demo<\/span>/);
    assert.match(
      page,
      /<p class="person-handle">@alex-public<\/p><p class="person-bio muted">No public bio yet\.<\/p>/,
    );
    assert.match(
      page,
      /data-follow-type="people" data-follow-slug="alex-public"[^>]*>Follow person</,
    );
    assert.match(
      page,
      /<h3><span class="sr-only">No public debates yet\.<\/span>/,
    );
    assert.match(
      renderProfile(origin, { ...profile, bio: "Public speaker" }, empty),
      /<p class="person-bio">Public speaker<\/p>/,
    );
  });
});
