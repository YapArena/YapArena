import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../transaction.ts";
import type { AuthenticationUser, PublicUser } from "./users.ts";

export interface StoredSession {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthenticationSnapshot {
  authGeneration: string;
}

export class SessionUnavailableError extends Error {}

// All callers lock the account before sessions, approvals or sign-in subjects.
export async function lockAccount(client: PoolClient, userId: string) {
  const result = await client.query<AuthenticationUser>(
    `SELECT id, email, created_at AS "createdAt",
       auth_generation AS "authGeneration" FROM users WHERE id = $1 AND account_status = 'active' FOR UPDATE`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function assertActiveSession(
  client: PoolClient,
  userId: string,
  tokenHash: string,
) {
  const result = await client.query<StoredSession>(
    `SELECT s.id, s.user_id AS "userId", s.expires_at AS "expiresAt",
       s.created_at AS "createdAt" FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.token_hash = $2
       AND u.account_status = 'active'
       AND s.auth_generation = u.auth_generation AND s.expires_at > clock_timestamp()
     FOR UPDATE OF s`,
    [userId, tokenHash],
  );
  if (!result.rows[0])
    throw new SessionUnavailableError("session is unavailable");
  return result.rows[0];
}

export async function insertSession(
  client: PoolClient,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  authGeneration: string,
): Promise<StoredSession> {
  const result = await client.query<StoredSession>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, auth_generation)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id AS "userId", expires_at AS "expiresAt", created_at AS "createdAt"`,
    [userId, tokenHash, expiresAt, authGeneration],
  );
  if (!result.rows[0]) throw new Error("created session was not returned");
  return result.rows[0];
}

// Carries the id of an account whose sessions were all ended; each web
// process closes that account's open live streams when it hears it.
export const ACCOUNT_REVOKED_CHANNEL = "yaparena_account_revoked_v1";

// Caller owns the account lock and the transaction. The generation advance is
// the ordering point; commit makes it visible on every application instance.
// Only security incidents end every session; signing out ends one session.
// The notice is delivered on commit, so a rollback closes no stream.
export async function revokeAccountSessions(
  client: PoolClient,
  userId: string,
  options: { action: "sessions.incident" },
) {
  const result = await client.query<{
    authGeneration: string;
    actorDatabaseRole: string;
  }>(
    `UPDATE users SET auth_generation = auth_generation + 1 WHERE id = $1
     RETURNING auth_generation AS "authGeneration", current_user AS "actorDatabaseRole"`,
    [userId],
  );
  if (!result.rows[0])
    throw new SessionUnavailableError("account is unavailable");
  const authGeneration = result.rows[0].authGeneration;
  await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await client.query(
    `INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
     VALUES ($1::bigint, $2, $1::bigint::text, $3::jsonb)`,
    [
      userId,
      options.action,
      JSON.stringify({
        actorDatabaseRole: result.rows[0].actorDatabaseRole,
        outcome: "success",
        authGeneration,
      }),
    ],
  );
  await client.query("SELECT pg_notify($1, $2)", [
    ACCOUNT_REVOKED_CHANNEL,
    userId,
  ]);
  return authGeneration;
}

export function createSessionRepository(database: Pool) {
  return Object.freeze({
    async create(
      userId: string,
      tokenHash: string,
      expiresAt: Date,
      expected: AuthenticationSnapshot,
    ): Promise<StoredSession> {
      return withTransaction(database, async (client) => {
        const account = await lockAccount(client, userId);
        if (!account || account.authGeneration !== expected.authGeneration)
          throw new SessionUnavailableError(
            "authentication state changed; sign in again",
          );
        const session = await insertSession(
          client,
          userId,
          tokenHash,
          expiresAt,
          account.authGeneration,
        );
        return session;
      });
    },

    // The request path: one indexed SELECT, no provider call and no row lock.
    async findUserByTokenHash(tokenHash: string): Promise<PublicUser | null> {
      const result = await database.query<PublicUser>(
        `SELECT users.id, users.email, users.created_at AS "createdAt"
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1
           AND users.account_status = 'active'
           AND sessions.auth_generation = users.auth_generation
           AND sessions.expires_at > clock_timestamp()`,
        [tokenHash],
      );
      return result.rows[0] ?? null;
    },

    async list(userId: string, currentTokenHash: string) {
      return withTransaction(database, async (client) => {
        if (!(await lockAccount(client, userId)))
          throw new SessionUnavailableError("account is unavailable");
        const current = await assertActiveSession(
          client,
          userId,
          currentTokenHash,
        );
        const result = await client.query<{
          id: string;
          createdAt: Date;
          expiresAt: Date;
          current: boolean;
        }>(
          `SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",id=$2::bigint AS current
          FROM sessions WHERE user_id=$1 AND auth_generation=(SELECT auth_generation FROM users WHERE id=$1)
            AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 101`,
          [userId, current.id],
        );
        return {
          sessions: result.rows.slice(0, 100),
          hasMore: result.rows.length > 100,
        };
      });
    },

    // Ends one session row. The account generation is unchanged, so every
    // other device stays signed in.
    async revokeSession(
      userId: string,
      currentTokenHash: string,
      targetId?: string,
      requestId?: string,
    ) {
      return withTransaction(database, async (client) => {
        if (!(await lockAccount(client, userId)))
          throw new SessionUnavailableError("account is unavailable");
        const current = await assertActiveSession(
          client,
          userId,
          currentTokenHash,
        );
        const target = targetId ?? current.id;
        const removed = await client.query<{ id: string }>(
          "DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id",
          [target, userId],
        );
        if (!removed.rows[0]) {
          return null;
        }
        await client.query(
          `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
          VALUES($1,'sessions.logout_one',$2,$3::jsonb)`,
          [
            userId,
            target,
            JSON.stringify({
              actorUserId: userId,
              actorSessionId: current.id,
              requestId,
              outcome: "success",
            }),
          ],
        );
        return { current: current.id === target };
      });
    },

    async deleteByTokenHash(tokenHash: string) {
      const result = await database.query(
        "DELETE FROM sessions WHERE token_hash = $1 RETURNING id",
        [tokenHash],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deleteExpired() {
      const result = await database.query(
        "DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP",
      );
      return result.rowCount ?? 0;
    },
  });
}
