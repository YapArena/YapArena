import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createMatchingRepository,
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";

// Sweeps take a database lock that a parallel suite's sweep may hold; retry until one runs.
async function sweepOnce(instance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await instance.sweep();
    if (result.acquired) return result;
    await delay(25);
  }
  throw new Error("the matchmaking sweep lock stayed busy");
}

const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const hours = (count) => new Date(Date.now() + count * 60 * 60 * 1000);

// "Notify me" (first-run build plan PR 9), as the runtime role: one request per account and
// debate, a notice for each requester when the speakers are reminded, and cleanup afterwards.
describe(
  "notify-me requests against PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, matching, queue;
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
      matching = createMatchingRepository(runtime);
      // No pairing here: a parallel queue suite's players must never be matched by these sweeps.
      queue = createMatchmaking(runtime, { liveDebateCapacity: 0 });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    async function account() {
      return (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
    }
    async function speaker() {
      const id = await account();
      const handle = `notify-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
         VALUES ($1, $2, 'Notify speaker', 'published')`,
        [id, handle],
      );
      return { id, handle };
    }
    // A debate booked three hours ahead through an accepted challenge, as players book one.
    async function scheduled() {
      const slug = `notify-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
         VALUES ($1, 'Cities should ban cars downtown', 'Synthetic notify fixture', 'For', 'Against', 'published')`,
        [slug],
      );
      const [a, b] = await Promise.all([speaker(), speaker()]);
      const booked = await matching.createRequest(a.id, {
        kind: "direct",
        topicSlug: slug,
        targetHandle: b.handle,
        requestedSide: "A",
        scheduledAt: hours(3),
      });
      const debate = await matching.acceptRequest(b.id, booked.id);
      return { debate, a, b };
    }
    const notices = async (userId, type) =>
      (
        await owner.query(
          `SELECT message, debate_id AS "debateId" FROM account_notifications
           WHERE user_id = $1 AND event_type = $2 ORDER BY id`,
          [userId, type],
        )
      ).rows;
    const requests = async (debateId) =>
      (
        await owner.query(
          "SELECT user_id::text AS id FROM debate_notify_requests WHERE debate_id = $1 ORDER BY user_id",
          [debateId],
        )
      ).rows.map((row) => row.id);

    it("creates the request table with one row per account and debate for the runtime", async () => {
      const table = await owner.query(
        `SELECT c.relrowsecurity AS rls,
           has_table_privilege('yaparena_runtime', c.oid, 'SELECT') AS read,
           has_table_privilege('yaparena_runtime', c.oid, 'INSERT') AS add,
           has_table_privilege('yaparena_runtime', c.oid, 'DELETE') AS remove,
           has_table_privilege('yaparena_runtime', c.oid, 'UPDATE') AS change,
           has_table_privilege('yaparena_runtime', c.oid, 'TRUNCATE') AS clear
         FROM pg_class c WHERE c.oid = 'yaparena.debate_notify_requests'::regclass`,
      );
      assert.deepEqual(table.rows[0], {
        rls: true,
        read: true,
        add: true,
        remove: true,
        change: false,
        clear: false,
      });
      const { debate } = await scheduled();
      const viewer = await account();
      await runtime.query(
        "INSERT INTO debate_notify_requests (user_id, debate_id) VALUES ($1, $2)",
        [viewer, debate.id],
      );
      await assert.rejects(
        runtime.query(
          "INSERT INTO debate_notify_requests (user_id, debate_id) VALUES ($1, $2)",
          [viewer, debate.id],
        ),
        { code: "23505" },
      );
      const row = await owner.query(
        "SELECT created_at FROM debate_notify_requests WHERE user_id = $1 AND debate_id = $2",
        [viewer, debate.id],
      );
      assert.ok(Date.now() - row.rows[0].created_at.getTime() < 60_000);
    });

    it("saves, reads and removes a request while the debate's reminder is still to come", async () => {
      const { debate } = await scheduled();
      const viewer = await account();
      assert.equal(await matching.isNotifying(viewer, debate.id), false);
      assert.equal(await matching.requestNotify(viewer, debate.id), "created");
      assert.equal(await matching.requestNotify(viewer, debate.id), "exists");
      assert.equal(await matching.isNotifying(viewer, debate.id), true);
      assert.deepEqual(await requests(debate.id), [String(viewer)]);
      await matching.cancelNotify(viewer, debate.id);
      await matching.cancelNotify(viewer, debate.id);
      assert.equal(await matching.isNotifying(viewer, debate.id), false);
      assert.deepEqual(await requests(debate.id), []);
      // Another account's request is its own.
      const other = await account();
      await matching.requestNotify(other, debate.id);
      assert.equal(await matching.isNotifying(viewer, debate.id), false);
    });

    it("refuses debates that aren't public, are demos, have started or start within minutes", async () => {
      const viewer = await account();
      await assert.rejects(
        matching.requestNotify(viewer, randomUUID()),
        MatchNotFoundError,
      );
      const { debate } = await scheduled();
      const set = (sql) => owner.query(sql, [debate.id]);
      await set(
        "UPDATE debates SET publication_state = 'hidden' WHERE id = $1",
      );
      await assert.rejects(
        matching.requestNotify(viewer, debate.id),
        MatchNotFoundError,
      );
      await set(
        "UPDATE debates SET publication_state = 'published' WHERE id = $1",
      );
      await set(
        "UPDATE topics SET publication_state = 'hidden' WHERE id = (SELECT topic_id FROM debates WHERE id = $1)",
      );
      await assert.rejects(
        matching.requestNotify(viewer, debate.id),
        MatchNotFoundError,
      );
      await set(
        "UPDATE topics SET publication_state = 'published' WHERE id = (SELECT topic_id FROM debates WHERE id = $1)",
      );
      await set("UPDATE debates SET is_demo = true WHERE id = $1");
      await assert.rejects(
        matching.requestNotify(viewer, debate.id),
        /only for debates that haven't started/,
      );
      await set("UPDATE debates SET is_demo = false WHERE id = $1");
      // Booked too late for a reminder (the queue's own matches start at once).
      await set(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP + interval '4 minutes', created_at = CURRENT_TIMESTAMP WHERE id = $1",
      );
      await assert.rejects(
        matching.requestNotify(viewer, debate.id),
        (error) =>
          error instanceof MatchConflictError &&
          /starts in a few minutes/.test(error.message),
      );
      await set(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1",
      );
      await assert.rejects(
        matching.requestNotify(viewer, debate.id),
        /starts in a few minutes/,
      );
      await set(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP + interval '2 hours', created_at = CURRENT_TIMESTAMP - interval '1 day' WHERE id = $1",
      );
      assert.equal(await matching.requestNotify(viewer, debate.id), "created");
      // A request stops counting once its debate is no longer awaiting its start.
      for (const status of ["live", "cancelled", "ended"]) {
        await owner.query("UPDATE debates SET status = $2 WHERE id = $1", [
          debate.id,
          status,
        ]);
        assert.equal(await matching.isNotifying(viewer, debate.id), false);
        await assert.rejects(
          matching.requestNotify(await account(), debate.id),
          /only for debates that haven't started/,
        );
      }
    });

    it("notifies each requester once with the speakers' reminder, which stays as it was", async () => {
      const { debate, a, b } = await scheduled();
      const [viewer, suspended, late] = await Promise.all([
        account(),
        account(),
        account(),
      ]);
      for (const user of [viewer, suspended, a.id])
        assert.equal(await matching.requestNotify(user, debate.id), "created");
      await owner.query(
        "UPDATE users SET account_status = 'suspended' WHERE id = $1",
        [suspended],
      );
      await owner.query(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP + interval '3 minutes', created_at = CURRENT_TIMESTAMP - interval '1 day' WHERE id = $1",
        [debate.id],
      );
      await sweepOnce(queue);
      await sweepOnce(queue);
      // Speakers: exactly today's reminder, once, including the one who also asked.
      for (const user of [a.id, b.id]) {
        assert.deepEqual(await notices(user, "event.starting"), [
          {
            message: "Your debate starts in a few minutes. Join now.",
            debateId: debate.id,
          },
        ]);
        assert.deepEqual(await notices(user, "event.notify_starting"), []);
      }
      assert.deepEqual(await notices(viewer, "event.notify_starting"), [
        {
          message:
            "A debate you asked to be notified about starts in a few minutes: “Cities should ban cars downtown”",
          debateId: debate.id,
        },
      ]);
      assert.deepEqual(await notices(suspended, "event.notify_starting"), []);
      const reminded = await owner.query(
        "SELECT count(*)::int AS count FROM event_history WHERE debate_id = $1 AND action = 'reminded'",
        [debate.id],
      );
      assert.equal(reminded.rows[0].count, 1);
      // It shows in the viewer's in-app notification list.
      const [listed] = await matching.listNotifications(viewer);
      assert.equal(listed.eventType, "event.notify_starting");
      assert.equal(listed.debateId, debate.id);
      assert.equal(listed.readAt, null);
      // Too late for a request once the reminder went out; the saved one still reads as on.
      await assert.rejects(
        matching.requestNotify(late, debate.id),
        /starts in a few minutes/,
      );
      assert.equal(await matching.isNotifying(viewer, debate.id), true);
    });

    it("refuses a request that waited for a reminder being sent", async () => {
      const { debate } = await scheduled();
      const viewer = await account();
      // The reminder step locks the debate before it records the reminder.
      const sweep = await owner.connect();
      try {
        await sweep.query("BEGIN");
        await sweep.query("SELECT 1 FROM debates WHERE id = $1 FOR UPDATE", [
          debate.id,
        ]);
        let settled = false;
        const pending = matching.requestNotify(viewer, debate.id);
        pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        await delay(200);
        assert.equal(settled, false, "the request waits for the reminder");
        await sweep.query(
          `INSERT INTO event_history (debate_id, action, from_status, to_status)
           VALUES ($1, 'reminded', 'scheduled', 'scheduled')`,
          [debate.id],
        );
        await sweep.query("COMMIT");
        await assert.rejects(pending, /starts in a few minutes/);
      } finally {
        sweep.release();
      }
      assert.deepEqual(await requests(debate.id), []);
    });

    it("deletes requests once their debate starts or is called off", async () => {
      const [waiting, cancelled, started] = await Promise.all([
        scheduled(),
        scheduled(),
        scheduled(),
      ]);
      const viewer = await account();
      for (const { debate } of [waiting, cancelled, started])
        await matching.requestNotify(viewer, debate.id);
      await owner.query(
        "UPDATE debates SET status = 'cancelled' WHERE id = $1",
        [cancelled.debate.id],
      );
      await owner.query("UPDATE debates SET status = 'live' WHERE id = $1", [
        started.debate.id,
      ]);
      await queue.pruneExpired();
      assert.deepEqual(await requests(waiting.debate.id), [String(viewer)]);
      assert.deepEqual(await requests(cancelled.debate.id), []);
      assert.deepEqual(await requests(started.debate.id), []);
    });
  },
);
