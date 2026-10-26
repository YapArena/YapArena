import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createMatchingRepository,
  MatchConflictError,
} from "../dist/features/matching/repository.js";
import {
  DEBATER_CONSENT_VERSION,
  DebaterSettingsRequiredError,
} from "../dist/features/transcription/debater-settings.js";

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

// Runs as the runtime role: direct challenges "now" or at an agreed time (Decision 0011).
describe(
  "direct challenges against PostgreSQL",
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

    async function player(displayName = "Challenge player") {
      const id = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      const handle = `chal-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
         VALUES ($1, $2, $3, 'published')`,
        [id, handle, displayName],
      );
      return { id, handle };
    }
    async function topic() {
      const slug = `chal-${randomUUID().slice(0, 12)}`;
      await owner.query(
        `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
         VALUES ($1, 'Canada should expand nuclear power', 'Synthetic challenge fixture', 'For', 'Against', 'published')`,
        [slug],
      );
      return slug;
    }
    const challenge = (from, to, slug, extra) =>
      matching.createRequest(from.id, {
        kind: "direct",
        topicSlug: slug,
        targetHandle: to.handle,
        proposition: "Canada should expand nuclear power",
        requestedSide: "A",
        ...extra,
      });
    const notices = async (userId, type) =>
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM account_notifications WHERE user_id = $1 AND event_type = $2",
          [userId, type],
        )
      ).rows[0].count;

    it("challenges an online player to debate now, who accepts within two minutes", async () => {
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      await queue.touch(b.id);
      const request = await challenge(a, b, slug, { mode: "now" });
      assert.equal(request.mode, "now");
      assert.equal(request.scheduledAt, null);
      const left = new Date(request.respondBy).getTime() - Date.now();
      assert.ok(left > 100_000 && left <= 120_000);
      const incoming = (await queue.state(b.id)).challenge;
      assert.equal(incoming.direction, "incoming");
      assert.equal(incoming.handle, a.handle);
      assert.equal(incoming.sideLabel, "Against");
      assert.equal((await queue.state(a.id)).challenge.direction, "outgoing");
      await assert.rejects(
        matching.acceptRequest(a.id, request.id),
        /wait for the other player/,
      );
      const debate = await matching.acceptRequest(b.id, request.id);
      assert.ok(Date.now() - new Date(debate.scheduledAt).getTime() < 60_000);
      const joining = await queue.state(a.id);
      assert.equal(joining.debate.slug, debate.slug);
      assert.equal(
        joining.upcoming,
        null,
        "a now debate has its own countdown",
      );
      assert.equal((await queue.state(b.id)).challenge, null);
    });

    it("opens a just-accepted now debate even right after a queue match was cancelled", async () => {
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      // A queue match from a minute ago whose debate was cancelled as a no-show.
      const cancelled = (
        await owner.query(
          `INSERT INTO debates (slug, topic_id, proposition, status, publication_state,
             rules_version, rules_snapshot, scheduled_at)
           SELECT $1, t.id, 'Canada should expand nuclear power', 'cancelled', 'published',
             r.version, r.rules, CURRENT_TIMESTAMP - interval '100 seconds'
           FROM topics t, event_rule_versions r WHERE t.slug = $2 AND r.version = 'preview-1'
           RETURNING id`,
          [`${slug}-cancelled`, slug],
        )
      ).rows[0].id;
      await owner.query(
        `INSERT INTO matchmaking_tickets (user_id, topic_id, side, status, debate_id)
         SELECT $1, id, 'A', 'matched', $2 FROM topics WHERE slug = $3`,
        [a.id, cancelled, slug],
      );
      assert.equal((await queue.state(a.id)).debate.status, "cancelled");
      await queue.touch(b.id);
      const request = await challenge(a, b, slug, { mode: "now" });
      const debate = await matching.acceptRequest(b.id, request.id);
      const state = await queue.state(a.id);
      assert.equal(state.debate.slug, debate.slug);
      assert.equal(state.debate.status, "scheduled");
    });

    it("keeps a challenge to an offline player pending, accepted later only while the challenger is online", async () => {
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      const request = await challenge(a, b, slug, { mode: "now" });
      assert.equal(request.respondBy, null);
      assert.equal((await queue.state(b.id)).challenge, null);
      await assert.rejects(
        matching.acceptRequest(b.id, request.id),
        /isn't online now; propose a time/,
      );
      await queue.touch(a.id);
      const debate = await matching.acceptRequest(b.id, request.id);
      assert.equal(debate.status, "scheduled");
    });

    it("agrees a time through proposals and counter-proposals", async () => {
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      const [first, second, counter] = [hours(3), hours(5), hours(8)];
      const request = await challenge(a, b, slug, {
        proposedTimes: [second, first],
      });
      assert.equal(new Date(request.scheduledAt).getTime(), first.getTime());
      const listed = (await matching.listRequests(b.id)).find(
        (entry) => entry.id === request.id,
      );
      assert.deepEqual(
        listed.proposals.map((proposal) =>
          new Date(proposal.startsAt).getTime(),
        ),
        [first.getTime(), second.getTime()],
      );
      assert.equal(listed.initiatorHandle, a.handle);
      assert.equal(listed.debateStatus, null);
      assert.equal(listed.initiatorName, "Challenge player");
      assert.equal(listed.targetHandle, b.handle);
      await assert.rejects(
        matching.acceptRequest(b.id, request.id),
        /choose one of the proposed times/,
      );
      const countered = await matching.proposeTimes(b.id, request.id, [
        counter,
      ]);
      assert.equal(
        new Date(countered.scheduledAt).getTime(),
        counter.getTime(),
      );
      const mine = (await matching.listRequests(b.id)).find(
        (entry) => entry.id === request.id,
      ).proposals;
      assert.equal(mine.length, 1);
      await assert.rejects(
        matching.acceptRequest(b.id, request.id, { proposalId: mine[0].id }),
        /accept the times you proposed/,
      );
      await assert.rejects(
        matching.acceptRequest(a.id, request.id, {
          proposalId: randomUUID(),
        }),
        /no longer proposed/,
      );
      const debate = await matching.acceptRequest(a.id, request.id, {
        proposalId: mine[0].id,
      });
      assert.equal(new Date(debate.scheduledAt).getTime(), counter.getTime());
      const proposal = await owner.query(
        "SELECT status FROM challenge_time_proposals WHERE id = $1",
        [mine[0].id],
      );
      assert.equal(proposal.rows[0].status, "accepted");
      assert.ok((await notices(a.id, "challenge.proposed")) >= 1);
    });

    it("allows several open challenges, one per opponent, up to ten", async () => {
      const slug = await topic();
      const a = await player();
      const opponents = await Promise.all(
        Array.from({ length: 11 }, () => player()),
      );
      for (const [index, opponent] of opponents.slice(0, 10).entries())
        await challenge(a, opponent, slug, { scheduledAt: hours(3 + index) });
      await assert.rejects(
        challenge(a, opponents[10], slug, { scheduledAt: hours(20) }),
        /10 open challenges/,
      );
      const b = await player();
      const c = await player();
      await challenge(b, c, slug, { scheduledAt: hours(3) });
      await assert.rejects(
        challenge(b, c, slug, { scheduledAt: hours(9) }),
        /already have an open challenge with this player/,
      );
      await assert.rejects(challenge(b, c, slug, {}), MatchConflictError);
    });

    it("finds people by handle prefix or display name, never the searcher", async () => {
      const marker = randomUUID().slice(0, 8);
      const a = await player(`Searcher ${marker}`);
      const b = await player(`Riley ${marker} Ortiz`);
      const byName = await matching.searchPeople(a.id, `${marker} ortiz`);
      assert.deepEqual(
        byName.map((person) => person.handle),
        [b.handle],
      );
      const byHandle = await matching.searchPeople(a.id, b.handle.slice(0, 10));
      assert.ok(byHandle.some((person) => person.handle === b.handle));
      assert.ok(
        (await matching.searchPeople(a.id, marker)).every(
          (person) => person.handle !== a.handle,
        ),
      );
      assert.deepEqual(await matching.searchPeople(a.id, "%_%"), []);
    });

    it("leaves an unanswered now challenge pending and reminds speakers once before a booking", async () => {
      const slug = await topic();
      const [a, b, c, d] = await Promise.all([
        player(),
        player(),
        player(),
        player(),
      ]);
      await queue.touch(b.id);
      const request = await challenge(a, b, slug, { mode: "now" });
      await owner.query(
        "UPDATE match_requests SET respond_by = CURRENT_TIMESTAMP - interval '1 second' WHERE id = $1",
        [request.id],
      );
      // A parallel suite's sweep may settle it first, so check the outcome, not the count.
      await sweepOnce(queue);
      const after = await owner.query(
        "SELECT status, respond_by FROM match_requests WHERE id = $1",
        [request.id],
      );
      assert.deepEqual(after.rows[0], { status: "open", respond_by: null });
      assert.equal(await notices(a.id, "challenge.unanswered"), 1);
      assert.equal(await notices(b.id, "challenge.unanswered"), 1);

      const booked = await challenge(c, d, slug, { scheduledAt: hours(3) });
      const debate = await matching.acceptRequest(d.id, booked.id);
      await owner.query(
        "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP + interval '3 minutes', created_at = CURRENT_TIMESTAMP - interval '1 day' WHERE id = $1",
        [debate.id],
      );
      await sweepOnce(queue);
      await sweepOnce(queue);
      assert.equal(await notices(c.id, "event.starting"), 1);
      assert.equal(await notices(d.id, "event.starting"), 1);
    });

    it("asks for a debate language and consent before queueing, challenging or accepting", async () => {
      const strict = createMatchingRepository(runtime, {
        requireDebaterSettings: true,
      });
      const strictQueue = createMatchmaking(runtime, {
        liveDebateCapacity: 0,
        requireDebaterSettings: true,
      });
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      const ready = (user, version = DEBATER_CONSENT_VERSION) =>
        owner.query(
          `INSERT INTO debater_settings (user_id, language, consent_version, consented_at)
           VALUES ($1, 'en', $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET consent_version = $2`,
          [user.id, version],
        );
      const send = (extra) =>
        strict.createRequest(a.id, {
          kind: "direct",
          topicSlug: slug,
          targetHandle: b.handle,
          proposition: "Canada should expand nuclear power",
          requestedSide: "A",
          scheduledAt: hours(3),
          ...extra,
        });
      await assert.rejects(send(), (error) => {
        assert.ok(error instanceof DebaterSettingsRequiredError);
        assert.deepEqual(error.missing, ["language", "consent"]);
        return true;
      });
      await assert.rejects(
        strictQueue.enter(a.id, { topicSlug: slug, side: "A" }),
        DebaterSettingsRequiredError,
      );
      // Consent to older wording no longer counts.
      await ready(a, "2020-01-01");
      await assert.rejects(send(), (error) => {
        assert.deepEqual(error.missing, ["consent"]);
        return true;
      });
      await ready(a);
      const request = await send();
      await assert.rejects(
        strict.acceptRequest(b.id, request.id),
        DebaterSettingsRequiredError,
      );
      await ready(b);
      const debate = await strict.acceptRequest(b.id, request.id);
      assert.equal(debate.status, "scheduled");
      const entered = await strictQueue.enter(a.id, {
        topicSlug: slug,
        side: "A",
      });
      assert.equal(entered.ticket.status, "searching");
      await strictQueue.leave(a.id);
    });

    it("puts a booked debate in both players' live state from a day ahead", async () => {
      const slug = await topic();
      const [a, b, c, d] = await Promise.all([
        player(),
        player(),
        player(),
        player(),
      ]);
      const when = hours(3);
      const request = await challenge(a, b, slug, { scheduledAt: when });
      assert.equal((await queue.state(a.id)).upcoming, null);
      const debate = await matching.acceptRequest(b.id, request.id);
      for (const speaker of [a, b]) {
        const { upcoming } = await queue.state(speaker.id);
        assert.equal(upcoming.slug, debate.slug);
        assert.equal(
          upcoming.proposition,
          "Canada should expand nuclear power",
        );
        assert.equal(new Date(upcoming.startsAt).getTime(), when.getTime());
        assert.equal(
          new Date(upcoming.joinDeadlineAt).getTime() - when.getTime(),
          600_000,
        );
      }
      const later = await challenge(c, d, slug, { scheduledAt: hours(30) });
      await matching.acceptRequest(d.id, later.id);
      assert.equal((await queue.state(c.id)).upcoming, null);
    });

    it("accepts a request opened before time proposals at its original time", async () => {
      const slug = await topic();
      const [a, b] = await Promise.all([player(), player()]);
      const when = hours(4);
      const id = (
        await owner.query(
          `INSERT INTO match_requests (kind, status, initiator_user_id, target_user_id, topic_id,
             proposition, requested_side, scheduled_at, expires_at)
           SELECT 'direct', 'open', $1, $2, t.id, 'Canada should expand nuclear power', 'A', $3,
             CURRENT_TIMESTAMP + interval '1 day' FROM topics t WHERE t.slug = $4 RETURNING id`,
          [a.id, b.id, when, slug],
        )
      ).rows[0].id;
      await assert.rejects(
        matching.acceptRequest(a.id, id),
        /wait for the other player/,
      );
      const debate = await matching.acceptRequest(b.id, id);
      assert.equal(new Date(debate.scheduledAt).getTime(), when.getTime());
    });

    it("signals challenge changes to both players", async () => {
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
        const copy = new Set(heard);
        heard.length = 0;
        return copy;
      };
      try {
        const slug = await topic();
        const [a, b] = await Promise.all([player(), player()]);
        await drain();
        const request = await challenge(a, b, slug, { scheduledAt: hours(3) });
        const opened = await drain();
        assert.ok(opened.has(a.id) && opened.has(b.id));
        await matching.proposeTimes(b.id, request.id, [hours(6)]);
        const countered = await drain();
        assert.ok(countered.has(a.id) && countered.has(b.id));
      } finally {
        await listener.end();
      }
    });
  },
);
