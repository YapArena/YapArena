import { readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { verifyRuntimeIdentity } from "./database.ts";
import { OperatorError } from "./operator-error.ts";

// Web and the jobs worker run as yaparena_runtime; the replay encoder passes
// verifyEncoderIdentity for its own role.
export async function verifyDatabaseState(
  database: Pool,
  migrationsDirectory: URL,
  verifyIdentity: (database: Pool) => Promise<void> = verifyRuntimeIdentity,
) {
  await verifyIdentity(database);

  const files = await readdir(migrationsDirectory);
  const expected = files
    .filter((file) => /^\d+_.+\.js$/u.test(file))
    .map((file) => file.replace(/\.js$/u, ""))
    .sort();
  const result = await database.query<{ name: string }>(
    "SELECT name FROM yaparena_migrations.pgmigrations ORDER BY name",
  );
  const applied = result.rows.map(({ name }) => name).sort();
  const missing = expected.filter((name) => !applied.includes(name));

  if (missing.length > 0) {
    throw new OperatorError(
      `database migrations are pending: ${missing.join(", ")}`,
    );
  }
}
