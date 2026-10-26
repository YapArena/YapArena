import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import pg from "pg";

import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createMatchingRepository,
  MatchConflictError,
} from "../dist/features/matching/repository.js";

// Sweeps take a database lock that a parallel suite's sweep may hold; retry until one runs.
async function sweepOnce(instance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await instance.sweep();
    if (result.acquired) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the matchmaking sweep lock stayed busy");
}

const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const hours = (count) => new Date(Date.now() + count * 60 * 60 * 1000);

// Runs as the runtime role: bookings hold time windows instead of one seat per player.
describe(
  "seat reservations against PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, matching, queue;
    // Other PostgreSQL suites share this database, so cleanup touches only this suite's players.
    const players = [];
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
    afterEach(async () => {
      await owner.query(
        "UPDATE matchmaking_tickets SET status = 'closed', closed_reason = 'left' WHERE status IN ('searching', 'offered') AND user_id = ANY($1::bigint[])",
        [players],
      );
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    async function player() {
      const id = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      players.push(id);
      const handle = `seat-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
         VALUES ($1, $2, 'Seat player', 'published')`,
        [id, handle],
      );
      return { id, handle };
    }
    async function topic() {
      const slug = `seat-${randomUUID().slice(0, 12)}`;
      const id = (
        await owner.query(
          `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
           VALUES ($1, 'Canada should expand nuclear power', 'Synthetic seat fixture', 'For', 'Against', 'published')
           RETURNING id`,
          [slug],
        )
      ).rows[0].id;
      return { id, slug };
    }
    const challenge = (from, to, slug, scheduledAt) =>
      matching.createRequest(from.id, {
        kind: "direct",
        topicSlug: slug,
        targetHandle: to.handle,
        proposition: "Canada should expand nuclear power",
        requestedSide: "A",
        scheduledAt,
      });
    async function status(requestId) {
      return (
        await owner.query("SELECT status FROM match_requests WHERE id = $1", [
          requestId,
        ])
      ).rows[0].status;
    }
    // A debate booked directly, as an operator fixture would, starting `minutes` from now.
    async function booking(topicId, a, b, minutes, { reserved = true } = {}) {
      const debateId = (
        await owner.query(
          `INSERT INTO debates (slug, topic_id, proposition, status, publication_state,
             rules_version, rules_snapshot, scheduled_at)
           VALUES ($1, $2, 'Canada should expand nuclear power', 'scheduled', 'published',
             'preview-1', '{}', CURRENT_TIMESTAMP + make_interval(mins => $3)) RETURNING id`,
          [`debate-${randomUUID()}`, topicId, minutes],
        )
      ).rows[0].id;
      await owner.query(
        reserved
          ? `INSERT INTO event_participants (debate_id, user_id, side, reserved_from, reserved_until)
             VALUES ($1, $2, 'A', CURRENT_TIMESTAMP + make_interval(mins => $4 - 5),
               CURRENT_TIMESTAMP + make_interval(mins => $4 + 20)),
             ($1, $3, 'B', CURRENT_TIMESTAMP + make_interval(mins => $4 - 5),
               CURRENT_TIMESTAMP + make_interval(mins => $4 + 20))`
          : "INSERT INTO event_participants (debate_id, user_id, side) VALUES ($1, $2, 'A'), ($1, $3, 'B')",
        reserved ? [debateId, a.id, b.id, minutes] : [debateId, a.id, b.id],
      );
      return debateId;
    }

    it("holds several bookings at different times and refuses an overlapping one", async () => {
      const { slug } = await topic();
      const [a, b, c, d] = await Promise.all([
        player(),
        player(),
        player(),
        player(),
      ]);
      const early = hours(3);
      const first = await challenge(a, b, slug, early);
      const second = await challenge(c, b, slug, hours(6));
      const debate = await matching.acceptRequest(b.id, first.id);
      await matching.acceptRequest(b.id, second.id);
      const seats = await owner.query(
        `SELECT reserved_from, reserved_until FROM event_participants
         WHERE user_id = $1 AND active ORDER BY reserved_from`,
        [b.id],
      );
      assert.equal(seats.rows.length, 2);
      const seat = await owner.query(
        "SELECT reserved_from, reserved_until FROM event_participants WHERE debate_id = $1 LIMIT 1",
        [debate.id],
      );
      assert.equal(
        early.getTime() - seat.rows[0].reserved_from.getTime(),
        5 * 60 * 1000,
      );
      assert.equal(
        seat.rows[0].reserved_until.getTime() - early.getTime(),
        (600 + 600) * 1000,
      );
      const clash = await challenge(
        d,
        b,
        slug,
        new Date(early.getTime() + 10 * 60 * 1000),
      );
      await assert.rejects(
        matching.acceptRequest(b.id, clash.id),
        /already has a debate at that time/,
      );
    });

    it("closes only the requests whose time overlaps an accepted match", async () => {
      const { slug } = await topic();
      const [a, b, c, e] = await Promise.all([
        player(),
        player(),
        player(),
        player(),
      ]);
      const when = hours(3);
      const accepted = await challenge(a, b, slug, when);
      const sameTime = await challenge(c, b, slug, when);
      const later = await challenge(e, b, slug, hours(9));
      await matching.acceptRequest(b.id, accepted.id);
      assert.equal(await status(sameTime.id), "conflicted");
      assert.equal(await status(later.id), "open");
    });

    it("keeps a queued player out of a match that would run into their booking", async () => {
      const room = await topic();
      const [a, other] = await Promise.all([player(), player()]);
      const debateId = await booking(room.id, a, other, 20);
      const entered = await queue.enter(a.id, {
        topicSlug: room.slug,
        side: "A",
      });
      assert.equal(entered.ticket.status, "searching");
      await owner.query(
        `UPDATE event_participants SET reserved_from = CURRENT_TIMESTAMP + interval '5 minutes',
           reserved_until = CURRENT_TIMESTAMP + interval '30 minutes' WHERE debate_id = $1`,
        [debateId],
      );
      const swept = await sweepOnce(queue);
      assert.ok(swept.value.booked >= 1);
      const left = await queue.state(a.id);
      assert.equal(left.ticket.closedReason, "booking");
      await assert.rejects(
        queue.enter(a.id, { topicSlug: room.slug, side: "A" }),
        MatchConflictError,
      );
    });

    it("treats a seat recorded before reservations as blocking every time", async () => {
      const room = await topic();
      const [a, b, c] = await Promise.all([player(), player(), player()]);
      await booking(room.id, a, b, 60 * 24, { reserved: false });
      await assert.rejects(
        challenge(a, c, room.slug, hours(30)),
        /already has a debate at that time/,
      );
      await assert.rejects(
        queue.enter(a.id, { topicSlug: room.slug, side: "A" }),
        /already has a debate at that time/,
      );
    });
  },
);
