import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import cookieParser from "cookie-parser";
import express from "express";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import {
  chromium,
  type Browser,
  type BrowserServer,
  type Page,
} from "playwright-core";
import { format } from "prettier";
import { createMediaProvider } from "../dist/features/media/provider.js";
import { createMediaAccountRevocation } from "../dist/features/media/account-revocation.js";
import { createAuthRouter } from "../dist/platform/auth/router.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { provisionDatabase } from "./provision-database.ts";

type ClientSdk = typeof import("livekit-client");
type BrowserRoom = import("livekit-client").Room;
declare global {
  interface Window {
    LivekitClient?: ClientSdk;
    yapCloudTrial?: {
      room: BrowserRoom;
      refreshedTokens: string[];
      disconnectReason: number | null;
    };
  }
}

// Explicit operator-only trial. No .env, hosted database, retained identities, media
// capture, publish calls, egress, recording or DeleteRoom API is used. Tokens and
// API credentials remain in process/browser memory and never enter evidence.
const mode = process.argv[2] ?? "--inspect";
assert.ok(
  ["--inspect", "--execute", "--execute-app", "--verify-app"].includes(mode),
);
assert.ok(process.argv.length <= 3);
const service = "srv-datv1kjncjis73a500cg";
const controlOrigin = "https://yaparena-staging-e100x84o.livekit.cloud";
const publicOrigin = "wss://yaparena-staging-e100x84o.livekit.cloud";
const artifactDirectory = resolve(
  mode === "--execute-app" || mode === "--verify-app"
    ? "docs/evidence/account-completion-baseline/media-app-cloud-revocation"
    : "docs/evidence/account-completion-baseline/media-cloud-revocation",
);
await mkdir(artifactDirectory, { recursive: true });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function configuration() {
  const config = await readFile("/Users/felixboucher/.render/cli.yaml", "utf8");
  const match = config.match(/^\s*key:\s*(.+)$/m);
  assert.ok(match?.[1]);
  const encoded = match[1].trim();
  const key: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  assert.ok(typeof key === "string" && key.length > 20);
  const response = await fetch(
    `https://api.render.com/v1/services/${service}/env-vars?limit=100`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(response.status, 200);
  const rows: unknown = await response.json();
  assert.ok(Array.isArray(rows) && rows.length < 100);
  const vars = new Map<string, string>();
  for (const row of rows) {
    assert.ok(object(row) && object(row.envVar));
    const entry = row.envVar;
    assert.ok(typeof entry.key === "string" && typeof entry.value === "string");
    vars.set(entry.key, entry.value);
  }
  const value = (name: string) => {
    const found = vars.get(name);
    assert.ok(found);
    return found;
  };
  const control = new URL(value("LIVEKIT_URL"));
  const browser = new URL(value("LIVEKIT_PUBLIC_URL"));
  assert.equal(control.origin, controlOrigin);
  assert.equal(browser.origin, publicOrigin);
  assert.equal(
    control.username + control.password + browser.username + browser.password,
    "",
  );
  return {
    livekitUrl: controlOrigin,
    livekitPublicUrl: publicOrigin,
    livekitKey: value("LIVEKIT_API_KEY"),
    livekitSecret: value("LIVEKIT_API_SECRET"),
  };
}
async function digest(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function report(name: string, value: unknown) {
  const path = resolve(artifactDirectory, `${name}.json`);
  await writeFile(
    `${path}.next`,
    await format(JSON.stringify(value), { parser: "json" }),
  );
  await rename(`${path}.next`, path);
}
// The application trial uses its own SCRAM cluster and two runtime pools. It
// accepts no database URL and never creates an identity in the hosted app.
async function applicationFixture(
  provider: Pick<
    ReturnType<typeof createMediaProvider>,
    "supportsTokenRevocation" | "token" | "removeSpeaker"
  >,
) {
  const execute = promisify(execFile);
  const exec = (file: string, args: string[]) =>
    execute(file, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  const directory = await mkdtemp("/private/tmp/yaparena-media-cloud-app-");
  const passwords = {
    postgres: randomBytes(24).toString("hex"),
    yaparena_owner: randomBytes(24).toString("hex"),
    yaparena_runtime: randomBytes(24).toString("hex"),
    yaparena_encoder: randomBytes(24).toString("hex"),
  };
  const databaseName = "revocation_test_media_cloud";
  const quiet = { info() {}, warn() {}, error() {} };
  let started = false;
  let owner: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  let worker: pg.Pool | undefined;
  let server: ReturnType<express.Express["listen"]> | undefined;
  let cleanupStarted = false;
  async function cleanup() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    const pending: Promise<unknown>[] = [];
    if (server) {
      server.closeAllConnections();
      pending.push(
        new Promise<void>((done, fail) =>
          server!.close((error) => (error ? fail(error) : done())),
        ),
      );
    }
    for (const pool of [owner, runtime, worker])
      if (pool) pending.push(pool.end());
    const closed = await Promise.allSettled(
      pending.map((item) => bounded(item, 5000)),
    );
    if (started)
      // If stopping cannot be proven, preserve the private directory for
      // inspection. Never remove the data directory of a possibly live server.
      await execute(
        "pg_ctl",
        [
          "--pgdata",
          resolve(directory, "data"),
          "--mode",
          "immediate",
          "--wait",
          "stop",
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
    await bounded(rm(directory, { recursive: true, force: true }), 5000);
    assert.ok(
      closed.every((item) => item.status === "fulfilled"),
      "local application connections did not close cleanly",
    );
  }
  try {
    assert.match(
      (await exec("pg_config", ["--version"])).stdout,
      /^PostgreSQL (17|18)\./,
    );
    const passwordFile = resolve(directory, "password");
    await writeFile(passwordFile, passwords.postgres, { mode: 0o600 });
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
    const socket = createServer().listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((done, fail) =>
      socket.close((error) => (error ? fail(error) : done())),
    );
    const url = (role: keyof typeof passwords, database: string) => {
      const value = new URL(`postgresql://127.0.0.1:${port}/${database}`);
      value.username = role;
      value.password = passwords[role];
      return value.href;
    };
    started = true;
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
    const limits = {
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      statement_timeout: 10000,
    };
    const administrator = new pg.Client({
      ...limits,
      connectionString: url("postgres", "postgres"),
    });
    await administrator.connect();
    try {
      await administrator.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await administrator.end();
    }
    const provisioner = new pg.Client({
      ...limits,
      connectionString: url("postgres", databaseName),
    });
    await provisioner.connect();
    try {
      await provisionDatabase(provisioner, passwords);
      const migrationOwner = new pg.Client({
        ...limits,
        connectionString: url("yaparena_owner", databaseName),
      });
      await migrationOwner.connect();
      try {
        await runner({
          dbClient: migrationOwner,
          dir: "migrations",
          direction: "up",
          schema: "yaparena",
          migrationsSchema: "yaparena_migrations",
          migrationsTable: "pgmigrations",
          logger: quiet,
          log() {},
        });
      } finally {
        await migrationOwner.end();
      }
      await provisionDatabase(provisioner);
    } finally {
      await provisioner.end();
    }
    owner = new pg.Pool({
      ...limits,
      connectionString: url("yaparena_owner", databaseName),
    });
    runtime = new pg.Pool({
      ...limits,
      connectionString: url("yaparena_runtime", databaseName),
    });
    worker = new pg.Pool({
      ...limits,
      connectionString: url("yaparena_runtime", databaseName),
    });
    const sessions = createSessionRepository(runtime);
    const user = (
      await owner.query<{ id: string; generation: string }>(
        "INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation AS generation",
      )
    ).rows[0]!;
    const cookies = [createSessionToken(), createSessionToken()];
    for (const cookie of cookies)
      await sessions.create(
        user.id,
        cookie.tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration: user.generation },
      );
    const topic = (
      await owner.query<{ id: string }>(
        `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
      VALUES($1,'Synthetic Cloud trial','Isolated local account','Support','Oppose','published') RETURNING id`,
        [`cloud-trial-${randomUUID()}`],
      )
    ).rows[0]!;
    const debate = (
      await owner.query<{ id: string }>(
        `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,rules_snapshot)
      VALUES($1,$2,'Synthetic speaker sign-out trial','scheduled','published','preview-1','{}') RETURNING id`,
        [topic.id, `cloud-trial-${randomUUID()}`],
      )
    ).rows[0]!;
    await owner.query(
      "INSERT INTO event_participants(debate_id,user_id,side) VALUES($1,$2,'A')",
      [debate.id, user.id],
    );
    await owner.query(
      "INSERT INTO media_device_checks(debate_id,user_id,camera_ok,microphone_ok) VALUES($1,$2,true,true)",
      [debate.id, user.id],
    );
    const mediaProvider = {
      supportsTokenRevocation: provider.supportsTokenRevocation,
      mintSpeakerToken: (id: string, identity: string, side: "A" | "B") =>
        provider.token(id, identity, true, side),
      removeSpeaker: (id: string, identity: string) =>
        provider.removeSpeaker(id, identity),
    };
    const media = createMediaAccountRevocation(runtime, mediaProvider);
    const jobs = createMediaAccountRevocation(worker, mediaProvider);
    const issued = await media.issueSpeakerGrant({
      userId: user.id,
      sessionTokenHash: cookies[0]!.tokenHash,
      debateId: debate.id,
    });
    const app = express();
    app.use(express.json(), cookieParser());
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app.use(
      "/api/auth",
      createAuthRouter({
        sessions,
        environment: "development",
        applicationOrigin: origin,
      }),
    );
    const request = (path: string, index = 0, method = "GET") =>
      fetch(`${origin}/api/auth${path}`, {
        method,
        headers: { Cookie: `session=${cookies[index]!.token}`, Origin: origin },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    for (let i = 0; i < cookies.length; i++)
      assert.equal((await request("/me", i)).status, 200);
    return {
      id: debate.id,
      original: issued.token,
      cleanup,
      async logoutAndDrain() {
        // Sign out ends one device, so sign out every session in turn.
        for (let i = 0; i < cookies.length; i++) {
          const response = await request("/logout", i, "POST");
          assert.equal(response.status, 204);
          assert.equal(response.headers.get("set-cookie"), null);
        }
        for (let i = 0; i < cookies.length; i++)
          assert.equal((await request("/me", i)).status, 401);
        const queued = (
          await owner!.query<{ state: string; job: string }>(
            "SELECT g.state,j.state AS job FROM media_account_grants g JOIN media_account_revocations j ON j.grant_id=g.id WHERE g.user_id=$1",
            [user.id],
          )
        ).rows;
        assert.deepEqual(queued, [{ state: "revoking", job: "pending" }]);
        await jobs.flush(10);
        const completed = (
          await owner!.query<{ state: string; job: string; attempts: number }>(
            "SELECT g.state,j.state AS job,j.attempts FROM media_account_grants g JOIN media_account_revocations j ON j.grant_id=g.id WHERE g.user_id=$1",
            [user.id],
          )
        ).rows;
        assert.deepEqual(completed, [
          { state: "revoked", job: "complete", attempts: 1 },
        ]);
        return {
          localSessionsRejected: 2,
          transactionalJobQueued: true,
          separateRuntimePoolCompleted: true,
        };
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
type Interval = {
  label: string;
  startedAt: number;
  stoppedAt: number | null;
};
let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let rooms: RoomServiceClient | undefined;
let fixtureRoom: string | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let phase = "read named staging configuration";
let executionStartedAt: number | undefined;
let roomExpired = false;
const intervals: Interval[] = [];
const pages = new Map<Page, Interval>();
const checks: string[] = [];
let result: Record<string, unknown> | undefined;
let maximumConcurrentClients = 0;
let application: Awaited<ReturnType<typeof applicationFixture>> | undefined;
async function bounded<T>(pending: Promise<T>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("trial step deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
async function disconnect(page: Page) {
  try {
    if (!page.isClosed())
      await bounded(
        page.evaluate(async () => {
          await window.yapCloudTrial?.room.disconnect();
        }),
        2000,
      );
  } catch {
    // Only the subprocess started by this helper is killed; never the user's
    // native browser. This bounds provider connection time if the SDK hangs.
    browserServer?.process().kill("SIGKILL");
    process.exitCode = 1;
  } finally {
    const interval = pages.get(page);
    if (interval && interval.stoppedAt === null)
      interval.stoppedAt = Date.now();
    if (!page.isClosed()) await bounded(page.close(), 2000);
  }
}
async function connect(label: string, token: string) {
  assert.ok(browser && executionStartedAt);
  assert.ok(Date.now() - executionStartedAt < 45_000);
  assert.ok([...pages.values()].filter((i) => i.stoppedAt === null).length < 2);
  const page = await browser.newPage();
  const interval = { label, startedAt: Date.now(), stoppedAt: null };
  pages.set(page, interval);
  intervals.push(interval);
  maximumConcurrentClients = Math.max(
    maximumConcurrentClients,
    [...pages.values()].filter((i) => i.stoppedAt === null).length,
  );
  await page.addScriptTag({
    path: resolve("node_modules/livekit-client/dist/livekit-client.umd.js"),
  });
  const response = await page.evaluate(
    async ({ token, url }) => {
      const sdk = window.LivekitClient;
      if (!sdk) throw new Error("installed SDK unavailable");
      sdk.setLogLevel(sdk.LogLevel.silent);
      const room = new sdk.Room({
        reconnectPolicy: { nextRetryDelayInMs: () => null },
      });
      const state: NonNullable<Window["yapCloudTrial"]> = {
        room,
        refreshedTokens: [],
        disconnectReason: null,
      };
      window.yapCloudTrial = state;
      // This is the real typed installed SDK engine event. RTCEngine's actual
      // SignalClient.onTokenRefresh handler emits it upon a server token update.
      room.engine.on("tokenRefreshed", (refreshed: string) => {
        state.refreshedTokens.push(refreshed);
      });
      room.on(sdk.RoomEvent.Disconnected, (reason) => {
        state.disconnectReason = reason ?? null;
      });
      try {
        await room.connect(url, token, {
          autoSubscribe: false,
          maxRetries: 0,
          websocketTimeout: 5000,
          peerConnectionTimeout: 5000,
        });
        return {
          connected: true,
          denied: false,
          status: null,
          canPublish: room.localParticipant.permissions?.canPublish ?? false,
          canSubscribe:
            room.localParticipant.permissions?.canSubscribe ?? false,
          publishedTracks: room.localParticipant.trackPublications.size,
        };
      } catch (error) {
        await room.disconnect();
        return {
          connected: false,
          denied:
            error instanceof sdk.ConnectionError &&
            error.reason === sdk.ConnectionErrorReason.NotAllowed &&
            (error.status === 401 || error.status === 403),
          status:
            error instanceof sdk.ConnectionError
              ? (error.status ?? null)
              : null,
          canPublish: false,
          canSubscribe: false,
          publishedTracks: 0,
        };
      }
    },
    { token, url: publicOrigin },
  );
  if (!response.connected) await disconnect(page);
  return { page, response };
}

try {
  if (mode === "--verify-app") {
    phase = "verify local application fixture without provider calls";
    let removals = 0;
    application = await applicationFixture({
      supportsTokenRevocation: true,
      async token() {
        return "synthetic-local-preflight-token";
      },
      async removeSpeaker() {
        removals++;
      },
    });
    const outcome = await application.logoutAndDrain();
    assert.equal(removals, 1);
    await application.cleanup();
    application = undefined;
    console.log(
      JSON.stringify({
        mode,
        result: "PASS",
        outcome,
        externalProviderCalls: 0,
        scope:
          "Local disposable fixture preparation only; simulated removal does not establish Cloud acceptance.",
      }),
    );
  } else {
    const config = await configuration();
    rooms = new RoomServiceClient(
      config.livekitUrl,
      config.livekitKey,
      config.livekitSecret,
      { requestTimeout: 3 },
    );
    const before = await rooms.listRooms();
    if (mode === "--inspect") {
      await report("inspection", {
        at: new Date().toISOString(),
        controlOrigin,
        publicOrigin,
        existingRoomCount: before.length,
        mutation: false,
        executionRequires: "explicit included-quota confirmation and --execute",
      });
      console.log(
        JSON.stringify({ mode, existingRooms: before.length, mutation: false }),
      );
    } else {
      assert.equal(
        process.env.MEDIA_CLOUD_INCLUDED_QUOTA_CONFIRMED,
        "5-minutes",
      );
      if (mode === "--execute-app")
        assert.equal(process.env.MEDIA_CLOUD_APP_TRIAL_APPROVED, "true");
      assert.equal(
        before.length,
        0,
        "do not run beside existing media participants",
      );
      const provider = createMediaProvider({
        ...config,
        // Storage methods are never called. No unrelated provider is contacted.
        s3Region: "auto",
        s3Bucket: "unused-no-recording",
        s3AccessKey: "unused-no-recording",
        s3SecretKey: "unused-no-recording",
      });
      assert.equal(provider.supportsTokenRevocation, true);
      if (mode === "--execute-app") {
        phase =
          "prepare isolated application sessions and tracked speaker grant";
        application = await applicationFixture(provider);
        assert.equal((await rooms.listRooms()).length, 0);
      }
      phase = "bounded disposable room trial";
      const id = application?.id ?? randomUUID(),
        speaker = randomUUID();
      fixtureRoom = `debate-${id}`;
      browserServer = await chromium.launchServer({
        executablePath:
          process.env.BROWSER_CHROME_PATH ??
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
      });
      browser = await chromium.connect(browserServer.wsEndpoint());
      executionStartedAt = Date.now();
      deadline = setTimeout(() => {
        browserServer?.process().kill("SIGKILL");
        process.exitCode = 1;
      }, 45_000);
      await rooms.createRoom({
        name: fixtureRoom,
        emptyTimeout: 30,
        departureTimeout: 10,
        maxParticipants: 3,
        metadata: "YapArena disposable no-media revocation acceptance",
      });
      const verifier = new TokenVerifier(
        config.livekitKey,
        config.livekitSecret,
      );
      const original =
        application?.original ?? (await provider.token(id, speaker, true, "A"));
      const viewerToken = await provider.token(id, randomUUID(), false);
      const originalClaims = await verifier.verify(original, 0);
      const viewerClaims = await verifier.verify(viewerToken, 0);
      assert.ok(typeof originalClaims.sub === "string");
      assert.ok(originalClaims.sub.startsWith("speaker-"));
      if (!application) assert.equal(originalClaims.sub, `speaker-${speaker}`);
      assert.equal(typeof originalClaims.nbf, "number");
      const originalNbf = originalClaims.nbf;
      assert.ok(typeof originalNbf === "number");
      assert.equal(viewerClaims.video?.canPublish, false);
      const initial = await connect("original speaker baseline", original);
      assert.ok(initial.response.connected && initial.response.canPublish);
      assert.equal(initial.response.publishedTracks, 0);
      const viewer = await connect("public viewer baseline", viewerToken);
      assert.ok(
        viewer.response.connected &&
          !viewer.response.canPublish &&
          viewer.response.canSubscribe,
      );
      assert.equal(viewer.response.publishedTracks, 0);
      checks.push(
        "original fresh speaker and independent view-only viewer connect without publishing tracks",
      );

      phase = "capture and verify actual server-refreshed token";
      await delay(1100);
      const marker = JSON.stringify({ revocationTrial: id });
      await rooms.updateParticipant(fixtureRoom, originalClaims.sub, {
        metadata: marker,
      });
      let refreshed: string | undefined;
      let refreshedNbf: number | undefined;
      const refreshDeadline = Date.now() + 8000;
      while (!refreshed && Date.now() < refreshDeadline) {
        const received = await initial.page.evaluate(
          () => window.yapCloudTrial?.refreshedTokens ?? [],
        );
        for (const candidate of received) {
          if (candidate === original) continue;
          const claims = await verifier.verify(candidate, 0);
          if (
            claims.sub === originalClaims.sub &&
            claims.video?.room === fixtureRoom &&
            claims.metadata === marker &&
            typeof claims.nbf === "number" &&
            claims.nbf > originalNbf
          ) {
            refreshed = candidate;
            refreshedNbf = claims.nbf;
            break;
          }
        }
        if (!refreshed) await delay(100);
      }
      assert.ok(refreshed && refreshedNbf);
      await disconnect(initial.page);
      const refreshedBaseline = await connect(
        "server-refreshed speaker baseline",
        refreshed,
      );
      assert.ok(
        refreshedBaseline.response.connected &&
          refreshedBaseline.response.canPublish,
      );
      assert.equal(refreshedBaseline.response.publishedTracks, 0);
      checks.push(
        "real SignalClient token-refresh event produced a signature-verified newer nbf token accepted before cutoff",
      );

      phase = "invoke actual strict provider revocation path";
      const cutoffStartedAt = Date.now();
      const applicationOutcome = application
        ? await application.logoutAndDrain()
        : null;
      if (!application) await provider.removeSpeaker(id, originalClaims.sub);
      const cutoffCompletedAt = Date.now();
      await refreshedBaseline.page.waitForFunction(
        () => window.yapCloudTrial?.disconnectReason != null,
        undefined,
        { timeout: 5000 },
      );
      const reason = await refreshedBaseline.page.evaluate(
        () => window.yapCloudTrial?.disconnectReason,
      );
      // The actual SDK enum is used rather than assuming a numeric wire value.
      assert.equal(
        await refreshedBaseline.page.evaluate(
          (value) =>
            value ===
            window.LivekitClient?.DisconnectReason.PARTICIPANT_REMOVED,
          reason,
        ),
        true,
      );
      await disconnect(refreshedBaseline.page);
      const originalReplay = await connect("original token replay", original);
      assert.ok(
        !originalReplay.response.connected && originalReplay.response.denied,
      );
      const refreshedReplay = await connect(
        "server-refreshed token replay",
        refreshed,
      );
      assert.ok(
        !refreshedReplay.response.connected && refreshedReplay.response.denied,
      );
      checks.push(
        "actual integrated explicit-cutoff removal disconnects the fixture and rejects both original and server-refreshed tokens as unauthorized",
      );
      if (application)
        checks.push(
          "Normal application HTTP logout rejects both local sessions and transactionally queues removal; a separate runtime database pool completes the durable Cloud revocation.",
        );

      phase = "verify view-only public access remains available";
      assert.equal(
        await viewer.page.evaluate(
          () =>
            window.yapCloudTrial?.room.state ===
            window.LivekitClient?.ConnectionState.Connected,
        ),
        true,
      );
      const remaining = await rooms.listParticipants(fixtureRoom);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.identity, viewerClaims.sub);
      assert.equal(remaining[0]?.permission?.canPublish, false);
      assert.equal(remaining[0]?.tracks.length, 0);
      await disconnect(viewer.page);
      const viewerAgain = await connect("public viewer reconnect", viewerToken);
      assert.ok(
        viewerAgain.response.connected &&
          !viewerAgain.response.canPublish &&
          viewerAgain.response.canSubscribe,
      );
      await disconnect(viewerAgain.page);
      checks.push(
        "independent public view-only client stays connected, retains no-publish permission and reconnects with its original token",
      );
      assert.ok(Date.now() - executionStartedAt < 45_000);
      result = {
        application: applicationOutcome,
        originalNbf: originalClaims.nbf,
        serverRefreshedNbf: refreshedNbf,
        explicitCutoffUnixSeconds: {
          minimum: Math.floor(cutoffStartedAt / 1000) + 30,
          maximum: Math.floor(cutoffCompletedAt / 1000) + 30,
          source: "actual compiled createMediaProvider.removeSpeaker path",
        },
        originalReplay: originalReplay.response,
        refreshedReplay: refreshedReplay.response,
        viewerReconnect: viewerAgain.response,
      };
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category: error instanceof Error ? error.name : "unclassified",
      details: "Tokens, credentials and provider response bodies omitted",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const page of pages.keys()) {
    try {
      await disconnect(page);
    } catch {
      const interval = pages.get(page);
      if (interval && interval.stoppedAt === null)
        interval.stoppedAt = Date.now();
    }
  }
  try {
    if (browser) await bounded(browser.close(), 2000);
    if (browserServer) await bounded(browserServer.close(), 2000);
  } catch {
    browserServer?.process().kill("SIGKILL");
    process.exitCode = 1;
  }
  if (deadline) clearTimeout(deadline);
  // Finish bounded local cleanup before observing automatic room expiry so it
  // cannot extend the Cloud trial beyond the absolute two-minute boundary.
  if (application)
    try {
      await application.cleanup();
    } catch {
      process.exitCode = 1;
      console.error(
        JSON.stringify({
          phase: "isolated application cleanup",
          result: "FAIL",
          details: "private diagnostics withheld",
        }),
      );
    }
  if (rooms && fixtureRoom) {
    // Cloud expiry is scheduled, rather than an exact departure-time alarm.
    // Reserve most of the two-minute total budget for observing that cleanup.
    const expiresBy = Math.min(
      Date.now() + 60_000,
      (executionStartedAt ?? Date.now()) + (application ? 110_000 : 115_000),
    );
    while (Date.now() < expiresBy) {
      try {
        if ((await rooms.listRooms([fixtureRoom])).length === 0) {
          roomExpired = true;
          break;
        }
      } catch {
        process.exitCode = 1;
      }
      await delay(1000);
    }
  }
  if (executionStartedAt) {
    const intervalBounds = intervals.map((interval) => ({
      label: interval.label,
      startedAt: new Date(interval.startedAt).toISOString(),
      stoppedAt: new Date(interval.stoppedAt ?? Date.now()).toISOString(),
      roundedUpperBoundMs: Math.max(
        10_000,
        (interval.stoppedAt ?? Date.now()) - interval.startedAt,
      ),
    }));
    // Conservatively include two 15-second unexpected-disconnect grace periods
    // beyond the timed intervals, even when all explicit disconnects succeeded.
    const participantUsageUpperBoundMs = intervalBounds.reduce(
      (total, interval) => total + interval.roundedUpperBoundMs,
      30_000,
    );
    const cloudTrialElapsedMs = Date.now() - executionStartedAt;
    const priorParticipantUsageUpperBoundMs =
      mode === "--execute-app" ? 90000 : 0;
    const passed = Boolean(
      result &&
      roomExpired &&
      participantUsageUpperBoundMs + priorParticipantUsageUpperBoundMs <
        300_000 &&
      cloudTrialElapsedMs < 120_000 &&
      process.exitCode !== 1,
    );
    if (!passed) process.exitCode = 1;
    await report("acceptance", {
      at: new Date().toISOString(),
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      scope: application
        ? "Actual local HTTP application logout, disposable PostgreSQL sessions/grant/outbox and separate-runtime-pool processing against hosted LiveKit Cloud. No hosted application account, microphone, camera, publishing, recording or egress. Synthetic local identity/device-check fixture; not hosted Privy, physical-device or audiovisual quality acceptance."
        : "Actual hosted LiveKit Cloud signaling/revocation with disposable identities, real installed SDK and actual application provider path; no application account, microphone, camera, media publishing, recording or egress. Not genuine application logout, physical-device or media-quality acceptance.",
      passed,
      controlOrigin,
      publicOrigin,
      fixtureRoom,
      maximumConcurrentClients,
      cloudTrialElapsedMs,
      participantUsageUpperBoundMs,
      priorParticipantUsageUpperBoundMs,
      confirmedIncludedQuotaMinutes: 5,
      roomExpired,
      intervals: intervalBounds,
      checks,
      result: result ?? null,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "scripts/verify-media-cloud-revocation.ts",
            "dist/features/media/provider.js",
            ...(application
              ? [
                  "dist/features/media/account-revocation.js",
                  "dist/platform/auth/router.js",
                  "dist/platform/auth/sessions.js",
                  "migrations/1792426006400_add-account-media-revocation.js",
                  "migrations/1792426008000_bind-media-replacement-intent.js",
                ]
              : []),
            "node_modules/livekit-client/dist/livekit-client.umd.js",
            "node_modules/livekit-client/src/room/RTCEngine.ts",
          ].map(async (path) => [path, await digest(path)]),
        ),
      ),
      limitations: [
        "Quota availability was confirmed by the founder; provider billing plan was not changed or inferred.",
        application
          ? "Disposable local application identities use synthetic owner-created accounts and device-check fixtures; no hosted database or genuine Privy login is exercised."
          : "Disposable provider identities are not retained YapArena accounts; full app-session/provider-outbox acceptance is separate.",
        "No recordings, physical devices, screen reader or audiovisual quality tested.",
      ],
    });
    console.log(
      JSON.stringify({
        passed,
        roomExpired,
        participantUsageUpperBoundMs,
        evidence: resolve(artifactDirectory, "acceptance.json"),
      }),
    );
  }
}
