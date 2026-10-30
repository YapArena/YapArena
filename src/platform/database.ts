import pg from "pg";
import type { Logger } from "pino";

import { OperatorError } from "./operator-error.ts";

const { Pool } = pg;

// The server cancels any web or jobs statement still running after 15 seconds
// (SQLSTATE 57014), so a runaway query or lock wait cannot hold a pool
// connection indefinitely. Transactions that need longer raise it with SET
// LOCAL statement_timeout (A4 uses 30 seconds), which wins for that
// transaction. There is no client-side query_timeout: pg cannot raise it per
// transaction, and it abandons the query without cancelling it.
export const defaultStatementTimeoutMs = 15_000;

export function createDatabase(
  connectionString: string,
  logger: Logger,
  observeWait?: (seconds: number) => void,
  limits: {
    max?: number;
    timeoutMs?: number;
    statementTimeoutMs?: number;
  } = {},
) {
  const statementTimeoutMs =
    limits.statementTimeoutMs ?? limits.timeoutMs ?? defaultStatementTimeoutMs;
  const database = new Pool({
    connectionString,
    max: limits.max ?? 10,
    connectionTimeoutMillis: limits.timeoutMs ?? 5_000,
    query_timeout: limits.timeoutMs,
    idleTimeoutMillis: 30_000,
    options: `-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=${statementTimeoutMs}`,
  });

  database.on("error", (error) => {
    logger.error({ error }, "idle database connection failed");
  });
  if (observeWait) {
    const acquire = database.connect.bind(database);
    // pg's own query path also calls connect with a callback.
    database.connect = ((
      callback?: (
        error: Error | undefined,
        client: pg.PoolClient | undefined,
        release: (err?: Error | boolean) => void,
      ) => void,
    ) => {
      const start = performance.now();
      if (callback)
        return acquire((error, client, release) => {
          observeWait((performance.now() - start) / 1000);
          callback(error, client, release);
        });
      return acquire().then((client) => {
        observeWait((performance.now() - start) / 1000);
        return client;
      });
    }) as typeof database.connect;
  }

  return database;
}

export async function verifyRuntimeIdentity(database: Pick<pg.Pool, "query">) {
  const result = await database.query<{ safe: boolean }>(`
    SELECT current_user = 'yaparena_runtime' AND session_user = 'yaparena_runtime'
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m
        WHERE m.member = r.oid OR (m.roleid = r.oid AND NOT EXISTS (SELECT 1 FROM pg_roles administrator
            WHERE administrator.oid = m.member AND administrator.rolname = 'postgres'
              AND (administrator.rolsuper OR administrator.rolcreaterole)
              AND m.admin_option
              AND NOT COALESCE((to_jsonb(m)->>'inherit_option')::boolean, true)
              AND NOT COALESCE((to_jsonb(m)->>'set_option')::boolean, true))))
      AND NOT EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
        AND refobjid = r.oid AND deptype = 'o'
        AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))
      AND NOT has_schema_privilege(r.oid, 'yaparena', 'CREATE')
      AND NOT has_schema_privilege(r.oid, 'yaparena_migrations', 'CREATE')
      AND has_table_privilege(r.oid, 'yaparena_migrations.pgmigrations', 'SELECT')
      AND NOT has_table_privilege(r.oid, 'yaparena_migrations.pgmigrations',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(r.oid, 'yaparena_migrations.pgmigrations', 'INSERT,UPDATE')
      AS safe FROM pg_roles r WHERE rolname = current_user
  `);
  if (!result.rows[0]?.safe) {
    throw new OperatorError(
      "database runtime identity violates the server-only boundary",
    );
  }
}

// Readiness ping. The deadline also covers pool acquisition, so a saturated
// pool reports not ready instead of holding the health check open.
export async function pingDatabase(
  database: Pick<pg.Pool, "query">,
  timeoutMs = 2_000,
) {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      database.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("database readiness timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
