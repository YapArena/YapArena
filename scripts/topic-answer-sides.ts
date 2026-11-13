// Owner command (Decision 0015, D4): review which side of each topic answers yes. Build first,
// then run it as the owner with the owner environment file:
//   node --env-file="$HOME/yaparena-private/production/owner.env" \
//     scripts/topic-answer-sides.ts list [--flagged]
//   node --env-file="$HOME/yaparena-private/production/owner.env" \
//     scripts/topic-answer-sides.ts review <topic slug> side-a-yes|side-a-not-yes "Reason" [--execute]
// "list" reads only: every published topic with both labels, its debate and answer counts, the
// labels' likely-mismatch flags and the latest review; --flagged keeps flagged or reviewed topics.
// "review" previews a review unless --execute is given, and records it in topic_answer_reviews.
// No .env loading, HTTP listener or automatic invocation.
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  listTopicAnswerSides,
  recordTopicAnswerReview,
  TopicAnswerSidesError,
} from "../dist/features/matching/topic-answer-sides.js";

const usage =
  'usage: topic-answer-sides.ts list [--flagged] | review <topic slug> side-a-yes|side-a-not-yes "<reason>" [--execute]';

export function parseArguments(argv: readonly string[]) {
  const [command, ...rest] = argv;
  if (command === "list") {
    const [flag, ...extra] = rest;
    if ((flag !== undefined && flag !== "--flagged") || extra.length)
      throw new TopicAnswerSidesError(usage);
    return { command: "list" as const, flagged: flag === "--flagged" };
  }
  if (command === "review") {
    const [slug, answer, reason, flag, ...extra] = rest;
    if (
      !slug ||
      (answer !== "side-a-yes" && answer !== "side-a-not-yes") ||
      !reason ||
      (flag !== undefined && flag !== "--execute") ||
      extra.length
    )
      throw new TopicAnswerSidesError(usage);
    return {
      command: "review" as const,
      slug,
      sideAIsYes: answer === "side-a-yes",
      reason,
      execute: flag === "--execute",
    };
  }
  throw new TopicAnswerSidesError(usage);
}

export async function runCommand(input: {
  argv: readonly string[];
  connectionString: string | undefined;
}) {
  const command = parseArguments(input.argv);
  if (!input.connectionString)
    throw new TopicAnswerSidesError("DATABASE_URL (the owner URL) is required");
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
      throw new TopicAnswerSidesError("the dedicated owner login is required");
    if (command.command === "list") {
      await client.query("BEGIN READ ONLY");
      try {
        const topics = await listTopicAnswerSides(client);
        return {
          command: "list" as const,
          topics: command.flagged
            ? topics.filter((topic) => topic.flags.length || topic.review)
            : topics,
        };
      } finally {
        await client.query("ROLLBACK");
      }
    }
    await client.query("BEGIN");
    try {
      const result = await recordTopicAnswerReview(client, command);
      await client.query(command.execute ? "COMMIT" : "ROLLBACK");
      return {
        command: "review" as const,
        ...result,
        executed: command.execute,
      };
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
    if (result.command === "list")
      console.log(JSON.stringify(result.topics, null, 2));
    else
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
      `topic answer sides failed; nothing was committed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
