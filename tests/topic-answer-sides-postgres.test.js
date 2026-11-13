import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { runCommand } from "../scripts/topic-answer-sides.ts";

// Decision 0015 (D4): the owner records which side of a topic answers yes; the
// web process only reads the reviews, and nobody changes or deletes one.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const denied = (error) => error.code === "42501";

describe(
  "topic answer reviews in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    const word = `ans${randomBytes(5).toString("hex")}`;
    let owner, runtime;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:revocation_test|yaparena_a4_test)[a-z0-9_]*$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
    });
    after(async () => {
      if (owner) {
        await owner.query("DELETE FROM debates WHERE slug LIKE $1", [
          `${word}-%`,
        ]);
        // Reviews are kept forever, so a reviewed topic stays, hidden.
        await owner.query(
          `DELETE FROM topics t WHERE t.slug LIKE $1
             AND NOT EXISTS (SELECT 1 FROM topic_answer_reviews r WHERE r.topic_id = t.id)`,
          [`${word}-%`],
        );
        await owner.query(
          "UPDATE topics SET publication_state = 'hidden' WHERE slug LIKE $1",
          [`${word}-%`],
        );
      }
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    const topic = async (name, sideA, sideB) => {
      const slug = `${word}-${name}`;
      const id = (
        await owner.query(
          `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
           VALUES ($1, $2, 'Synthetic answer side fixture', $3, $4, 'published') RETURNING id`,
          [slug, `Answer sides ${word} ${name}`, sideA, sideB],
        )
      ).rows[0].id;
      return { slug, id };
    };
    const debate = (topicId, name, proposition) =>
      owner.query(
        `INSERT INTO debates (slug, topic_id, proposition, status, publication_state,
           rules_version, rules_snapshot, scheduled_at)
         SELECT $1, $2, $3, 'scheduled', 'published', r.version, r.rules,
           CURRENT_TIMESTAMP + interval '1 day'
         FROM event_rule_versions r WHERE r.version = 'preview-1'`,
        [`${word}-${name}`, topicId, proposition],
      );
    const command = (...argv) =>
      runCommand({ argv, connectionString: ownerUrl });

    it("lets the runtime read reviews but never write, change or delete them", async () => {
      const { id } = await topic("grants", "For", "Against");
      await owner.query(
        `INSERT INTO topic_answer_reviews (topic_id, side_a_is_yes, reason)
         VALUES ($1, true, 'Synthetic grant check')`,
        [id],
      );
      assert.equal(
        (
          await runtime.query(
            "SELECT side_a_is_yes FROM topic_answer_reviews WHERE topic_id = $1",
            [id],
          )
        ).rows[0].side_a_is_yes,
        true,
      );
      for (const [sql, values] of [
        [
          "INSERT INTO topic_answer_reviews (topic_id, side_a_is_yes, reason) VALUES ($1, false, 'Runtime attempt')",
          [id],
        ],
        [
          "UPDATE topic_answer_reviews SET side_a_is_yes = false WHERE topic_id = $1",
          [id],
        ],
        ["DELETE FROM topic_answer_reviews WHERE topic_id = $1", [id]],
      ])
        await assert.rejects(runtime.query(sql, values), denied, sql);
      // Even the owner can only add reviews.
      for (const sql of [
        "UPDATE topic_answer_reviews SET reason = 'Rewritten reason' WHERE topic_id = $1",
        "DELETE FROM topic_answer_reviews WHERE topic_id = $1",
      ])
        await assert.rejects(
          owner.query(sql, [id]),
          (error) =>
            error.code === "23514" && /insert-only/.test(error.message),
          sql,
        );
      await assert.rejects(
        owner.query(
          `INSERT INTO topic_answer_reviews (topic_id, side_a_is_yes, reason)
           VALUES ($1, true, 'abc')`,
          [id],
        ),
        (error) => error.code === "23514",
      );
    });

    it("lists published topics with counts and flags, and records reviews as the owner", async () => {
      const flagged = await topic("flagged", "No more cars", "Yes, cars stay");
      const plain = await topic("plain", "For", "Against");
      await debate(flagged.id, "title", `Answer sides ${word} flagged`);
      await debate(flagged.id, "typed", "A question typed before the lock");
      const listed = async (...flags) =>
        (await command("list", ...flags)).topics.filter((entry) =>
          entry.slug.startsWith(`${word}-`),
        );
      const before = await listed();
      const row = before.find((entry) => entry.slug === flagged.slug);
      assert.deepEqual(
        {
          debates: row.debates,
          titleDebates: row.titleDebates,
          answers: row.answers,
        },
        { debates: 2, titleDebates: 1, answers: 0 },
      );
      assert.deepEqual(row.flags, [
        "side B starts with Yes",
        "side A starts with No or Against",
      ]);
      assert.equal(row.review, null);
      assert.ok(before.some((entry) => entry.slug === plain.slug));
      assert.deepEqual(
        (await listed("--flagged")).map((entry) => entry.slug).sort(),
        [`${word}-flagged`, `${word}-grants`].sort(),
      );

      const reason = "Side B argues yes";
      // Without --execute the review is only previewed.
      assert.deepEqual(
        await command("review", flagged.slug, "side-a-not-yes", reason),
        {
          command: "review",
          recorded: true,
          slug: flagged.slug,
          sideAIsYes: false,
          previous: null,
          executed: false,
        },
      );
      assert.equal(
        (await listed()).find((entry) => entry.slug === flagged.slug).review,
        null,
      );
      const recorded = await command(
        "review",
        flagged.slug,
        "side-a-not-yes",
        reason,
        "--execute",
      );
      assert.equal(recorded.recorded, true);
      assert.equal(recorded.executed, true);
      const latest = (await listed()).find(
        (entry) => entry.slug === flagged.slug,
      ).review;
      assert.equal(latest.sideAIsYes, false);
      assert.equal(latest.reason, reason);
      // The same answer again records nothing; a new answer is the latest.
      assert.equal(
        (
          await command(
            "review",
            flagged.slug,
            "side-a-not-yes",
            "Repeat review",
            "--execute",
          )
        ).recorded,
        false,
      );
      await command(
        "review",
        flagged.slug,
        "side-a-yes",
        "Read again after the debate",
        "--execute",
      );
      assert.equal(
        (await listed()).find((entry) => entry.slug === flagged.slug).review
          .sideAIsYes,
        true,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM topic_answer_reviews WHERE topic_id = $1",
            [flagged.id],
          )
        ).rows[0].count,
        2,
      );
      await assert.rejects(
        command(
          "review",
          `${word}-missing`,
          "side-a-yes",
          "Missing topic",
          "--execute",
        ),
        /topic not found/,
      );
      await assert.rejects(
        runCommand({ argv: ["list"], connectionString: runtimeUrl }),
        /dedicated owner login/,
      );
    });
  },
);
