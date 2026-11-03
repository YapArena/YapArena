import type { Pool, PoolClient } from "pg";
import { resolveAvatarId } from "../identity/avatars.ts";
import {
  type TransactionOptions,
  withTransaction,
} from "../../platform/transaction.ts";
import { createCommunityDelivery, publicFrame } from "./delivery.ts";
import { activeRestriction } from "./restrictions.ts";

export class CommunityNotFoundError extends Error {}
export class CommunityConflictError extends Error {
  constructor(
    message: string,
    readonly code = "COMMUNITY_CONFLICT",
  ) {
    super(message);
  }
}
export class CommunityForbiddenError extends Error {}
export class CommunityRateError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    readonly code = "COMMUNITY_RATE_LIMIT",
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

export type ReasonCode =
  "harassment" | "hate" | "threat" | "spam" | "privacy" | "other";
export type CaseAction =
  "dismiss" | "remove_chat" | "restrict_account" | "pause_chat";
export type ContentType = "topic" | "profile" | "debate";
type PublicationState = "draft" | "published" | "hidden";

interface EventRow {
  id: string;
  slug: string;
  status: string;
  publicationState: string;
  isDemo: boolean;
}
interface ChatRow {
  id: string;
  debateId: string;
  authorUserId: string;
  authorName: string;
  // Read only to resolve the author's avatar; never sent (Decision 0014).
  authorHandle?: string | null;
  authorAvatar?: string | null;
  body: string;
  state: "visible" | "removed";
  createdAt: Date;
  clientMessageId: string | null;
  revision: string;
  streamRevision?: string;
}
interface AcceptedChatRow extends ChatRow {
  payloadMatches: boolean;
}
export interface CaseRow {
  id: string;
  reporterUserId: string;
  debateId: string;
  targetType: "event" | "chat";
  targetChatId: string | null;
  reasonCode: ReasonCode;
  detail: string;
  status: "open" | "dismissed" | "actioned";
  action: CaseAction | null;
  reviewerUserId: string | null;
  decisionReason: ReasonCode | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  subjectUserId: string | null;
  chatBody: string | null;
  chatState: "open" | "paused";
}
export interface AppealRow {
  id: string;
  caseId: string;
  appellantUserId: string;
  reason: string;
  status: "open" | "upheld" | "overturned";
  reviewerUserId: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

const chatFields = `m.id, m.debate_id AS "debateId",
  m.author_user_id AS "authorUserId",
  COALESCE(p.display_name, 'Participant') AS "authorName",
  p.handle AS "authorHandle", p.avatar_id AS "authorAvatar",
  m.body, m.state, m.created_at AS "createdAt",
  m.client_message_id AS "clientMessageId", m.revision::text AS revision,
  m.stream_revision::text AS "streamRevision"`;
const chatJoin = `FROM event_chat_messages m
  LEFT JOIN public_profiles p ON p.user_id = m.author_user_id
    AND p.publication_state = 'published'`;

// The receipt survives message-body retention. A purged canonical message can
// only be acknowledged as removed; this path never recreates its content.
const receiptFields = `r.message_id AS id, r.debate_id AS "debateId",
  r.author_user_id AS "authorUserId", COALESCE(p.display_name, 'Participant') AS "authorName",
  p.handle AS "authorHandle", p.avatar_id AS "authorAvatar", m.body, COALESCE(m.state, 'removed') AS state, r.created_at AS "createdAt",
  r.client_message_id AS "clientMessageId", COALESCE(m.revision,r.revision)::text AS revision,
  COALESCE(m.stream_revision,r.stream_revision)::text AS "streamRevision"`;
const receiptJoin = `FROM community_submission_receipts r
  LEFT JOIN event_chat_messages m ON m.id=r.message_id
  LEFT JOIN public_profiles p ON p.user_id=r.author_user_id AND p.publication_state='published'`;

function publicMessage(item: ChatRow, viewerId?: string) {
  return {
    id: item.id,
    debateId: item.debateId,
    authorName: item.authorName,
    // The placeholder "Participant" has no avatar.
    authorAvatarId: item.authorHandle
      ? resolveAvatarId(item.authorAvatar, item.authorHandle)
      : null,
    body: item.state === "removed" ? null : item.body,
    state: item.state,
    createdAt: item.createdAt,
    revision: item.revision,
    streamRevision: item.streamRevision,
    clientMessageId:
      viewerId === item.authorUserId ? item.clientMessageId : null,
  };
}

const caseFields = `c.id, c.reporter_user_id AS "reporterUserId",
  c.debate_id AS "debateId", c.target_type AS "targetType",
  c.target_chat_id AS "targetChatId", c.reason_code AS "reasonCode",
  c.detail, c.status, c.action, c.reviewer_user_id AS "reviewerUserId",
  c.decision_reason AS "decisionReason", c.decision_note AS "decisionNote",
  c.decided_at AS "decidedAt", c.created_at AS "createdAt",
  m.author_user_id AS "subjectUserId", m.body AS "chatBody",
  COALESCE(ec.state, 'open') AS "chatState"`;
const caseJoin = `FROM moderation_cases c
  LEFT JOIN event_chat_messages m ON m.id = c.target_chat_id
  LEFT JOIN event_chat_controls ec ON ec.debate_id = c.debate_id`;

// Public reads bind projection and visibility in one snapshot.
const readSnapshot = {
  isolation: "repeatable read",
  readOnly: true,
} as const satisfies TransactionOptions;

async function lockAccount(client: PoolClient, userId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `community:${userId}`,
  ]);
  // Take the account row before any room counter, as a chat or like insert's
  // foreign key would afterwards. An A4 transaction holding this row FOR UPDATE
  // takes its room counter at COMMIT, so waiting here cannot form a cycle.
  await client.query("SELECT 1 FROM users WHERE id = $1 FOR KEY SHARE", [
    userId,
  ]);
}

