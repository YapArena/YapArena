import type { Pool } from "pg";

import type {
  DebateStatus,
  PublicTopic,
  PublicProfile,
  PublicDebate,
  PublicList,
} from "./public-types.ts";
export type {
  DebateStatus,
  PublicTopic,
  PublicProfile,
  PublicDebate,
  PublicList,
} from "./public-types.ts";

type TopicRow = PublicTopic;
type ProfileRow = PublicProfile;
interface DebateRow extends Omit<
  PublicDebate,
  "topic" | "speakerA" | "speakerB" | "sponsor" | "timing"
> {
  topicSlug: string;
  topicTitle: string;
  sideALabel: string;
  sideBLabel: string;
  speakerAHandle: string | null;
  speakerADisplayName: string | null;
  speakerBHandle: string | null;
  speakerBDisplayName: string | null;
}

function page<T>(rows: T[], limit: number, offset: number): PublicList<T> {
  return {
    items: rows.slice(0, limit),
    pagination: { limit, offset, hasMore: rows.length > limit },
  };
}

// The rules' turn length and maximum duration, as stored (jsonb values).
interface TimingRow {
  turnSeconds?: unknown;
  maximumSeconds?: unknown;
}
function timing(row: TimingRow | null) {
  const turn = row?.turnSeconds;
  const maximum = row?.maximumSeconds;
  if (
    typeof turn !== "number" ||
    typeof maximum !== "number" ||
    !Number.isInteger(turn) ||
    !Number.isInteger(maximum) ||
    turn <= 0 ||
    maximum < turn
  )
    return null;
  return { turnCount: Math.floor(maximum / turn), turnSeconds: turn };
}

function mapDebate(row: DebateRow): PublicDebate {
  return {
    id: row.id,
    slug: row.slug,
    proposition: row.proposition,
    status: row.status,
    rulesVersion: row.rulesVersion,
    scheduledAt: row.scheduledAt,
    liveStartedAt: row.liveStartedAt,
    liveEndedAt: row.liveEndedAt,
    isDemo: row.isDemo,
    createdAt: row.createdAt,
    topic: {
      slug: row.topicSlug,
      title: row.topicTitle,
      sideALabel: row.sideALabel,
      sideBLabel: row.sideBLabel,
    },
    speakerA:
      row.speakerAHandle && row.speakerADisplayName
        ? { handle: row.speakerAHandle, displayName: row.speakerADisplayName }
        : null,
    speakerB:
      row.speakerBHandle && row.speakerBDisplayName
        ? { handle: row.speakerBHandle, displayName: row.speakerBDisplayName }
        : null,
    sponsor: null,
  };
}

const topicColumns = `id, slug, title, summary,
  side_a_label AS "sideALabel", side_b_label AS "sideBLabel",
  is_demo AS "isDemo", created_at AS "createdAt"`;

const debateColumns = `d.id, d.slug, d.proposition, d.status,
  d.rules_version AS "rulesVersion", d.scheduled_at AS "scheduledAt",
  d.live_started_at AS "liveStartedAt", d.live_ended_at AS "liveEndedAt",
  d.is_demo AS "isDemo", d.created_at AS "createdAt",
  t.slug AS "topicSlug", t.title AS "topicTitle",
  t.side_a_label AS "sideALabel", t.side_b_label AS "sideBLabel",
  pa.handle AS "speakerAHandle", pa.display_name AS "speakerADisplayName",
  pb.handle AS "speakerBHandle", pb.display_name AS "speakerBDisplayName"`;

const debateJoins = `FROM debates d
  INNER JOIN topics t ON t.id = d.topic_id AND t.publication_state = 'published'
  LEFT JOIN public_profiles pa ON pa.id = d.speaker_a_profile_id AND pa.publication_state = 'published'
  LEFT JOIN public_profiles pb ON pb.id = d.speaker_b_profile_id AND pb.publication_state = 'published'`;

