// Decision 0015: what the debate's last-answer bar and its card say
// (frontend/endorsement-bar-model.ts), for every state in the plan's copy.
import assert from "node:assert/strict";
import { it } from "node:test";

const {
  BAR_FOOTER,
  BAR_HEADING,
  answerLabels,
  barView,
  cardLeft,
  changeText,
  emptyStatus,
  revealTime,
  shownEndorsement,
  switchText,
  yesPercent,
} = await import("../public/endorsement-bar-model.js");

const labels = {
  sideA: "People first",
  sideB: "Markets first",
  sideAIsYes: true,
};
const figure = (overrides = {}) => ({
  throughTurn: 6,
  yes: 1640,
  accounts: 3491,
  previous: { throughTurn: 5, yes: 1570, accounts: 3500 },
  switched: { toYes: 70, toNo: 38, cameBack: 12 },
  multiAnswerAccounts: 412,
  ...overrides,
});
const input = (endorsement, overrides = {}) => ({
  endorsement,
  revealMode: "per_round",
  revealAt: null,
  now: Date.parse("2026-11-13T12:00:00Z"),
  ...overrides,
});

it("rounds the yes share to a whole percentage, and No takes the rest", () => {
  assert.equal(yesPercent(1640, 3491), 47);
  assert.equal(yesPercent(1, 3), 33);
  assert.equal(yesPercent(2, 3), 67);
  assert.equal(yesPercent(0, 0), 0);
  const view = barView(input(figure()), labels);
  assert.deepEqual(
    view.card.shares.map((share) => share.percent),
    [47, 53],
  );
});

it("describes a revealed figure for screen readers and in the card", () => {
  const view = barView(input(figure()), labels);
  assert.equal(view.empty, false);
  assert.equal(view.yesPercent, 47);
  assert.equal(
    view.valueText,
    "47% Yes, People first; 53% No, Markets first; 3,491 accounts",
  );
  assert.deepEqual(view.card, {
    heading: BAR_HEADING,
    shares: [
      { answer: "Yes", label: "People first", percent: 47 },
      { answer: "No", label: "Markets first", percent: 53 },
    ],
    counts: "1,640 Yes · 1,851 No · 3,491 accounts · through turn 6",
    change: "Since turn 5: +2 pts Yes",
    switches:
      "120 accounts changed answer: 70 to Yes, 38 to No, 12 changed back",
    status: null,
    footer: "Not a vote, a price or a forecast.",
  });
  assert.equal(BAR_FOOTER, "Not a vote, a price or a forecast.");
});

it("names the change since the previous counted turn", () => {
  assert.equal(changeText(figure({ previous: null })), "First revealed turn");
  assert.equal(
    changeText(
      figure({ previous: { throughTurn: 5, yes: 47, accounts: 100 } }),
    ),
    "No change since turn 5",
  );
  assert.equal(
    changeText(
      figure({ previous: { throughTurn: 4, yes: 48, accounts: 100 } }),
    ),
    "Since turn 4: −1 pt Yes",
  );
  assert.equal(
    changeText(
      figure({ previous: { throughTurn: 2, yes: 60, accounts: 100 } }),
    ),
    "Since turn 2: −13 pts Yes",
  );
});

it("counts accounts that changed answer, or says no one did", () => {
  assert.equal(
    switchText(figure({ switched: { toYes: 0, toNo: 0, cameBack: 0 } })),
    "No one changed answer",
  );
  assert.equal(
    switchText(figure({ switched: { toYes: 1, toNo: 0, cameBack: 0 } })),
    "1 account changed answer: 1 to Yes, 0 to No, 0 changed back",
  );
  assert.equal(
    switchText(figure({ switched: { toYes: 1200, toNo: 3, cameBack: 1 } })),
    "1,204 accounts changed answer: 1,200 to Yes, 3 to No, 1 changed back",
  );
});

it("says one account in the singular", () => {
  const view = barView(
    input(
      figure({
        yes: 1,
        accounts: 1,
        previous: null,
        switched: { toYes: 0, toNo: 0, cameBack: 0 },
      }),
    ),
    labels,
  );
  assert.equal(
    view.valueText,
    "100% Yes, People first; 0% No, Markets first; 1 account",
  );
  assert.equal(view.card.counts, "1 Yes · 0 No · 1 account · through turn 6");
});

