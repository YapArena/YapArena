import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PublicTopic } from "../src/features/discovery/public-types.ts";

type CreatedTopic = Pick<
  PublicTopic,
  "id" | "slug" | "title" | "summary" | "sideALabel" | "sideBLabel"
> & { publicationState: "draft" | "published" | "hidden" };
import {
  createMatchingRepository,
  MatchConflictError,
} from "../dist/features/matching/repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});
const matching = createMatchingRepository(pool);
const suffix = randomUUID().slice(0, 8);
const users: string[] = [];
const profiles: string[] = [];
const requests: string[] = [];
const events: string[] = [];
let topicId: string | undefined;

async function person(name: string) {
  const created = await pool.query<{ id: string }>(
    "INSERT INTO users DEFAULT VALUES RETURNING id",
  );
  const id = created.rows[0]!.id;
  users.push(id);
  const profile = await pool.query<{ id: string }>(
    `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
     VALUES ($1, $2, $3, 'published') RETURNING id`,
    [id, `match-${name}-${suffix}`, name],
  );
  profiles.push(profile.rows[0]!.id);
  return {
    id,
    handle: `match-${name}-${suffix}`,
    profileId: profile.rows[0]!.id,
  };
}

try {
  const [a, b, c, d, e] = await Promise.all(
    ["a", "b", "c", "d", "e"].map(person) as [
      Promise<Awaited<ReturnType<typeof person>>>,
      Promise<Awaited<ReturnType<typeof person>>>,
      Promise<Awaited<ReturnType<typeof person>>>,
      Promise<Awaited<ReturnType<typeof person>>>,
      Promise<Awaited<ReturnType<typeof person>>>,
    ],
  );
  const topic: CreatedTopic = await matching.createTopic(a.id, {
    slug: `match-topic-${suffix}`,
    title: "Verification topic",
    summary: "A debate topic created for integration verification.",
    sideALabel: "For",
    sideBLabel: "Against",
  });
  topicId = topic.id;
  assert.equal(topic.publicationState, "draft");
  assert.ok(await matching.publishTopic(a.id, `match-topic-${suffix}`));
  assert.equal(
    await matching.publishTopic(b.id, `match-topic-${suffix}`),
    null,
  );
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const direct = async (
    from: Awaited<ReturnType<typeof person>>,
    side: "A" | "B",
  ) => {
    const request = await matching.createRequest(from.id, {
      kind: "direct",
      topicSlug: `match-topic-${suffix}`,
      targetHandle: b.handle,
      requestedSide: side,
      scheduledAt,
    });
    requests.push(request.id);
    return request;
  };
  const first = await direct(a, "A");
  const competing = await direct(c, "B");
  const outcomes = await Promise.allSettled([
    matching.acceptRequest(b.id, first.id),
    matching.acceptRequest(b.id, competing.id),
  ]);
  assert.equal(
    outcomes.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter((entry) => entry.status === "rejected").length,
    1,
  );
  assert.ok(
    outcomes.find((entry) => entry.status === "rejected")!.reason instanceof
      MatchConflictError,
  );
  const event = outcomes.find((entry) => entry.status === "fulfilled")!.value;
  events.push(event.id);
  assert.equal(event.status, "scheduled");
  assert.equal(event.rulesVersion, "prototype-media-1");
  assert.equal(
    (event.rulesSnapshot as { financial_terms: string }).financial_terms,
    "not_active",
  );
  assert.notEqual(event.speakerAProfileId, event.speakerBProfileId);
  assert.equal(
    (await matching.listRequests(b.id)).filter(
      (entry) => entry.status === "conflicted",
    ).length,
    1,
  );
  assert.equal((await matching.listNotifications(b.id)).length >= 2, true);
  await assert.rejects(
    () => matching.acceptRequest(b.id, first.id),
    MatchConflictError,
  );

  const initiator = event.speakerAProfileId === a.profileId ? a : c;
  await matching.markReady(initiator.id, event.id);
  await matching.markReady(b.id, event.id);
  assert.equal((await matching.getEvent(event.id))!.status, "ready");
  const rescheduled = await matching.operatorTransition(
    a.id,
    event.id,
    "reschedule",
    "A verified scheduling change",
    new Date(Date.now() + 4 * 60 * 60 * 1000),
  );
  assert.equal(rescheduled!.status, "scheduled");
  assert.equal(rescheduled!.readyAAt, null);
  await matching.markReady(initiator.id, event.id);
  await matching.markReady(b.id, event.id);
  await pool.query(
    "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP WHERE id = $1",
    [event.id],
  );
  await pool.query(
    `INSERT INTO debate_media (debate_id, state, active_side, recording_status)
     VALUES ($1, 'running', 'A', 'recording')`,
    [event.id],
  );
  assert.equal(
    (await matching.operatorTransition(
      a.id,
      event.id,
      "start",
      "Verification start",
    ))!.status,
    "live",
  );
  const ended = await matching.operatorTransition(
    a.id,
    event.id,
    "end",
    "Verification end",
  );
  assert.ok(ended!.liveStartedAt && ended!.liveEndedAt);
  await pool.query(
    `UPDATE debate_media SET state = 'ended', recording_status = 'ready'
     WHERE debate_id = $1`,
    [event.id],
  );
  const afterEnd = await matching.createRequest(initiator.id, {
    kind: "direct",
    topicSlug: `match-topic-${suffix}`,
    targetHandle: d.handle,
    requestedSide: "A",
    scheduledAt,
  });
  requests.push(afterEnd.id);
  await matching.closeRequest(initiator.id, afterEnd.id, "withdrawn");
  assert.equal(
    (await matching.operatorTransition(
      a.id,
      event.id,
      "replay",
      "Recording verified",
    ))!.status,
    "replay",
  );
  assert.equal((await matching.getEventHistory(event.id)).length >= 6, true);

  const queue = await matching.createRequest(d.id, {
    kind: "queue",
    topicSlug: `match-topic-${suffix}`,
    requestedSide: "B",
    scheduledAt,
  });
  requests.push(queue.id);
  const joined = await matching.joinQueue(e.id, queue.id);
  events.push(joined.id);
  assert.equal(joined.speakerBProfileId, d.profileId);
  assert.equal(joined.speakerAProfileId, e.profileId);
  assert.equal(
    (await matching.listQueue()).some((entry) => entry.id === queue.id),
    false,
  );
  await pool.query(
    "UPDATE debates SET scheduled_at = CURRENT_TIMESTAMP - INTERVAL '20 minutes' WHERE id = $1",
    [joined.id],
  );
  assert.equal(
    (await matching.operatorTransition(
      a.id,
      joined.id,
      "no_show",
      "Participant absent after grace period",
    ))!.status,
    "cancelled",
  );
  console.log(
    "PostgreSQL topics, concurrent acceptance, queue, lifecycle, history, and notifications verified.",
  );
} finally {
  if (requests.length)
    await pool.query("DELETE FROM match_requests WHERE id = ANY($1::uuid[])", [
      requests,
    ]);
  if (events.length)
    await pool.query("DELETE FROM debates WHERE id = ANY($1::uuid[])", [
      events,
    ]);
  if (topicId) await pool.query("DELETE FROM topics WHERE id = $1", [topicId]);
  if (profiles.length)
    await pool.query("DELETE FROM public_profiles WHERE id = ANY($1::uuid[])", [
      profiles,
    ]);
  if (users.length)
    await pool.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [users]);
  if (users.length)
    await pool.query(
      "DELETE FROM identity_audit_events WHERE user_id = ANY($1::bigint[])",
      [users],
    );
  await pool.end();
}
