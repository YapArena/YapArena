import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupLine,
  newestRevealed,
  noteText,
  noticeGroups,
  sinceFor,
} from "../public/results-notice-model.js";

const at = (minutes) =>
  new Date(Date.UTC(2026, 9, 31, 18, minutes)).toISOString();
const result = (overrides = {}) => ({
  roundId: "r1",
  debateId: "d1",
  slug: "nuclear",
  proposition: "Canada should expand nuclear power",
  turnNumber: 1,
  turnSide: "A",
  state: "settled",
  voidReason: null,
  side: "YES",
  quantity: 10,
  outcome: {
    status: "executed",
    premium: "0",
    fee: "0",
    payout: "0",
    net: "4000",
  },
  revealedAt: at(0),
  ...overrides,
});

describe("results notice (Decision 0013, interface 10)", () => {
  it("asks since the stored last-seen time, or a week back on a new device", () => {
    const now = Date.parse(at(0));
    assert.equal(sinceFor(at(5), now), at(5));
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    for (const stored of [
      null,
      "",
      "yesterday",
      "2026-10-31",
      "2026-13-45T99:99:99Z",
    ])
      assert.equal(sinceFor(stored, now), weekAgo, String(stored));
  });

  it("stores the newest reveal time as last seen", () => {
    assert.equal(newestRevealed([]), null);
    assert.equal(
      newestRevealed([
        result({ revealedAt: at(1) }),
        result({ revealedAt: at(9) }),
        result({ revealedAt: at(3) }),
      ]),
      at(9),
    );
  });

  it("groups only unseen results per debate, newest debate first", () => {
    const groups = noticeGroups(
      [
        result({ roundId: "a", revealedAt: at(1) }),
        result({
          roundId: "b",
          revealedAt: at(2),
          outcome: { ...result().outcome, net: "-600" },
        }),
        result({
          roundId: "c",
          revealedAt: at(3),
          state: "void",
          outcome: null,
        }),
        result({
          roundId: "d",
          debateId: "d2",
          slug: "transit",
          proposition: "Cities should fund free transit",
          revealedAt: at(8),
        }),
        result({ roundId: "old", revealedAt: at(0) }),
      ],
      at(0),
    );
    assert.deepEqual(
      groups.map((group) => [
        group.debateId,
        group.positions,
        group.voided,
        group.net,
      ]),
      [
        ["d2", 1, 0, 4000n],
        ["d1", 3, 1, 3400n],
      ],
    );
    assert.equal(groups[1].newest, at(3));
    assert.equal(noticeGroups([result()], at(0)).length, 0);
    assert.equal(noticeGroups([result()], null).length, 1);
  });

  it("words each debate's results and refunds", () => {
    const [mixed] = noticeGroups(
      [
        result({ roundId: "a" }),
        result({ roundId: "b", outcome: { ...result().outcome, net: "-600" } }),
        result({ roundId: "c", state: "void", outcome: null }),
      ],
      null,
    );
    assert.equal(
      groupLine(mixed),
      "“Canada should expand nuclear power” · +0.34 YC across 3 turns · 1 refunded",
    );
    const [one] = noticeGroups([result()], null);
    assert.equal(
      groupLine(one),
      "“Canada should expand nuclear power” · +0.40 YC across 1 turn",
    );
    const [refund] = noticeGroups(
      [result({ state: "void", outcome: null })],
      null,
    );
    assert.equal(
      groupLine(refund),
      "“Canada should expand nuclear power” · your position was refunded",
    );
    const [refunds] = noticeGroups(
      [
        result({ roundId: "a", state: "void", outcome: null }),
        result({ roundId: "b", state: "void", outcome: null }),
      ],
      null,
    );
    assert.equal(
      groupLine(refunds),
      "“Canada should expand nuclear power” · 2 positions were refunded",
    );
    assert.equal(noteText(0), "Simulated, no cash value.");
    assert.equal(noteText(1), "And 1 more debate. Simulated, no cash value.");
    assert.equal(noteText(3), "And 3 more debates. Simulated, no cash value.");
  });
});
