import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { once } from "node:events";
import pg from "pg";
import type { Response as HttpTestResponse } from "supertest";
import type { PublicUser } from "../src/platform/auth/users.ts";
import type { PublicTopic } from "../src/features/discovery/public-types.ts";

type HttpResponse<Body> = Omit<HttpTestResponse, "body"> & { body: Body };
type HttpUser = Omit<PublicUser, "createdAt"> & { createdAt: string };
type RegisteredUser = HttpUser;
type CreatedTopic = Pick<
  PublicTopic,
  "id" | "slug" | "title" | "summary" | "sideALabel" | "sideBLabel"
> & { publicationState: "draft" | "published" | "hidden" };
type AccountNotification = {
  id: string;
  eventType: string;
  message: string;
  debateId: string | null;
  requestId: string | null;
  readAt: Date | null;
  createdAt: Date;
};
import pino from "pino";
import express from "express";
import supertest from "./test-http-request.ts";
import { runner, MigrationBuilder } from "node-pg-migrate";
import { deliveryTables } from "../migrations/1791335211412_durable-community-delivery.js";
import { receiptTables } from "../migrations/1791345540042_preserve-chat-idempotency.js";
import { a4Tables } from "../migrations/1792093616251_add-a4-yap-coins.js";
import { publicBotTables } from "../migrations/1792195231830_add-public-bot-discovery.js";
import { replayJobTables } from "../migrations/1791385198189_automatic-replay-packaging.js";
import { provisionDatabase } from "./provision-database.ts";
import {
  runtimeGrants,
  up as isolationMigrationUp,
} from "../migrations/1791158400000_isolate_server_database.js";
import { createApp } from "../dist/app.js";
import {
  createDatabase,
  verifyRuntimeIdentity,
} from "../dist/platform/database.js";
import { verifyDatabaseState } from "../dist/platform/migrations.js";
import { createRuntime } from "../dist/platform/runtime.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createMessageRepository } from "../dist/features/messages/repository.js";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";
import { createAuth0Accounts } from "../dist/platform/auth/auth0-accounts.js";
import { createSignInState } from "../dist/platform/auth/sign-in-state.js";
import { createLoginSecrets } from "../dist/platform/auth/auth0.js";
import { createTestIdentityRouter } from "./test-identity.ts";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import { createMeasurementRepository } from "../dist/features/measurement/repository.js";
import { createA4Repository } from "../dist/features/a4/repository.js";

// This harness creates its own isolated Docker cluster. It accepts no external URL,
// never reads .env, mounts no data volume, and uses only synthetic random credentials.
const exec = promisify(execFile);
// The applied isolation migration still names the wallet tables that the
// legacy sign-in removal (Decision 0009) dropped.
const droppedLegacyTables = new Set(["wallet_identities", "wallet_challenges"]);
const applicationTables = [
  ...Object.keys(runtimeGrants).filter(
    (table) => !droppedLegacyTables.has(table),
  ),
  "account_operations",
  "media_account_grants",
  "media_account_revocations",
  "provider_identities",
  "auth_login_transactions",
  "auth_pending_links",
  "account_subjects",
  "auth_controls",
  "coin_accounts",
  "coin_grant_lots",
  "coin_grant_profit_events",
  "coin_journals",
  "coin_postings",
  "coin_sandbox_books",
  "coin_debate_rounds",
  "coin_debate_orders",
  "coin_debate_reveal_modes",
  "recording_clocks",
  "coin_sandbox_controls",
  "coin_sandbox_requests",
  "coin_sandbox_openings",
  "coin_sandbox_events",
  "coin_sandbox_system_accounts",
  "coin_external_receipts",
  "coin_nonce_reservations",
  "coin_sandbox_reports",
  "coin_sandbox_report_events",
  "coin_sandbox_webhook_inbox",
  "coin_sandbox_webhook_outcomes",
  ...deliveryTables,
  ...receiptTables,
  ...replayJobTables,
  ...a4Tables,
  ...publicBotTables,
  "a4_play_closing_balances",
  "matchmaking_tickets",
  "match_offers",
  "account_device_checks",
  // Decision 0012: live transcription.
  "debater_settings",
  "transcription_dispatches",
  "transcription_updates",
  "transcript_segments",
  "outline_heads",
  "outline_versions",
  "outline_windows",
  "outline_flags",
  "challenge_time_proposals",
  "matchmaking_presence",
];
const container = `yaparena-isolation-${randomUUID().slice(0, 8)}`;
const evidenceDirectory = `/tmp/${container}-evidence`;
const postgresImage =
  process.env.DATABASE_TEST_IMAGE ?? "postgres:18.4-bookworm";
if (!/^postgres:(17|18)(\.\d+)?-bookworm$/.test(postgresImage))
  throw new Error(
    "Database harness accepts official PostgreSQL 17/18 bookworm images only",
  );
const secret = () => randomBytes(24).toString("hex");
const adminPassword = secret();
const bootstrapPassword = secret();
const passwords = { yaparena_owner: secret(), yaparena_runtime: secret() };
const logger = pino({ level: "silent" });
const inventorySql = await readFile(
  new URL("./database-privilege-inventory.sql", import.meta.url),
  "utf8",
);
let port: string | undefined;
let hostDirectory: string | undefined;
let started = false;
type Role =
  "postgres" | "fixture_admin" | "yaparena_owner" | "yaparena_runtime";
const url = (database: string, role: Role = "postgres") => {
  const connection = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  connection.username = role;
  connection.password =
    role === "fixture_admin"
      ? bootstrapPassword
      : role === "postgres"
        ? adminPassword
        : passwords[role];
  return connection.href;
};
async function connect(database: string, role: Role = "postgres") {
  const client = new pg.Client({ connectionString: url(database, role) });
  await client.connect();
  return client;
}
const quiet = { info() {}, warn() {}, error() {} };
async function migrate(
  client: pg.Client,
  options: Partial<Parameters<typeof runner>[0]> = {},
) {
  return runner({
    dbClient: client,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
    ...options,
  });
}
const migrationsBefore = async (timestamp: bigint) =>
  (await readdir(new URL("../migrations", import.meta.url))).filter(
    (name) =>
      /^\d+_.+\.js$/.test(name) && BigInt(name.split("_")[0]!) < timestamp,
  ).length;
