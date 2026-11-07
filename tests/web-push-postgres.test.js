import assert from "node:assert/strict";
import { createECDH, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  createMatchingRepository,
  remindScheduledDebate,
} from "../dist/features/matching/repository.js";
import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createPushDelivery,
  createPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS,
  PUSH_DELIVERY_ATTEMPTS,
} from "../dist/features/matching/push.js";
import { withTransaction } from "../dist/platform/transaction.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const hours = (count) => new Date(Date.now() + count * 60 * 60 * 1000);

// Web push for "Notify me" (first-run build plan PR 10), as the runtime role: subscriptions per
// account, deliveries queued with the reminder's in-app notice, and the delivery job.
describe(
  "web push subscriptions and deliveries against PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, matching, queue, subscriptions;
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
      queue = createMatchmaking(runtime, { liveDebateCapacity: 0 });
      subscriptions = createPushSubscriptions(runtime);
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
      const handle = `push-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
         VALUES ($1, $2, 'Push speaker', 'published')`,
        [id, handle],
      );
      return { id, handle };
    }
    async function scheduled() {
      const slug = `push-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
         VALUES ($1, 'Cities should ban cars downtown', 'Synthetic push fixture', 'For', 'Against', 'published')`,
        [slug],
      );
      const [a, b] = await Promise.all([speaker(), speaker()]);
      const booked = await matching.createRequest(a.id, {
        kind: "direct",
        topicSlug: slug,
        targetHandle: b.handle,
        proposition: "Cities should ban cars downtown",
        requestedSide: "A",
        scheduledAt: hours(3),
      });
      const debate = await matching.acceptRequest(b.id, booked.id);
      return { debate, a, b };
    }
    // A browser's subscription on a push service, with its own keys.
    function browser(host = "web.push.apple.com") {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      return {
        endpoint: `https://${host}/${randomUUID()}`,
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: Buffer.from(randomUUID().slice(0, 16)).toString("base64url"),
      };
    }
    const owned = async (userId) =>
      (
        await owner.query(
          "SELECT endpoint FROM web_push_subscriptions WHERE user_id = $1 ORDER BY id",
          [userId],
        )
      ).rows.map((row) => row.endpoint);
    const deliveries = async (debateId) =>
      (
        await owner.query(
          `SELECT s.endpoint, w.attempts FROM web_push_deliveries w
           JOIN web_push_subscriptions s ON s.id = w.subscription_id
           WHERE w.debate_id = $1 ORDER BY s.endpoint`,
          [debateId],
        )
      ).rows;
    async function remind(debateId, webPush) {
      await withTransaction(runtime, (client) =>
        remindScheduledDebate(client, debateId, "scheduled", { webPush }),
      );
    }

    it("creates both tables with row security and runtime access only", async () => {
      for (const table of ["web_push_subscriptions", "web_push_deliveries"]) {
        const result = await owner.query(
          `SELECT c.relrowsecurity AS rls,
             has_table_privilege('yaparena_runtime', c.oid, 'SELECT') AS read,
             has_table_privilege('yaparena_runtime', c.oid, 'INSERT') AS add,
             has_table_privilege('yaparena_runtime', c.oid, 'UPDATE') AS change,
             has_table_privilege('yaparena_runtime', c.oid, 'DELETE') AS remove,
             has_table_privilege('yaparena_runtime', c.oid, 'TRUNCATE') AS clear
           FROM pg_class c WHERE c.oid = $1::regclass`,
          [`yaparena.${table}`],
        );
        assert.deepEqual(
          result.rows[0],
          {
            rls: true,
            read: true,
            add: true,
            change: true,
            remove: true,
            clear: false,
          },
          table,
        );
      }
      const user = await account();
      const good = browser();
      for (const bad of [
        { ...good, endpoint: "http://web.push.apple.com/x" },
        { ...good, p256dh: "short" },
        { ...good, auth: "x".repeat(23) },
      ])
        await assert.rejects(
          runtime.query(
            "INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)",
            [user, bad.endpoint, bad.p256dh, bad.auth],
          ),
          { code: "23514" },
        );
    });

    it("saves one row per browser, moves it between accounts and keeps the newest ten", async () => {
      const [first, second] = [await account(), await account()];
      const phone = browser();
      assert.equal(await subscriptions.save(first, phone), "created");
      const rotated = { ...phone, auth: browser().auth };
      assert.equal(await subscriptions.save(first, rotated), "updated");
      const row = await owner.query(
        "SELECT auth FROM web_push_subscriptions WHERE endpoint = $1",
        [phone.endpoint],
      );
      assert.equal(row.rows[0].auth, rotated.auth);
      // The same browser signed in to another account belongs to that account now.
      assert.equal(await subscriptions.save(second, phone), "created");
      assert.deepEqual(await owned(first), []);
      assert.deepEqual(await owned(second), [phone.endpoint]);
      await subscriptions.remove(first, phone.endpoint);
      assert.deepEqual(await owned(second), [phone.endpoint], "only your own");
      await subscriptions.remove(second, phone.endpoint);
      assert.deepEqual(await owned(second), []);
      const many = [];
      for (let index = 0; index <= MAX_PUSH_SUBSCRIPTIONS; index++) {
        const next = browser("fcm.googleapis.com");
        many.push(next.endpoint);
        await subscriptions.save(first, next);
      }
      assert.deepEqual(await owned(first), many.slice(1), "the oldest goes");
      // An account takes its subscriptions with it.
      await owner.query("DELETE FROM users WHERE id = $1", [first]);
      assert.deepEqual(await owned(first), []);
    });

    it("queues a delivery per subscription of each notified requester, only with push on", async () => {
      const { debate, a } = await scheduled();
      const [viewer, suspended, bystander] = [
        await account(),
        await account(),
        await account(),
      ];
      for (const user of [viewer, suspended, a.id])
        await matching.requestNotify(user, debate.id);
      await owner.query(
        "UPDATE users SET account_status = 'suspended' WHERE id = $1",
        [suspended],
      );
      const [phone, laptop] = [browser(), browser("fcm.googleapis.com")];
      await subscriptions.save(viewer, phone);
      await subscriptions.save(viewer, laptop);
      for (const user of [suspended, a.id, bystander])
        await subscriptions.save(user, browser());
      await remind(debate.id, true);
      assert.deepEqual(
        (await deliveries(debate.id)).map((row) => row.endpoint),
        [phone.endpoint, laptop.endpoint].sort(),
      );
      // The in-app notice is unchanged and goes to the same viewer.
      const notices = await owner.query(
        "SELECT user_id::text AS id FROM account_notifications WHERE debate_id = $1 AND event_type = 'event.notify_starting'",
        [debate.id],
      );
      assert.deepEqual(
        notices.rows.map((row) => row.id),
        [String(viewer)],
      );
      // Without push, the reminder queues nothing.
      const other = await scheduled();
      await matching.requestNotify(viewer, other.debate.id);
      await remind(other.debate.id, false);
      assert.deepEqual(await deliveries(other.debate.id), []);
      await owner.query(
        "DELETE FROM web_push_deliveries WHERE debate_id = $1",
        [debate.id],
      );
    });

    it("sends each due delivery once, deletes gone subscriptions and retries a few times", async () => {
      const { debate } = await scheduled();
      const viewer = await account();
      await matching.requestNotify(viewer, debate.id);
      const [delivered, gone, flaky] = [browser(), browser(), browser()];
      for (const subscription of [delivered, gone, flaky])
        await subscriptions.save(viewer, subscription);
      await remind(debate.id, true);
      const sent = [];
      const outcomes = {
        [delivered.endpoint]: "sent",
        [gone.endpoint]: "gone",
        [flaky.endpoint]: "retry",
      };
      const job = createPushDelivery({
        database: runtime,
        logger: { info() {}, warn() {} },
        push: {
          send: async (subscription, message) => {
            sent.push([subscription.endpoint, message]);
            return { outcome: outcomes[subscription.endpoint] ?? "sent" };
          },
        },
      });
      const first = await job.flush();
      assert.equal(first.sent, 1);
      assert.equal(first.gone, 1);
      assert.equal(first.retry, 1);
      assert.deepEqual(
        sent.find(([endpoint]) => endpoint === delivered.endpoint)[1],
        {
          title: "Cities should ban cars downtown",
          url: `/debates/${debate.slug}`,
        },
      );
      assert.deepEqual(await owned(viewer), [
        delivered.endpoint,
        flaky.endpoint,
      ]);
      assert.deepEqual(await deliveries(debate.id), [
        { endpoint: flaky.endpoint, attempts: 1 },
      ]);
      // Still leased: the next pass leaves it alone.
      sent.length = 0;
      await job.flush();
      assert.deepEqual(sent, []);
      for (let attempt = 2; attempt <= PUSH_DELIVERY_ATTEMPTS; attempt++) {
        await owner.query(
          "UPDATE web_push_deliveries SET claimed_until = CURRENT_TIMESTAMP - interval '1 second' WHERE debate_id = $1",
          [debate.id],
        );
        await job.flush();
        assert.deepEqual(await deliveries(debate.id), [
          { endpoint: flaky.endpoint, attempts: attempt },
        ]);
      }
      // Out of tries, the hourly cleanup removes it.
      await owner.query(
        "UPDATE web_push_deliveries SET claimed_until = CURRENT_TIMESTAMP - interval '1 second' WHERE debate_id = $1",
        [debate.id],
      );
      sent.length = 0;
      await job.flush();
      assert.deepEqual(sent, []);
      await queue.pruneExpired();
      assert.deepEqual(await deliveries(debate.id), []);
    });

    it("skips a debate called off since the reminder, and expires old deliveries", async () => {
      const [called, late] = [await scheduled(), await scheduled()];
      const viewer = await account();
      await subscriptions.save(viewer, browser());
      for (const { debate } of [called, late]) {
        await matching.requestNotify(viewer, debate.id);
        await remind(debate.id, true);
      }
      await owner.query(
        "UPDATE debates SET status = 'cancelled' WHERE id = $1",
        [called.debate.id],
      );
      await owner.query(
        "UPDATE web_push_deliveries SET created_at = CURRENT_TIMESTAMP - interval '11 minutes' WHERE debate_id = $1",
        [late.debate.id],
      );
      const sent = [];
      const job = createPushDelivery({
        database: runtime,
        logger: { info() {}, warn() {} },
        push: {
          send: async (subscription) => {
            sent.push(subscription.endpoint);
            return { outcome: "sent" };
          },
        },
      });
      const result = await job.flush();
      assert.equal(result.skipped, 1);
      assert.deepEqual(sent, []);
      assert.deepEqual(await deliveries(called.debate.id), []);
      assert.equal((await deliveries(late.debate.id)).length, 1);
      await queue.pruneExpired();
      assert.deepEqual(await deliveries(late.debate.id), []);
    });
  },
);
