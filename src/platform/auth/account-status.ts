import type { PoolClient } from "pg";
import { revokeAccountSessions } from "./sessions.ts";

export type AccountStatusChange = "suspend" | "reinstate";

export class AccountStatusError extends Error {}

const accountId = /^[1-9]\d{0,18}$/;

// Owner-only (YA-08): suspends or reinstates one account inside the caller's
// transaction. Changing the status ends the account's sessions in the
// database (trigger `account_status_revoke`). A suspension also runs the
// incident revocation, which closes the account's open live streams on every
// web process when the transaction commits. Each change records the owner
// role, the previous status and the operator's reason.
export async function changeAccountStatus(
  client: PoolClient,
  input: { userId: string; change: AccountStatusChange; reason: string },
) {
  if (!accountId.test(input.userId))
    throw new AccountStatusError("invalid account id");
  if (input.change !== "suspend" && input.change !== "reinstate")
    throw new AccountStatusError("choose suspend or reinstate");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500)
    throw new AccountStatusError("the reason must be 5-500 characters");
  const role = (
    await client.query<{ role: string }>("SELECT current_user AS role")
  ).rows[0]?.role;
  if (role !== "yaparena_owner")
    throw new AccountStatusError("the dedicated owner login is required");
  const account = (
    await client.query<{ status: string; sessions: number }>(
      `SELECT account_status AS status,
         (SELECT count(*)::int FROM sessions WHERE user_id=users.id) AS sessions
       FROM users WHERE id=$1 FOR UPDATE`,
      [input.userId],
    )
  ).rows[0];
  if (!account) throw new AccountStatusError("account not found");
  const status = input.change === "suspend" ? "suspended" : "active";
  if (account.status === status)
    return { changed: false, status, endedSessions: 0 };
  await client.query("UPDATE users SET account_status=$2 WHERE id=$1", [
    input.userId,
    status,
  ]);
  if (input.change === "suspend")
    await revokeAccountSessions(client, input.userId, {
      action: "sessions.incident",
    });
  await client.query(
    `INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
     VALUES ($1::bigint, $2, $1::bigint::text, $3::jsonb)`,
    [
      input.userId,
      input.change === "suspend" ? "account.suspended" : "account.reinstated",
      JSON.stringify({
        actorDatabaseRole: role,
        outcome: "success",
        previousStatus: account.status,
        reason,
      }),
    ],
  );
  return { changed: true, status, endedSessions: account.sessions };
}