async function eventFor(client: PoolClient, id: string, lock = false) {
  const result = await client.query<EventRow>(
    `SELECT id, slug, status, publication_state AS "publicationState",
       is_demo AS "isDemo" FROM debates WHERE id = $1 AND EXISTS (SELECT 1 FROM topics
         WHERE topics.id = debates.topic_id AND publication_state = 'published')${lock ? " FOR SHARE" : ""}`,
    [id],
  );
  const event = result.rows[0];
  if (!event || event.publicationState !== "published" || event.isDemo)
    throw new CommunityNotFoundError("event not found");
  return event;
}

async function assertWritable(client: PoolClient, userId: string) {
  if (await activeRestriction(client, userId))
    throw new CommunityForbiddenError("community activity is restricted");
}

const contentTables = {
  topic: "topics",
  profile: "public_profiles",
  debate: "debates",
} as const satisfies Record<ContentType, string>;
const uuidKey =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A topic by slug, a profile by handle, a debate by slug or id, locked for a visibility change.
// Its owners hear about the change: a topic's creator, a profile's owner, a debate's speakers.
// They and, for a topic, everyone who debated on it are involved and cannot decide it.
async function contentFor(client: PoolClient, type: ContentType, key: string) {
  const query =
    type === "topic"
      ? `SELECT id, slug AS key, publication_state AS state FROM topics WHERE slug = $1`
      : type === "profile"
        ? `SELECT id, handle AS key, publication_state AS state FROM public_profiles WHERE handle = $1`
        : `SELECT id, slug AS key, publication_state AS state FROM debates
           WHERE ${uuidKey.test(key) ? "id = $1::uuid" : "slug = $1"}`;
  const found = await client.query<{
    id: string;
    key: string;
    state: PublicationState;
  }>(`${query} FOR UPDATE`, [key]);
  const item = found.rows[0];
  if (!item) throw new CommunityNotFoundError(`${type} not found`);
  const accounts = async (sql: string) =>
    (await client.query<{ userId: string }>(sql, [item.id])).rows.map(
      (row) => row.userId,
    );
  const owners = await accounts(
    type === "topic"
      ? `SELECT creator_user_id AS "userId" FROM topics WHERE id = $1 AND creator_user_id IS NOT NULL`
      : type === "profile"
        ? `SELECT user_id AS "userId" FROM public_profiles WHERE id = $1 AND user_id IS NOT NULL`
        : `SELECT user_id AS "userId" FROM event_participants WHERE debate_id = $1`,
  );
  const debaters =
    type === "topic"
      ? await accounts(
          `SELECT DISTINCT p.user_id AS "userId" FROM event_participants p
           JOIN debates d ON d.id = p.debate_id WHERE d.topic_id = $1`,
        )
      : [];
  return { ...item, owners, involved: [...owners, ...debaters] };
}