it("prints plain Yes and No for a topic reviewed as side A is not yes", () => {
  const reviewed = { ...labels, sideAIsYes: false };
  assert.deepEqual(answerLabels(reviewed), { Yes: "Yes", No: "No" });
  assert.deepEqual(answerLabels(labels), {
    Yes: "People first",
    No: "Markets first",
  });
  const view = barView(input(figure()), reviewed);
  assert.equal(view.valueText, "47% Yes; 53% No; 3,491 accounts");
  assert.deepEqual(
    view.card.shares.map((share) => share.label),
    ["Yes", "No"],
  );
});

it("stays empty before a per-round debate's first reveal", () => {
  const view = barView(input(null), labels);
  assert.equal(view.empty, true);
  assert.equal(view.yesPercent, 0);
  assert.equal(view.valueText, "No results revealed yet");
  assert.deepEqual(view.card, {
    heading: BAR_HEADING,
    shares: [],
    counts: null,
    change: null,
    switches: null,
    status: "Fills after each turn's answers are revealed.",
    footer: BAR_FOOTER,
  });
  // A figure with no accounts is empty too.
  assert.equal(
    barView(input(figure({ yes: 0, accounts: 0 })), labels).empty,
    true,
  );
});

it("says when a five-day debate's answers are revealed", () => {
  const at = "2026-11-18T20:00:00.000Z";
  assert.equal(revealTime(Date.parse(at)), "Nov 18 at 3:00 PM EST");
  assert.equal(
    barView(input(null, { revealMode: "five_day", revealAt: at }), labels).card
      .status,
    "Answers stay hidden until Nov 18 at 3:00 PM EST, 5 days after the debate.",
  );
  // Before the debate ends its reveal time isn't known yet.
  assert.equal(
    emptyStatus({ revealMode: "five_day", revealAt: null, now: 0 }),
    "Answers stay hidden until 5 days after the debate.",
  );
  // Past the close with nothing counted.
  assert.equal(
    emptyStatus({
      revealMode: "five_day",
      revealAt: at,
      now: Date.parse(at) + 1,
    }),
    "No answers were counted in this debate.",
  );
});

it("keeps the card inside the surface, centred on the share's edge", () => {
  assert.equal(cardLeft(1000, 300, 50), 350);
  assert.equal(cardLeft(1000, 300, 5), 8);
  assert.equal(cardLeft(1000, 300, 98), 692);
  // A card wider than the surface starts at the margin.
  assert.equal(cardLeft(200, 320, 50), 8);
});

it("follows the replay's playing turn and shows the latest otherwise", () => {
  const turn = (throughTurn) => figure({ throughTurn, previous: null });
  const turns = [turn(1), turn(2), turn(4)];
  const latest = turns.at(-1);
  // Turn 3 was void; each turn starts 60 s after the one before.
  const starts = [1, 2, 3, 4].map((turnNumber) => ({
    turnNumber,
    startSeconds: 30 + 60 * (turnNumber - 1),
  }));
  const shown = (position, overrides = {}) =>
    shownEndorsement({ latest, turns, starts, position, ...overrides });
  // Live: no replay position.
  assert.deepEqual(shown(null), { endorsement: latest, waiting: false });
  // Before turn 1 starts the bar waits.
  assert.deepEqual(shown(0), { endorsement: null, waiting: true });
  // A turn's figure shows from its first second.
  assert.equal(shown(30).endorsement, turns[0]);
  assert.equal(shown(89.9).endorsement, turns[0]);
  assert.equal(shown(90).endorsement, turns[1]);
  // The void turn keeps the figure before it.
  assert.equal(shown(150).endorsement, turns[1]);
  assert.equal(shown(210).endorsement, turns[2]);
  // Past the end, and seeking back, follow the position.
  assert.equal(shown(9999).endorsement, latest);
  assert.equal(shown(31).endorsement, turns[0]);
  // Without places in the recording, or before any reveal, the latest.
  assert.deepEqual(shown(31, { starts: [] }), {
    endorsement: latest,
    waiting: false,
  });
  assert.deepEqual(shown(31, { turns: [], latest: null }), {
    endorsement: null,
    waiting: false,
  });
  // Waiting says why the bar is empty.
  assert.equal(
    barView(input(null, { waiting: true }), labels).card.status,
    "Fills as each turn plays.",
  );
});