// Decision 0010 retires ordinary YAP play (A4 ledger scope 'global'). Seed it
// as the A4 engine wrote it, just before the freeze migration: a funded
// account, play value still reserved for a round, and an unopened human round.
const freezeMigration = 1792860564050n;
async function seedRetiredPlay(owner: pg.Client) {
  const user = (
    await owner.query<{ id: string }>(
      "INSERT INTO yaparena.users DEFAULT VALUES RETURNING id",
    )
  ).rows[0]!.id;
  const issuer = "global:YAP:play-issuer:issuer",
    wallet = `global:YAP:user:${user}:available`,
    held = `global:YAP:round:isolation:user:${user}:reserved`;
  const journal = async (
    reference: string,
    from: string,
    to: string,
    amount: bigint,
  ) => {
    await owner.query("BEGIN");
    await owner.query(
      `INSERT INTO yaparena.a4_accounts(id,scope,asset,user_id,kind) VALUES
        ($1,'global','YAP',NULL,'issuer'),($2,'global','YAP',$4,'available'),
        ($3,'global','YAP',$4,'reserved') ON CONFLICT DO NOTHING`,
      [issuer, wallet, held, user],
    );
    await owner.query(
      "UPDATE yaparena.a4_accounts SET amount=amount+(CASE WHEN id=$2 THEN $3::numeric ELSE -$3::numeric END) WHERE id IN ($1,$2)",
      [from, to, String(amount)],
    );
    await owner.query(
      "INSERT INTO yaparena.a4_journals(reference,scope,asset,kind,metadata) VALUES($1,'global','YAP','isolation_fixture','{}')",
      [reference],
    );
    await owner.query(
      "INSERT INTO yaparena.a4_postings(reference,account_id,amount) VALUES($1,$2,$3),($1,$4,$5)",
      [reference, from, String(-amount), to, String(amount)],
    );
    await owner.query("COMMIT");
  };
  await journal(`starter:global:${user}`, issuer, wallet, 1_000_000_000n);
  await journal(`reserve:isolation:${user}`, wallet, held, 10_000_000n);
  const topic = (
    await owner.query<{ id: string }>(
      "INSERT INTO yaparena.topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES('retired-play-isolation','Retired play fixture','Synthetic upgrade fixture','Support','Oppose','published') RETURNING id",
    )
  ).rows[0]!.id;
  const debate = (
    await owner.query<{ id: string }>(
      "INSERT INTO yaparena.debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) VALUES('retired-play-isolation',$1,'Should retired play stay readable?','scheduled','published','preview-1','{}') RETURNING id",
      [topic],
    )
  ).rows[0]!.id;
  const session = randomUUID(),
    round = randomUUID();
  await owner.query(
    `INSERT INTO yaparena.a4_sessions(id,creator_id,debate_id,asset,mode,state,config,seed,reveal_at,proposition,topic_id)
    VALUES($1,$2,$3,'YAP','human','running',$4,'isolation-seed',clock_timestamp()-interval '1 second','Should retired play stay readable?',$5)`,
    [
      session,
      user,
      debate,
      JSON.stringify({
        rule: "a4-v1",
        epsilon: 50000,
        feeBps: 0,
        maxQuantity: 100,
        capacity: 1001,
        population: 0,
        preset: "heterogeneous",
        quantity: 1,
        periods: 1,
        delayed: false,
        roundSeconds: 300,
      }),
      topic,
    ],
  );
  await owner.query(
    `INSERT INTO yaparena.a4_rounds(id,session_id,asset,period,state,opens_at,closes_at,seed,seed_commitment)
    VALUES($1,$2,'YAP',1,'scheduled',clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second','isolation-round-seed','isolation-commitment')`,
    [round, session],
  );
  return {
    held,
    round,
    release: () =>
      journal(`release:isolation:${user}`, held, wallet, 10_000_000n),
  };
}
const playBalances = async (owner: pg.Client) =>
  (
    await owner.query<{ id: string; kind: string; amount: string }>(
      "SELECT id,kind,amount::text AS amount FROM yaparena.a4_accounts WHERE scope='global' ORDER BY id",
    )
  ).rows;