// Restoring returns an item to the state its latest hide replaced. An item hidden outside the
// app returns to draft if it is a profile, which only its owner publishes, and otherwise to
// published.
async function restoredState(
  client: PoolClient,
  type: ContentType,
  id: string,
): Promise<"draft" | "published"> {
  const latest = await client.query<{
    action: "hide" | "unhide";
    fromState: "draft" | "published";
  }>(
    `SELECT action, from_state AS "fromState" FROM content_moderation_actions
     WHERE target_type = $1 AND target_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [type, id],
  );
  const action = latest.rows[0];
  if (action?.action === "hide") return action.fromState;
  return type === "profile" ? "draft" : "published";
}

const contentNotices = {
  topic: ["one of your topics", "your topic"],
  profile: ["your public profile", "your public profile"],
  debate: ["one of your debates", "your debate"],
} as const satisfies Record<ContentType, readonly [string, string]>;

async function caseFor(client: PoolClient, id: string, lock = false) {
  const result = await client.query<CaseRow>(
    `SELECT ${caseFields} ${caseJoin} WHERE c.id = $1${lock ? " FOR UPDATE OF c" : ""}`,
    [id],
  );
  const found = result.rows[0];
  if (!found) throw new CommunityNotFoundError("case not found");
  return found;
}

async function audit(
  client: PoolClient,
  caseId: string,
  actorId: string,
  action: string,
  appealId: string | null = null,
  note: string | null = null,
) {
  await client.query(
    `INSERT INTO community_audit_events (case_id, appeal_id, actor_user_id, action, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [caseId, appealId, actorId, action, note],
  );
}

async function notifyCase(
  client: PoolClient,
  userId: string,
  debateId: string,
  message: string,
) {
  await client.query(
    `INSERT INTO account_notifications (user_id, event_type, message, debate_id)
     VALUES ($1, 'community_moderation', $2, $3)`,
    [userId, message, debateId],
  );
}

export function createCommunityRepository(database: Pool) {
  const delivery = createCommunityDelivery(database);
  return Object.freeze({
    async publicUpdates(id: string, after: string | null) {
      return publicFrame(id, after, await delivery.read(id, after ?? "0"));
    },
    async publicEvent(id: string) {
      const result = await database.query<{
        id: string;
        slug: string;
        status: string;
        proposition: string;
        topicTitle: string;
        sideALabel: string;
        sideBLabel: string;
        speakerA: string | null;
        speakerB: string | null;
        scheduledAt: Date | null;
      }>(
        `SELECT d.id, d.slug, d.status, d.proposition,
          t.title AS "topicTitle", t.side_a_label AS "sideALabel",
          t.side_b_label AS "sideBLabel", pa.display_name AS "speakerA",
          pb.display_name AS "speakerB", d.scheduled_at AS "scheduledAt"
         FROM debates d JOIN topics t ON t.id = d.topic_id
         LEFT JOIN public_profiles pa ON pa.id = d.speaker_a_profile_id AND pa.publication_state = 'published'
         LEFT JOIN public_profiles pb ON pb.id = d.speaker_b_profile_id AND pb.publication_state = 'published'
         WHERE d.id = $1 AND d.publication_state = 'published'
           AND t.publication_state = 'published' AND d.is_demo = false`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async publicEventBySlug(slug: string) {
      const result = await database.query<{ id: string }>(
        `SELECT d.id FROM debates d JOIN topics t ON t.id = d.topic_id
         WHERE d.slug = $1 AND d.publication_state = 'published'
           AND t.publication_state = 'published' AND d.is_demo = false`,
        [slug],
      );
      return result.rows[0] ? this.publicEvent(result.rows[0].id) : null;
    },

    async summary(id: string, userId?: string) {
      const event = await this.publicEvent(id);
      if (!event) throw new CommunityNotFoundError("event not found");
      const result = await database.query<{
        likes: string;
        liked: boolean;
        chatState: "open" | "paused";
      }>(
        `SELECT
          (SELECT COUNT(*)::text FROM event_likes WHERE debate_id = $1) AS likes,
          EXISTS (SELECT 1 FROM event_likes WHERE debate_id = $1 AND user_id = $2) AS liked,
          COALESCE((SELECT state FROM event_chat_controls WHERE debate_id = $1), 'open') AS "chatState"`,
        [id, userId ?? null],
      );
      return {
        eventId: id,
        likes: Number(result.rows[0]!.likes),
        liked: result.rows[0]!.liked,
        chatState: result.rows[0]!.chatState,
        chatWritable:
          event.status === "live" && result.rows[0]!.chatState === "open",
      };
    },

    async listChat(id: string, before?: string, viewerId?: string) {
      return withTransaction(
        database,
        async (client) => {
          await eventFor(client, id);
          const result = await client.query<ChatRow>(
            `SELECT ${chatFields} ${chatJoin}
         WHERE m.debate_id = $1 AND m.state = 'visible'
           AND ($2::bigint IS NULL OR m.id < $2)
         ORDER BY m.id DESC LIMIT 51`,
            [id, before ?? null],
          );
          return {
            items: result.rows
              .slice(0, 50)
              .reverse()
              .map((item) => publicMessage(item, viewerId)),
            hasMore: result.rows.length > 50,
          };
        },
        readSnapshot,
      );
    },

    async syncChat(
      id: string,
      after: string,
      watchedIds: string[],
      viewerId?: string,
    ) {
      return withTransaction(
        database,
        async (client) => {
          await eventFor(client, id);
          const [newMessages, watched] = await Promise.all([
            client.query<ChatRow>(
              `SELECT ${chatFields} ${chatJoin}
           WHERE m.debate_id = $1 AND m.state = 'visible' AND m.id > $2
           ORDER BY m.id ASC LIMIT 51`,
              [id, after],
            ),
            watchedIds.length
              ? client.query<ChatRow>(
                  `SELECT ${chatFields} ${chatJoin}
               WHERE m.debate_id = $1 AND m.id = ANY($2::bigint[])
               ORDER BY m.id ASC`,
                  [id, watchedIds],
                )
              : Promise.resolve({ rows: [] as ChatRow[] }),
          ]);
          return {
            items: newMessages.rows
              .slice(0, 50)
              .map((item) => publicMessage(item, viewerId)),
            hasMore: newMessages.rows.length > 50,
            // Legacy clients use absence from watched to hide moderated messages.
            watched: watched.rows
              .filter((item) => item.state === "visible")
              .map((item) => publicMessage(item, viewerId)),
            removed: watched.rows
              .filter((item) => item.state === "removed")
              .map((item) => publicMessage(item, viewerId)),
          };
        },
        readSnapshot,
      );
    },

    async postChat(
      id: string,
      userId: string,
      body: string,
      clientMessageId?: string,
      canPost = true,
    ) {
      body = body.trim();
      return withTransaction(database, async (client) => {
        await lockAccount(client, userId);
        // Access is always checked, even for an acknowledgment of an earlier write.
        const event = await eventFor(client, id, true);
        if (clientMessageId) {
          const accepted = await client.query<AcceptedChatRow>(
            `SELECT ${receiptFields}, r.body_hash=sha256(convert_to($4,'UTF8')) AS "payloadMatches" ${receiptJoin}
             WHERE r.debate_id = $1 AND r.author_user_id = $2 AND r.client_message_id = $3`,
            [id, userId, clientMessageId, body],
          );
          const original = accepted.rows[0];
          if (original) {
            if (!original.payloadMatches)
              throw new CommunityConflictError(
                "submission key was already accepted with different text",
                "CHAT_PAYLOAD_CONFLICT",
              );
            return publicMessage(original, userId);
          }
        }
        if (!canPost)
          throw new CommunityForbiddenError(
            "participant role is required to chat",
          );
        await assertWritable(client, userId);
        if (event.status !== "live")
          throw new CommunityConflictError(
            "chat is available only during a live event",
            "CHAT_CLOSED",
          );
        const profile = await client.query<{
          authorName: string;
          authorHandle: string;
          authorAvatar: string | null;
        }>(
          `SELECT display_name AS "authorName", handle AS "authorHandle",
             avatar_id AS "authorAvatar" FROM public_profiles WHERE user_id = $1
             AND publication_state = 'published' AND is_demo = false`,
          [userId],
        );
        if (!profile.rowCount)
          throw new CommunityForbiddenError(
            "a published profile is required to chat",
          );
        await client.query(
          `INSERT INTO event_chat_controls (debate_id) VALUES ($1)
           ON CONFLICT (debate_id) DO NOTHING`,
          [id],
        );
        const control = await client.query<{ state: string }>(
          "SELECT state FROM event_chat_controls WHERE debate_id = $1 FOR UPDATE",
          [id],
        );
        if (control.rows[0]?.state !== "open")
          throw new CommunityConflictError(
            "event chat is paused",
            "CHAT_PAUSED",
          );
        const limits = await client.query<{
          recent: string;
          hourly: string;
          retryAt: Date | null;
          retryAfterSeconds: number;
        }>(
          `SELECT recent, hourly, "retryAt",
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("retryAt" - clock_timestamp()))))::int AS "retryAfterSeconds"
           FROM (SELECT
             COUNT(*) FILTER (WHERE created_at > clock_timestamp() - INTERVAL '10 seconds')::text AS recent,
             COUNT(*)::text AS hourly,
             GREATEST(MAX(created_at) + INTERVAL '10 seconds',
               CASE WHEN COUNT(*) >= 30 THEN
                 (array_agg(created_at ORDER BY created_at DESC))[30] + INTERVAL '1 hour'
               END) AS "retryAt"
             FROM event_chat_messages WHERE author_user_id = $1
               AND created_at > clock_timestamp() - INTERVAL '1 hour') allowance`,
          [userId],
        );
        const allowance = limits.rows[0]!;
        if (Number(allowance.recent) > 0 || Number(allowance.hourly) >= 30)
          throw new CommunityRateError(
            "chat limit reached; wait before retrying",
            allowance.retryAfterSeconds,
            Number(allowance.hourly) >= 30
              ? "CHAT_HOURLY_LIMIT"
              : "CHAT_COOLDOWN",
            allowance.retryAt ?? undefined,
          );
        const result = await client.query<ChatRow>(
          `INSERT INTO event_chat_messages (debate_id, author_user_id, body, client_message_id, created_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())
           RETURNING id, debate_id AS "debateId", author_user_id AS "authorUserId",
             body, state, created_at AS "createdAt", client_message_id AS "clientMessageId", revision::text AS revision,
             stream_revision::text AS "streamRevision"`,
          [id, userId, body, clientMessageId ?? null],
        );
        return publicMessage(
          { ...result.rows[0]!, ...profile.rows[0]! },
          userId,
        );
      });
    },

    async reconcileSubmissions(id: string, userId: string, keys: string[]) {
      return withTransaction(
        database,
        async (client) => {
          await eventFor(client, id);
          const result = await client.query<ChatRow>(
            `SELECT ${receiptFields} ${receiptJoin}
        WHERE r.debate_id=$1 AND r.author_user_id=$2 AND r.client_message_id=ANY($3::uuid[])`,
            [id, userId, keys],
          );
          return result.rows.map((item) => publicMessage(item, userId));
        },
        readSnapshot,
      );
    },

    async setLike(id: string, userId: string, liked: boolean) {
      return withTransaction(database, async (client) => {
        await lockAccount(client, userId);
        await eventFor(client, id, true);
        if (liked) await assertWritable(client, userId);
        const current = await client.query(
          "SELECT 1 FROM event_likes WHERE debate_id = $1 AND user_id = $2",
          [id, userId],
        );
        if (Boolean(current.rowCount) !== liked) {
          const changes = await client.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM event_like_changes
             WHERE user_id = $1 AND changed_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
            [userId],
          );
          if (Number(changes.rows[0]!.total) >= 10)
            throw new CommunityRateError(
              "like change limit reached; try again later",
            );
          if (liked) {
            await client.query(
              `INSERT INTO event_likes (debate_id, user_id) VALUES ($1, $2)
               ON CONFLICT (debate_id, user_id) DO NOTHING`,
              [id, userId],
            );
          } else {
            await client.query(
              "DELETE FROM event_likes WHERE debate_id = $1 AND user_id = $2",
              [id, userId],
            );
          }
          await client.query(
            `INSERT INTO event_like_changes (debate_id, user_id, action)
             VALUES ($1, $2, $3)`,
            [id, userId, liked ? "like" : "unlike"],
          );
        }
        const result = await client.query<{ likes: string }>(
          "SELECT COUNT(*)::text AS likes FROM event_likes WHERE debate_id = $1",
          [id],
        );
        return { liked, likes: Number(result.rows[0]!.likes) };
      });
    },

    async report(
      userId: string,
      targetType: "event" | "chat",
      targetId: string,
      reasonCode: ReasonCode,
      detail: string,
    ) {
      return withTransaction(database, async (client) => {
        await lockAccount(client, userId);
        await assertWritable(client, userId);
        const count = await client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM moderation_cases
           WHERE reporter_user_id = $1
             AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'`,
          [userId],
        );
        if (Number(count.rows[0]!.total) >= 5)
          throw new CommunityRateError("report limit reached; try again later");
        let debateId = targetId;
        let chatId: string | null = null;
        if (targetType === "chat") {
          const chat = await client.query<{
            debateId: string;
            authorUserId: string;
          }>(
            `SELECT debate_id AS "debateId", author_user_id AS "authorUserId"
             FROM event_chat_messages WHERE id = $1 AND state = 'visible' FOR SHARE`,
            [targetId],
          );
          if (!chat.rows[0])
            throw new CommunityNotFoundError("chat message not found");
          if (chat.rows[0].authorUserId === userId)
            throw new CommunityForbiddenError("cannot report your own chat");
          debateId = chat.rows[0].debateId;
          chatId = targetId;
        }
        await eventFor(client, debateId, true);
        const result = await client.query<{ id: string }>(
          `INSERT INTO moderation_cases
            (reporter_user_id, debate_id, target_type, target_chat_id, reason_code, detail)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [userId, debateId, targetType, chatId, reasonCode, detail],
        );
        await audit(client, result.rows[0]!.id, userId, "reported");
        return { id: result.rows[0]!.id, status: "open" as const };
      });
    },

    async listCases(status: "open" | "dismissed" | "actioned" = "open") {
      const result = await database.query<CaseRow>(
        `SELECT ${caseFields} ${caseJoin}
         WHERE c.status = $1 ORDER BY c.created_at ASC, c.id ASC LIMIT 50`,
        [status],
      );
      return result.rows;
    },

    async getCase(id: string) {
      const client = await database.connect();
      try {
        const record = await caseFor(client, id);
        const [appeals, history] = await Promise.all([
          client.query<AppealRow>(
            `SELECT id, case_id AS "caseId", appellant_user_id AS "appellantUserId",
              reason, status, reviewer_user_id AS "reviewerUserId",
              decision_note AS "decisionNote", decided_at AS "decidedAt",
              created_at AS "createdAt"
             FROM moderation_appeals WHERE case_id = $1`,
            [id],
          ),
          client.query(
            `SELECT action, note, actor_user_id AS "actorUserId", occurred_at AS "occurredAt"
             FROM community_audit_events WHERE case_id = $1 ORDER BY id`,
            [id],
          ),
        ]);
        return {
          ...record,
          appeal: appeals.rows[0] ?? null,
          history: history.rows,
        };
      } finally {
        client.release();
      }
    },

    async listMyCases(userId: string) {
      const result = await database.query<
        CaseRow & {
          appealId: string | null;
          appealStatus: string | null;
        }
      >(
        `SELECT ${caseFields}, a.id AS "appealId", a.status AS "appealStatus"
         ${caseJoin} LEFT JOIN moderation_appeals a ON a.case_id = c.id
         WHERE c.reporter_user_id = $1 OR m.author_user_id = $1
         ORDER BY c.created_at DESC, c.id DESC LIMIT 50`,
        [userId],
      );
      return result.rows.map((item) => ({
        id: item.id,
        debateId: item.debateId,
        targetType: item.targetType,
        reasonCode: item.reasonCode,
        detail: item.reporterUserId === userId ? item.detail : null,
        status: item.status,
        action: item.action,
        decisionReason: item.decisionReason,
        createdAt: item.createdAt,
        decidedAt: item.decidedAt,
        isReporter: item.reporterUserId === userId,
        appealId: item.subjectUserId === userId ? item.appealId : null,
        appealStatus: item.subjectUserId === userId ? item.appealStatus : null,
        canAppeal:
          item.subjectUserId === userId &&
          item.status === "actioned" &&
          (item.action === "remove_chat" ||
            item.action === "restrict_account") &&
          !item.appealId &&
          !!item.decidedAt &&
          item.decidedAt.getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000,
      }));
    },

    async decideCase(
      id: string,
      moderatorId: string,
      action: CaseAction,
      reasonCode: ReasonCode,
      note: string,
    ) {
      return withTransaction(database, async (client) => {
        const record = await caseFor(client, id, true);
        if (record.status !== "open")
          throw new CommunityConflictError("case already reviewed");
        if (
          record.reporterUserId === moderatorId ||
          record.subjectUserId === moderatorId
        )
          throw new CommunityForbiddenError(
            "cannot review your own case or content",
          );
        if (record.targetType === "event") {
          const ownSeat = await client.query(
            "SELECT 1 FROM event_participants WHERE debate_id = $1 AND user_id = $2",
            [record.debateId, moderatorId],
          );
          if (ownSeat.rowCount)
            throw new CommunityForbiddenError("cannot review your own event");
        }
        if (
          (record.targetType === "chat" && action === "pause_chat") ||
          (record.targetType === "event" &&
            ["remove_chat", "restrict_account"].includes(action))
        )
          throw new CommunityConflictError(
            "action does not apply to this report",
          );
        if (action === "remove_chat") {
          const changed = await client.query(
            `UPDATE event_chat_messages SET state = 'removed', removal_case_id = $2
             WHERE id = $1 AND state = 'visible'`,
            [record.targetChatId, id],
          );
          if (!changed.rowCount)
            throw new CommunityConflictError("chat message is already removed");
        } else if (action === "restrict_account") {
          if (!record.subjectUserId)
            throw new CommunityConflictError("chat author is unavailable");
          await lockAccount(client, record.subjectUserId);
          const active = await client.query(
            `SELECT 1 FROM community_restrictions
             WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
            [record.subjectUserId],
          );
          if (active.rowCount)
            throw new CommunityConflictError(
              "account already has an active restriction",
            );
          await client.query(
            `INSERT INTO community_restrictions (user_id, case_id, expires_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
            [record.subjectUserId, id],
          );
        } else if (action === "pause_chat") {
          await client.query(
            `INSERT INTO event_chat_controls (debate_id) VALUES ($1)
             ON CONFLICT (debate_id) DO NOTHING`,
            [record.debateId],
          );
          const changed = await client.query(
            `UPDATE event_chat_controls SET state = 'paused', pause_case_id = $2,
               updated_at = CURRENT_TIMESTAMP
             WHERE debate_id = $1 AND state = 'open'`,
            [record.debateId, id],
          );
          if (!changed.rowCount)
            throw new CommunityConflictError("event chat is already paused");
        }
        await client.query(
          `UPDATE moderation_cases SET status = $2, action = $3,
             reviewer_user_id = $4, decision_reason = $5, decision_note = $6,
             decided_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [
            id,
            action === "dismiss" ? "dismissed" : "actioned",
            action,
            moderatorId,
            reasonCode,
            note,
          ],
        );
        await audit(client, id, moderatorId, action);
        await notifyCase(
          client,
          record.reporterUserId,
          record.debateId,
          "Your community report was reviewed. See My reports and appeals for the decision.",
        );
        if (record.subjectUserId && action !== "dismiss")
          await notifyCase(
            client,
            record.subjectUserId,
            record.debateId,
            "A moderation action affected your event chat. See My reports and appeals for details and appeal options.",
          );
        return {
          id,
          status: action === "dismiss" ? "dismissed" : "actioned",
          action,
        };
      });
    },

    async resumeChat(id: string, moderatorId: string, note: string) {
      return withTransaction(database, async (client) => {
        const record = await caseFor(client, id, true);
        if (record.action !== "pause_chat" || record.status !== "actioned")
          throw new CommunityConflictError("case did not pause chat");
        if (record.reporterUserId === moderatorId)
          throw new CommunityForbiddenError("cannot review your own report");
        const ownSeat = await client.query(
          "SELECT 1 FROM event_participants WHERE debate_id = $1 AND user_id = $2",
          [record.debateId, moderatorId],
        );
        if (ownSeat.rowCount)
          throw new CommunityForbiddenError("cannot review your own event");
        const changed = await client.query(
          `UPDATE event_chat_controls SET state = 'open', pause_case_id = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE debate_id = $1 AND state = 'paused' AND pause_case_id = $2`,
          [record.debateId, id],
        );
        if (!changed.rowCount)
          throw new CommunityConflictError("chat is not paused by this case");
        await audit(client, id, moderatorId, "chat_resumed", null, note);
        return { id, chatState: "open" as const };
      });
    },

    async appeal(id: string, userId: string, reason: string) {
      return withTransaction(database, async (client) => {
        const record = await caseFor(client, id, true);
        if (
          record.status !== "actioned" ||
          !["remove_chat", "restrict_account"].includes(record.action ?? "") ||
          record.subjectUserId !== userId
        )
          throw new CommunityForbiddenError(
            "case is not appealable by this account",
          );
        if (
          !record.decidedAt ||
          record.decidedAt.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000
        )
          throw new CommunityConflictError("appeal window has closed");
        const existing = await client.query(
          "SELECT 1 FROM moderation_appeals WHERE case_id = $1",
          [id],
        );
        if (existing.rowCount)
          throw new CommunityConflictError("case has already been appealed");
        const result = await client.query<{ id: string }>(
          `INSERT INTO moderation_appeals (case_id, appellant_user_id, reason)
           VALUES ($1, $2, $3) RETURNING id`,
          [id, userId, reason],
        );
        await audit(client, id, userId, "appealed", result.rows[0]!.id);
        return { id: result.rows[0]!.id, caseId: id, status: "open" as const };
      });
    },

    async listAppeals() {
      const result = await database.query<AppealRow>(
        `SELECT id, case_id AS "caseId", appellant_user_id AS "appellantUserId",
          reason, status, reviewer_user_id AS "reviewerUserId",
          decision_note AS "decisionNote", decided_at AS "decidedAt",
          created_at AS "createdAt"
         FROM moderation_appeals WHERE status = 'open'
         ORDER BY created_at ASC, id ASC LIMIT 50`,
      );
      return result.rows;
    },

    async decideAppeal(
      id: string,
      moderatorId: string,
      decision: "upheld" | "overturned",
      note: string,
    ) {
      return withTransaction(database, async (client) => {
        const target = await client.query<{ caseId: string }>(
          'SELECT case_id AS "caseId" FROM moderation_appeals WHERE id = $1',
          [id],
        );
        if (!target.rows[0])
          throw new CommunityNotFoundError("appeal not found");
        const record = await caseFor(client, target.rows[0].caseId, true);
        const appeal = await client.query<AppealRow>(
          `SELECT id, case_id AS "caseId", appellant_user_id AS "appellantUserId",
            reason, status, reviewer_user_id AS "reviewerUserId",
            decision_note AS "decisionNote", decided_at AS "decidedAt",
            created_at AS "createdAt"
           FROM moderation_appeals WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (appeal.rows[0]?.status !== "open")
          throw new CommunityConflictError("appeal already reviewed");
        if (
          record.reviewerUserId === moderatorId ||
          appeal.rows[0].appellantUserId === moderatorId
        )
          throw new CommunityForbiddenError(
            "a different moderator must review the appeal",
          );
        if (decision === "overturned") {
          if (record.action === "remove_chat") {
            await client.query(
              `UPDATE event_chat_messages SET state = 'visible', removal_case_id = NULL
               WHERE id = $1 AND state = 'removed' AND removal_case_id = $2`,
              [record.targetChatId, record.id],
            );
          } else if (record.action === "restrict_account") {
            await client.query(
              `UPDATE community_restrictions SET revoked_at = CURRENT_TIMESTAMP
               WHERE case_id = $1 AND revoked_at IS NULL`,
              [record.id],
            );
          }
        }
        await client.query(
          `UPDATE moderation_appeals SET status = $2, reviewer_user_id = $3,
            decision_note = $4, decided_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id, decision, moderatorId, note],
        );
        await audit(client, record.id, moderatorId, `appeal_${decision}`, id);
        await notifyCase(
          client,
          appeal.rows[0].appellantUserId,
          record.debateId,
          "Your community appeal was reviewed. See My reports and appeals for the decision.",
        );
        return { id, status: decision };
      });
    },

    // Moderators hide a topic, profile or debate from public pages, or restore it (YA-07). The
    // accounts the item involves cannot decide it, as with cases.
    async setContentVisibility(
      type: ContentType,
      key: string,
      moderatorId: string,
      hidden: boolean,
      reasonCode: ReasonCode | null,
      note: string,
    ) {
      return withTransaction(database, async (client) => {
        const item = await contentFor(client, type, key);
        if (item.involved.includes(moderatorId))
          throw new CommunityForbiddenError(
            "cannot moderate your own content or debates",
          );
        if (hidden === (item.state === "hidden"))
          throw new CommunityConflictError(
            hidden ? `${type} is already hidden` : `${type} is not hidden`,
          );
        const state = hidden
          ? "hidden"
          : await restoredState(client, type, item.id);
        await client.query(
          `UPDATE ${contentTables[type]} SET publication_state = $2,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [item.id, state],
        );
        const action = await client.query<{ id: string }>(
          `INSERT INTO content_moderation_actions
             (target_type, target_id, action, from_state, to_state, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            type,
            item.id,
            hidden ? "hide" : "unhide",
            item.state,
            state,
            hidden ? reasonCode : null,
          ],
        );
        await client.query(
          `INSERT INTO community_audit_events (content_action_id, actor_user_id, action, note)
           VALUES ($1, $2, $3, $4)`,
          [
            action.rows[0]!.id,
            moderatorId,
            hidden ? "content_hidden" : "content_restored",
            note,
          ],
        );
        const [hiddenNotice, restoredNotice] = contentNotices[type];
        for (const userId of item.owners)
          await client.query(
            `INSERT INTO account_notifications (user_id, event_type, message, debate_id)
             VALUES ($1, 'community_moderation', $2, $3)`,
            [
              userId,
              hidden
                ? `A moderator hid ${hiddenNotice} from public pages.`
                : `A moderator restored ${restoredNotice}.`,
              type === "debate" ? item.id : null,
            ],
          );
        return {
          id: action.rows[0]!.id,
          targetType: type,
          target: item.key,
          publicationState: state,
        };
      });
    },

    async listContentActions() {
      const result = await database.query(
        `SELECT a.id, a.target_type AS "targetType", a.target_id AS "targetId",
           COALESCE(t.slug, p.handle, d.slug) AS target,
           COALESCE(t.title, p.display_name, d.proposition) AS label,
           COALESCE(t.publication_state, p.publication_state, d.publication_state)
             AS "publicationState",
           a.action, a.from_state AS "fromState", a.to_state AS "toState",
           a.reason_code AS "reasonCode", e.note, e.actor_user_id AS "actorUserId",
           a.created_at AS "createdAt"
         FROM content_moderation_actions a
         JOIN community_audit_events e ON e.content_action_id = a.id
         LEFT JOIN topics t ON a.target_type = 'topic' AND t.id = a.target_id
         LEFT JOIN public_profiles p ON a.target_type = 'profile' AND p.id = a.target_id
         LEFT JOIN debates d ON a.target_type = 'debate' AND d.id = a.target_id
         ORDER BY a.created_at DESC, a.id DESC LIMIT 50`,
      );
      return result.rows;
    },

    async pruneExpired() {
      const totals = await withTransaction(database, async (client) => {
        const cases =
          await client.query(`DELETE FROM moderation_cases WHERE id IN (
          SELECT c.id FROM moderation_cases c WHERE c.status <> 'open'
          AND c.decided_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
          AND NOT EXISTS (SELECT 1 FROM moderation_appeals a WHERE a.case_id=c.id AND a.status='open')
          ORDER BY c.id LIMIT 500 FOR UPDATE SKIP LOCKED)`);
        const likeChanges =
          await client.query(`DELETE FROM event_like_changes WHERE id IN (
          SELECT id FROM event_like_changes WHERE changed_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
          ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED)`);
        // An item's latest hide stays while it is hidden: restoring reads the state it replaced.
        // The runtime cannot update these records, so this batch takes no row locks; a row
        // another cleanup already deleted is simply skipped.
        const contentActions =
          await client.query(`DELETE FROM content_moderation_actions WHERE id IN (
          SELECT a.id FROM content_moderation_actions a
          WHERE a.created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
            AND (a.action = 'unhide' OR EXISTS (SELECT 1 FROM content_moderation_actions b
              WHERE b.target_type = a.target_type AND b.target_id = a.target_id
                AND (b.created_at, b.id) > (a.created_at, a.id)))
          ORDER BY a.created_at, a.id LIMIT 500)`);
        return {
          cases: cases.rowCount ?? 0,
          contentActions: contentActions.rowCount ?? 0,
          chat: 0,
          likes: 0,
          likeChanges: likeChanges.rowCount ?? 0,
        };
      });
      const rooms = await database.query<{
        id: string;
      }>(`SELECT debate_id AS id FROM (
        SELECT debate_id FROM event_chat_messages WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
        UNION SELECT debate_id FROM event_likes WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
        ) candidates ORDER BY debate_id LIMIT 10`);
      for (const { id } of rooms.rows) {
        await withTransaction(database, async (client) => {
          // Lock both entity sets without waiting before any trigger takes the counter.
          // One room/transaction avoids inversions against multi-room topic/profile triggers.
          const chatIds = await client.query<{ id: string }>(
            `SELECT m.id FROM event_chat_messages m
            WHERE m.debate_id=$1 AND m.created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
            AND NOT EXISTS (SELECT 1 FROM moderation_cases c WHERE c.target_chat_id=m.id)
            ORDER BY m.id LIMIT 50 FOR UPDATE SKIP LOCKED`,
            [id],
          );
          const likeIds = await client.query<{ id: string }>(
            `SELECT user_id AS id FROM event_likes
            WHERE debate_id=$1 AND created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
            ORDER BY user_id LIMIT 50 FOR UPDATE SKIP LOCKED`,
            [id],
          );
          const chat = await client.query(
            "DELETE FROM event_chat_messages WHERE debate_id=$1 AND id=ANY($2::bigint[])",
            [id, chatIds.rows.map((r) => r.id)],
          );
          const likes = await client.query(
            "DELETE FROM event_likes WHERE debate_id=$1 AND user_id=ANY($2::bigint[])",
            [id, likeIds.rows.map((r) => r.id)],
          );
          totals.chat += chat.rowCount ?? 0;
          totals.likes += likes.rowCount ?? 0;
        });
      }
      return totals;
    },
  });
}
