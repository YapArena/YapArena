import assert from "node:assert/strict";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runner } from "node-pg-migrate";
import pg from "pg";
import {
  createReplayJobs,
  type ReplayDatabaseClient,
} from "../dist/features/media/replay-jobs.js";
import {
  buildReplayPackage,
  run,
  verifyReplayTools,
  type ProcessOptions,
} from "../dist/features/media/replay-packaging.js";
import { createReplayWorker } from "../dist/features/media/replay-worker.js";
import {
  createReplayThumbnailTask,
  replayThumbnailKey,
} from "../dist/features/media/replay-thumbnail.js";
import {
  verifyEncoderIdentity,
  verifyRuntimeIdentity,
} from "../dist/platform/database.js";
import { replayStorageFixture } from "../tests/helpers/replay-storage.ts";
import { provisionDatabase } from "./provision-database.ts";

// No .env, hosted URLs, provider access or bucket writes. Every role and object
// belongs to this disposable local cluster/synthetic in-memory storage adapter.
const exec = promisify(execFile);
const quiet = { info() {}, warn() {}, error() {} };
const directory = await mkdtemp("/tmp/yaparena-replay-trial-");
const container = `yaparena-replay-${randomUUID().slice(0, 8)}`;
const hostMode = process.env.REPLAY_POSTGRES_MODE === "host";
const passwords = Object.fromEntries(
  ["postgres", "yaparena_owner", "yaparena_runtime", "yaparena_encoder"].map(
    (role) => [role, randomBytes(24).toString("hex")],
  ),
);
let started = false;
// pool is the encoder's own login; runtime stands in for web and the jobs
// worker changing the same events while the encoder works.
let admin: pg.Client | undefined,
  owner: pg.Client | undefined,
  pool: pg.Pool | undefined,
  runtime: pg.Pool | undefined;