export function createDiscoveryRepository(database: Pick<Pool, "query">) {
  async function watchableDebates(limit: number): Promise<PublicDebate[]> {
    // Rank recent playable debates by revealed human YAP premium volume.
    // Media access is still reauthorized by the normal playback endpoints.
    const result = await database.query<DebateRow>(
      `WITH candidates AS MATERIALIZED (
          SELECT ${debateColumns},
            CASE WHEN d.status = 'live' THEN 0 ELSE 1 END AS priority,
            COALESCE(d.live_started_at, d.live_ended_at, d.created_at) AS recent
          ${debateJoins}
          INNER JOIN debate_media m ON m.debate_id = d.id
          WHERE d.publication_state = 'published' AND NOT d.is_demo
            AND ((d.status = 'live' AND m.state IN ('running', 'paused'))
              OR (d.status IN ('replay', 'finalized')
                AND m.recording_status = 'ready' AND m.recording_key IS NOT NULL))
          ORDER BY priority, recent DESC, d.id DESC LIMIT 50
        )
        SELECT c.* FROM candidates c
        ORDER BY c.priority,
          COALESCE((SELECT sum((o.outcome->>'premium')::numeric)
            FROM (
              SELECT r.id FROM a4_rounds r
              JOIN a4_sessions s ON s.id = r.session_id
              WHERE s.debate_id = c.id AND s.mode = 'human' AND s.asset = 'YAP'
                AND r.state = 'settled' AND r.revealed_at IS NOT NULL
                AND s.reveal_at <= clock_timestamp() AND r.revealed_at <= clock_timestamp()
              ORDER BY r.revealed_at DESC, r.id DESC LIMIT 100
            ) settled JOIN a4_submissions o ON o.round_id = settled.id
            WHERE o.kind = 'human' AND (o.outcome->>'executed')::boolean), 0) DESC,
          c.recent DESC, c.id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapDebate);
  }
  return Object.freeze({
    async listHomepageDebates(topicIds: string[]): Promise<PublicDebate[]> {
      const result = await database.query<DebateRow>(
        `SELECT ${debateColumns} ${debateJoins} WHERE d.publication_state='published' AND d.topic_id=ANY($1::uuid[]) ORDER BY d.created_at DESC,d.id DESC LIMIT 100`,
        [topicIds],
      );
      return result.rows.map(mapDebate);
    },
    async getFeaturedDebate(): Promise<PublicDebate | null> {
      return (await watchableDebates(1))[0] ?? null;
    },
    async listWatchableDebates(): Promise<PublicDebate[]> {
      return watchableDebates(9);
    },
    async listTopics({
      query = "",
      limit = 12,
      offset = 0,
    }: {
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<PublicList<PublicTopic>> {
      const result = await database.query<TopicRow>(
        `SELECT ${topicColumns}
         FROM topics
         WHERE publication_state = 'published'
           AND ($1 = '' OR to_tsvector('simple', title || ' ' || summary)
             @@ websearch_to_tsquery('simple', $1))
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [query, limit + 1, offset],
      );
      return page(result.rows, limit, offset);
    },

    async getTopic(slug: string): Promise<PublicTopic | null> {
      const result = await database.query<TopicRow>(
        `SELECT ${topicColumns}
         FROM topics WHERE slug = $1 AND publication_state = 'published'`,
        [slug],
      );
      return result.rows[0] ?? null;
    },

    async getProfile(handle: string): Promise<PublicProfile | null> {
      const result = await database.query<ProfileRow>(
        `SELECT id, handle, display_name AS "displayName", bio,
                is_demo AS "isDemo"
         FROM public_profiles
         WHERE handle = $1 AND publication_state = 'published'`,
        [handle],
      );
      return result.rows[0] ?? null;
    },

    async listDebates({
      query = "",
      status,
      topicSlug,
      profileHandle,
      limit = 12,
      offset = 0,
    }: {
      query?: string;
      status?: DebateStatus;
      topicSlug?: string;
      profileHandle?: string;
      limit?: number;
      offset?: number;
    }): Promise<PublicList<PublicDebate>> {
      const result = await database.query<DebateRow>(
        `SELECT ${debateColumns}
         ${debateJoins}
         WHERE d.publication_state = 'published'
           AND ($1 = '' OR to_tsvector('simple', d.proposition)
             @@ websearch_to_tsquery('simple', $1)
             OR to_tsvector('simple', t.title || ' ' || t.summary)
             @@ websearch_to_tsquery('simple', $1))
           AND ($2::text IS NULL OR d.status = $2)
           AND ($3::text IS NULL OR t.slug = $3)
           AND ($4::text IS NULL OR pa.handle = $4 OR pb.handle = $4)
         ORDER BY CASE d.status
           WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1
           WHEN 'replay' THEN 2 WHEN 'finalized' THEN 3 ELSE 4 END,
           CASE WHEN d.status = 'scheduled' THEN d.scheduled_at END ASC NULLS LAST,
           d.created_at DESC, d.id DESC
         LIMIT $5 OFFSET $6`,
        [
          query,
          status ?? null,
          topicSlug ?? null,
          profileHandle ?? null,
          limit + 1,
          offset,
        ],
      );
      const mapped = result.rows.map(mapDebate);
      return page(mapped, limit, offset);
    },

    // Published, non-demo pages for /sitemap.xml, within the 50,000-URL limit
    // of one sitemap. A debate's page needs its topic published too. Profiles
    // are listed only for speakers in such a debate, so the sitemap never
    // enumerates every account's handle.
    async listSitemap(): Promise<{
      topics: string[];
      debates: string[];
      profiles: string[];
    }> {
      const published = `FROM debates d
        INNER JOIN topics t ON t.id = d.topic_id AND t.publication_state = 'published'
        WHERE d.publication_state = 'published' AND NOT d.is_demo`;
      const [topics, debates, profiles] = await Promise.all([
        database.query<{ slug: string }>(
          `SELECT slug FROM topics
           WHERE publication_state = 'published' AND NOT is_demo
           ORDER BY created_at DESC, id DESC LIMIT 10000`,
        ),
        database.query<{ slug: string }>(
          `SELECT d.slug ${published}
           ORDER BY d.created_at DESC, d.id DESC LIMIT 30000`,
        ),
        database.query<{ handle: string }>(
          `SELECT p.handle FROM public_profiles p
           WHERE p.publication_state = 'published' AND NOT p.is_demo
             AND EXISTS (SELECT 1 ${published}
               AND p.id IN (d.speaker_a_profile_id, d.speaker_b_profile_id))
           ORDER BY p.handle LIMIT 10000`,
        ),
      ]);
      return {
        topics: topics.rows.map((row) => row.slug),
        debates: debates.rows.map((row) => row.slug),
        profiles: profiles.rows.map((row) => row.handle),
      };
    },

    async getDebate(slug: string): Promise<PublicDebate | null> {
      const result = await database.query<
        DebateRow & { timing?: TimingRow | null }
      >(
        `SELECT ${debateColumns},
           (SELECT jsonb_build_object(
              'turnSeconds', r.rules->'initial_speaking_time_seconds',
              'maximumSeconds', r.rules->'maximum_duration_seconds')
            FROM event_rule_versions r
            WHERE r.version = d.rules_version) AS timing
         ${debateJoins}
         WHERE d.slug = $1 AND d.publication_state = 'published'`,
        [slug],
      );
      const row = result.rows[0];
      return row
        ? { ...mapDebate(row), timing: timing(row.timing ?? null) }
        : null;
    },
  });
}
