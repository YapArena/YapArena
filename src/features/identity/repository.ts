import type { Pool } from "pg";
import { activityLabel, hiddenActivityTypes } from "./activity.ts";

export interface OwnedProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  publicationState: "draft" | "published" | "hidden";
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowItem {
  id: string;
  targetType: "topic" | "profile";
  slug: string;
  title: string;
  createdAt: Date;
}

export interface ActivityItem {
  id: string;
  eventType: string;
  label: string;
  occurredAt: Date;
}

export interface NotificationItem {
  eventType: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface TermsAcceptance {
  termsVersion: string;
  minimumAge: number;
  acceptedAt: Date;
}

type ActivityRow = Omit<ActivityItem, "label"> & { subject: string | null };

function page<T>(rows: T[], limit: number, offset: number) {
  return {
    items: rows.slice(0, limit),
    pagination: { limit, offset, hasMore: rows.length > limit },
  };
}

const profileFields = `id, handle, display_name AS "displayName", bio,
  publication_state AS "publicationState", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

// Role and sign-in method events name the role or method in subject_id; other
// subjects are record IDs and stay private to the database.
const activityFields = `id, event_type AS "eventType", occurred_at AS "occurredAt",
  CASE WHEN event_type IN ('account_roles.insert', 'account_roles.delete',
    'sign_in.method_linked') THEN subject_id END AS subject`;

const labelled = (rows: ActivityRow[]): ActivityItem[] =>
  rows.map(({ subject, ...row }) => ({
    ...row,
    label: activityLabel(row.eventType, subject),
  }));

// Export reads are bounded; an account with more rows than this is exported
// by an operator.
const exportLimit = 5000;

export function createIdentityRepository(database: Pool) {
  return Object.freeze({
    async getProfile(userId: string): Promise<OwnedProfile | null> {
      const result = await database.query<OwnedProfile>(
        `SELECT ${profileFields} FROM public_profiles WHERE user_id = $1`,
        [userId],
      );
      return result.rows[0] ?? null;
    },

    // The handle pop-up passes the terms the account accepted. One statement
    // records both, so a profile created there always has its acceptance.
    async createProfile(
      userId: string,
      handle: string,
      displayName: string,
      bio: string | null,
      publicationState: "draft" | "published" = "draft",
      terms?: { version: string; minimumAge: number },
    ) {
      const insert = `INSERT INTO public_profiles (user_id, handle, display_name, bio, publication_state)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${profileFields}`;
      const values = [userId, handle, displayName, bio, publicationState];
      const result = await database.query<OwnedProfile>(
        terms
          ? `WITH accepted AS (
               INSERT INTO terms_acceptances (user_id, terms_version, minimum_age)
               VALUES ($1, $6, $7) ON CONFLICT (user_id, terms_version) DO NOTHING
             ) ${insert}`
          : insert,
        terms ? [...values, terms.version, terms.minimumAge] : values,
      );
      if (!result.rows[0]) throw new Error("created profile was not returned");
      return result.rows[0];
    },

    async updateProfile(
      userId: string,
      changes: {
        displayName?: string;
        bio?: string | null;
        publicationState?: "draft" | "published";
      },
    ): Promise<OwnedProfile | null> {
      const result = await database.query<OwnedProfile>(
        `UPDATE public_profiles SET
           display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
           bio = CASE WHEN $4 THEN $5 ELSE bio END,
           publication_state = CASE WHEN $6 THEN $7 ELSE publication_state END,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND publication_state <> 'hidden' AND is_demo = false
         RETURNING ${profileFields}`,
        [
          userId,
          "displayName" in changes,
          changes.displayName ?? null,
          "bio" in changes,
          changes.bio ?? null,
          "publicationState" in changes,
          changes.publicationState ?? null,
        ],
      );
      return result.rows[0] ?? null;
    },

    // Drafts, hidden and demo profiles hold their handles too.
    async isHandleTaken(handle: string): Promise<boolean> {
      const result = await database.query<{ taken: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM public_profiles WHERE handle = $1) AS taken",
        [handle],
      );
      return result.rows[0]?.taken ?? false;
    },

    async getRoles(userId: string): Promise<string[]> {
      const result = await database.query<{ role: string }>(
        "SELECT role FROM account_roles WHERE user_id = $1 ORDER BY role",
        [userId],
      );
      return result.rows.map((row) => row.role);
    },

    async follow(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<"created" | "exists" | "missing" | "self"> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      const selfCheck =
        type === "profile" ? "AND (user_id IS NULL OR user_id <> $1)" : "";
      const ownerSelect =
        type === "profile" ? "user_id" : "NULL::bigint AS user_id";
      const result = await database.query<{
        result: "created" | "exists" | "missing" | "self";
      }>(
        `WITH visible AS (
           SELECT id FROM ${targetTable}
           WHERE ${identifier} = $2 AND publication_state = 'published' ${selfCheck}
         ), target AS (
           SELECT id, ${ownerSelect} FROM ${targetTable} WHERE ${identifier} = $2
         ), inserted AS (
           INSERT INTO follows (user_id, ${targetColumn})
           SELECT $1, id FROM visible ON CONFLICT DO NOTHING RETURNING id
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM inserted) THEN 'created'
           WHEN EXISTS (SELECT 1 FROM visible) THEN 'exists'
           WHEN $3 = 'profile' AND EXISTS (SELECT 1 FROM target WHERE user_id = $1) THEN 'self'
           ELSE 'missing' END AS result`,
        [userId, slug, type],
      );
      return result.rows[0]?.result ?? "missing";
    },

    async unfollow(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<void> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      await database.query(
        `DELETE FROM follows f USING ${targetTable} target
         WHERE f.user_id = $1 AND f.${targetColumn} = target.id AND target.${identifier} = $2`,
        [userId, slug],
      );
    },

    async isFollowing(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<boolean> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      const result = await database.query<{ following: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM follows f JOIN ${targetTable} target
             ON target.id = f.${targetColumn}
           WHERE f.user_id = $1 AND target.${identifier} = $2
             AND target.publication_state = 'published'
         ) AS following`,
        [userId, slug],
      );
      return result.rows[0]?.following ?? false;
    },

    async listFollows(userId: string, limit: number, offset: number) {
      const result = await database.query<FollowItem>(
        `SELECT f.id, 'topic' AS "targetType", t.slug, t.title, f.created_at AS "createdAt"
         FROM follows f JOIN topics t ON t.id = f.topic_id AND t.publication_state = 'published'
         WHERE f.user_id = $1
         UNION ALL
         SELECT f.id, 'profile' AS "targetType", p.handle AS slug,
           p.display_name AS title, f.created_at AS "createdAt"
         FROM follows f JOIN public_profiles p ON p.id = f.profile_id
           AND p.publication_state = 'published'
         WHERE f.user_id = $1
         ORDER BY "createdAt" DESC, id DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
      );
      return page(result.rows, limit, offset);
    },

    async listActivity(userId: string, limit: number, offset: number) {
      const result = await database.query<ActivityRow>(
        `SELECT ${activityFields}
         FROM identity_audit_events
         WHERE user_id = $1 AND event_type <> ALL($4::text[])
         ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset, hiddenActivityTypes],
      );
      return page(labelled(result.rows), limit, offset);
    },

    // The account's own nonfinancial records for a download (Decision 0002).
    async exportData(userId: string) {
      const [profile, follows, activity, notifications] = await Promise.all([
        database.query<OwnedProfile>(
          `SELECT ${profileFields} FROM public_profiles WHERE user_id = $1`,
          [userId],
        ),
        database.query<FollowItem>(
          `SELECT f.id, 'topic' AS "targetType", t.slug, t.title, f.created_at AS "createdAt"
           FROM follows f JOIN topics t ON t.id = f.topic_id
           WHERE f.user_id = $1
           UNION ALL
           SELECT f.id, 'profile' AS "targetType", p.handle AS slug,
             p.display_name AS title, f.created_at AS "createdAt"
           FROM follows f JOIN public_profiles p ON p.id = f.profile_id
           WHERE f.user_id = $1
           ORDER BY "createdAt" DESC, id DESC LIMIT $2`,
          [userId, exportLimit],
        ),
        database.query<ActivityRow>(
          `SELECT ${activityFields}
           FROM identity_audit_events
           WHERE user_id = $1 AND event_type <> ALL($3::text[])
           ORDER BY occurred_at DESC, id DESC LIMIT $2`,
          [userId, exportLimit, hiddenActivityTypes],
        ),
        database.query<NotificationItem>(
          `SELECT event_type AS "eventType", message, read_at AS "readAt",
             created_at AS "createdAt"
           FROM account_notifications WHERE user_id = $1
           ORDER BY created_at DESC, id DESC LIMIT $2`,
          [userId, exportLimit],
        ),
      ]);
      return {
        profile: profile.rows[0] ?? null,
        follows: follows.rows.map(({ targetType, slug, title, createdAt }) => ({
          targetType,
          slug,
          title,
          createdAt,
        })),
        activity: labelled(activity.rows).map(
          ({ eventType, label, occurredAt }) => ({
            eventType,
            label,
            occurredAt,
          }),
        ),
        notifications: notifications.rows,
        termsAcceptances: (
          await database.query<TermsAcceptance>(
            `SELECT terms_version AS "termsVersion", minimum_age AS "minimumAge",
               accepted_at AS "acceptedAt"
             FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at DESC`,
            [userId],
          )
        ).rows,
      };
    },

    async deleteExpiredAudit() {
      const result = await database.query(
        "DELETE FROM identity_audit_events WHERE occurred_at < CURRENT_TIMESTAMP - INTERVAL '90 days'",
      );
      return result.rowCount ?? 0;
    },
  });
}
