import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { runner, type RunnerOption } from "node-pg-migrate";
import pg from "pg";
import { chromium } from "playwright-core";
import { verifyCommunityLoad } from "./verify-community-load.ts";
import { verifyCommunityDelivery } from "./verify-community-delivery.ts";
import { verifyChatClient } from "./verify-chat-client.ts";
import { verifyMediaOperations } from "./verify-media-operations.ts";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import { provisionDatabase } from "./provision-database.ts";

// Disposable, volume-free local cluster; never loads .env or accepts a hosted URL.
const exec = promisify(execFile);
const setupOnly = process.argv.includes("--setup-only");
const container = `yaparena-chat-${randomUUID().slice(0, 8)}`;
const passwords = Object.fromEntries(
  ["postgres", "yaparena_owner", "yaparena_runtime", "yaparena_encoder"].map(
    (role) => [role, randomBytes(24).toString("hex")],
  ),
);
const quiet = { info() {}, warn() {}, error() {} };
let started = false;
let hostDirectory: string | undefined;
let app: ChildProcess | undefined;
let secondary: ChildProcess | undefined;
let admin: pg.Client | undefined;
let owner!: pg.Client;
let port: string | undefined;
const url = (role: string) =>
  `postgresql://${role}:${passwords[role]}@127.0.0.1:${port}/postgres`;
const connect = async (role: string) => {
  const client = new pg.Client({
    connectionString: url(role),
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
  });
  await client.connect();
  return client;
};
const migrate = (options: Partial<RunnerOption> = {}) =>
  runner({
    dbClient: owner,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
    ...options,
  });

