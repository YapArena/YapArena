// Owner command (Decision 0003): change one topic's category. Build first, then run it as the
// owner with the owner environment file. It previews the change unless --execute is given:
//   node --env-file="$HOME/yaparena-private/production/owner.env" \
//     scripts/set-topic-category.ts <topic slug> <category> "Reason for the record" [--execute]
// The categories are politics, society, cities, technology, work, climate, education, economy
// and other. Each change records the previous category and the reason in topic_category_changes.
// No .env loading, HTTP listener or automatic invocation.
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  changeTopicCategory,
  TopicCategoryError,
} from "../dist/features/matching/topic-category.js";

export function parseArguments(argv: readonly string[]) {
  const [slug, category, reason, flag, ...extra] = argv;
  if (
    !slug ||
    !category ||
    !reason ||
    (flag !== undefined && flag !== "--execute") ||
    extra.length
  )
    throw new TopicCategoryError(
      'usage: set-topic-category.ts <topic slug> <category> "<reason>" [--execute]',
    );
  return { slug, category, reason, execute: flag === "--execute" };
}

export async function runCommand(input: {
  argv: readonly string[];
  connectionString: string | undefined;
}) {
  const command = parseArguments(input.argv);
  if (!input.connectionString)
    throw new TopicCategoryError("DATABASE_URL (the owner URL) is required");
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
      throw new TopicCategoryError("the dedicated owner login is required");
    await client.query("BEGIN");
    try {
      const result = await changeTopicCategory(client, command);
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
      `topic category change failed; nothing was committed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
