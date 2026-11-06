import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";
import { runCommand } from "../scripts/set-topic-category.ts";

// Decision 0003: a topic's category comes from the fixed list, the creator sets
// it, and afterwards only the owner changes it, with a recorded reason.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const denied = (error) => error.code === "42501";

describe(
  "topic categories in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    // One search word that only this run's topics contain.
    const word = `cat${randomBytes(5).toString("hex")}`;
    let owner, runtime, userId;
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
      userId = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
    });
    after(async () => {
      // A topic's category changes go with it.
      await owner?.query("DELETE FROM topics WHERE slug LIKE $1", [
        `${word}-%`,
      ]);
      if (userId) await owner.query("DELETE FROM users WHERE id=$1", [userId]);
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    const input = (name, category) => ({
      slug: `${word}-${name}`,
      title: `Category ${word} ${name}`,
      summary: "Synthetic topic category fixture",
      sideALabel: "For",
      sideBLabel: "Against",
      ...(category && { category }),
    });
    const stored = async (slug) =>
      (await owner.query("SELECT category FROM topics WHERE slug=$1", [slug]))
        .rows[0]?.category;

    it("files a topic without a category under other and refuses unknown ones", async () => {
      await owner.query(
        `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label)
         VALUES ($1,'Older topic','Synthetic','Yes','No')`,
        [`${word}-older`],
      );
      assert.equal(await stored(`${word}-older`), "other");
      await assert.rejects(
        owner.query(
          `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,category)
           VALUES ($1,'Unknown','Synthetic','Yes','No','sports')`,
          [`${word}-unknown`],
        ),
        (error) =>
          error.code === "23514" && error.constraint === "topics_category",
      );
    });

    it("creates topics with their category, serves it publicly and filters by it", async () => {
      const matching = createMatchingRepository(runtime);
      const discovery = createDiscoveryRepository(runtime);
      const climate = await matching.createTopic(
        userId,
        input("climate", "climate"),
      );
      assert.equal(climate.category, "climate");
      const plain = await matching.createTopic(userId, input("plain"));
      assert.equal(plain.category, "other");
      assert.deepEqual(
        (await matching.listOwnTopics(userId))
          .map((topic) => [topic.slug, topic.category])
          .sort(),
        [
          [`${word}-climate`, "climate"],
          [`${word}-plain`, "other"],
        ],
      );
      // Drafts stay out of public lists until published.
      assert.deepEqual(
        (await discovery.listTopics({ query: word, category: "climate" }))
          .items,
        [],
      );
      for (const slug of [climate.slug, plain.slug])
        assert.ok(await matching.publishTopic(userId, slug));
      assert.equal(
        (await discovery.getTopic(climate.slug)).category,
        "climate",
      );
      const slugs = async (category) =>
        (await discovery.listTopics({ query: word, category })).items
          .map((topic) => topic.slug)
          .sort();
      assert.deepEqual(await slugs("climate"), [climate.slug]);
      assert.deepEqual(await slugs("other"), [plain.slug]);
      assert.deepEqual(await slugs("politics"), []);
      assert.deepEqual(await slugs(undefined), [climate.slug, plain.slug]);
    });

    it("lets only the owner change a category, with a recorded reason", async () => {
      const slug = `${word}-climate`;
      const id = (
        await owner.query("SELECT id FROM topics WHERE slug=$1", [slug])
      ).rows[0].id;
      // The runtime publishes and hides topics, but never recategorizes one.
      await assert.rejects(
        runtime.query("UPDATE topics SET category='work' WHERE id=$1", [id]),
        denied,
      );
      await runtime.query(
        "UPDATE topics SET category=category, publication_state='published' WHERE id=$1",
        [id],
      );
      for (const sql of [
        "SELECT * FROM topic_category_changes",
        "INSERT INTO topic_category_changes DEFAULT VALUES",
        "DELETE FROM topic_category_changes",
      ])
        await assert.rejects(runtime.query(sql), denied, sql);

      const command = (...argv) =>
        runCommand({ argv, connectionString: ownerUrl });
      // Without --execute the command previews and changes nothing.
      assert.deepEqual(await command(slug, "work", "Synthetic preview only"), {
        changed: true,
        slug,
        category: "work",
        previousCategory: "climate",
        executed: false,
      });
      assert.equal(await stored(slug), "climate");
      assert.deepEqual(
        await command(slug, "work", "Synthetic recategorization", "--execute"),
        {
          changed: true,
          slug,
          category: "work",
          previousCategory: "climate",
          executed: true,
        },
      );
      assert.equal(await stored(slug), "work");
      const changes = async () =>
        (
          await owner.query(
            `SELECT from_category, to_category, reason, recorded_by
             FROM topic_category_changes WHERE topic_id=$1 ORDER BY created_at, id`,
            [id],
          )
        ).rows;
      assert.deepEqual(await changes(), [
        {
          from_category: "climate",
          to_category: "work",
          reason: "Synthetic recategorization",
          recorded_by: "yaparena_owner",
        },
      ]);
      // Choosing the current category records nothing.
      assert.equal(
        (await command(slug, "work", "Synthetic repeat", "--execute")).changed,
        false,
      );
      assert.equal((await changes()).length, 1);
      await assert.rejects(
        command(slug, "sports", "Synthetic unknown", "--execute"),
        /choose a category/,
      );
      await assert.rejects(
        command(`${word}-missing`, "work", "Synthetic missing", "--execute"),
        /topic not found/,
      );
      await assert.rejects(
        runCommand({
          argv: [slug, "politics", "Synthetic runtime attempt", "--execute"],
          connectionString: runtimeUrl,
        }),
        /dedicated owner login/,
      );
      assert.equal(await stored(slug), "work");
      // The record of a change stays as written.
      await assert.rejects(
        owner.query(
          "UPDATE topic_category_changes SET reason='Rewritten reason' WHERE topic_id=$1",
          [id],
        ),
        denied,
      );
      await assert.rejects(
        owner.query(
          `INSERT INTO topic_category_changes(topic_id,from_category,to_category,reason)
           VALUES ($1,'work','work','Synthetic no-op')`,
          [id],
        ),
        (error) => error.code === "23514",
      );
    });
  },
);
