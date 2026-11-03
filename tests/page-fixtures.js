// Shared fixtures and the snapshot helper for the page snapshot tests.
// Topic, profile and debate fixtures come from tests/discovery.test.js; the
// homepage fixtures come from tests/homepage.test.js.
import { publicHomepage } from "../dist/features/discovery/homepage-model.js";
import { referenceHomepage } from "../dist/features/discovery/homepage-reference.js";

// Line breaks at tag boundaries keep snapshot diffs readable. Existing
// backslashes and newlines are escaped first, so the encoding stays lossless
// and two different pages can never produce the same snapshot.
const serializers = [
  (value) =>
    String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll("><", ">\n<"),
];
export const snapshot = (t, value) => t.assert.snapshot(value, { serializers });

export const origin = "https://arena.example";

export const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "public-topic",
  title: "Public topic",
  summary: "A question worth debating.",
  sideALabel: "For",
  sideBLabel: "Against",
  isDemo: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};
export const profile = {
  id: "22222222-2222-4222-8222-222222222222",
  handle: "alex-public",
  displayName: "Alex Public",
  bio: "Public speaker",
  isDemo: false,
  avatarId: "yap-owl",
};
export const debate = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "public-debate",
  proposition: "Should we debate this?",
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
  speakerA: {
    handle: profile.handle,
    displayName: profile.displayName,
    avatarId: profile.avatarId,
  },
  speakerB: null,
  sponsor: null,
};

// Every free-text field carries all five escaped characters. Slugs, handles
// and ids stay in their validated formats.
export const hostileText = (label) =>
  `${label} <b>&amp;</b> "quoted" 'single' & <`;
export const hostileTopic = {
  ...topic,
  id: "44444444-4444-4444-8444-444444444444",
  slug: "hostile-topic",
  title: hostileText("Topic"),
  summary: hostileText("Summary"),
  sideALabel: hostileText("Side A"),
  sideBLabel: hostileText("Side B"),
  isDemo: true,
};
export const hostileProfile = {
  ...profile,
  handle: "hostile-person",
  displayName: hostileText("Name"),
  bio: hostileText("Bio"),
  isDemo: true,
};
export const hostileDebate = {
  ...debate,
  id: "55555555-5555-4555-8555-555555555555",
  slug: "hostile-debate",
  proposition: hostileText("Proposition"),
  rulesVersion: hostileText("Rules"),
  status: "live",
  isDemo: true,
  topic: {
    slug: hostileTopic.slug,
    title: hostileTopic.title,
    sideALabel: hostileTopic.sideALabel,
    sideBLabel: hostileTopic.sideBLabel,
  },
  speakerA: {
    handle: hostileProfile.handle,
    displayName: hostileProfile.displayName,
    avatarId: "yap-crab",
  },
  speakerB: {
    handle: "morgan-lee",
    displayName: hostileText("Morgan"),
    avatarId: "yap-frog",
  },
};

export const list = (items, pagination = {}) => ({
  items,
  pagination: { limit: 12, offset: 0, hasMore: false, ...pagination },
});
export const empty = list([]);

// Settlement dates far in the future keep the 24-hour window deterministic.
const round = (number, share, offer) => ({
  id: `round-${number}`,
  runId: null,
  debateId: hostileDebate.id,
  debateSlug: hostileDebate.slug,
  number,
  period: 1,
  settledAt: `2999-01-0${number}T00:00:00.000Z`,
  closesAt: `2999-01-0${number}T00:00:00.000Z`,
  mode: "seed",
  share,
  offer,
  medianNo: null,
  medianYes: null,
  branch: null,
  argumentLabel: hostileText("Argument"),
  ownLimit: null,
  humans: 2,
  bots: 498,
  executed: 120,
  premium: "2500000000",
  quantity: "500",
});
export const activity = {
  scope: "shared",
  synthetic: true,
  revision: "fixture-revision",
  hasMore: false,
  window: 30,
  items: [
    round(1, { n: "52", d: "100" }, { n: "40", d: "100" }),
    round(2, { n: "47", d: "100" }, null),
  ],
  arguments: [
    {
      stance: "for",
      text: hostileText("For argument"),
      rate: 61,
      endorsed: 305,
      population: 500,
    },
    {
      stance: "against",
      text: hostileText("Against argument"),
      rate: 39,
      endorsed: 195,
      population: 500,
    },
  ],
  category: hostileText("Category"),
  totals: {
    premium: "5000000000",
    humanCommitments: 4,
    botCommitments: 996,
    executed: 240,
  },
};

const homeTopic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "public-idea",
  title: 'Public <idea> "safe"',
  sideALabel: "For <the> idea",
  sideBLabel: "Against & questioning",
  isDemo: false,
};
const homeDebate = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "real-debate",
  proposition: "A real <question>?",
  status: "live",
  topic: { slug: homeTopic.slug },
  speakerA: { displayName: "Alex Rivera", avatarId: "yap-owl" },
  speakerB: null,
};
const homeDebates = [
  homeDebate,
  {
    ...homeDebate,
    id: "replay",
    status: "finalized",
    speakerA: null,
    speakerB: { displayName: "Morgan B", avatarId: "yap-frog" },
  },
  { ...homeDebate, id: "upcoming", status: "scheduled" },
];
// The router passes the versioned avatar address (Decision 0014).
const avatarUrl = (id) => `/assets/avatars/${id}.svg?v=0123456789ab`;
export const publicHome = publicHomepage(
  [homeTopic],
  homeDebates,
  {},
  avatarUrl,
);
const syntheticHome = publicHomepage(
  [hostileTopic, homeTopic],
  [{ ...hostileDebate, topic: { slug: hostileTopic.slug } }, ...homeDebates],
  { [hostileTopic.id]: activity },
  avatarUrl,
);
export const homes = {
  empty: publicHomepage([], []),
  unavailable: { ...publicHomepage([], []), available: false },
  public: publicHome,
  synthetic: { ...syntheticHome, following: [hostileTopic.id] },
  reference: referenceHomepage(),
};
