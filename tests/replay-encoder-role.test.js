import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  encoderGrantClauses,
  encoderGrants,
  encoderRole,
  encoderSequences,
  down,
  up,
} from "../migrations/1793675904690_add-replay-encoder-role.js";
import {
  encoderTables,
  verifyEncoderIdentity,
} from "../dist/platform/database.js";
import { verifyDatabaseState } from "../dist/platform/migrations.js";
import { OperatorError } from "../dist/platform/operator-error.js";
import { provisionDatabase } from "../scripts/provision-database.ts";

// The replay encoder's own database role (audit finding YA-15). The
// PostgreSQL suite proves the boundary on a real database; these checks keep
// the migration, the startup check and provisioning in step without one.
function migrationSql() {
  const steps = [];
  up({ sql: (text) => steps.push(text) });
  return steps;
}

describe("replay encoder role", () => {
  it("starts with a guard that needs the owner and a provisioned encoder", () => {
    const [guard] = migrationSql();
    assert.match(guard, /current_user <> 'yaparena_owner'/);
    assert.match(guard, /Provision the yaparena_encoder identity first/);
    assert.match(guard, /DATABASE_ENCODER_PASSWORD/);
    assert.match(guard, /rolbypassrls/);
    assert.match(guard, /pg_auth_members/);
    assert.match(guard, /NOT relrowsecurity/);
    for (const table of encoderTables)
      assert.match(guard, new RegExp(`'${table}'`));
    assert.throws(() => down(), /forward fix/);
  });

  it("grants and policies name only the encoder", () => {
    const sql = migrationSql().join("\n");
    const grantees = [...sql.matchAll(/\bGRANT\b[^;]*?\bTO (\w+)/g)].map(
      (match) => match[1],
    );
    assert.ok(grantees.length > encoderTables.length);
    assert.deepEqual(new Set(grantees), new Set([encoderRole]));
    const policies = [
      ...sql.matchAll(/CREATE POLICY (\w+) ON yaparena\.(\w+)[^;]*?TO (\w+)/g),
    ];
    assert.ok(policies.length >= encoderTables.length);
    for (const [, , table, role] of policies) {
      assert.equal(role, encoderRole);
      assert.ok(encoderTables.includes(table), table);
    }
    assert.doesNotMatch(sql, /\bGRANT (ALL|TRUNCATE|REFERENCES|TRIGGER)\b/);
    assert.doesNotMatch(sql, /\bTO (PUBLIC|yaparena_runtime|anon)\b/);
  });

  it("pairs lock-only updates with a policy that refuses every write", () => {
    const sql = migrationSql().join("\n");
    for (const table of ["debate_media", "topics"])
      assert.match(
        sql,
        new RegExp(
          `CREATE POLICY encoder_lock ON yaparena\\.${table} FOR UPDATE[^;]*WITH CHECK \\(false\\)`,
        ),
      );
    assert.match(
      sql,
      /CREATE TRIGGER encoder_publication_guard BEFORE UPDATE ON yaparena\.debates\s+FOR EACH ROW WHEN \(current_user = 'yaparena_encoder'\)/,
    );
    assert.match(sql, /OLD\.status = 'ended' AND NEW\.status = 'replay'/);
  });

  it("writes whole-table grants only where the manifest says so", () => {
    assert.equal(
      encoderGrantClauses({ select: "*", insert: "*", delete: true }),
      "SELECT, INSERT, DELETE",
    );
    assert.equal(
      encoderGrantClauses({
        select: ["id"],
        insert: ["id", "kind"],
        update: ["kind"],
      }),
      "SELECT (id), INSERT (id, kind), UPDATE (kind)",
    );
    assert.equal(encoderGrantClauses({}), "");
    for (const spec of Object.values(encoderGrants)) {
      // Never a whole-table UPDATE: each one names its columns.
      assert.ok(spec.update === undefined || Array.isArray(spec.update));
      assert.ok(spec.insert === undefined || Array.isArray(spec.insert));
    }
    assert.deepEqual(encoderSequences, ["event_history_id_seq"]);
  });

  it("checks the same tables at startup as the migration grants", () => {
    assert.deepEqual(
      [...encoderTables].sort(),
      Object.keys(encoderGrants).sort(),
    );
    assert.deepEqual(
      Object.entries(encoderGrants)
        .filter(([, spec]) => spec.delete)
        .map(([table]) => table),
      ["media_replay_jobs", "media_replay_attempts"],
    );
  });

  it("refuses an encoder login outside its boundary", async () => {
    const calls = [];
    const database = (rows) => ({
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows };
      },
    });
    await verifyEncoderIdentity(database([{ safe: true }]));
    assert.match(calls[0].sql, /current_user = 'yaparena_encoder'/);
    assert.match(calls[0].sql, /AS safe FROM pg_roles/);
    assert.deepEqual(calls[0].values, [
      encoderTables,
      ["media_replay_jobs", "media_replay_attempts"],
    ]);
    for (const rows of [[{ safe: false }], []])
      await assert.rejects(
        verifyEncoderIdentity(database(rows)),
        (error) =>
          error instanceof OperatorError &&
          /encoder identity violates the replay-only boundary/.test(
            error.message,
          ),
      );
  });

  it("lets the encoder verify migrations with its own identity check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "encoder-migrations-"));
    await writeFile(join(directory, "100_create-users.js"), "");
    const checked = [];
    const database = {
      query: async () => ({ rows: [{ name: "100_create-users" }] }),
    };
    await verifyDatabaseState(
      database,
      pathToFileURL(`${directory}/`),
      async (pool) => {
        checked.push(pool);
      },
    );
    assert.deepEqual(checked, [database]);
  });

  it("needs three distinct passwords to provision", async () => {
    const client = (adminPassword) => {
      const statements = [];
      return {
        statements,
        connectionParameters: { password: adminPassword },
        async query(sql, values) {
          statements.push(sql);
          // Owner and runtime exist already; the encoder role does not.
          const exists =
            sql.startsWith("SELECT * FROM pg_roles") &&
            values[0] !== "yaparena_encoder";
          return { rows: [], rowCount: exists ? 1 : 0 };
        },
      };
    };
    for (const [admin, passwords, message] of [
      [
        "admin",
        { yaparena_owner: "a", yaparena_runtime: "b", yaparena_encoder: "a" },
        /must be distinct/,
      ],
      [
        "admin",
        { yaparena_owner: "a", yaparena_runtime: "b", yaparena_encoder: "b" },
        /must be distinct/,
      ],
      [
        "c",
        { yaparena_owner: "a", yaparena_runtime: "b", yaparena_encoder: "c" },
        /Administrator and application passwords must be distinct/,
      ],
    ]) {
      const fake = client(admin);
      await assert.rejects(provisionDatabase(fake, passwords), message);
      assert.deepEqual(fake.statements, ["BEGIN", "ROLLBACK"]);
    }
    // An installation from before the encoder role needs its password.
    const fake = client("admin");
    await assert.rejects(
      provisionDatabase(fake),
      /New identities require secret-managed passwords/,
    );
    assert.equal(fake.statements.at(-1), "ROLLBACK");
  });
});
