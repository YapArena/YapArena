import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  likelySideMismatch,
  listTopicAnswerSides,
  recordTopicAnswerReview,
  TopicAnswerSidesError,
} from "../dist/features/matching/topic-answer-sides.js";
import { parseArguments, runCommand } from "../scripts/topic-answer-sides.ts";

// A database client that answers the review queries and records them.
function client({ role = "yaparena_owner", topic, topics = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      queries.push([sql, values]);
      if (sql.startsWith("SELECT current_user")) return { rows: [{ role }] };
      if (sql.startsWith("SELECT t.id,"))
        return {
          rows: topic === null ? [] : [topic ?? { id: "t1", previous: null }],
        };
      if (sql.startsWith("SELECT t.slug")) return { rows: topics };
      return { rows: [] };
    },
  };
}

const review = (overrides = {}) => ({
  slug: "civil-ai",
  sideAIsYes: false,
  reason: "Side B says yes",
  ...overrides,
});

// Decision 0015 (D4): side A answers yes; the owner reviews labels that read the other way.
describe("topic answer sides", () => {
  it("flags labels that likely put yes on side B", () => {
    assert.deepEqual(likelySideMismatch("For", "Against"), []);
    assert.deepEqual(likelySideMismatch("Yes, build it", "No"), []);
    assert.deepEqual(likelySideMismatch("Nobody wins", "Yesterday's plan"), []);
    assert.deepEqual(likelySideMismatch("Keep it", "Yes, change it"), [
      "side B starts with Yes",
    ]);
    assert.deepEqual(likelySideMismatch("No more cars", "Cars stay"), [
      "side A starts with No or Against",
    ]);
    assert.deepEqual(likelySideMismatch(" against the plan", " YES"), [
      "side B starts with Yes",
      "side A starts with No or Against",
    ]);
  });

  it("lists published topics with their flags and latest review, as the owner only", async () => {
    const reviewedAt = new Date("2026-11-13T10:00:00Z");
    const fake = client({
      topics: [
        {
          slug: "cars",
          title: "Should cities ban cars?",
          sideALabel: "No more cars",
          sideBLabel: "Cars stay",
          debates: 2,
          titleDebates: 1,
          answers: 40,
          sideAIsYes: false,
          reason: "Side A argues no",
          reviewedAt,
        },
        {
          slug: "civil-ai",
          title: "Civil AI",
          sideALabel: "For",
          sideBLabel: "Against",
          debates: 0,
          titleDebates: 0,
          answers: 0,
          sideAIsYes: null,
          reason: null,
          reviewedAt: null,
        },
      ],
    });
    assert.deepEqual(await listTopicAnswerSides(fake), [
      {
        slug: "cars",
        title: "Should cities ban cars?",
        sideALabel: "No more cars",
        sideBLabel: "Cars stay",
        debates: 2,
        titleDebates: 1,
        answers: 40,
        flags: ["side A starts with No or Against"],
        review: {
          sideAIsYes: false,
          reason: "Side A argues no",
          reviewedAt: reviewedAt.toISOString(),
        },
      },
      {
        slug: "civil-ai",
        title: "Civil AI",
        sideALabel: "For",
        sideBLabel: "Against",
        debates: 0,
        titleDebates: 0,
        answers: 0,
        flags: [],
        review: null,
      },
    ]);
    assert.match(
      fake.queries[1][0],
      /WHERE t\.publication_state = 'published'/,
    );
    assert.match(fake.queries[1][0], /d\.proposition = t\.title/);
    await assert.rejects(
      listTopicAnswerSides(client({ role: "yaparena_runtime" })),
      /dedicated owner login/,
    );
  });

  it("records a review only when it changes the latest one", async () => {
    const fake = client();
    assert.deepEqual(await recordTopicAnswerReview(fake, review()), {
      recorded: true,
      slug: "civil-ai",
      sideAIsYes: false,
      previous: null,
    });
    const insert = fake.queries.at(-1);
    assert.match(insert[0], /^INSERT INTO topic_answer_reviews/);
    assert.deepEqual(insert[1], ["t1", false, "Side B says yes"]);

    const same = client({ topic: { id: "t1", previous: false } });
    assert.equal(
      (await recordTopicAnswerReview(same, review())).recorded,
      false,
    );
    assert.equal(
      same.queries.some(([sql]) => sql.startsWith("INSERT")),
      false,
    );
    const back = client({ topic: { id: "t1", previous: false } });
    assert.equal(
      (
        await recordTopicAnswerReview(
          back,
          review({
            sideAIsYes: true,
            reason: "  Read again: side A says yes  ",
          }),
        )
      ).recorded,
      true,
    );
    assert.equal(back.queries.at(-1)[1][2], "Read again: side A says yes");
  });

  it("refuses bad input, other logins and unknown topics", async () => {
    for (const [input, message] of [
      [review({ slug: "Bad Slug" }), /invalid topic slug/],
      [review({ reason: "abc" }), /5-500 characters/],
      [review({ reason: "x".repeat(501) }), /5-500 characters/],
    ])
      await assert.rejects(recordTopicAnswerReview(client(), input), message);
    await assert.rejects(
      recordTopicAnswerReview(client({ role: "yaparena_runtime" }), review()),
      (error) =>
        error instanceof TopicAnswerSidesError &&
        /dedicated owner login/.test(error.message),
    );
    await assert.rejects(
      recordTopicAnswerReview(client({ topic: null }), review()),
      /topic not found/,
    );
  });

  it("parses the list and review commands and nothing else", async () => {
    assert.deepEqual(parseArguments(["list"]), {
      command: "list",
      flagged: false,
    });
    assert.deepEqual(parseArguments(["list", "--flagged"]), {
      command: "list",
      flagged: true,
    });
    assert.deepEqual(
      parseArguments(["review", "civil-ai", "side-a-not-yes", "Reason here"]),
      {
        command: "review",
        slug: "civil-ai",
        sideAIsYes: false,
        reason: "Reason here",
        execute: false,
      },
    );
    assert.equal(
      parseArguments([
        "review",
        "civil-ai",
        "side-a-yes",
        "Reason here",
        "--execute",
      ]).sideAIsYes,
      true,
    );
    for (const argv of [
      [],
      ["show"],
      ["list", "--all"],
      ["list", "--flagged", "extra"],
      ["review", "civil-ai", "yes", "Reason here"],
      ["review", "civil-ai", "side-a-yes"],
      ["review", "civil-ai", "side-a-yes", "Reason here", "--force"],
      ["review", "civil-ai", "side-a-yes", "Reason here", "--execute", "x"],
    ])
      assert.throws(() => parseArguments(argv), /usage:/);
    await assert.rejects(
      runCommand({ argv: ["list"], connectionString: undefined }),
      /DATABASE_URL/,
    );
  });
});
