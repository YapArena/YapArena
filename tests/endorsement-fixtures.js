// Decision 0015: the topic page's last-answer figure, as the reader returns it
// (src/features/endorsement/topic-page.ts). Debate ids match page-fixtures.js.
import { debate, hostileDebate, hostileText } from "./page-fixtures.js";

export const switching = {
  multiAnswerAccounts: 412,
  switchers: 74,
  stayed: 49,
  cameBack: 25,
  pairs: { within: 300, between: 200 },
  switches: { within: 12, between: 18 },
  toYes: 18,
  toNo: 12,
};

export const noSwitching = {
  multiAnswerAccounts: 0,
  switchers: 0,
  stayed: 0,
  cameBack: 0,
  pairs: { within: 0, between: 0 },
  switches: { within: 0, between: 0 },
  toYes: 0,
  toNo: 0,
};

const first = { slug: debate.slug, title: debate.proposition };
const second = { slug: hostileDebate.slug, title: hostileText("debate") };

// Two debates: four per-round turns over two days, then a five-day debate's
// three turns revealed at once.
export const history = [
  ["2026-11-05T18:01:00.000000Z", 1, first, 40, 100],
  ["2026-11-05T18:02:00.000000Z", 2, first, 62, 120],
  ["2026-11-06T18:03:00.000000Z", 3, first, 70, 140],
  ["2026-11-06T18:04:00.000000Z", 4, first, 75, 150],
  ["2026-11-12T14:00:00.000000Z", 1, second, 1500, 3200],
  ["2026-11-12T14:00:00.000000Z", 2, second, 1600, 3400],
  ["2026-11-12T14:00:00.000000Z", 3, second, 1641, 3491],
].map(([revealedAt, turnNumber, link, yes, accounts], index) => ({
  id: String(index + 1),
  revealedAt,
  turnNumber,
  debate: link,
  yes,
  accounts,
}));

export const endorsementView = {
  figure: {
    yes: 1641,
    accounts: 3491,
    switching,
    revealedAt: "2026-11-12T14:00:00.000000Z",
    lastDebate: { ...second, liveEndedAt: "2026-11-07T14:00:00.000000Z" },
    debatesCounted: 14,
  },
  history,
  debates: [
    {
      debateId: debate.id,
      throughTurn: 4,
      yes: 73,
      accounts: 140,
      switching: noSwitching,
    },
  ],
  sideAIsYes: true,
};

export const emptyEndorsementView = {
  figure: null,
  history: [],
  debates: [],
  sideAIsYes: true,
};