let peakEncoderRssKiB = 0;
let samples: Promise<void>[] = [];
const spawned = (command: string, args: string[], options: SpawnOptions) => {
  const child = spawn(command, args, options);
  if (child.pid) {
    const sample = () => {
      const pending = exec("ps", ["-o", "rss=", "-p", String(child.pid)])
        .then(({ stdout }) => {
          peakEncoderRssKiB = Math.max(
            peakEncoderRssKiB,
            Number(stdout.trim()) || 0,
          );
        })
        .catch(() => {});
      samples.push(pending);
    };
    const interval = setInterval(sample, 30);
    sample();
    child.once("close", () => clearInterval(interval));
  }
  return child;
};
const measuredRun = (
  command: string,
  args: string[],
  options?: ProcessOptions,
) => run(command, args, { ...options, spawnProcess: spawned });
try {
  assert.match(process.version, /^v24\./);
  await verifyReplayTools();
  let postgresVersion, port;
  if (hostMode) {
    postgresVersion = (await exec("initdb", ["--version"])).stdout.trim();
    assert.match(postgresVersion, /PostgreSQL\) (17|18)\./);
    const passwordFile = resolve(directory, "password");
    await writeFile(passwordFile, passwords.postgres!, { mode: 0o600 });
    await exec("initdb", [
      "--encoding=UTF8",
      "--pgdata",
      resolve(directory, "data"),
      "--username",
      "postgres",
      "--auth",
      "scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
    await rm(passwordFile);
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    port = (reserve.address() as AddressInfo).port;
    await new Promise((resolve) => reserve.close(resolve));
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--log",
      resolve(directory, "postgres.log"),
      "--options",
      `-p ${port} -h 127.0.0.1 -k ${directory}`,
      "--wait",
      "start",
    ]);
    started = true;
  } else {
    started = true;
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
    port = Number(
      (await exec("docker", ["port", container, "5432/tcp"])).stdout
        .trim()
        .split(":")
        .at(-1),
    );
  }
  const config = (role: string) => ({
    host: "127.0.0.1",
    port,
    database: "postgres",
    user: role,
    password: passwords[role],
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
    query_timeout: 3000,
    connectionTimeoutMillis: 2000,
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate = new pg.Client(config("postgres"));
    try {
      await candidate.connect();
      admin = candidate;
      break;
    } catch {
      await candidate.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!admin) throw new Error("Disposable PostgreSQL did not become ready");
  const serverVersion = (
    await admin.query<{ server_version: string }>("SHOW server_version")
  ).rows[0]!.server_version;
  assert.match(serverVersion, /^(17|18)\./);
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
    "Replay database must use UTF8 server encoding",
  );
  assert.equal(
    encoding.client,
    "UTF8",
    "Replay database must use UTF8 client encoding",
  );
  if (hostMode && process.env.LC_ALL === "C") {
    assert.equal(encoding.locale, "C");
    assert.equal(encoding.collation, "C");
  }
  console.log(
    JSON.stringify({ trial: "replay-database-encoding", ...encoding }),
  );
  postgresVersion ||= `PostgreSQL ${serverVersion} (Docker)`;
  await provisionDatabase(admin, passwords);
  owner = new pg.Client(config("yaparena_owner"));
  await owner.connect();
  await runner({
    dbClient: owner,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
  });
  await admin.query(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN",
  );
  pool = new pg.Pool({ ...config("yaparena_encoder"), max: 8 });
  runtime = new pg.Pool({ ...config("yaparena_runtime"), max: 2 });
  await verifyEncoderIdentity(pool);
  await verifyRuntimeIdentity(runtime);
  await assert.rejects(verifyRuntimeIdentity(pool), /violates/);
  await assert.rejects(verifyEncoderIdentity(runtime), /violates/);
  const jobs = createReplayJobs(pool);
  const topic = (
    await owner!.query<{
      id: string;
    }>(`INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
    VALUES('replay-trial','Synthetic replay','Synthetic','For','Against','published') RETURNING id`)
  ).rows[0]!.id;
  const event = async (name: string, status = "ended") => {
    const room = (
      await owner!.query<{ id: string }>(
        `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot)
      SELECT $1,$2,'Synthetic replay',$3,'published',version,rules FROM event_rule_versions WHERE version='prototype-media-1' RETURNING id`,
        [name, topic, status],
      )
    ).rows[0]!.id;
    const sourceKey = `debates/${room}/${randomUUID()}.mp4`;
    await owner!.query(
      `INSERT INTO debate_media(debate_id,state,recording_status,egress_id,recording_key)
      VALUES($1,'ended','ready',$2,$3)`,
      [room, randomUUID(), sourceKey],
    );
    return { room, sourceKey };
  };
  const digest = "a".repeat(64);
  const initial = await event("replay-concurrent");
  const enqueued = await Promise.all([
    jobs.reconcile(),
    jobs.reconcile(),
    jobs.reconcile(),
  ]);
  assert.equal(
    enqueued.reduce((a, b) => a + b, 0),
    1,
  );
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => jobs.claim()),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  // The preceding assertion establishes the single controlled claim.
  const job = claims.find(Boolean)!;
  assert.equal(await jobs.bindSource(job, '"fixed-source"'), true);
  assert.equal(await jobs.bindSource(job, '"changed-source"'), false);
  assert.equal(await jobs.heartbeat({ ...job, leaseId: randomUUID() }), false);
  // Roll back after publication SQL has run, proving state/history/cursor/job
  // are one transaction rather than four separately committed writes.
  const cursor = (
    await owner!.query<{ cursor: string }>(
      "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
      [initial.room],
    )
  ).rows[0]!.cursor;
  const injected = createReplayJobs({
    query: pool.query.bind(pool),
    async connect(): Promise<ReplayDatabaseClient> {
      const client = await pool!.connect();
      return {
        on(...args: Parameters<ReplayDatabaseClient["on"]>) {
          client.on(...args);
        },
        removeListener(
          ...args: Parameters<ReplayDatabaseClient["removeListener"]>
        ) {
          client.removeListener(...args);
        },
        query<Row extends pg.QueryResultRow>(text: string, args?: unknown[]) {
          if (text.includes("INSERT INTO yaparena.event_history"))
            throw new Error("synthetic transaction fault");
          return client.query<Row>(text, args);
        },
        release() {
          client.release();
        },
      };
    },
  });
  await assert.rejects(
    injected.complete(job, digest),
    /synthetic transaction fault/,
  );
  assert.equal(await jobs.ready(initial.room, initial.sourceKey), null);
  assert.equal(
    (
      await owner!.query<{ status: string }>(
        "SELECT status FROM debates WHERE id=$1",
        [initial.room],
      )
    ).rows[0]!.status,
    "ended",
  );
  assert.equal(
    (
      await owner!.query<{ cursor: string }>(
        "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
        [initial.room],
      )
    ).rows[0]!.cursor,
    cursor,
  );
  assert.equal(await jobs.complete(job, digest), true);
  assert.equal(await jobs.complete(job, digest), false);
  assert.deepEqual(await jobs.ready(initial.room, initial.sourceKey), {
    packageKey: job.packageKey,
    hasCaptions: false,
  });
  assert.ok(
    (await jobs.thumbnailCandidates()).some(
      (candidate) => candidate.sourceKey === initial.sourceKey,
    ),
  );
  assert.ok(
    !(await jobs.thumbnailCandidates([initial.sourceKey])).some(
      (candidate) => candidate.sourceKey === initial.sourceKey,
    ),
  );
  assert.equal(
    (
      await pool.query("DELETE FROM media_replay_attempts WHERE id=$1", [
        job.leaseId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query("DELETE FROM media_replay_jobs WHERE id=$1", [job.id]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await owner!.query<{ status: string; live_ended_at?: Date | null }>(
        "SELECT status,live_ended_at FROM debates WHERE id=$1",
        [initial.room],
      )
    ).rows[0]!.status,
    "replay",
  );
  assert.equal(
    (
      await owner!.query<{ n: number }>(
        "SELECT count(*)::int n FROM event_history WHERE debate_id=$1 AND action='automatic_replay' AND actor_user_id IS NULL",
        [initial.room],
      )
    ).rows[0]!.n,
    1,
  );
  await jobs.fail(job, "processing_failed");
  assert.equal(
    (
      await pool.query<{ state: string }>(
        "SELECT state FROM media_replay_attempts WHERE id=$1",
        [job.leaseId],
      )
    ).rows[0]!.state,
    "ready",
    "uncertain commit never cleans a published package",
  );
  console.log(
    "PostgreSQL concurrent enqueue/claim, source pin, transaction rollback, atomic automatic publication and idempotent completion PASS",
  );

  const loss = await event("replay-publication-connection-loss");
  await jobs.reconcile();
  const lossJob = (await jobs.claim())!;
  await jobs.bindSource(lossJob, '"loss-source"');
  const blocker = await runtime.connect();
  await blocker.query("BEGIN");
  await blocker.query(
    "SELECT debate_id FROM debate_media WHERE debate_id=$1 FOR UPDATE",
    [loss.room],
  );
  let backend: number | undefined;
  const losing = createReplayJobs({
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool!.connect();
      backend = (client as pg.PoolClient & { processID: number }).processID;
      return client;
    },
  });
  const lost = losing.complete(lossJob, digest);
  const rejection = assert.rejects(
    lost,
    (error: NodeJS.ErrnoException) =>
      ["57P01", "ECONNRESET"].includes(error.code!) ||
      error.message.includes("Connection terminated"),
  );
  for (let i = 0; i < 100; i++) {
    const blocked =
      backend &&
      (
        await admin.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [backend],
        )
      ).rows[0]?.wait_event_type === "Lock";
    if (blocked) break;
    if (i === 99)
      throw new Error("Publication did not reach controlled lock wait");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await admin.query("SELECT pg_terminate_backend($1)", [backend]);
  try {
    await rejection;
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
  }
  assert.equal(await jobs.ready(loss.room, loss.sourceKey), null);
  assert.equal(
    (
      await owner!.query<{ status: string }>(
        "SELECT status FROM debates WHERE id=$1",
        [loss.room],
      )
    ).rows[0]!.status,
    "ended",
  );
  await jobs.fail(lossJob, "processing_failed", false);
  const lossCleanup = (await jobs.claimCleanup())!;
  assert.equal(lossCleanup.packageKey, lossJob.packageKey);
  await jobs.finishCleanup(lossCleanup, true);
  console.log(
    "Encoder publication backend termination: error handled, rollback complete, ready pointer absent PASS",
  );

  // A removal transaction holds the domain lock while a completion starts.
  // Completion must wait, re-read visibility and refuse after removal commits.
  const removed = await event("replay-removal");
  await jobs.reconcile();
  const removedJob = (await jobs.claim())!;
  await jobs.bindSource(removedJob, '"fixed"');
  const remover = await runtime.connect();
  await remover.query("BEGIN");
  await remover.query(
    "UPDATE debates SET publication_state='hidden' WHERE id=$1",
    [removed.room],
  );
  let finished = false;
  const pending = jobs.complete(removedJob, digest).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, false);
  await remover.query("COMMIT");
  remover.release();
  assert.equal(await pending, false);
  assert.equal(await jobs.ready(removed.room, removed.sourceKey), null);
  await jobs.fail(removedJob, "lease_lost");
  const cleanup = (await jobs.claimCleanup())!;
  assert.equal(cleanup.packageKey, removedJob.packageKey);
  assert.equal(
    await jobs.finishCleanup({ ...cleanup, token: randomUUID() }, true),
    false,
  );
  assert.equal(await jobs.finishCleanup(cleanup, true), true);

  const expired = await event("replay-expiry");
  await jobs.reconcile();
  const expiredJob = (await jobs.claim())!;
  await owner!.query(
    "UPDATE media_replay_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [expiredJob.id],
  );
  await jobs.reconcile();
  await owner!.query(
    "UPDATE media_replay_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1",
    [expiredJob.id],
  );
  const replacement = (await jobs.claim())!;
  assert.notEqual(replacement.leaseId, expiredJob.leaseId);
  assert.equal(await jobs.bindSource(expiredJob, '"old"'), false);
  assert.equal(await jobs.complete(expiredJob, digest), false);
  await jobs.bindSource(replacement, '"new"');
  await owner!.query(
    "UPDATE debate_media SET captions_vtt=$2 WHERE debate_id=$1",
    [
      expired.room,
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nReviewed synthetic tone\n",
    ],
  );
  assert.equal(await jobs.complete(replacement, digest), false);
  await jobs.fail(replacement, "lease_lost");
  await jobs.reconcile();
  const captionJob = (await jobs.claim())!;
  assert.equal(captionJob.attempts, 1);
  assert.ok(captionJob.captionsVtt);
  await jobs.bindSource(captionJob, '"new"');
  assert.equal(await jobs.complete(captionJob, digest), true);
  assert.equal(
    (await jobs.ready(expired.room, expired.sourceKey))!.hasCaptions,
    true,
  );

  const deleted = await event("replay-delete");
  await jobs.reconcile();
  const deletedJob = (await jobs.claim())!;
  await owner!.query("DELETE FROM debates WHERE id=$1", [deleted.room]);
  assert.equal(await jobs.complete(deletedJob, digest), false);
  await jobs.fail(deletedJob, "lease_lost");
  assert.equal(
    (
      await pool.query<{ state: string }>(
        "SELECT state FROM media_replay_jobs WHERE id=$1",
        [deletedJob.id],
      )
    ).rows[0]!.state,
    "cancelled",
  );
  assert.ok(
    (
      await pool.query("SELECT id FROM media_replay_attempts WHERE job_id=$1", [
        deletedJob.id,
      ])
    ).rowCount,
  );

  const changed = await event("replay-source-change");
  await jobs.reconcile();
  const changedJob = (await jobs.claim())!;
  await jobs.bindSource(changedJob, '"old-source"');
  const newKey = `debates/${changed.room}/${randomUUID()}.mp4`;
  await owner!.query(
    "UPDATE debate_media SET recording_key=$2 WHERE debate_id=$1",
    [changed.room, newKey],
  );
  assert.equal(await jobs.complete(changedJob, digest), false);
  await jobs.fail(changedJob, "lease_lost");
  await jobs.reconcile();
  const newSourceJob = (await jobs.claim())!;
  assert.equal(newSourceJob.sourceKey, newKey);
  assert.equal(newSourceJob.attempts, 1);
  await jobs.bindSource(newSourceJob, '"new-source"');
  assert.equal(await jobs.complete(newSourceJob, digest), true);

  const retry = await event("replay-retries");
  await jobs.reconcile();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const claimed = (await jobs.claim())!;
    assert.equal(claimed.attempts, attempt);
    await jobs.fail(claimed, "encoder_failed");
    await owner!.query(
      "UPDATE media_replay_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1",
      [claimed.id],
    );
  }
  await jobs.reconcile();
  assert.equal(await jobs.claim(), null);
  assert.equal(
    (
      await pool.query<{ state: string }>(
        "SELECT state FROM media_replay_jobs WHERE debate_id=$1",
        [retry.room],
      )
    ).rows[0]!.state,
    "failed",
  );
  assert.equal(
    (
      await pool.query("DELETE FROM media_replay_jobs WHERE debate_id=$1", [
        retry.room,
      ])
    ).rowCount,
    0,
  );
  await owner!.query(
    "UPDATE topics SET publication_state='hidden' WHERE id=$1",
    [topic],
  );
  assert.equal(await jobs.ready(initial.room, initial.sourceKey), null);
  console.log(
    "PostgreSQL removal/complete race, stale lease fencing, caption invalidation, deletion tombstones, five-attempt budget and topic revocation PASS",
  );

  const denial = await admin.query<{
    rolname: string;
    access: boolean;
  }>(`SELECT r.rolname,has_schema_privilege(r.oid,'yaparena','USAGE') AS access
    FROM pg_roles r WHERE rolname IN('anon','authenticated')`);
  assert.ok(denial.rows.every((row) => !row.access));
  await assert.rejects(
    pool.query("UPDATE media_replay_jobs SET source_key=$2 WHERE id=$1", [
      job.id,
      job.sourceKey,
    ]),
    (error: NodeJS.ErrnoException) => error.code === "42501",
  );
  await assert.rejects(
    pool.query(
      "ALTER TABLE yaparena.media_replay_jobs DISABLE ROW LEVEL SECURITY",
    ),
    (error: NodeJS.ErrnoException) => error.code === "42501",
  );
  // The encoder's login reaches only its queue and the rows publication
  // touches; tests/replay-encoder-role-postgres.test.js covers the rest.
  for (const [sql, values] of [
    ["SELECT id FROM sessions LIMIT 1", []],
    ["SELECT id FROM users LIMIT 1", []],
    ["SELECT * FROM coin_accounts LIMIT 1", []],
    ["SELECT id FROM event_chat_messages LIMIT 1", []],
    [
      "UPDATE debates SET publication_state='hidden' WHERE id=$1",
      [initial.room],
    ],
    ["DELETE FROM community_room_events WHERE room_id=$1", [initial.room]],
  ] as const)
    await assert.rejects(
      pool.query(sql, [...values]),
      (error: NodeJS.ErrnoException) => error.code === "42501",
      sql,
    );
  const tables = (
    await admin.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname,relrowsecurity FROM pg_class WHERE relname IN('media_replay_jobs','media_replay_attempts')",
    )
  ).rows;
  assert.equal(tables.length, 2);
  assert.ok(tables.every((row) => row.relrowsecurity));
  await jobs.reconcile();
  await owner!.query(
    "UPDATE media_replay_attempts SET state='cleaned' WHERE state<>'cleaned'",
  );
  await owner!.query(
    "UPDATE media_replay_jobs SET updated_at=clock_timestamp()-INTERVAL '31 days' WHERE state='cancelled'",
  );
  assert.ok(await jobs.prune());
  console.log(
    "Encoder-only RLS/grants, immutable binding columns and bounded tombstone retention PASS",
  );

  await owner!.query(
    "UPDATE topics SET publication_state='published' WHERE id=$1",
    [topic],
  );
  // Keep earlier fixtures ineligible before running the actual complete worker.
  await owner!.query("UPDATE debates SET publication_state='hidden'");
  const canary = await event("replay-canary");
  const outside = await event("replay-outside-canary");
  const scoped = createReplayJobs(pool, [canary.room]);
  assert.equal(await scoped.reconcile(), 1);
  assert.equal(
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int n FROM media_replay_jobs WHERE debate_id=$1",
        [outside.room],
      )
    ).rows[0]!.n,
    0,
  );
  const canaryJob = (await scoped.claim())!;
  assert.equal(canaryJob.debateId, canary.room);
  assert.equal(await createReplayJobs(pool, []).claim(), null);
  assert.equal(
    await createReplayJobs(pool, []).complete(canaryJob, digest),
    false,
  );
  await owner!.query(
    "UPDATE debates SET publication_state='hidden' WHERE id=ANY($1::uuid[])",
    [[canary.room, outside.room]],
  );
  await jobs.fail(canaryJob, "lease_lost");
  console.log(
    "Real PostgreSQL room-scoped canary enqueue/claim/completion isolation PASS",
  );
  const synthetic = await event("replay-automatic-encoder");
  const input = resolve(directory, "synthetic.mp4");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
  const storage = replayStorageFixture();
  storage.put(synthetic.sourceKey, await readFile(input));
  const before = performance.now();
  const worker = createReplayWorker({
    jobs,
    storage: storage.storage,
    logger: quiet,
    options: { tempRoot: directory },
    packageMedia: (input, output, captions, options) =>
      buildReplayPackage(input, output, captions, {
        ...options,
        runProcess: measuredRun,
      }),
  });
  await worker.tick();
  await worker.stop();
  await Promise.all(samples);
  samples = [];
  const ready = await jobs.ready(synthetic.room, synthetic.sourceKey);
  assert.ok(ready);
  assert.equal(ready.hasCaptions, false);
  const prefix = ready.packageKey.slice(0, -4) + "/hls/";
  // JSON.parse applies ToString to this known fixture Buffer; its standard
  // library declaration exposes only the string form of that native operation.
  const marker = (
    JSON.parse as (text: string | Buffer) => {
      files: number;
      reviewedCaptions: boolean;
      bytes: number;
    }
  )(storage.objects.get(prefix + "ready.json")!.body);
  assert.equal(marker.files, 13);
  assert.equal(marker.reviewedCaptions, false);
  assert.equal(
    storage.commands
      .filter((command) => command.constructor.name === "PutObjectCommand")
      .at(-1)!.input.Key,
    prefix + "ready.json",
  );
  const thumbnailTask = createReplayThumbnailTask({
    jobs: {
      thumbnailCandidates: async (excluded) =>
        (await jobs.thumbnailCandidates(excluded)).filter(
          (candidate) => candidate.sourceKey === synthetic.sourceKey,
        ),
    },
    storage: storage.storage.thumbnails,
    logger: quiet,
  });
  await thumbnailTask(new AbortController().signal);
  assert.equal(
    await storage.storage.thumbnails.exists(synthetic.sourceKey),
    true,
  );
  const image = await storage.storage.thumbnails.read(synthetic.sourceKey);
  assert.ok(image.length > 100 && image.length < 300_000);
  assert.ok(storage.objects.has(replayThumbnailKey(synthetic.sourceKey)));
  assert.equal(
    (
      await owner!.query<{ status: string }>(
        "SELECT status FROM debates WHERE id=$1",
        [synthetic.room],
      )
    ).rows[0]!.status,
    "replay",
  );
  assert.equal(
    (await readdir(directory)).filter((name) =>
      name.startsWith("yaparena-replay-"),
    ).length,
    0,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      node: process.version,
      postgres: postgresVersion,
      ffmpeg: (await exec("ffmpeg", ["-version"])).stdout.split("\n")[0],
      sourceSeconds: 6,
      encoderThreads: 2,
      elapsedSeconds: Number(((performance.now() - before) / 1000).toFixed(3)),
      peakEncoderRssMiB: Number((peakEncoderRssKiB / 1024).toFixed(2)),
      workerPeakRssMiB: Number(
        (process.resourceUsage().maxRSS / 1024).toFixed(2),
      ),
      packageFiles: marker.files,
      thumbnailBytes: image.length,
      packageBytes: marker.bytes,
      scope:
        "real PostgreSQL encoder-role transactions + FFmpeg, synthetic in-memory object adapter; no hosted storage/edge or physical-device evidence",
    }),
  );

  // Real query stall while cancellation drains the encoding task. Use the same
  // timeout budget as the integrated dedicated worker, not owner credentials.
  const stalled = await event("replay-shutdown-db-stall");
  storage.put(stalled.sourceKey, await readFile(input));
  const stalledPool = new pg.Pool({
    ...config("yaparena_encoder"),
    max: 2,
    query_timeout: 1500,
    connectionTimeoutMillis: 1500,
    options:
      "-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=1500 -c lock_timeout=1000",
  });
  try {
    await verifyEncoderIdentity(stalledPool);
    const stalledJobs = createReplayJobs(stalledPool);
    let began!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      began = resolve;
    });
    const draining = createReplayWorker({
      jobs: {
        ...stalledJobs,
        async heartbeat() {
          began();
          await stalledPool.query("SELECT pg_sleep(10)");
          return true;
        },
      },
      storage: storage.storage,
      logger: quiet,
      options: {
        tempRoot: directory,
        leaseMs: 5000,
        heartbeatMs: 100,
        maxJobMs: 5000,
      },
      packageMedia: async (_input, _output, _captions, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    });
    draining.start();
    await queryStarted;
    const stopStart = performance.now();
    await draining.stop();
    const shutdownMs = performance.now() - stopStart;
    assert.ok(shutdownMs < 8000);
    assert.equal(
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM media_replay_jobs WHERE debate_id=$1",
          [stalled.room],
        )
      ).rows[0]!.state,
      "queued",
    );
    assert.equal(
      (await readdir(directory)).filter((name) =>
        name.startsWith("yaparena-replay-"),
      ).length,
      0,
    );
    console.log(
      JSON.stringify({
        result: "PASS",
        scenario: "worker shutdown while real PostgreSQL heartbeat is stalled",
        shutdownMs: Number(shutdownMs.toFixed(2)),
        deadlineMs: 8000,
      }),
    );
  } finally {
    await stalledPool.end();
  }
} finally {
  await pool?.end();
  await runtime?.end();
  await owner?.end();
  await admin?.end();
  if (started && hostMode)
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--mode",
      "fast",
      "--wait",
      "stop",
    ]);
  else if (started)
    await exec("docker", ["rm", "--force", container]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