try {
  assert.match(process.version, /^v24\./, "Use Node.js 24 for this trial");
  if (setupOnly)
    assert.equal(
      process.env.COMMUNITY_POSTGRES_MODE,
      "host",
      "--setup-only requires COMMUNITY_POSTGRES_MODE=host to exercise native initdb",
    );
  if (process.env.COMMUNITY_POSTGRES_MODE === "host") {
    const version = (await exec("initdb", ["--version"])).stdout;
    assert.match(version, /PostgreSQL\) (17|18)\./);
    hostDirectory = await mkdtemp("/tmp/yaparena-chat-pg-");
    const passwordFile = `${hostDirectory}/password`;
    await writeFile(passwordFile, passwords.postgres!, { mode: 0o600 });
    await exec("initdb", [
      "--encoding=UTF8",
      "--pgdata",
      `${hostDirectory}/data`,
      "--username",
      "postgres",
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
    await exec(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_PASSWORD",
        "postgres:18.4-bookworm",
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: passwords.postgres } },
    );
    started = true;
    port = (await exec("docker", ["port", container, "5432/tcp"])).stdout
      .trim()
      .split(":")
      .at(-1);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      admin = await connect("postgres");
      break;
    } catch {
      await delay(250);
    }
  }
  if (!admin) throw new Error("Local PostgreSQL did not become ready");
  await provisionDatabase(admin, passwords);
  owner = await connect("yaparena_owner");
  const migrations = (await readdir("migrations")).filter((name) =>
    name.endsWith(".js"),
  );
  await migrate({ count: migrations.length - 1 });
  // Verify an actual older-server row survives the new migration unchanged.
  const legacyUser = (
    await owner.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    )
  ).rows[0]!.id;
  const legacyTopic = (
    await owner.query<{ id: string }>(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES ('chat-upgrade-topic','Upgrade','Synthetic','For','Against','published') RETURNING id",
    )
  ).rows[0]!.id;
  const legacyEvent = (
    await owner.query<{ id: string }>(
      "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT 'chat-upgrade-event',$1,'Synthetic upgrade','live','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
      [legacyTopic],
    )
  ).rows[0]!.id;
  const legacyMessage = (
    await owner.query<{ id: string }>(
      "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES ($1,$2,'Legacy synthetic text') RETURNING id",
      [legacyEvent, legacyUser],
    )
  ).rows[0]!.id;
  const legacyKey = randomUUID();
  const legacyKeyed = (
    await owner.query<{ id: string }>(
      "INSERT INTO event_chat_messages(debate_id,author_user_id,body,client_message_id,created_at) VALUES ($1,$2,'Existing keyed acceptance',$3,clock_timestamp()-INTERVAL '20 seconds') RETURNING id",
      [legacyEvent, legacyUser, legacyKey],
    )
  ).rows[0]!.id;
  await migrate();
  // Match plain-PostgreSQL authentication CI: migrations must also work without
  // provider roles. Roles added afterward still receive no private privileges.
  await admin.query<never>(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN",
  );
  const binding = (
    await owner.query<{ message_id: string; matches: boolean }>(
      "SELECT message_id::text,body_hash=sha256(convert_to('Existing keyed acceptance','UTF8')) AS matches FROM community_submission_receipts WHERE author_user_id=$1 AND debate_id=$2 AND client_message_id=$3",
      [legacyUser, legacyEvent, legacyKey],
    )
  ).rows[0]!;
  assert.deepEqual(binding, { message_id: legacyKeyed, matches: true });
  const upgraded = (
    await owner.query<{
      client_message_id: string | null;
      revision: string;
      body: string | null;
    }>(
      "SELECT client_message_id, revision::text, body FROM event_chat_messages WHERE id=$1",
      [legacyMessage],
    )
  ).rows[0]!;
  assert.deepEqual(upgraded, {
    client_message_id: null,
    revision: "0",
    body: "Legacy synthetic text",
  });
  const grants = await admin.query<{
    anon: boolean;
    authenticated: boolean;
    runtime: boolean;
  }>(
    "SELECT has_function_privilege('anon','yaparena.advance_chat_revision()','EXECUTE') AS anon, has_function_privilege('authenticated','yaparena.advance_chat_revision()','EXECUTE') AS authenticated, has_function_privilege('yaparena_runtime','yaparena.advance_chat_revision()','EXECUTE') AS runtime",
  );
  assert.deepEqual(grants.rows[0]!, {
    anon: false,
    authenticated: false,
    runtime: false,
  });
  console.log(
    "Chat migration: existing-row compatibility and private trigger privileges PASS",
  );

  // Use the migrated database and its real chat column before any browser/load work.
  // Roll back the probe so the existing workload and retention fixtures stay intact.
  const unicode = "界".repeat(500);
  const probe = await connect("yaparena_runtime");
  try {
    await probe.query("BEGIN");
    const observed = (
      await probe.query<{
        serverEncoding: string;
        clientEncoding: string;
        locale: string;
        collation: string;
        version: string;
        characters: number;
        bytes: number;
      }>(
        `SELECT current_setting('server_encoding') AS "serverEncoding",
          current_setting('client_encoding') AS "clientEncoding",
          datctype AS locale,
          datcollate AS collation,
          current_setting('server_version') AS version,
          char_length($1::text) AS characters, octet_length($1::text) AS bytes
          FROM pg_database WHERE datname=current_database()`,
        [unicode],
      )
    ).rows[0]!;
    assert.equal(
      observed.serverEncoding,
      "UTF8",
      "Community Unicode prerequisite: server_encoding must be UTF8; initialize the disposable native cluster with --encoding=UTF8",
    );
    assert.equal(
      observed.clientEncoding,
      "UTF8",
      "Community Unicode prerequisite: client_encoding must be UTF8",
    );
    if (
      process.env.COMMUNITY_POSTGRES_MODE === "host" &&
      process.env.LC_ALL === "C"
    ) {
      assert.equal(observed.locale, "C", "native LC_CTYPE must remain C");
      assert.equal(observed.collation, "C", "native LC_COLLATE must remain C");
    }
    assert.equal(
      observed.characters,
      500,
      "Unicode fixture must have 500 characters",
    );
    assert.equal(
      observed.bytes,
      1500,
      "Unicode fixture must have 1500 UTF-8 bytes",
    );
    const column = await probe.query<{ maximum: number }>(
      `SELECT character_maximum_length AS maximum FROM information_schema.columns
       WHERE table_schema='yaparena' AND table_name='event_chat_messages' AND column_name='body'`,
    );
    assert.equal(
      column.rows[0]?.maximum,
      500,
      "chat body must retain its 500-character limit",
    );
    const inserted = await probe.query<{ id: string }>(
      "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES($1,$2,$3) RETURNING id",
      [legacyEvent, legacyUser, unicode],
    );
    const readback = await probe.query<{
      body: string;
      characters: number;
      bytes: number;
    }>(
      "SELECT body, char_length(body) AS characters, octet_length(body) AS bytes FROM event_chat_messages WHERE id=$1",
      [inserted.rows[0]!.id],
    );
    assert.deepEqual(readback.rows, [
      { body: unicode, characters: 500, bytes: 1500 },
    ]);
    console.log(
      JSON.stringify({
        trial: "community-unicode-setup",
        result: "PASS",
        mode:
          process.env.COMMUNITY_POSTGRES_MODE === "host" ? "native" : "docker",
        ...observed,
        columnLimit: 500,
        exactReadback: true,
      }),
    );
  } finally {
    try {
      await probe.query("ROLLBACK");
    } finally {
      await probe.end();
    }
  }

  if (setupOnly) {
    console.log(
      "Disposable native community Unicode setup PASS (no browser or load workload requested)",
    );
  } else {
    await exec(process.execPath, ["scripts/verify-community.ts"], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: url("yaparena_owner"),
        COMMUNITY_RUNTIME_URL: url("yaparena_runtime"),
      },
    }).then((result) => process.stdout.write(result.stdout));

    const runtimePool = new pg.Pool({
      connectionString: url("yaparena_runtime"),
      options: "-c search_path=pg_catalog,yaparena,pg_temp",
    });
    try {
      if (process.env.COMMUNITY_DURABLE_TRIAL === "1")
        await verifyCommunityDelivery({
          pool: runtimePool,
          owner,
          admin,
          url: url("yaparena_runtime"),
        });
      if (process.env.COMMUNITY_DURABLE_TRIAL === "1")
        await verifyMediaOperations({
          pool: runtimePool,
          owner,
          admin,
          url: url("yaparena_runtime"),
        });
      const repository = createCommunityRepository(runtimePool);
      await owner.query<never>(
        "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,'chat-upgrade-author','Synthetic upgrade author','published')",
        [legacyUser],
      );
      await owner.query<never>(
        "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '20 seconds' WHERE id=$1",
        [legacyMessage],
      );
      const expiryKey = randomUUID();
      const accepted = await repository.postChat(
        legacyEvent,
        legacyUser,
        "Synthetic retained acceptance",
        expiryKey,
      );
      await assert.rejects(
        runtimePool.query<never>(
          "UPDATE event_chat_messages SET client_message_id=$2 WHERE id=$1",
          [accepted.id, randomUUID()],
        ),
        (error: { code?: string }) => error.code === "23514",
      );
      await owner.query<never>(
        "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '366 days' WHERE id=$1",
        [accepted.id],
      );
      const pruned = await repository.pruneExpired();
      assert.equal(pruned.chat, 1);
      const afterExpiry = await repository.postChat(
        legacyEvent,
        legacyUser,
        "Synthetic retained acceptance",
        expiryKey,
      );
      assert.equal(afterExpiry.id, accepted.id);
      assert.equal(afterExpiry.state, "removed");
      assert.equal(afterExpiry.body, null);
      assert.ok(BigInt(afterExpiry.revision) > BigInt(accepted.revision));
      assert.ok(
        BigInt(afterExpiry.streamRevision!) > BigInt(accepted.streamRevision!),
      );
      assert.deepEqual(
        await repository.reconcileSubmissions(legacyEvent, legacyUser, [
          expiryKey,
        ]),
        [afterExpiry],
      );
      const cursor = (
        await owner.query<{ cursor: string }>(
          "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
          [legacyEvent],
        )
      ).rows[0]!.cursor;
      const retries = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.postChat(
            legacyEvent,
            legacyUser,
            "Synthetic retained acceptance",
            expiryKey,
            false,
          ),
        ),
      );
      assert.ok(
        retries.every((item) => item.id === accepted.id && item.body === null),
      );
      await assert.rejects(
        repository.postChat(
          legacyEvent,
          legacyUser,
          "Conflicting after purge",
          expiryKey,
        ),
        (error: { code?: string }) => error.code === "CHAT_PAYLOAD_CONFLICT",
      );
      await assert.rejects(
        runtimePool.query<never>(
          "INSERT INTO event_chat_messages(debate_id,author_user_id,body,client_message_id) VALUES ($1,$2,'Bypass retry',$3)",
          [legacyEvent, legacyUser, expiryKey],
        ),
        (error: { code?: string }) => error.code === "23505",
      );
      assert.equal(
        (
          await owner.query<{ cursor: string }>(
            "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
            [legacyEvent],
          )
        ).rows[0]!.cursor,
        cursor,
        "failed duplicate rolls back log and counter",
      );
      assert.equal(
        (
          await owner.query<{ n: string }>(
            "SELECT COUNT(*)::text AS n FROM event_chat_messages WHERE id=$1",
            [accepted.id],
          )
        ).rows[0]!.n,
        "0",
      );
      const rolledBackKey = randomUUID();
      const writer = await runtimePool.connect();
      try {
        await writer.query<never>("BEGIN");
        await writer.query<never>(
          "INSERT INTO event_chat_messages(debate_id,author_user_id,body,client_message_id) VALUES ($1,$2,'Rolled back binding',$3)",
          [legacyEvent, legacyUser, rolledBackKey],
        );
        await writer.query<never>("ROLLBACK");
      } finally {
        writer.release();
      }
      assert.equal(
        (
          await owner.query<{ n: string }>(
            "SELECT COUNT(*)::text AS n FROM community_submission_receipts WHERE client_message_id=$1",
            [rolledBackKey],
          )
        ).rows[0]!.n,
        "0",
      );
      console.log(
        "Chat idempotency retention: backfill, canonical purged acknowledgment, concurrent retries, conflicting reuse, database enforcement and rollback PASS",
      );
    } finally {
      await runtimePool.end();
    }

    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const httpPort = (reservation.address() as AddressInfo).port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${httpPort}`;
    async function startServer() {
      app = spawn(process.execPath, ["scripts/test-identity-entry.ts"], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "development",
          NODE_OPTIONS: "--max-semi-space-size=4",
          COMMUNITY_STREAM_ENABLED:
            process.env.COMMUNITY_DURABLE_TRIAL === "1" ? "true" : "false",
          HOST: "127.0.0.1",
          PORT: String(httpPort),
          APP_ORIGIN: base,
          LOG_LEVEL: "silent",
          API_RATE_LIMIT:
            process.env.COMMUNITY_DURABLE_TRIAL === "1" ? "10000" : "300",
          DATABASE_URL: url("yaparena_runtime"),
        },
        stdio: "ignore",
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(`${base}/ready`)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* Startup is still in progress. */
        }
        await delay(100);
      }
      if (!ready) throw new Error("Runtime application failed readiness");
    }
    async function stopServer() {
      if (app && app.exitCode === null) {
        const exited = once(app, "exit");
        app.kill("SIGTERM");
        const deadline = setTimeout(() => app!.kill("SIGKILL"), 8000);
        try {
          await exited;
        } finally {
          clearTimeout(deadline);
        }
        assert.equal(
          app.exitCode,
          0,
          "graceful stream drain must finish without forced kill",
        );
      }
    }
    await startServer();
    if (process.env.COMMUNITY_CLIENT_ONLY === "1") {
      const artifactDir =
        process.env.BROWSER_ARTIFACT_DIR ?? `/tmp/${container}-evidence`;
      await mkdir(artifactDir, { recursive: true });
      const browser = await chromium.launch({
        executablePath:
          process.env.BROWSER_CHROME_PATH ??
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      try {
        await verifyChatClient({
          browser,
          base,
          eventSlug: "chat-upgrade-event",
          eventId: legacyEvent,
          artifactDir,
        });
      } finally {
        await browser.close();
      }
    } else {
      await exec(process.execPath, ["scripts/verify-community-browser.ts"], {
        env: {
          PATH: process.env.PATH,
          COMMUNITY_DURABLE_TRIAL: process.env.COMMUNITY_DURABLE_TRIAL ?? "0",
          DATABASE_URL: url("yaparena_owner"),
          BROWSER_BASE_URL: base,
          BROWSER_ARTIFACT_DIR:
            process.env.BROWSER_ARTIFACT_DIR ?? `/tmp/${container}-evidence`,
          ...(process.env.BROWSER_CHROME_PATH
            ? { BROWSER_CHROME_PATH: process.env.BROWSER_CHROME_PATH }
            : {}),
        },
        maxBuffer: 1024 * 1024,
      }).then((result) => process.stdout.write(result.stdout));
    }
    if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
      const secondReservation = createServer();
      secondReservation.listen(0, "127.0.0.1");
      await once(secondReservation, "listening");
      const secondPort = (secondReservation.address() as AddressInfo).port;
      await new Promise((resolve) => secondReservation.close(resolve));
      const secondBase = `http://127.0.0.1:${secondPort}`;
      secondary = spawn(process.execPath, ["scripts/test-identity-entry.ts"], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "development",
          NODE_OPTIONS: "--max-semi-space-size=4",
          HOST: "127.0.0.1",
          PORT: String(secondPort),
          APP_ORIGIN: secondBase,
          LOG_LEVEL: "silent",
          RUN_BACKGROUND_JOBS: "false",
          COMMUNITY_STREAM_ENABLED: "true",
          DATABASE_URL: url("yaparena_runtime"),
        },
        stdio: "ignore",
      });
      let secondReady = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(`${secondBase}/ready`)).ok) {
            secondReady = true;
            break;
          }
        } catch {
          /* Still starting. */
        }
        await delay(100);
      }
      assert.ok(secondReady, "second runtime process must become ready");
      await verifyCommunityLoad({
        owner,
        base,
        secondBase,
        restart: async (during) => {
          await stopServer();
          await during();
          await startServer();
        },
      });
    }
    console.log("Disposable community PostgreSQL/runtime/browser trial PASS");
  }
} finally {
  if (secondary && secondary.exitCode === null) {
    const exited = once(secondary, "exit");
    secondary.kill("SIGTERM");
    await exited;
  }
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
  if (owner) await owner.end();
  if (admin) await admin.end();
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
    else await exec("docker", ["rm", "--force", container]);
  }
  if (hostDirectory) await rm(hostDirectory, { recursive: true, force: true });
}
