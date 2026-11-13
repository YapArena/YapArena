import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  createTopicEndorsementReader,
  topicSideAIsYes,
} from "../dist/features/endorsement/topic-page.js";

// Decision 0015: what the topic page reads, as the runtime role. The stored
// points are covered by endorsement-postgres.test.js; this covers D4, the
// founder's latest review of which side answers yes.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;

describe(
  "the topic page's endorsement reader",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    it("reads side A as yes until the latest review says otherwise", async () => {
      const topicId = (
        await owner.query(
          `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
          VALUES($1,$2,'Synthetic reader fixture','No change','Change it','published')
          RETURNING id`,
          [
            `endorsement-reader-${randomUUID()}`,
            `Should reader fixture ${randomUUID()} count?`,
          ],
        )
      ).rows[0].id;
      const reader = createTopicEndorsementReader(runtime, "simulation");
      assert.deepEqual(await reader.topic(topicId), {
        figure: null,
        history: [],
        debates: [],
        sideAIsYes: true,
      });
      const review = (sideAIsYes) =>
        owner.query(
          `INSERT INTO topic_answer_reviews(topic_id,side_a_is_yes,reason)
          VALUES($1,$2,'Synthetic review for the reader test')`,
          [topicId, sideAIsYes],
        );
      await review(false);
      assert.equal(await topicSideAIsYes(runtime, topicId), false);
      assert.equal((await reader.topic(topicId)).sideAIsYes, false);
      await review(true);
      assert.equal(await topicSideAIsYes(runtime, topicId), true);
      // Another topic's review never applies.
      assert.equal(await topicSideAIsYes(runtime, randomUUID()), true);
    });
  },
);
