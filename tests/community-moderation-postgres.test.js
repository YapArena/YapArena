import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  createCommunityRepository,
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
} from "../dist/features/community/repository.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createMatchmaking } from "../dist/features/matching/matchmaking.js";
import {
  createMatchingRepository,
  MatchConflictError,
} from "../dist/features/matching/repository.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;

// Runs as the runtime role: how far a community restriction reaches, and moderators hiding and
// restoring topics, profiles and debates (YA-07).
describe(
  "community restrictions and content visibility against PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, community, identity, matching, queue;
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
      community = createCommunityRepository(runtime);
      identity = createIdentityRepository(runtime);
      matching = createMatchingRepository(runtime);
      // No pairing: a parallel queue suite's players must never be matched here.
      queue = createMatchmaking(runtime, { liveDebateCapacity: 0 });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    const unique = () => `mod-${randomUUID().slice(0, 12)}`;
    async function account() {
      return (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
    }
    async function player(publicationState = "published") {
      const id = await account();
      const handle = unique();
      const profile = (
        await owner.query(
          `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
           VALUES ($1, $2, 'Moderation player', $3) RETURNING id`,
          [id, handle, publicationState],
        )
      ).rows[0].id;
      return { id, handle, profile };
    }
    async function topic(creatorId = null) {
      const slug = unique();
      const id = (
        await owner.query(
          `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label,
             publication_state, creator_user_id)
           VALUES ($1, 'Cities should ban cars downtown', 'Synthetic moderation fixture',
             'For', 'Against', 'published', $2) RETURNING id`,
          [slug, creatorId],
        )
      ).rows[0].id;
      return { id, slug };
    }
    async function debate(topicId, ...speakers) {
      const slug = unique();
      const id = (
        await owner.query(
          `INSERT INTO debates (slug, topic_id, proposition, status, publication_state,
             rules_version, rules_snapshot, scheduled_at)
           SELECT $1, $2, 'Cities should ban cars downtown', 'ended', 'published',
             version, rules, CURRENT_TIMESTAMP - interval '1 day'
           FROM event_rule_versions WHERE version = 'preview-1' RETURNING id`,
          [slug, topicId],
        )
      ).rows[0].id;
      for (const [index, userId] of speakers.entries())
        await owner.query(
          "INSERT INTO event_participants (debate_id, user_id, side) VALUES ($1, $2, $3)",
          [id, userId, index === 0 ? "A" : "B"],
        );
      return { id, slug };
    }
    async function restrict(userId) {
      const fixture = await debate((await topic()).id);
      const caseId = (
        await owner.query(
          `INSERT INTO moderation_cases (reporter_user_id, debate_id, target_type, reason_code, detail)
           VALUES ($1, $2, 'event', 'spam', 'Synthetic restriction fixture') RETURNING id`,
          [await account(), fixture.id],
        )
      ).rows[0].id;
      await owner.query(
        `INSERT INTO community_restrictions (user_id, case_id, expires_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + interval '7 days')`,
        [userId, caseId],
      );
      return { caseId, debateId: fixture.id };
    }
    const state = async (table, id) =>
      (
        await owner.query(
          `SELECT publication_state AS state FROM ${table} WHERE id = $1`,
          [id],
        )
      ).rows[0].state;
    const trail = async (targetId) =>
      (
        await owner.query(
          `SELECT a.action, a.from_state AS "fromState", a.to_state AS "toState",
             a.reason_code AS "reasonCode", e.action AS "auditAction",
             e.actor_user_id AS "actorUserId", e.note, e.case_id AS "caseId"
           FROM content_moderation_actions a
           JOIN community_audit_events e ON e.content_action_id = a.id
           WHERE a.target_id = $1 ORDER BY a.created_at, a.id`,
          [targetId],
        )
      ).rows;
    const notices = async (userId) =>
      (
        await owner.query(
          `SELECT message FROM account_notifications
           WHERE user_id = $1 AND event_type = 'community_moderation' ORDER BY id`,
          [userId],
        )
      ).rows.map((row) => row.message);

    it("finds an active restriction until it is revoked or expires", async () => {
      const { id } = await player();
      assert.equal(await identity.restriction(id), null);
      const { caseId, debateId } = await restrict(id);
      const active = await identity.restriction(id);
      assert.ok(active.expiresAt.getTime() > Date.now() + 6 * 86_400_000);
      // Chat-side checks read the same restriction.
      await assert.rejects(
        community.setLike(debateId, id, true),
        CommunityForbiddenError,
      );
      await owner.query(
        "UPDATE community_restrictions SET revoked_at = CURRENT_TIMESTAMP WHERE case_id = $1",
        [caseId],
      );
      assert.equal(await identity.restriction(id), null);
      await restrict(id);
      await owner.query(
        `UPDATE community_restrictions SET expires_at = CURRENT_TIMESTAMP - interval '1 second'
         WHERE user_id = $1`,
        [id],
      );
      assert.equal(await identity.restriction(id), null);
    });

    it("never seats a restricted player, even when the other player accepts", async () => {
      const { slug } = await topic();
      const [a, b] = [await player(), await player()];
      const request = await matching.createRequest(a.id, {
        kind: "direct",
        topicSlug: slug,
        targetHandle: b.handle,
        requestedSide: "A",
        proposedTimes: [new Date(Date.now() + 3 * 60 * 60 * 1000)],
      });
      await restrict(a.id);
      await assert.rejects(
        matching.acceptRequest(b.id, request.id),
        (error) =>
          error instanceof MatchConflictError &&
          /can't take this debate/.test(error.message),
      );
      const seats = await owner.query(
        "SELECT count(*)::int AS count FROM event_participants WHERE user_id = ANY($1::bigint[])",
        [[a.id, b.id]],
      );
      assert.equal(seats.rows[0].count, 0);
    });

    it("cancels a queue match whose player was restricted and requeues the other", async () => {
      const { id: topicId } = await topic();
      const [a, b] = [await player(), await player()];
      const ticket = async (userId, side) =>
        (
          await owner.query(
            `INSERT INTO matchmaking_tickets (user_id, topic_id, side, status)
             VALUES ($1, $2, $3, 'offered') RETURNING id`,
            [userId, topicId, side],
          )
        ).rows[0].id;
      const [ticketA, ticketB] = [
        await ticket(a.id, "A"),
        await ticket(b.id, "B"),
      ];
      const offer = (
        await owner.query(
          `INSERT INTO match_offers (topic_id, ticket_a_id, ticket_b_id, user_a_id, user_b_id,
             status, deadline_at, accepted_a_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', clock_timestamp() + interval '30 seconds',
             clock_timestamp()) RETURNING id`,
          [topicId, ticketA, ticketB, a.id, b.id],
        )
      ).rows[0].id;
      await restrict(a.id);
      const result = await queue.accept(b.id, offer);
      assert.equal(result.debateId, null);
      const rows = await owner.query(
        `SELECT (SELECT status FROM match_offers WHERE id = $1) AS offer,
           (SELECT status || ':' || coalesce(closed_reason, '') FROM matchmaking_tickets WHERE id = $2) AS a,
           (SELECT status FROM matchmaking_tickets WHERE id = $3) AS b`,
        [offer, ticketA, ticketB],
      );
      assert.deepEqual(rows.rows[0], {
        offer: "cancelled",
        a: "closed:unavailable",
        b: "searching",
      });
    });

    it("hides and restores a topic, profile and debate with audit rows and notices", async () => {
      const moderator = await account();
      const creator = await account();
      const item = await topic(creator);
      const hidden = await community.setContentVisibility(
        "topic",
        item.slug,
        moderator,
        true,
        "spam",
        "Promotional topic with no debate",
      );
      assert.equal(hidden.publicationState, "hidden");
      assert.equal(await state("topics", item.id), "hidden");
      const restored = await community.setContentVisibility(
        "topic",
        item.slug,
        moderator,
        false,
        null,
        "Reviewed again; it is a real topic",
      );
      assert.equal(restored.publicationState, "published");
      assert.equal(await state("topics", item.id), "published");
      assert.deepEqual(await trail(item.id), [
        {
          action: "hide",
          fromState: "published",
          toState: "hidden",
          reasonCode: "spam",
          auditAction: "content_hidden",
          actorUserId: moderator,
          note: "Promotional topic with no debate",
          caseId: null,
        },
        {
          action: "unhide",
          fromState: "hidden",
          toState: "published",
          reasonCode: null,
          auditAction: "content_restored",
          actorUserId: moderator,
          note: "Reviewed again; it is a real topic",
          caseId: null,
        },
      ]);
      assert.deepEqual(await notices(creator), [
        "A moderator hid one of your topics from public pages.",
        "A moderator restored your topic.",
      ]);

      // A private profile goes back to private, not public.
      const person = await player("draft");
      await community.setContentVisibility(
        "profile",
        person.handle,
        moderator,
        true,
        "harassment",
        "Profile text targets another player",
      );
      assert.equal(await state("public_profiles", person.profile), "hidden");
      await community.setContentVisibility(
        "profile",
        person.handle,
        moderator,
        false,
        null,
        "Owner removed the text by email",
      );
      assert.equal(await state("public_profiles", person.profile), "draft");
      assert.equal((await notices(person.id)).length, 2);

      // A debate by slug, then by id; both speakers hear about it.
      const [a, b] = [await account(), await account()];
      const match = await debate((await topic()).id, a, b);
      await community.setContentVisibility(
        "debate",
        match.slug,
        moderator,
        true,
        "hate",
        "Hateful remarks throughout the debate",
      );
      assert.equal(await state("debates", match.id), "hidden");
      await community.setContentVisibility(
        "debate",
        match.id,
        moderator,
        false,
        null,
        "Appeal reviewed; restoring the debate",
      );
      assert.equal(await state("debates", match.id), "published");
      for (const speaker of [a, b])
        assert.deepEqual(await notices(speaker), [
          "A moderator hid one of your debates from public pages.",
          "A moderator restored your debate.",
        ]);

      const listed = await community.listContentActions();
      const latest = listed.find((entry) => entry.targetId === match.id);
      assert.equal(latest.action, "unhide");
      assert.equal(latest.target, match.slug);
      assert.equal(latest.publicationState, "published");
      assert.equal(latest.label, "Cities should ban cars downtown");
    });

    it("keeps the people involved from deciding, and refuses repeated or unknown changes", async () => {
      const moderator = await account();
      const creator = await account();
      const [a, b] = [await account(), await account()];
      const item = await topic(creator);
      const match = await debate(item.id, a, b);
      const person = await player();
      const hide = (type, key, actor) =>
        community.setContentVisibility(
          type,
          key,
          actor,
          true,
          "other",
          "Synthetic conflict-of-interest check",
        );
      for (const [type, key, actor] of [
        ["topic", item.slug, creator],
        ["topic", item.slug, a],
        ["debate", match.slug, b],
        ["profile", person.handle, person.id],
      ])
        await assert.rejects(hide(type, key, actor), CommunityForbiddenError);
      assert.equal(await state("topics", item.id), "published");
      assert.deepEqual(await trail(item.id), []);

      await hide("topic", item.slug, moderator);
      await assert.rejects(
        hide("topic", item.slug, moderator),
        CommunityConflictError,
      );
      await assert.rejects(
        community.setContentVisibility(
          "profile",
          person.handle,
          moderator,
          false,
          null,
          "Restoring a visible profile",
        ),
        CommunityConflictError,
      );
      await assert.rejects(
        hide("topic", unique(), moderator),
        CommunityNotFoundError,
      );
    });

    it("restores items hidden outside the app to a safe state", async () => {
      const moderator = await account();
      const person = await player();
      const item = await topic();
      await owner.query(
        "UPDATE public_profiles SET publication_state = 'hidden' WHERE id = $1",
        [person.profile],
      );
      await owner.query(
        "UPDATE topics SET publication_state = 'hidden' WHERE id = $1",
        [item.id],
      );
      const note = "Hidden before the in-app tool existed";
      await community.setContentVisibility(
        "profile",
        person.handle,
        moderator,
        false,
        null,
        note,
      );
      await community.setContentVisibility(
        "topic",
        item.slug,
        moderator,
        false,
        null,
        note,
      );
      // Only its owner publishes a profile again; a topic returns to public.
      assert.equal(await state("public_profiles", person.profile), "draft");
      assert.equal(await state("topics", item.id), "published");
    });

    it("prunes year-old visibility changes but keeps the hide a hidden item needs", async () => {
      const moderator = await account();
      const [visible, hidden] = [await topic(), await topic()];
      const action = async (targetId, kind, from, to, daysAgo) =>
        (
          await owner.query(
            `INSERT INTO content_moderation_actions
               (target_type, target_id, action, from_state, to_state, reason_code, created_at)
             VALUES ('topic', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP - make_interval(days => $6))
             RETURNING id`,
            [
              targetId,
              kind,
              from,
              to,
              kind === "hide" ? "spam" : null,
              daysAgo,
            ],
          )
        ).rows[0].id;
      const oldHide = await action(
        visible.id,
        "hide",
        "published",
        "hidden",
        400,
      );
      const oldRestore = await action(
        visible.id,
        "unhide",
        "hidden",
        "published",
        399,
      );
      const neededHide = await action(
        hidden.id,
        "hide",
        "draft",
        "hidden",
        400,
      );
      await owner.query(
        `INSERT INTO community_audit_events (content_action_id, actor_user_id, action, note)
         VALUES ($1, $2, 'content_hidden', 'Year-old synthetic hide')`,
        [oldHide, moderator],
      );
      const totals = await community.pruneExpired();
      assert.ok(totals.contentActions >= 2);
      const left = await owner.query(
        "SELECT id FROM content_moderation_actions WHERE id = ANY($1::uuid[])",
        [[oldHide, oldRestore, neededHide]],
      );
      assert.deepEqual(
        left.rows.map((row) => row.id),
        [neededHide],
      );
      const audit = await owner.query(
        "SELECT count(*)::int AS count FROM community_audit_events WHERE content_action_id = $1",
        [oldHide],
      );
      assert.equal(audit.rows[0].count, 0);
    });

    it("keeps every audit event tied to exactly one case or content change", async () => {
      await assert.rejects(
        owner.query(
          `INSERT INTO community_audit_events (actor_user_id, action) VALUES ($1, 'orphan')`,
          [await account()],
        ),
        /community_audit_events_subject/,
      );
    });
  },
);
