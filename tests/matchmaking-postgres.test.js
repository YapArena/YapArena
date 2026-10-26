import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import pg from "pg";

import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createMatchingRepository,
  MatchConflictError,
  MatchNotFoundError,
} from "../dist/features/matching/repository.js";
import { createDebateAutoStart } from "../dist/features/media/auto-start.js";
import {
  createMediaRepository,
  MediaConflictError,
} from "../dist/features/media/repository.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;

// Runs as the runtime role, so it also proves the queue tables' grants and policies.
describe(
  "live topic queue against PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, queue;
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
      queue = createMatchmaking(runtime, { liveDebateCapacity: 100000 });
    });
    afterEach(async () => {
      // Only this suite writes queue rows; leave nothing waiting for the next test's sweeps.
      await owner.query(
        "UPDATE match_offers SET status = 'cancelled' WHERE status = 'pending'",
      );
      await owner.query(
        "UPDATE matchmaking_tickets SET status = 'closed', closed_reason = 'left' WHERE status IN ('searching', 'offered')",
      );
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    async function player() {
      const id = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      await owner.query(
        `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
         VALUES ($1, $2, 'Queue player', 'published')`,
        [id, `queue-${randomUUID().slice(0, 12)}`],
      );
      return id;
    }
    async function topic() {
      const slug = `queue-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
         VALUES ($1, 'Canada should expand nuclear power', 'Synthetic queue fixture', 'For', 'Against', 'published')`,
        [slug],
      );
      return slug;
    }
    async function offers(slug) {
      return (
        await owner.query(
          `SELECT o.* FROM match_offers o JOIN topics t ON t.id = o.topic_id
           WHERE t.slug = $1 ORDER BY o.created_at`,
          [slug],
        )
      ).rows;
    }
    async function ticket(userId) {
      return (
        await owner.query(
          "SELECT * FROM matchmaking_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
          [userId],
        )
      ).rows[0];
    }
    async function expire(offerId) {
      await owner.query(
        `UPDATE match_offers SET created_at = CURRENT_TIMESTAMP - interval '1 minute',
           deadline_at = CURRENT_TIMESTAMP - interval '1 second' WHERE id = $1`,
        [offerId],
      );
    }

    it("pairs opposite sides into an offer and starts a debate when both accept", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      const waiting = await queue.enter(a, { topicSlug: slug, side: "A" });
      assert.equal(waiting.ticket.status, "searching");
      assert.equal(waiting.ticket.sideLabel, "For");
      assert.deepEqual(await queue.waiting(slug), { sideA: 1, sideB: 0 });
      const offered = await queue.enter(b, { topicSlug: slug, side: "B" });
      assert.equal(offered.ticket.status, "offered");
      assert.equal(offered.offer.acceptedByMe, false);
      const deadline = new Date(offered.offer.deadlineAt).getTime();
      const now = new Date(offered.serverNow).getTime();
      assert.ok(deadline - now > 25_000 && deadline - now <= 30_000);

      const first = await queue.accept(a, offered.offer.id);
      assert.equal(first.debateId, null);
      assert.equal(first.state.offer.acceptedByMe, true);
      assert.equal((await queue.state(b)).offer.acceptedByOpponent, true);
      const second = await queue.accept(b, offered.offer.id);
      assert.ok(second.debateId);
      assert.equal(second.state.ticket.status, "matched");
      assert.equal(second.state.debate.id, second.debateId);

      const debate = (
        await owner.query(
          "SELECT proposition, status, scheduled_at FROM debates WHERE id = $1",
          [second.debateId],
        )
      ).rows[0];
      assert.equal(debate.proposition, "Canada should expand nuclear power");
      assert.equal(debate.status, "scheduled");
      assert.ok(Date.now() - new Date(debate.scheduled_at).getTime() < 60_000);
      const seats = (
        await owner.query(
          "SELECT user_id, side FROM event_participants WHERE debate_id = $1 ORDER BY side",
          [second.debateId],
        )
      ).rows;
      assert.deepEqual(
        seats.map((seat) => [seat.user_id, seat.side]),
        [
          [a, "A"],
          [b, "B"],
        ],
      );
      assert.equal(
        (await queue.state(a)).debate.slug.startsWith("debate-"),
        true,
      );
      // A repeat accept is harmless; a seated player cannot queue again.
      assert.equal((await queue.accept(a, offered.offer.id)).debateId, null);
      await assert.rejects(
        queue.enter(a, { topicSlug: slug, side: "A" }),
        MatchConflictError,
      );
    });

    it("creates exactly one debate when both players accept at the same moment", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      await queue.enter(a, { topicSlug: slug, side: "A" });
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      const results = await Promise.all([
        queue.accept(a, offer.id),
        queue.accept(b, offer.id),
      ]);
      assert.equal(results.filter((result) => result.debateId).length, 1);
      const debates = await owner.query(
        "SELECT count(*)::int AS count FROM event_participants WHERE user_id = ANY($1::bigint[])",
        [[a, b]],
      );
      assert.equal(debates.rows[0].count, 2);
    });

    it("pairs simultaneous entries exactly once, oldest first", async () => {
      const slug = await topic();
      const sideA = [await player(), await player(), await player()];
      const sideB = [await player(), await player(), await player()];
      await Promise.all([
        ...sideA.map((id) => queue.enter(id, { topicSlug: slug, side: "A" })),
        ...sideB.map((id) => queue.enter(id, { topicSlug: slug, side: "B" })),
      ]);
      await queue.sweep();
      const made = await offers(slug);
      assert.equal(made.length, 3);
      assert.equal(new Set(made.map((offer) => offer.ticket_a_id)).size, 3);
      assert.equal(new Set(made.map((offer) => offer.ticket_b_id)).size, 3);
      for (const id of [...sideA, ...sideB])
        assert.equal((await ticket(id)).status, "offered");

      const later = await topic();
      const [early, late, opponent] = [
        await player(),
        await player(),
        await player(),
      ];
      await queue.enter(early, { topicSlug: later, side: "A" });
      await queue.enter(late, { topicSlug: later, side: "A" });
      await owner.query(
        "UPDATE matchmaking_tickets SET priority_at = priority_at - interval '1 minute' WHERE user_id = $1",
        [early],
      );
      await queue.enter(opponent, { topicSlug: later, side: "B" });
      assert.equal((await ticket(early)).status, "offered");
      assert.equal((await ticket(late)).status, "searching");
    });

    it("requeues the player who accepted when the 30 seconds run out", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      await queue.enter(a, { topicSlug: slug, side: "A" });
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      const queuedAt = (await ticket(a)).priority_at;
      await queue.accept(a, offer.id);
      await expire(offer.id);
      await assert.rejects(queue.accept(b, offer.id), MatchConflictError);
      const swept = await queue.sweep();
      assert.equal(swept.acquired, true);
      assert.equal((await offers(slug))[0].status, "expired");
      const requeued = await ticket(a);
      assert.equal(requeued.status, "searching");
      assert.deepEqual(requeued.priority_at, queuedAt);
      const missed = await queue.state(b);
      assert.equal(missed.ticket.status, "closed");
      assert.equal(missed.ticket.closedReason, "missed");
    });

    it("returns the opponent to the queue when a player declines or leaves", async () => {
      const slug = await topic();
      const [a, b, c] = [await player(), await player(), await player()];
      await queue.enter(a, { topicSlug: slug, side: "A" });
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      const declined = await queue.decline(b, offer.id);
      assert.equal(declined.ticket.closedReason, "declined");
      assert.equal((await ticket(a)).status, "searching");
      await assert.rejects(queue.decline(b, offer.id), MatchConflictError);
      await assert.rejects(queue.accept(c, offer.id), MatchNotFoundError);

      const second = await queue.enter(c, { topicSlug: slug, side: "B" });
      assert.equal(second.ticket.status, "offered");
      const left = await queue.leave(a);
      assert.equal(left.ticket.closedReason, "declined");
      assert.equal((await ticket(c)).status, "searching");
      const gone = await queue.leave(c);
      assert.equal(gone.ticket.closedReason, "left");
      assert.equal((await queue.leave(c)).ticket.closedReason, "left");
    });

    it("cancels the match and requeues the other player when one no longer qualifies", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      await queue.enter(a, { topicSlug: slug, side: "A" });
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      await queue.accept(a, offer.id);
      await owner.query(
        "UPDATE public_profiles SET publication_state = 'hidden' WHERE user_id = $1",
        [b],
      );
      const result = await queue.accept(b, offer.id);
      assert.equal(result.debateId, null);
      assert.equal(result.state.ticket.closedReason, "unavailable");
      assert.equal((await ticket(a)).status, "searching");
      assert.equal((await offers(slug))[0].status, "cancelled");

      const closed = await topic();
      const [c, d] = [await player(), await player()];
      await queue.enter(c, { topicSlug: closed, side: "A" });
      const next = await queue.enter(d, { topicSlug: closed, side: "B" });
      await queue.accept(c, next.offer.id);
      await owner.query(
        "UPDATE topics SET publication_state = 'hidden' WHERE slug = $1",
        [closed],
      );
      await queue.accept(d, next.offer.id);
      assert.equal((await ticket(c)).closed_reason, "topic_closed");
      assert.equal((await ticket(d)).closed_reason, "topic_closed");
    });

    it("keeps one queue per player and refuses unknown topics", async () => {
      const [slug, other] = [await topic(), await topic()];
      const a = await player();
      const first = await queue.enter(a, { topicSlug: slug, side: "A" });
      const again = await queue.enter(a, { topicSlug: slug, side: "A" });
      assert.equal(again.ticket.id, first.ticket.id);
      await assert.rejects(
        queue.enter(a, { topicSlug: other, side: "A" }),
        /already in a queue/,
      );
      await assert.rejects(
        queue.enter(a, { topicSlug: "queue-missing-topic", side: "A" }),
        MatchNotFoundError,
      );
      const stranger = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      await assert.rejects(
        queue.enter(stranger, { topicSlug: slug, side: "B" }),
        /published participant profile/,
      );
      assert.equal((await queue.state(stranger)).ticket, null);
    });

    it("drops absent players and waits for a free recording slot", async () => {
      const slug = await topic();
      const [a, b, c] = [await player(), await player(), await player()];
      await queue.enter(a, { topicSlug: slug, side: "A" });
      await owner.query(
        "UPDATE matchmaking_tickets SET last_seen_at = CURRENT_TIMESTAMP - interval '2 minutes' WHERE user_id = $1",
        [a],
      );
      assert.deepEqual(await queue.waiting(slug), { sideA: 0, sideB: 0 });
      await queue.sweep();
      assert.equal((await ticket(a)).closed_reason, "stale");

      const full = createMatchmaking(runtime, { liveDebateCapacity: 0 });
      await full.enter(b, { topicSlug: slug, side: "A" });
      await full.enter(c, { topicSlug: slug, side: "B" });
      await full.sweep();
      assert.equal((await ticket(b)).status, "searching");
      assert.equal((await full.touch(b)).ticket.status, "searching");
      await queue.sweep();
      assert.equal((await ticket(b)).status, "offered");
      assert.equal((await ticket(c)).status, "offered");
    });

    it("prunes resolved queue history after its retention period", async () => {
      const slug = await topic();
      const a = await player();
      await queue.enter(a, { topicSlug: slug, side: "A" });
      await queue.leave(a);
      await owner.query(
        "UPDATE matchmaking_tickets SET updated_at = CURRENT_TIMESTAMP - interval '31 days' WHERE user_id = $1",
        [a],
      );
      assert.ok((await queue.pruneExpired()) >= 1);
      assert.equal(await ticket(a), undefined);
    });

    // Both players accepted; returns the new debate's id.
    async function matched(slug, a, b) {
      await queue.enter(a, { topicSlug: slug, side: "A" });
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      await queue.accept(a, offer.id);
      return (await queue.accept(b, offer.id)).debateId;
    }

    it("requires a recent camera and microphone check before queueing", async () => {
      const slug = await topic();
      const a = await player();
      const checked = createMatchmaking(runtime, {
        liveDebateCapacity: 100000,
        requireDeviceCheck: true,
      });
      await assert.rejects(
        checked.enter(a, { topicSlug: slug, side: "A" }),
        /check your camera and microphone/,
      );
      const media = createMediaRepository(runtime);
      await media.checkAccountDevice(a, true, false);
      await assert.rejects(
        checked.enter(a, { topicSlug: slug, side: "A" }),
        /check your camera/,
      );
      await media.checkAccountDevice(a, true, true);
      assert.equal(
        (await checked.enter(a, { topicSlug: slug, side: "A" })).ticket.status,
        "searching",
      );
      await owner.query(
        "UPDATE account_device_checks SET checked_at = CURRENT_TIMESTAMP - interval '31 minutes' WHERE user_id = $1",
        [a],
      );
      await checked.leave(a);
      await assert.rejects(
        checked.enter(a, { topicSlug: slug, side: "A" }),
        /check your camera/,
      );
    });

    it("starts a ready debate automatically, once, with the system as actor", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      const debateId = await matched(slug, a, b);
      const calls = [];
      let release;
      const autoStart = createDebateAutoStart({
        database: runtime,
        startDebate: async (input) => {
          calls.push(input);
          await new Promise((resolve) => {
            release = resolve;
          });
        },
        logger: { error() {} },
      });
      assert.equal(await autoStart.tryStart(debateId), false);
      const matching = createMatchingRepository(runtime);
      await matching.markReady(a, debateId);
      await matching.markReady(b, debateId);
      const first = autoStart.tryStart(debateId);
      while (!release) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await autoStart.tryStart(debateId), false);
      release();
      assert.equal(await first, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].debateId, debateId);
      assert.equal(calls[0].actorUserId, null);
      assert.match(calls[0].reason, /Automatic start/);
    });

    it("waits for both speakers, and the worker logs start failures without stopping", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      const debateId = await matched(slug, a, b);
      const matching = createMatchingRepository(runtime);
      await matching.markReady(a, debateId);
      await matching.markReady(b, debateId);
      const errors = [];
      let failure = new MediaConflictError("both speakers must be connected");
      const autoStart = createDebateAutoStart({
        database: runtime,
        startDebate: async () => {
          throw failure;
        },
        logger: { error: (details) => errors.push(details.debateId) },
      });
      assert.equal(await autoStart.tryStart(debateId), false);
      failure = new MatchConflictError("invalid event transition");
      assert.equal(await autoStart.tryStart(debateId), false);
      failure = new Error("egress unavailable");
      await assert.rejects(autoStart.tryStart(debateId), /egress unavailable/);
      await autoStart.sweep();
      assert.ok(errors.includes(debateId));
    });

    it("cancels a matched debate nobody started and requeues the player who joined", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      const queuedAt = (await queue.enter(a, { topicSlug: slug, side: "A" }))
        .ticket.queuedAt;
      const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
      await queue.accept(a, offer.id);
      const { debateId } = await queue.accept(b, offer.id);
      await createMatchingRepository(runtime).markReady(a, debateId);
      await queue.sweep();
      assert.equal(
        (
          await owner.query("SELECT status FROM debates WHERE id = $1", [
            debateId,
          ])
        ).rows[0].status,
        "scheduled",
      );
      await owner.query(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP - interval '91 seconds' WHERE id = $1",
        [debateId],
      );
      const swept = await queue.sweep();
      assert.ok(swept.value.noShows >= 1);
      const debate = (
        await owner.query(
          "SELECT status, ended_reason FROM debates WHERE id = $1",
          [debateId],
        )
      ).rows[0];
      assert.deepEqual(debate, {
        status: "cancelled",
        ended_reason: "automatic_no_show",
      });
      const seats = await owner.query(
        "SELECT count(*)::int AS count FROM event_participants WHERE debate_id = $1 AND active",
        [debateId],
      );
      assert.equal(seats.rows[0].count, 0);
      const back = await ticket(a);
      assert.equal(back.status, "searching");
      assert.equal(new Date(back.priority_at).toISOString(), queuedAt);
      assert.equal((await ticket(b)).status, "matched");
      const notices = await owner.query(
        "SELECT count(*)::int AS count FROM account_notifications WHERE debate_id = $1 AND event_type = 'event.no_show'",
        [debateId],
      );
      assert.equal(notices.rows[0].count, 2);
      const history = await owner.query(
        "SELECT actor_user_id, to_status FROM event_history WHERE debate_id = $1 AND action = 'no_show'",
        [debateId],
      );
      assert.deepEqual(history.rows, [
        { actor_user_id: null, to_status: "cancelled" },
      ]);
    });

    it("gives a scheduled debate ten minutes to start before cancelling it", async () => {
      const slug = await topic();
      const [a, b] = [await player(), await player()];
      const topicId = (
        await owner.query("SELECT id FROM topics WHERE slug = $1", [slug])
      ).rows[0].id;
      const debateId = (
        await owner.query(
          `INSERT INTO debates (slug, topic_id, proposition, status, publication_state,
             rules_version, rules_snapshot, scheduled_at)
           VALUES ($1, $2, 'Canada should expand nuclear power', 'scheduled', 'published',
             'preview-1', '{}', CURRENT_TIMESTAMP - interval '9 minutes') RETURNING id`,
          [`debate-${randomUUID()}`, topicId],
        )
      ).rows[0].id;
      await owner.query(
        "INSERT INTO event_participants (debate_id, user_id, side) VALUES ($1, $2, 'A'), ($1, $3, 'B')",
        [debateId, a, b],
      );
      await queue.sweep();
      const status = async () =>
        (
          await owner.query("SELECT status FROM debates WHERE id = $1", [
            debateId,
          ])
        ).rows[0].status;
      assert.equal(await status(), "scheduled");
      await owner.query(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP - interval '11 minutes' WHERE id = $1",
        [debateId],
      );
      await queue.sweep();
      assert.equal(await status(), "cancelled");
      assert.equal(await ticket(a), undefined);
    });

    it("signals only queue state changes to each affected player", async () => {
      const listener = new pg.Client({
        connectionString: runtimeUrl,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      await listener.connect();
      const heard = [];
      listener.on("notification", (message) => {
        if (message.channel === "yaparena_user_v1") heard.push(message.payload);
      });
      await listener.query("LISTEN yaparena_user_v1");
      const drain = async () => {
        await listener.query("SELECT 1");
        const copy = [...heard];
        heard.length = 0;
        return copy.sort();
      };
      try {
        const slug = await topic();
        const [a, b] = [await player(), await player()];
        await queue.enter(a, { topicSlug: slug, side: "A" });
        assert.deepEqual(await drain(), [a]);
        await queue.touch(a);
        assert.equal(await queue.touchMany([a, b]), 1);
        assert.deepEqual(await drain(), []);
        const { offer } = await queue.enter(b, { topicSlug: slug, side: "B" });
        assert.deepEqual(await drain(), [a, b].sort());
        await queue.accept(a, offer.id);
        assert.deepEqual(await drain(), [a, b].sort());
        const { debateId, state } = await queue.accept(b, offer.id);
        assert.deepEqual(await drain(), [a, b].sort());
        assert.equal(state.debate.id, debateId);
        assert.equal(state.debate.status, "scheduled");
        const window =
          new Date(state.debate.joinDeadlineAt).getTime() -
          new Date(state.serverNow).getTime();
        assert.ok(window > 80_000 && window <= 90_000);
        assert.equal(await queue.touchMany([]), 0);
      } finally {
        await listener.end();
      }
    });
  },
);
