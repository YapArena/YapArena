// Owner command (YA-08): suspend or reinstate one account. Build first, then run it as the
// owner with the owner environment file. It previews the change unless --execute is given:
//   node --env-file="$HOME/yaparena-private/production/owner.env" \
//     scripts/suspend-account.ts suspend 123 "Reason for the record" [--execute]
//   node ... scripts/suspend-account.ts reinstate 123 "Reason for the record" [--execute]
// A suspension ends every session, closes the account's open live streams and records the
// reason in identity_audit_events. No .env loading, HTTP listener or automatic invocation.
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  AccountStatusError,
  changeAccountStatus,
  type AccountStatusChange,
} from "../dist/platform/auth/account-status.js";

export function parseArguments(argv: readonly string[]) {
  const [change, userId, reason, flag, ...extra] = argv;
  if (
    (change !== "suspend" && change !== "reinstate") ||
    !userId ||
    !reason ||
    (flag !== undefined && flag !== "--execute") ||
    extra.length
  )
    throw new AccountStatusError(
      'usage: suspend-account.ts suspend|reinstate <account id> "<reason>" [--execute]',
    );
  return {
    change: change as AccountStatusChange,
    userId,
    reason,
    execute: flag === "--execute",
  };
}

export async function runCommand(input: {
  argv: readonly string[];
  connectionString: string | undefined;
}) {
  const command = parseArguments(input.argv);
  if (!input.connectionString)
    throw new AccountStatusError("DATABASE_URL (the owner URL) is required");
  const database = new pg.Pool({
    connectionString: input.connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    options:
      "-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=15000 -c lock_timeout=10000",
  });
  const client = await database.connect();
  try {
    const identity = (
      await client.query<{ safe: boolean }>(
        "SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AS safe",
      )
    ).rows[0];
    if (!identity?.safe)
      throw new AccountStatusError("the dedicated owner login is required");
    await client.query("BEGIN");
    try {
      const result = await changeAccountStatus(client, command);
      await client.query(command.execute ? "COMMIT" : "ROLLBACK");
      return { ...result, executed: command.execute };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
    await database.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runCommand({
      argv: process.argv.slice(2),
      connectionString: process.env.DATABASE_URL,
    });
    console.log(
      JSON.stringify({
        ...result,
        note: result.executed
          ? "committed"
          : "preview only, nothing changed; add --execute to commit",
      }),
    );
  } catch (error) {
    console.error(
      `account status change failed; nothing was committed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