async function treasuryScenario(database: string, upgrade: boolean) {
  const admin = await connect(database);
  let owner: pg.Client | undefined;
  try {
    await provisionDatabase(admin, passwords);
    owner = await connect(database, "yaparena_owner");
    let preservedRequest: string | undefined;
    if (upgrade) {
      const prefix = (
        await readdir(new URL("../migrations", import.meta.url))
      ).filter(
        (name) =>
          /^\d+_.+\.js$/.test(name) &&
          BigInt(name.split("_")[0]!) < 1792426006500n,
      ).length;
      await migrate(owner, { count: prefix });
      await owner.query(
        "UPDATE yaparena.coin_sandbox_controls SET rail='base-sepolia' WHERE singleton",
      );
      // Seed the funding request with owner SQL: today's sandbox code needs
      // tables that later migrations add.
      const account = (
        await owner.query<{ id: string }>(
          "INSERT INTO yaparena.users DEFAULT VALUES RETURNING id",
        )
      ).rows[0]!;
      preservedRequest = randomUUID();
      await owner.query(
        `INSERT INTO yaparena.coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status,expires_at)
        VALUES($1,$2,'funding',repeat('a',64),repeat('b',64),'{"amount":"1"}'::jsonb,'quoted',clock_timestamp()+interval '10 minutes')`,
        [preservedRequest, account.id],
      );
    }
    await migrate(owner);
    if (preservedRequest)
      assert.equal(
        (
          await owner.query<{ kind: string }>(
            "SELECT kind FROM yaparena.coin_sandbox_requests WHERE id=$1",
            [preservedRequest],
          )
        ).rows[0]?.kind,
        "funding",
      );
    const result = await exec(
      process.execPath,
      ["--test", "tests/coin-treasury-postgres.test.js"],
      {
        env: {
          ...process.env,
          COIN_TREASURY_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
          COIN_TREASURY_TEST_OWNER_DATABASE_URL: url(
            database,
            "yaparena_owner",
          ),
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch((error: ExecFileException & { stdout: string; stderr: string }) => {
      console.log(error.stdout);
      console.log(error.stderr);
      throw new Error("Isolated testnet treasury PostgreSQL checks failed");
    });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      `${evidenceDirectory}/treasury-${upgrade ? "upgrade" : "fresh"}.log`,
      result.stdout,
    );
    console.log(result.stdout);
  } finally {
    await owner?.end();
    await admin.end();
  }
}
async function denied(client: pg.Client, sql: string, values?: unknown[]) {
  await assert.rejects(
    client.query(sql, values),
    (error) => (error as { code?: string }).code === "42501",
    `must deny: ${sql}`,
  );
}

async function browserChecks(admin: pg.Client) {
  // Both roles are genuine PostgreSQL API identities; SET ROLE supplements the
  // separate runtime login tests below. It does not establish hosted HTTP isolation.
  for (const role of ["anon", "authenticated"]) {
    await admin.query(`SET ROLE ${role}`);
    try {
      for (const table of applicationTables) {
        await denied(admin, `SELECT * FROM yaparena.${table}`);
        await denied(admin, `INSERT INTO yaparena.${table} DEFAULT VALUES`);
        await denied(admin, `DELETE FROM yaparena.${table}`);
      }
      await denied(admin, "SELECT * FROM yaparena_migrations.pgmigrations");
    } finally {
      await admin.query("RESET ROLE");
    }
    // Even if a future operator exposes the schema, object ACLs must still deny access.
    await admin.query("BEGIN");
    try {
      await admin.query(`GRANT USAGE ON SCHEMA yaparena TO ${role}`);
      const objects = await admin.query<{
        relname: string;
        relkind: string;
        column: string | null;
      }>(`SELECT c.relname, c.relkind,
        (SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped
          AND attidentity<>'a' AND attgenerated='' ORDER BY attnum LIMIT 1) AS column FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='yaparena'
        AND c.relkind IN ('r','p','v','m','S')`);
      // Use savepoints because expected permission errors abort a transaction.
      await admin.query(`SET LOCAL ROLE ${role}`);
      for (const object of objects.rows) {
        const sql =
          object.relkind === "S"
            ? `SELECT nextval('yaparena.${object.relname}')`
            : `SELECT * FROM yaparena.${object.relname}`;
        await admin.query("SAVEPOINT probe");
        await denied(admin, sql);
        await admin.query("ROLLBACK TO SAVEPOINT probe");
        if (object.relkind === "r") {
          for (const mutation of [
            `UPDATE yaparena.${object.relname} SET ${object.column} = ${object.column}`,
            `INSERT INTO yaparena.${object.relname} DEFAULT VALUES`,
            `DELETE FROM yaparena.${object.relname}`,
          ]) {
            await admin.query("SAVEPOINT probe");
            await denied(admin, mutation);
            await admin.query("ROLLBACK TO SAVEPOINT probe");
          }
        }
        if (object.relkind === "S") {
          for (const mutation of [
            `SELECT last_value FROM yaparena.${object.relname}`,
            `SELECT setval('yaparena.${object.relname}',1)`,
          ]) {
            await admin.query("SAVEPOINT probe");
            await denied(admin, mutation);
            await admin.query("ROLLBACK TO SAVEPOINT probe");
          }
        }
      }
      for (const routine of [
        "identity_audit_row",
        "assign_participant_role",
        "product_measurement_record_completion",
        "isolation_definer_probe",
        "capture_community_change",
        "capture_submission_receipt",
      ]) {
        await admin.query("SAVEPOINT probe");
        await denied(admin, `SELECT yaparena.${routine}()`);
        await admin.query("ROLLBACK TO SAVEPOINT probe");
      }
      await admin.query("SAVEPOINT probe");
      await denied(admin, "SELECT email FROM yaparena.users");
      await admin.query("ROLLBACK TO SAVEPOINT probe");
    } finally {
      await admin.query("ROLLBACK");
    }
  }
}

async function membershipChecks(
  database: string,
  admin: pg.Client,
  owner: pg.Client,
) {
  const bootstrap = await connect(database, "fixture_admin");
  const login = await connect(database, "yaparena_runtime");
  let phase: string | undefined;
  const results = [];
  try {
    const creator = await admin.query<{
      member: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      "SELECT pg_get_userbyid(member) AS member, admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid='yaparena_runtime'::regrole",
    );
    assert.deepEqual(creator.rows, [
      {
        member: "postgres",
        admin_option: true,
        inherit_option: false,
        set_option: false,
      },
    ]);
    const identity = (
      await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
        "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(identity, { rolsuper: false, rolcreaterole: true });
    const builder = new (
      MigrationBuilder as new (
        database: Pick<
          ConstructorParameters<typeof MigrationBuilder>[0],
          "query"
        >,
        ...options: [object, boolean, typeof quiet]
      ) => MigrationBuilder
    )(
      {
        query() {
          throw new Error("Offline guard compilation");
        },
      },
      {},
      false,
      quiet,
    );
    isolationMigrationUp(builder);
    const guard = builder.getSqlSteps()[0]!;
    await owner.query(guard);
    await verifyRuntimeIdentity(login);
    const negative = async (name: string, install: string, undo: string) => {
      phase = name;
      await bootstrap.query(install);
      try {
        await assert.rejects(
          provisionDatabase(admin),
          /Unsafe pre-existing database identities/,
        );
        await assert.rejects(verifyRuntimeIdentity(login), /violates/);
        await assert.rejects(
          owner.query(guard),
          (error) => (error as { code?: string }).code === "P0001",
        );
        results.push({
          case: name,
          pass: true,
          guards: ["provision", "migration", "runtime"],
        });
      } finally {
        await bootstrap.query(undo);
      }
      await verifyRuntimeIdentity(login);
    };
    await negative(
      "deny outbound runtime membership regardless of flags",
      "GRANT yaparena_owner TO yaparena_runtime WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_owner FROM yaparena_runtime",
    );
    await negative(
      "deny browser inbound delegation even with no inherit or set",
      "GRANT yaparena_runtime TO anon WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM anon",
    );
    await negative(
      "deny unrelated inbound member",
      "GRANT yaparena_runtime TO outside_reader WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM outside_reader",
    );
    await negative(
      "deny postgres inbound SET grant",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
      "REVOKE SET OPTION FOR yaparena_runtime FROM postgres",
    );
    await negative(
      "deny postgres inbound INHERIT grant",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET FALSE",
      "REVOKE INHERIT OPTION FOR yaparena_runtime FROM postgres",
    );
    await negative(
      "deny inbound grant lacking administrative status",
      "GRANT yaparena_runtime TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    await negative(
      "deny other privileged administrator inbound grant",
      "GRANT yaparena_runtime TO outside_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM outside_admin",
    );
    const mediatorNegative = async (
      name: string,
      install: string,
      undo: string,
    ) => {
      phase = name;
      await bootstrap.query(install);
      try {
        await assert.rejects(
          provisionDatabase(admin),
          /Browser\/API role has an unsafe administrative membership|Unsafe pre-existing database identities/,
        );
        results.push({
          case: name,
          pass: true,
          guard: "provision",
          surface: "mediator",
        });
      } finally {
        await bootstrap.query(undo);
      }
      await provisionDatabase(admin);
      await verifyRuntimeIdentity(login);
    };
    results.push({
      case: "standard authenticator direct provider grants accepted",
      pass: true,
    });
    await mediatorNegative(
      "deny anon service-role escalation",
      "GRANT service_role TO anon WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE service_role FROM anon",
    );
    await mediatorNegative(
      "deny authenticated service-role escalation",
      "GRANT service_role TO authenticated WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE service_role FROM authenticated",
    );
    await mediatorNegative(
      "deny mediator ADMIN delegation",
      "GRANT service_role TO authenticator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
      "REVOKE ADMIN OPTION FOR service_role FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator service-role inheritance",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT TRUE, SET TRUE",
      "REVOKE INHERIT OPTION FOR service_role FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator service-role grant without SET",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    await mediatorNegative(
      "deny mediator role-level inheritance",
      "ALTER ROLE authenticator INHERIT",
      "ALTER ROLE authenticator NOINHERIT",
    );
    await mediatorNegative(
      "deny mediator owner membership",
      "GRANT yaparena_owner TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_owner FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator runtime membership",
      "GRANT yaparena_runtime TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator postgres membership",
      "GRANT postgres TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE postgres FROM authenticator",
    );
    await mediatorNegative(
      "deny malformed privileged service target",
      "ALTER ROLE service_role CREATEROLE",
      "ALTER ROLE service_role NOCREATEROLE",
    );
    await mediatorNegative(
      "deny alternate indirect service-role route",
      "GRANT service_role TO mediator_proxy WITH ADMIN FALSE, INHERIT FALSE, SET FALSE; GRANT mediator_proxy TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      "REVOKE mediator_proxy FROM authenticator; REVOKE service_role FROM mediator_proxy",
    );

    console.log(
      "Creator and API mediator membership guards: " +
        results.length +
        " denial/acceptance cases PASS.",
    );
  } catch (error) {
    throw new Error(
      "Role membership fixture failed at " + (phase ?? "initialization"),
      { cause: error },
    );
  } finally {
    await login.end();
    await bootstrap.end();
  }
}

async function runtimeChecks(
  database: string,
  owner: pg.Client,
  admin: pg.Client,
) {
  const pool = createDatabase(url(database, "yaparena_runtime"), logger);
  const login = await connect(database, "yaparena_runtime");
  try {
    assert.equal(
      (await login.query<{ name: string }>("SELECT session_user AS name"))
        .rows[0]!.name,
      "yaparena_runtime",
    );
    await verifyDatabaseState(pool, new URL("../migrations", import.meta.url));
    await assert.rejects(verifyRuntimeIdentity(owner), /violates/);
    for (const sql of [
      "CREATE TABLE yaparena.forbidden (id int)",
      "ALTER TABLE yaparena.users ADD COLUMN forbidden int",
      "DROP TABLE yaparena.messages",
      "CREATE FUNCTION yaparena.forbidden() RETURNS int LANGUAGE SQL AS 'SELECT 1'",
      "CREATE VIEW yaparena.forbidden AS SELECT * FROM yaparena.users",
      "GRANT yaparena_owner TO yaparena_runtime",
      "SET ROLE yaparena_owner",
      "SET ROLE postgres",
      "CREATE ROLE isolation_escalation",
      "UPDATE yaparena_migrations.pgmigrations SET name = name",
      "INSERT INTO yaparena_migrations.pgmigrations(name, run_on) VALUES ('forbidden',now())",
      "DELETE FROM yaparena_migrations.pgmigrations",
      "TRUNCATE yaparena_migrations.pgmigrations",
      "SELECT nextval('yaparena_migrations.pgmigrations_id_seq')",
      "SELECT setval('yaparena.users_id_seq',1)",
      "SELECT yaparena.isolation_definer_probe()",
      "SELECT yaparena.capture_community_change()",
      "SELECT yaparena.capture_submission_receipt()",
      "DELETE FROM yaparena.community_submission_receipts",
      "UPDATE yaparena.community_submission_receipts SET body_hash=body_hash",
      "UPDATE yaparena.users SET email = email",
    ])
      await denied(login, sql);
    // PostgreSQL can emit a warning and grant nothing instead of throwing here.
    await login.query("GRANT SELECT ON yaparena.users TO anon");
    assert.equal(
      (
        await admin.query<{ access: boolean }>(
          "SELECT has_table_privilege('anon','yaparena.users','SELECT') AS access",
        )
      ).rows[0]!.access,
      false,
    );

    const sessions = createSessionRepository(pool);
    const messages = createMessageRepository(pool);
    const discovery = createDiscoveryRepository(pool);
    const identity = createIdentityRepository(pool);
    const matching = createMatchingRepository(pool);
    const media = createMediaRepository(pool);
    const community = createCommunityRepository(pool);
    const measurement = createMeasurementRepository(pool);
    // Sign-in runs through the test identity entry, which calls the same
    // post-callback sign-in function as the Auth0 callback under the runtime
    // role: account creation, mapping, linking and session issue.
    const auth0Accounts = createAuth0Accounts(pool);
    const app = express()
      .use(
        "/api/test-identity",
        createTestIdentityRouter({
          accounts: auth0Accounts,
          environment: "development",
        }),
      )
      .use(
        createApp({
          sessions,
          messages,
          database: pool,
          discovery,
          identity,
          matching,
          community,
          measurement,
          logger,
          applicationOrigin: "http://localhost:3000",
          authRateLimit: 100,
        }),
      );
    const agents = [];
    const people: RegisteredUser[] = [];
    for (const name of ["alice", "bob", "moderator", "reviewer"]) {
      const agent = supertest.agent(app);
      agents.push(agent);
      const email = `${name}@isolation.test`;
      const response: HttpResponse<{ user: RegisteredUser }> = await agent
        .post("/api/test-identity/sign-in")
        .send({ email })
        .expect(201);
      const user = response.body.user;
      people.push(user);
      assert.deepEqual(await identity.getRoles(user.id), ["participant"]);
      await agent.get("/api/auth/me").expect(200);
      await agent.post("/api/auth/logout").expect(204);
      const again: HttpResponse<{ user: RegisteredUser }> = await agent
        .post("/api/test-identity/sign-in")
        .send({ email })
        .expect(200);
      assert.equal(again.body.user.id, user.id);
      await identity.createProfile(user.id, name, name, null);
      await identity.updateProfile(user.id, { publicationState: "published" });
    }
    // Google for a known address: no account or session until the email
    // code, then the Google subject joins the same account.
    const linking = supertest.agent(app);
    const pending: HttpResponse<{ pendingLinkId: string }> = await linking
      .post("/api/test-identity/sign-in")
      .send({ email: "alice@isolation.test", method: "google" })
      .expect(202);
    const linked: HttpResponse<{ user: RegisteredUser; linked: string[] }> =
      await linking
        .post("/api/test-identity/sign-in")
        .send({
          email: "alice@isolation.test",
          method: "email",
          pendingLinkId: pending.body.pendingLinkId,
        })
        .expect(200);
    assert.equal(linked.body.user.id, people[0]!.id);
    assert.deepEqual(linked.body.linked, ["google"]);
    // Sign-in state is stored, consumed once and pruned by the runtime role.
    const signInState = createSignInState(pool);
    const secrets = createLoginSecrets();
    const binding = randomBytes(32).toString("base64url");
    await signInState.create({
      binding,
      purpose: "sign_in",
      returnPath: "/",
      secrets,
    });
    assert.equal(
      (await signInState.consume(secrets.state, binding))?.purpose,
      "sign_in",
    );
    assert.equal(await signInState.consume(secrets.state, binding), null);
    await denied(
      login,
      "UPDATE yaparena.auth_login_transactions SET return_path='/x'",
    );
    await denied(
      login,
      "UPDATE yaparena.provider_identities SET user_id=NULL WHERE provider='auth0'",
    );
    const [alice, bob, moderator, reviewer] = people as [
      RegisteredUser,
      RegisteredUser,
      RegisteredUser,
      RegisteredUser,
    ];
    await owner.query(
      "INSERT INTO account_roles(user_id,role) VALUES ($1,'moderator'),($2,'moderator'),($1,'operator')",
      [moderator.id, reviewer.id],
    );
    await agents[0]!.get("/api/me/roles").expect(200);
    await agents[0]!.get("/moderation").expect(403);
    await agents[2]!.get("/moderation").expect(200);
    await denied(
      login,
      "INSERT INTO yaparena.account_roles(user_id,role) VALUES ($1,'operator')",
      [alice.id],
    );
    await agents[0]!
      .post("/api/messages")
      .send({ name: "Boundary" })
      .expect(201);
    await agents[0]!.get("/api/messages").expect(200);

    const topic: CreatedTopic = await matching.createTopic(alice.id, {
      slug: "isolation-topic",
      title: "Boundary verification",
      summary: "Synthetic fixture",
      sideALabel: "For",
      sideBLabel: "Against",
    });
    await matching.publishTopic(alice.id, topic.slug);
    assert.equal(
      await identity.follow(alice.id, "topic", topic.slug),
      "created",
    );
    assert.equal(
      await identity.isFollowing(alice.id, "topic", topic.slug),
      true,
    );
    await identity.unfollow(alice.id, "topic", topic.slug);
    await discovery.listTopics({ limit: 10, offset: 0 });
    const request = await matching.createRequest(alice.id, {
      kind: "direct",
      topicSlug: topic.slug,
      targetHandle: "bob",
      proposition: "Does the database boundary work?",
      requestedSide: "A",
      scheduledAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    const event = await matching.acceptRequest(bob.id, request.id);
    const notification = (
      (await matching.listNotifications(bob.id)) as AccountNotification[]
    )[0];
    assert.ok(notification);
    assert.equal(
      await matching.markNotificationRead(bob.id, notification.id),
      true,
    );
    await media.checkDevice(event.id, alice.id, true, true);
    await media.checkDevice(event.id, bob.id, true, true);
    await matching.markReady(alice.id, event.id);
    await matching.markReady(bob.id, event.id);
    await media.start(event.id, "synthetic-egress", "synthetic-replay");
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "start",
      "Synthetic start",
    );
    const chat = await community.postChat(event.id, alice.id, "Synthetic chat");
    await community.setLike(event.id, bob.id, true);
    const report = await community.report(
      bob.id,
      "chat",
      chat.id,
      "spam",
      "Synthetic report",
    );
    await community.decideCase(
      report.id,
      moderator.id,
      "remove_chat",
      "spam",
      "Synthetic moderation",
    );
    const appeal = await community.appeal(
      report.id,
      alice.id,
      "Synthetic appeal",
    );
    await community.decideAppeal(
      appeal.id,
      reviewer.id,
      "overturned",
      "Synthetic review",
    );
    assert.equal((await community.listChat(event.id)).items.length, 1);
    const token = "a".repeat(64);
    await measurement.grant(token);
    assert.equal(
      await measurement.recordDiscovery(token, alice.id, "debate", event.id),
      true,
    );
    assert.equal(
      await measurement.setAffiliation(
        "alice",
        "independent",
        "Synthetic classification",
        moderator.id,
      ),
      true,
    );
    const watchId = randomUUID();
    assert.equal(
      await measurement.startWatch(token, alice.id, watchId, event.id, "live"),
      true,
    );
    assert.equal(await measurement.progressWatch(token, watchId, true), true);
    await media.pause(event.id, moderator.id, "Synthetic pause");
    await media.resume(
      event.id,
      moderator.id,
      (await media.get(event.id))!.revision,
    );
    await media.tick();
    await media.stop(event.id, "Synthetic end");
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "end",
      "Synthetic completion",
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM product_measurement_events WHERE event_type='debate_completed' AND debate_id=$1",
          [event.id],
        )
      ).rows[0]!.n,
      1,
    );
    await media.claimRecordingStops();
    await media.recordingStopFailed(event.id);
    await media.recordingEnded("synthetic-egress", true, "synthetic-replay");
    await media.setCaptions(
      event.id,
      "WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic",
    );
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "replay",
      "Synthetic replay",
    );
    assert.ok((await measurement.summary()).events.length);
    await measurement.withdraw(token);
    await agents[0]!.get("/ready").expect(200);

    // Execute the runtime's real scheduled cleanup and clock callbacks; only the
    // timer scheduler is injected so tests need not wait one hour.
    const jobs: (() => unknown)[] = [];
    const workerPool = createDatabase(
      url(database, "yaparena_runtime"),
      logger,
    );
    const worker = (
      createRuntime as typeof createRuntime &
        ((
          options: Omit<
            Parameters<typeof createRuntime>[0],
            "setIntervalFn" | "clearIntervalFn"
          > & {
            setIntervalFn: (callback: () => unknown) => { unref(): void };
            clearIntervalFn: () => void;
          },
        ) => ReturnType<typeof createRuntime>)
    )({
      database: workerPool,
      sessions: createSessionRepository(workerPool),
      identity: createIdentityRepository(workerPool),
      matching: createMatchingRepository(workerPool),
      community: createCommunityRepository(workerPool),
      measurement: createMeasurementRepository(workerPool),
      media: createMediaRepository(workerPool),
      logger,
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: () =>
        verifyDatabaseState(
          workerPool,
          new URL("../migrations", import.meta.url),
        ),
      setIntervalFn: (callback: () => unknown) => {
        jobs.push(callback);
        return { unref() {} };
      },
      clearIntervalFn() {},
    });
    const failures = [];
    // Repository jobs also get called directly so runtime's logged-error recovery
    // cannot hide a permission failure behind a resolved callback.
    const aliceGeneration = (
      await owner.query<{ generation: string }>(
        "SELECT auth_generation::text AS generation FROM yaparena.users WHERE id=$1",
        [alice.id],
      )
    ).rows[0]!.generation;
    await sessions.create(
      alice.id,
      "b".repeat(64),
      new Date(Date.now() - 60_000),
      { authGeneration: aliceGeneration },
    );
    assert.equal(await sessions.deleteExpired(), 1);
    await owner.query(
      "UPDATE yaparena.identity_audit_events SET occurred_at = now() - INTERVAL '100 days' WHERE user_id=$1",
      [alice.id],
    );
    assert.ok(await identity.deleteExpiredAudit());
    const expiring = await matching.createRequest(alice.id, {
      kind: "direct",
      topicSlug: topic.slug,
      targetHandle: "bob",
      proposition: "Will an expired request be cleaned up?",
      requestedSide: "A",
      scheduledAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    await owner.query(
      "UPDATE yaparena.match_requests SET created_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 minute' WHERE id=$1",
      [expiring.id],
    );
    await matching.expireRequests();
    assert.equal(
      (
        await owner.query<{ status: string }>(
          "SELECT status FROM yaparena.match_requests WHERE id=$1",
          [expiring.id],
        )
      ).rows[0]!.status,
      "expired",
    );
    await owner.query(
      "UPDATE yaparena.event_likes SET created_at = now() - INTERVAL '400 days'",
    );
    assert.equal((await community.pruneExpired()).likes, 1);
    await owner.query(
      "UPDATE yaparena.product_measurement_affiliation_audit SET occurred_at = now() - INTERVAL '400 days'",
    );
    assert.equal((await measurement.pruneExpired()).audit, 1);
    await worker.start();
    try {
      for (const job of jobs) await job();
    } catch (error) {
      failures.push(error);
    }
    await worker.stop();
    assert.deepEqual(failures, []);
    assert.equal(jobs.length, 2);

    // A future migration explicitly chooses DML and RLS; safe defaults grant
    // nothing to browser roles and no surprise EXECUTE to runtime.
    await owner.query(
      "CREATE TABLE yaparena.future_probe(id bigserial PRIMARY KEY, value text)",
    );
    await owner.query(
      "CREATE FUNCTION yaparena.future_routine() RETURNS int LANGUAGE SQL AS 'SELECT 1'",
    );
    await denied(login, "SELECT * FROM yaparena.future_probe");
    await denied(login, "SELECT yaparena.future_routine()");
    await owner.query(
      "GRANT SELECT,INSERT ON yaparena.future_probe TO yaparena_runtime",
    );
    await owner.query(
      "GRANT USAGE ON SEQUENCE yaparena.future_probe_id_seq TO yaparena_runtime",
    );
    await owner.query(
      "ALTER TABLE yaparena.future_probe ENABLE ROW LEVEL SECURITY",
    );
    await owner.query(
      "CREATE POLICY backend_access ON yaparena.future_probe TO yaparena_runtime USING (true) WITH CHECK (true)",
    );
    assert.equal(
      (
        await login.query<{ id: string }>(
          "INSERT INTO yaparena.future_probe(value) VALUES ('synthetic') RETURNING id",
        )
      ).rowCount,
      1,
    );
    for (const role of ["anon", "authenticated"]) {
      const defaults = (
        await admin.query<{
          access: boolean;
          execute: boolean;
          sequence: boolean;
        }>(
          "SELECT has_table_privilege($1,'yaparena.future_probe','SELECT,INSERT,UPDATE,DELETE') AS access, has_function_privilege($1,'yaparena.future_routine()','EXECUTE') AS execute, has_sequence_privilege($1,'yaparena.future_probe_id_seq','USAGE,SELECT,UPDATE') AS sequence",
          [role],
        )
      ).rows[0];
      assert.deepEqual(defaults, {
        access: false,
        execute: false,
        sequence: false,
      });
      await admin.query(`SET ROLE ${role}`);
      await denied(admin, "SELECT * FROM yaparena.future_probe");
      await denied(admin, "SELECT yaparena.future_routine()");
      await admin.query("RESET ROLE");
    }
  } finally {
    await login.end();
    await pool.end();
  }
}

async function scenario(database: string, upgrade: boolean) {
  const admin = await connect(database);
  let owner;
  let retiredPlay: Awaited<ReturnType<typeof playBalances>> | undefined;
  try {
    const encoding = (
      await admin.query<{
        server: string;
        client: string;
        locale: string;
        collation: string;
      }>(
        `SELECT current_setting('server_encoding') AS server, current_setting('client_encoding') AS client,
          datctype AS locale, datcollate AS collation
          FROM pg_database WHERE datname=current_database()`,
      )
    ).rows[0]!;
    assert.equal(
      encoding.server,
      "UTF8",
      "Isolation database must use UTF8 server encoding",
    );
    assert.equal(
      encoding.client,
      "UTF8",
      "Isolation database must use UTF8 client encoding",
    );
    if (
      process.env.DATABASE_TEST_MODE === "host" &&
      process.env.LC_ALL === "C"
    ) {
      assert.equal(encoding.locale, "C");
      assert.equal(encoding.collation, "C");
    }
    console.log(
      JSON.stringify({
        trial: "isolation-database-encoding",
        database,
        ...encoding,
      }),
    );
    const legacyCount = (
      await readdir(new URL("../migrations", import.meta.url))
    ).filter(
      (name) =>
        /^\d+_.+\.js$/.test(name) &&
        BigInt(name.split("_")[0]!) < 1791158400000n,
    ).length;
    await assert.rejects(
      provisionDatabase(admin, {
        yaparena_owner: "same-synthetic-secret",
        yaparena_runtime: "same-synthetic-secret",
      }),
      /distinct/,
    );
    await admin.query("CREATE SCHEMA provider_fixture");
    await admin.query("CREATE TABLE provider_fixture.sentinel(id int)");
    await admin.query(
      "GRANT USAGE ON SCHEMA provider_fixture TO anon,authenticated",
    );
    await admin.query(
      "GRANT SELECT ON provider_fixture.sentinel TO anon,authenticated",
    );
    await admin.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA provider_fixture GRANT SELECT ON TABLES TO anon",
    );
    if (upgrade) {
      await migrate(admin, {
        schema: "public",
        migrationsSchema: "public",
        count: legacyCount,
      });
      await admin.query(
        "INSERT INTO users(email,password_hash) VALUES ('legacy@isolation.test','synthetic-legacy-hash')",
      );
      await admin.query(`INSERT INTO sessions(user_id,token_hash,expires_at)
        SELECT id,repeat('a',64),CURRENT_TIMESTAMP+INTERVAL '7 days' FROM users WHERE email='legacy@isolation.test'`);
      await admin.query(`INSERT INTO wallet_challenges(address,chain_id,purpose,message,expires_at)
        VALUES('0x' || repeat('a',40),1,'login','Synthetic legacy challenge',CURRENT_TIMESTAMP+INTERVAL '5 minutes')`);
      await admin.query(
        "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated,legacy_reader",
      );
      await admin.query(
        "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC",
      );
      await admin.query("GRANT SELECT(email) ON public.users TO anon");
      await admin.query(
        "CREATE VIEW public.external_leak AS SELECT email FROM public.users",
      );
      await admin.query("GRANT SELECT ON public.external_leak TO anon");
      await assert.rejects(
        provisionDatabase(admin, passwords),
        /External views/,
      );
      await admin.query("DROP VIEW public.external_leak");
      await admin.query(
        "CREATE FUNCTION public.external_routine_leak() RETURNS text LANGUAGE SQL BEGIN ATOMIC SELECT email::text FROM public.users LIMIT 1; END",
      );
      await assert.rejects(
        provisionDatabase(admin, passwords),
        /External routines/,
      );
      await admin.query("DROP FUNCTION public.external_routine_leak()");
    }
    await provisionDatabase(admin, passwords);
    await admin.query("GRANT yaparena_owner TO legacy_reader");
    await assert.rejects(
      provisionDatabase(admin),
      /unsafe administrative membership/,
    );
    await admin.query("REVOKE yaparena_owner FROM legacy_reader");
    owner = await connect(database, "yaparena_owner");
    // Seed dangerous creator defaults to prove hardening handles global and schema
    // additions, PUBLIC EXECUTE, direct/browser/inherited grants and column ACLs.
    await owner.query(
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO legacy_reader",
    );
    await owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA yaparena GRANT ALL ON TABLES TO anon,authenticated",
    );
    await owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA yaparena GRANT EXECUTE ON ROUTINES TO anon",
    );
    if (!upgrade) await migrate(owner, { count: legacyCount });
    await owner.query(
      "CREATE FUNCTION yaparena.isolation_definer_probe() RETURNS text LANGUAGE SQL SECURITY DEFINER SET search_path=yaparena,pg_catalog AS 'SELECT email::text FROM yaparena.users LIMIT 1'",
    );
    await owner.query(
      "CREATE VIEW yaparena.isolation_view_probe AS SELECT email FROM yaparena.users",
    );
    await owner.query(
      "CREATE MATERIALIZED VIEW yaparena.isolation_materialized_probe AS SELECT email FROM yaparena.users",
    );
    await owner.query(
      "CREATE POLICY unsafe_legacy_policy ON yaparena.account_roles TO PUBLIC USING (true) WITH CHECK (true)",
    );
    if (upgrade) {
      // Stop before the legacy sign-in removal. It must refuse while the
      // seeded password account remains and name it, as on staging before
      // the account reset.
      const beforeRemoval = (
        await readdir(new URL("../migrations", import.meta.url))
      ).filter(
        (name) =>
          /^\d+_.+\.js$/.test(name) &&
          BigInt(name.split("_")[0]!) < 1792426019000n,
      ).length;
      await migrate(owner, { count: beforeRemoval - legacyCount });
      const legacy = (
        await owner.query<{ id: string }>(
          "SELECT id FROM yaparena.users WHERE email='legacy@isolation.test'",
        )
      ).rows;
      assert.equal(legacy.length, 1);
      assert.equal(
        (
          await owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM sessions",
          )
        ).rows[0]!.n,
        0,
        "legacy session cookies must be retired on upgrade",
      );
      assert.equal(
        (
          await owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM wallet_challenges WHERE consumed_at IS NULL",
          )
        ).rows[0]!.n,
        0,
        "legacy unbound challenges must be retired on upgrade",
      );
      await assert.rejects(
        migrate(owner),
        (error: unknown) =>
          error instanceof Error &&
          /legacy sign-in credentials remain/.test(error.message) &&
          "detail" in error &&
          typeof error.detail === "string" &&
          error.detail.includes(`with a password: ${legacy[0]!.id};`),
      );
      // The runner leaves a supplied client inside the failed migration's
      // transaction; a deployment exits instead.
      await owner.query("ROLLBACK");
      // The staging reset deletes every such account before this release.
      await owner.query("DELETE FROM yaparena.users WHERE id=$1", [
        legacy[0]!.id,
      ]);
      // The Privy schema removal must refuse while a provider
      // freeze/unfreeze job is unfinished, naming the account, and delete
      // remaining Privy identities once it is resolved.
      await migrate(owner, { count: 1 });
      const privy = (
        await owner.query<{ id: string }>(
          "INSERT INTO yaparena.users DEFAULT VALUES RETURNING id",
        )
      ).rows[0]!.id;
      await owner.query(
        `INSERT INTO yaparena.provider_identities(provider,subject,user_id,methods,auth_generation,credentials_digest)
        VALUES('privy','did:privy:isolation',$1,'["email"]',0,repeat('a',64))`,
        [privy],
      );
      await owner.query(
        "UPDATE yaparena.users SET auth_generation=auth_generation+1 WHERE id=$1",
        [privy],
      );
      await assert.rejects(
        migrate(owner),
        (error: unknown) =>
          error instanceof Error &&
          /unfinished provider revocation jobs remain/.test(error.message) &&
          "detail" in error &&
          typeof error.detail === "string" &&
          error.detail.includes(`account ${privy}: pending/preflight`),
      );
      await owner.query("ROLLBACK");
      await owner.query(
        "UPDATE yaparena.provider_revocation_jobs SET state='complete',control_phase='done' WHERE user_id=$1",
        [privy],
      );
      // Stop before the YAP play freeze. It must refuse while play value is
      // committed or a human round is unfinished, and name both.
      const applied = (
        await owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM yaparena_migrations.pgmigrations",
        )
      ).rows[0]!.n;
      await migrate(owner, {
        count: (await migrationsBefore(freezeMigration)) - applied,
      });
      const play = await seedRetiredPlay(owner);
      await assert.rejects(
        migrate(owner),
        (error: unknown) =>
          error instanceof Error &&
          /YAP play is still in progress/.test(error.message) &&
          "detail" in error &&
          typeof error.detail === "string" &&
          error.detail.includes(
            `value is still committed: account ${play.held}`,
          ) &&
          error.detail.includes(`round ${play.round}`),
      );
      await owner.query("ROLLBACK");
      // The worker of this release voids the unopened human round instead of
      // opening it, even with A4 disabled as on staging.
      await play.release();
      const worker = createDatabase(url(database, "yaparena_runtime"), logger);
      try {
        await createA4Repository(worker, "disabled").tick();
      } finally {
        await worker.end();
      }
      assert.equal(
        (
          await owner.query<{ state: string }>(
            "SELECT state FROM yaparena.a4_rounds WHERE id=$1",
            [play.round],
          )
        ).rows[0]!.state,
        "void",
      );
      retiredPlay = await playBalances(owner);
    }
    await migrate(owner);
    if (retiredPlay) {
      // Balances match before and after the freeze, and are recorded.
      assert.deepEqual(await playBalances(owner), retiredPlay);
      assert.deepEqual(
        (
          await owner.query<{ id: string; kind: string; amount: string }>(
            "SELECT account_id AS id,kind,amount::text AS amount FROM yaparena.a4_play_closing_balances ORDER BY account_id",
          )
        ).rows,
        retiredPlay,
      );
      await assert.rejects(
        owner.query(
          "UPDATE yaparena.a4_accounts SET amount=amount+1 WHERE scope='global'",
        ),
        /YAP play is retired/,
      );
      console.log(
        JSON.stringify({
          trial: "retired-yap-play-freeze",
          database,
          closedAccounts: retiredPlay.length,
        }),
      );
    }
    assert.deepEqual(
      (
        await owner.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='yaparena' AND c.relname IN ('wallet_identities','wallet_challenges','wallet_operations','provider_identity_recoveries',
            'provider_revocation_jobs','provider_passkey_bootstraps','provider_passkey_intents','provider_session_exchanges',
            'account_security_keys','account_security_users','account_security_challenges','account_access_challenges',
            'embedded_wallet_provisioning')
          UNION ALL SELECT table_name || '.' || column_name FROM information_schema.columns
          WHERE table_schema='yaparena' AND (
            (table_name='users' AND column_name IN ('password_hash','auth_changed_at'))
            OR (table_name='provider_identities' AND column_name IN ('auth_generation','minimum_issued_at','credentials_digest','credentials_snapshot','checked_at'))
            OR (table_name='account_operations' AND column_name='authorizing_passkey_id'))
          UNION ALL SELECT provider FROM yaparena.provider_identities WHERE provider<>'auth0'`,
        )
      ).rows,
      [],
      "legacy sign-in, Privy, passkey and wallet tables and columns are removed",
    );
    await membershipChecks(database, admin, owner);
    const inventory = Object.fromEntries(
      (
        await admin.query<{ section: string; evidence: unknown }>(inventorySql)
      ).rows.map(({ section, evidence }) => [section, evidence]),
    ) as {
      relations: { schema: string; kind: string }[];
      policies: { schema: string; roles: string[] }[];
      effectiveRelations: {
        identity: string;
        schema: string;
        privileges: Record<string, boolean>;
      }[];
      effectiveSchemas: { identity: string; schema: string; create: boolean }[];
      defaultPrivileges: { creator: string; schema: string }[];
    };
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      `${evidenceDirectory}/${upgrade ? "upgrade" : "fresh"}-inventory.json`,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    assert.equal(
      inventory.relations.filter(
        (r) => r.schema === "yaparena" && r.kind === "r",
      ).length,
      applicationTables.length,
    );
    assert.ok(
      inventory.policies
        .filter((p) => p.schema === "yaparena")
        .every((p) => p.roles.includes("yaparena_runtime")),
    );
    assert.equal(
      inventory.effectiveRelations
        .filter(
          (r) =>
            ["anon", "authenticated"].includes(r.identity) &&
            ["yaparena", "yaparena_migrations"].includes(r.schema),
        )
        .some((r) => Object.values(r.privileges).some(Boolean)),
      false,
    );
    assert.equal(
      inventory.effectiveSchemas.some(
        (s) =>
          s.identity === "yaparena_runtime" &&
          s.schema.startsWith("yaparena") &&
          s.create,
      ),
      false,
    );
    assert.equal(
      (
        await admin.query<{ safe: boolean }>(
          "SELECT has_table_privilege('anon','provider_fixture.sentinel','SELECT') AS safe",
        )
      ).rows[0]!.safe,
      true,
    );
    assert.ok(
      inventory.defaultPrivileges.some(
        (d) => d.creator === "postgres" && d.schema === "provider_fixture",
      ),
    );
    await browserChecks(admin);
    await runtimeChecks(database, owner, admin);
    if (process.env.ACCOUNT_SECURITY_VERIFY === "true") {
      const result = await exec(
        process.execPath,
        [
          "--test",
          "tests/account-operation-auth.test.js",
          "tests/auth0-sign-in-postgres.test.js",
          "tests/account-session-management.test.js",
          "tests/coin-ledger-postgres.test.js",
          "tests/coin-external-operations.test.js",
          "tests/coin-sandbox-postgres.test.js",
          "tests/coin-debate-postgres.test.js",
          "tests/coin-reports-postgres.test.js",
          "tests/media-account-revocation-postgres.test.js",
        ],
        {
          env: {
            ...process.env,
            A4_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
            A4_TEST_OWNER_URL: url(database, "yaparena_owner"),
            WALLET_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
            WALLET_TEST_OWNER_DATABASE_URL: url(database, "yaparena_owner"),
            REVOCATION_TEST_DATABASE_URL: url(database, "yaparena_owner"),
            REVOCATION_TEST_RUNTIME_URL: url(database, "yaparena_runtime"),
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      ).catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          console.log(error.stdout);
          console.log(error.stderr);
          throw new Error(
            "Focused account security/ledger PostgreSQL checks failed",
          );
        },
      );
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        `${evidenceDirectory}/${upgrade ? "upgrade" : "fresh"}-account-security.log`,
        result.stdout,
      );
      console.log(result.stdout);
    }
    if (process.env.A4_VERIFY === "true") {
      const result = await exec(
        process.execPath,
        ["--test", "tests/a4-postgres.test.js"],
        {
          env: {
            ...process.env,
            A4_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
            A4_TEST_OWNER_URL: url(database, "yaparena_owner"),
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      ).catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          console.log(error.stdout);
          throw new Error("A4 runtime PostgreSQL tests failed");
        },
      );
      console.log(result.stdout);
    }
    if (process.env.A4_QUALITY === "true" && !upgrade) {
      const result = await exec("npm", ["run", "check"], {
        env: {
          ...process.env,
          A4_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
          A4_TEST_OWNER_URL: url(database, "yaparena_owner"),
          WALLET_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
          WALLET_TEST_OWNER_DATABASE_URL: url(database, "yaparena_owner"),
          REVOCATION_TEST_DATABASE_URL: url(database, "yaparena_owner"),
          REVOCATION_TEST_RUNTIME_URL: url(database, "yaparena_runtime"),
          COIN_TREASURY_TEST_DATABASE_URL: url(
            "revocation_test_coin_treasury_fresh",
            "yaparena_runtime",
          ),
          COIN_TREASURY_TEST_OWNER_DATABASE_URL: url(
            "revocation_test_coin_treasury_fresh",
            "yaparena_owner",
          ),
        },
        maxBuffer: 8 * 1024 * 1024,
      }).catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          console.log(error.stdout);
          console.error(error.stderr);
          throw new Error("Full runtime-backed quality gate failed");
        },
      );
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(`${evidenceDirectory}/quality.log`, result.stdout);
      console.log(
        result.stdout
          .split("\n")
          .filter((line) =>
            /^ℹ (tests |pass |fail |skipped |all files)/.test(line),
          )
          .join("\n"),
      );
      console.log(
        "Full quality gate with A4, wallet and revocation PostgreSQL identities PASS.",
      );
    }
    if (process.env.A4_BROWSER === "true" && !upgrade) {
      const verification = exec(
        process.execPath,
        ["scripts/verify-a4-browser.ts"],
        {
          env: {
            ...process.env,
            A4_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
            A4_TEST_OWNER_URL: url(database, "yaparena_owner"),
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      verification.child.stdout!.on("data", (data) =>
        process.stdout.write(data),
      );
      await verification.catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          console.log(error.stderr);
          throw new Error("A4 browser verification failed");
        },
      );
    }
    // Decision 0011: two browsers through the live queue and a "now" challenge.
    if (process.env.MATCHMAKING_BROWSER === "true" && !upgrade) {
      const verification = exec(
        process.execPath,
        ["scripts/verify-matchmaking-browser.ts"],
        {
          env: {
            ...process.env,
            A4_TEST_DATABASE_URL: url(database, "yaparena_runtime"),
            A4_TEST_OWNER_URL: url(database, "yaparena_owner"),
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      verification.child.stdout!.on("data", (data) =>
        process.stdout.write(data),
      );
      await verification.catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          console.log(error.stderr);
          throw new Error("Matchmaking browser verification failed");
        },
      );
    }
    await provisionDatabase(admin);
    await migrate(owner); // repeated operator steps preserve isolation and migration history
    console.log(
      `${upgrade ? "Upgrade" : "Fresh installation"}: inventory, browser denial, runtime login, backend journeys, worker, triggers and future defaults PASS.`,
    );
  } finally {
    if (owner) await owner.end();
    await admin.end();
  }
}

try {
  if (process.env.DATABASE_TEST_MODE === "host") {
    const version = (await exec("pg_config", ["--version"])).stdout;
    if (!/^PostgreSQL (17|18)\./.test(version))
      throw new Error("Host harness requires PostgreSQL 17/18");
    hostDirectory = await mkdtemp("/tmp/yaparena-isolation-pg-");
    const passwordFile = `${hostDirectory}/password`;
    await writeFile(passwordFile, bootstrapPassword, { mode: 0o600 });
    await exec("initdb", [
      "--encoding=UTF8",
      "--pgdata",
      `${hostDirectory}/data`,
      "--username",
      "fixture_admin",
      "--auth",
      "scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
    await rm(passwordFile);
    const reserved = createServer();
    reserved.listen(0, "127.0.0.1");
    await once(reserved, "listening");
    port = String((reserved.address() as AddressInfo).port);
    await new Promise((resolve) => reserved.close(resolve));
    await exec("pg_ctl", [
      "--pgdata",
      `${hostDirectory}/data`,
      "--log",
      `${hostDirectory}/postgres.log`,
      "--options",
      `-p ${port} -h 127.0.0.1 -k ${hostDirectory}`,
      "--wait",
      "start",
    ]);
    started = true;
    console.log(version.trim());
  } else {
    await exec("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      "POSTGRES_USER=fixture_admin",
      "--env",
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);
    started = true;
    const mapping = await exec("docker", ["port", container, "5432/tcp"]);
    port = mapping.stdout.trim().split(":").at(-1);
  }
  let admin;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      admin = await connect("postgres", "fixture_admin");
      break;
    } catch {
      await delay(500);
    }
  }
  assert.ok(admin, "disposable PostgreSQL must become ready");
  try {
    const role = await admin.query<{ sql: string }>(
      "SELECT format('CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS NOREPLICATION PASSWORD %L', $1::text) AS sql",
      [adminPassword],
    );
    await admin.query(role.rows[0]!.sql);
    await admin.query(
      "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE legacy_reader NOLOGIN; CREATE ROLE outside_reader NOLOGIN; CREATE ROLE outside_admin NOLOGIN CREATEROLE; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator LOGIN NOINHERIT; CREATE ROLE mediator_proxy NOLOGIN; GRANT legacy_reader TO anon,authenticated",
    );
    await admin.query(
      "GRANT anon,authenticated TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE",
    );
    await admin.query(
      "GRANT anon,authenticated,service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    for (const database of [
      "revocation_test_a4_fresh",
      "revocation_test_a4_upgrade",
      "revocation_test_coin_treasury_fresh",
      "revocation_test_coin_treasury_upgrade",
    ])
      await admin.query(`CREATE DATABASE ${database} OWNER postgres`);
  } finally {
    await admin.end();
  }
  if (
    process.env.ACCOUNT_SECURITY_VERIFY === "true" ||
    process.env.A4_QUALITY === "true"
  ) {
    await treasuryScenario("revocation_test_coin_treasury_fresh", false);
    await treasuryScenario("revocation_test_coin_treasury_upgrade", true);
  }
  await scenario("revocation_test_a4_fresh", false);
  await scenario("revocation_test_a4_upgrade", true);
  console.log(
    "Local SQL isolation verified. This verifier does not inspect hosted Data API/GraphQL/Realtime configuration.",
  );
  console.log(`Sanitized catalog snapshots: ${evidenceDirectory}`);
} catch (error) {
  // Child-process errors may contain arguments; never print generated credentials.
  const message = (error as { cmd?: string }).cmd
    ? `local ${process.env.DATABASE_TEST_MODE === "host" ? "PostgreSQL" : "Docker"} command failed; check local process permissions and prerequisites`
    : (error as Error).message;
  console.error(
    `Database isolation verification failed (${(error as { code?: string }).code ?? "assertion"}): ${message}`,
  );
  const postgresLog =
    hostDirectory && (error as { cmd?: string }).cmd
      ? await readFile(`${hostDirectory}/postgres.log`, "utf8").catch(() => "")
      : "";
  if ((error as { stderr?: string }).stderr || postgresLog) {
    let diagnostic = `${(error as { stderr?: string }).stderr ?? ""}\n${postgresLog}`;
    for (const value of [
      adminPassword,
      bootstrapPassword,
      ...Object.values(passwords),
    ])
      diagnostic = diagnostic.replaceAll(value, "[redacted]");
    diagnostic = diagnostic.replace(
      /postgres(?:ql)?:\/\/[^\s'"<>]+/g,
      "[redacted database URL]",
    );
    console.error(diagnostic.slice(-4000));
  }
  process.exitCode = 1;
} finally {
  if (started) {
    if (hostDirectory)
      await exec("pg_ctl", [
        "--pgdata",
        `${hostDirectory}/data`,
        "--mode",
        "fast",
        "--wait",
        "stop",
      ]);
    else await exec("docker", ["stop", container]);
  }
  if (hostDirectory) await rm(hostDirectory, { recursive: true, force: true });
}
