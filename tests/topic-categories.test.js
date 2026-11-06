import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TOPIC_CATEGORY,
  isTopicCategory,
  TOPIC_CATEGORIES,
  TOPIC_CATEGORY_IDS,
  topicCategoryName,
} from "../dist/features/discovery/topic-categories.js";
import {
  changeTopicCategory,
  TopicCategoryError,
} from "../dist/features/matching/topic-category.js";
import {
  topicCategories,
  up,
} from "../migrations/1794001552074_add-topic-categories.js";
import { parseArguments, runCommand } from "../scripts/set-topic-category.ts";

// A database client that answers the change's queries and records them.
function client({ role = "yaparena_owner", topic } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      queries.push([sql, values]);
      if (sql.startsWith("SELECT current_user")) return { rows: [{ role }] };
      if (sql.startsWith("SELECT id, category FROM topics"))
        return {
          rows:
            topic === null ? [] : [topic ?? { id: "t1", category: "other" }],
        };
      return { rows: [] };
    },
  };
}

describe("topic categories", () => {
  it("lists the founder's nine categories in order, Other last", () => {
    assert.deepEqual(
      TOPIC_CATEGORIES.map(([, name]) => name),
      [
        "Politics",
        "Society",
        "Cities",
        "Technology",
        "Work",
        "Climate",
        "Education",
        "Economy",
        "Other",
      ],
    );
    assert.deepEqual(
      TOPIC_CATEGORY_IDS,
      TOPIC_CATEGORIES.map(([, name]) => name.toLowerCase()),
    );
    assert.equal(DEFAULT_TOPIC_CATEGORY, "other");
    assert.equal(topicCategoryName("cities"), "Cities");
  });

  it("accepts only the listed ids", () => {
    for (const id of TOPIC_CATEGORY_IDS)
      assert.equal(isTopicCategory(id), true);
    for (const value of [
      "Politics",
      "sports",
      "",
      " other",
      null,
      undefined,
      3,
      ["other"],
    ])
      assert.equal(isTopicCategory(value), false);
  });

  it("matches the database's checks, with existing topics becoming other", () => {
    assert.deepEqual([...topicCategories], [...TOPIC_CATEGORY_IDS]);
    const statements = [];
    up({ sql: (sql) => statements.push(sql) });
    const sql = statements.join("\n");
    const list = TOPIC_CATEGORY_IDS.map((id) => `'${id}'`).join(", ");
    assert.match(
      sql,
      /ADD COLUMN category varchar\(20\) NOT NULL DEFAULT 'other'/,
    );
    for (const column of ["category", "from_category", "to_category"])
      assert.ok(sql.includes(`CHECK (${column} IN (${list}))`), column);
    // Only the owner changes a category, and its record stays as written.
    assert.match(sql, /BEFORE UPDATE OF category ON yaparena\.topics/);
    assert.match(sql, /current_user <> 'yaparena_owner'/);
    assert.match(sql, /topic category changes are append-only/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(sql, /GRANT/);
  });
});

describe("owner topic category change", () => {
  it("changes the category and records the previous one with the reason", async () => {
    const database = client({ topic: { id: "t1", category: "other" } });
    assert.deepEqual(
      await changeTopicCategory(database, {
        slug: "civil-ai",
        category: "technology",
        reason: "  Belongs with technology  ",
      }),
      {
        changed: true,
        slug: "civil-ai",
        category: "technology",
        previousCategory: "other",
      },
    );
    const [, lock, update, record] = database.queries;
    assert.match(lock[0], /FOR UPDATE/);
    assert.deepEqual(lock[1], ["civil-ai"]);
    assert.match(update[0], /^UPDATE topics SET category=\$2/);
    assert.deepEqual(update[1], ["t1", "technology"]);
    assert.match(record[0], /INSERT INTO topic_category_changes/);
    assert.deepEqual(record[1], [
      "t1",
      "other",
      "technology",
      "Belongs with technology",
    ]);
  });

  it("changes nothing when the topic already has the category", async () => {
    const database = client({ topic: { id: "t1", category: "work" } });
    assert.deepEqual(
      await changeTopicCategory(database, {
        slug: "civil-ai",
        category: "work",
        reason: "Already filed here",
      }),
      {
        changed: false,
        slug: "civil-ai",
        category: "work",
        previousCategory: "work",
      },
    );
    assert.equal(database.queries.length, 2);
  });

  it("refuses bad input, other roles and unknown topics before changing anything", async () => {
    const valid = {
      slug: "civil-ai",
      category: "politics",
      reason: "Synthetic reason",
    };
    for (const [input, options, message] of [
      [{ ...valid, slug: "BAD" }, {}, /invalid topic slug/],
      [{ ...valid, category: "Politics" }, {}, /choose a category: politics, /],
      [{ ...valid, category: "sports" }, {}, /choose a category/],
      [{ ...valid, reason: " no " }, {}, /5-500 characters/],
      [{ ...valid, reason: "x".repeat(501) }, {}, /5-500 characters/],
      [valid, { role: "yaparena_runtime" }, /dedicated owner login/],
      [valid, { topic: null }, /topic not found/],
    ]) {
      const database = client(options);
      await assert.rejects(
        changeTopicCategory(database, input),
        (error) =>
          error instanceof TopicCategoryError && message.test(error.message),
      );
      assert.ok(
        database.queries.every(([sql]) => !/^(UPDATE|INSERT)/.test(sql)),
      );
    }
  });

  it("reads the command's arguments and previews unless --execute is given", () => {
    assert.deepEqual(
      parseArguments(["civil-ai", "politics", "Synthetic reason"]),
      {
        slug: "civil-ai",
        category: "politics",
        reason: "Synthetic reason",
        execute: false,
      },
    );
    assert.equal(
      parseArguments(["civil-ai", "politics", "Synthetic reason", "--execute"])
        .execute,
      true,
    );
    for (const argv of [
      [],
      ["civil-ai", "politics"],
      ["civil-ai", "politics", "Synthetic reason", "--commit"],
      ["civil-ai", "politics", "Synthetic reason", "--execute", "extra"],
    ])
      assert.throws(() => parseArguments(argv), /usage: set-topic-category/);
  });

  it("needs the owner database URL", async () => {
    await assert.rejects(
      runCommand({
        argv: ["civil-ai", "politics", "Synthetic reason"],
        connectionString: undefined,
      }),
      /DATABASE_URL \(the owner URL\) is required/,
    );
  });
});
