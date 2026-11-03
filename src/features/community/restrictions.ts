import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * The account's active community restriction, if any. A moderator applies one to a chat author
 * (Decision 0005); while it lasts the account cannot chat, like, report, change its profile,
 * create topics or take part in new debates.
 */
export async function activeRestriction(
  database: Queryable,
  userId: string,
): Promise<{ expiresAt: Date } | null> {
  const result = await database.query<{ expiresAt: Date | null }>(
    `SELECT max(expires_at) AS "expiresAt" FROM community_restrictions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
    [userId],
  );
  const expiresAt = result.rows[0]?.expiresAt;
  return expiresAt ? { expiresAt } : null;
}
