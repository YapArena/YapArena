import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { format } from "prettier";
import {
  createPublicClient,
  getAddress,
  http,
  type Hex,
  type HttpTransportConfig,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { provisionDatabase } from "./provision-database.ts";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createAuth0Accounts } from "../dist/platform/auth/auth0-accounts.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
  withdrawalApprovalTerms,
} from "../dist/features/account-wallet/sandbox-repository.js";
import {
  baseSepoliaAsset,
  createBaseSepoliaAdapter,
  createBaseSepoliaReceipt,
  validatePreparedTestTransfer,
  type PreparedTestTransfer,
  type TestTransferObservation,
} from "../src/features/account-wallet/base-sepolia.ts";

// Explicit approved valueless test only. No .env, hosted DB, live asset, provider
// account or financial user is touched. A persistent private disposable cluster
// preserves the ledger/nonce mapping across chain finality waits and restarts.
assert.equal(process.env.COIN_TESTNET_ENVIRONMENT, "sandbox");
assert.equal(process.argv.length, 2);
const exec = promisify(execFile);
const directory = "/private/tmp/yaparena-coin-testnet-ledger";
const keysPath = "/private/tmp/yaparena-coin-testnet/keys.json";
const artifactDirectory = resolve("docs/evidence/coin-testnet/ledger");
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(artifactDirectory, { recursive: true });
assert.equal(await realpath(directory), directory);
assert.equal((await lstat(directory)).mode & 0o077, 0);
const lockPath = resolve(directory, "operator.lock");
const lock = await open(lockPath, "wx", 0o600);
const statePath = resolve(directory, "state.json");
const quiet = { info() {}, warn() {}, error() {} };
const database = "revocation_test_coin_base";
type PrivateState = {
  port: number;
  fixture: string;
  password: string;
  passwords: {
    postgres: string;
    yaparena_owner: string;
    yaparena_runtime: string;
  };
  token: string;
  userId?: string;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}
function serialized(value: unknown): value is `0x02${string}` {
  return typeof value === "string" && /^0x02(?:[0-9a-f]{2})+$/.test(value);
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
async function readPrivate(path: string): Promise<unknown> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o077, 0);
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  return data;
}
async function persist(path: string, value: unknown, replace = false) {
  const destination = replace ? `${path}.next` : path;
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === "bigint" ? String(entry) : entry,
      ),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  if (replace) await rename(destination, path);
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
function parseState(value: unknown): PrivateState {
  assert.ok(object(value) && object(value.passwords));
  assert.ok(
    typeof value.port === "number" &&
      Number.isSafeInteger(value.port) &&
      value.port > 1024 &&
      value.port <= 65535,
  );
  for (const key of ["fixture", "password", "token"] as const)
    assert.ok(typeof value[key] === "string" && value[key].length >= 20);
  const passwords = value.passwords;
  assert.ok(
    typeof passwords.postgres === "string" &&
      typeof passwords.yaparena_owner === "string" &&
      typeof passwords.yaparena_runtime === "string",
  );
  assert.ok(
    value.userId === undefined ||
      (typeof value.userId === "string" && /^[1-9][0-9]*$/.test(value.userId)),
  );
  return {
    port: value.port,
    fixture: String(value.fixture),
    password: String(value.password),
    token: String(value.token),
    passwords: {
      postgres: passwords.postgres,
      yaparena_owner: passwords.yaparena_owner,
      yaparena_runtime: passwords.yaparena_runtime,
    },
    ...(value.userId === undefined ? {} : { userId: value.userId }),
  };
}
function parsePrepared(value: unknown): PreparedTestTransfer {
  assert.ok(object(value));
  assert.ok(
    value.environment === "sandbox" &&
      value.chainId === 84532 &&
      value.token === baseSepoliaAsset.token,
  );
  assert.ok(
    typeof value.from === "string" &&
      typeof value.to === "string" &&
      typeof value.amount === "string" &&
      /^[1-9][0-9]*$/.test(value.amount),
  );
  assert.ok(
    typeof value.nonce === "number" &&
      Number.isSafeInteger(value.nonce) &&
      value.nonce >= 0 &&
      typeof value.operationId === "string",
  );
  assert.ok(hex(value.hash));
  assert.ok(serialized(value.serializedTransaction));
  return {
    environment: "sandbox",
    chainId: 84532,
    token: baseSepoliaAsset.token,
    from: getAddress(value.from),
    to: getAddress(value.to),
    amount: BigInt(value.amount),
    nonce: value.nonce,
    operationId: value.operationId,
    hash: value.hash,
    serializedTransaction: value.serializedTransaction,
  };
}
async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
  return port;
}
let previousRpc = Promise.resolve();
const pacedFetch: NonNullable<HttpTransportConfig["fetchFn"]> = async (
  input,
  init,
) => {
  const previous = previousRpc;
  let release = () => {};
  previousRpc = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  try {
    return await fetch(input, init);
  } finally {
    await delay(350);
    release();
  }
};
const transport = () =>
  http("https://sepolia.base.org", {
    timeout: 10_000,
    retryCount: 0,
    fetchFn: pacedFetch,
  });
const adapter = createBaseSepoliaAdapter({
  ...baseSepoliaAsset,
  transport: transport(),
});
const reader = createPublicClient({
  chain: baseSepolia,
  transport: transport(),
});
let owner: pg.Pool | undefined, runtime: pg.Pool | undefined;
let phase = "private setup";
try {
  const keys = await readPrivate(keysPath);
  assert.ok(object(keys));
  const key = (value: unknown): Hex => {
    assert.ok(hex(value));
    return value;
  };
  const accounts = {
    funder: privateKeyToAccount(key(keys.funder)),
    custody: privateKeyToAccount(key(keys.custody)),
    recipient: privateKeyToAccount(key(keys.recipient)),
  };
  let state: PrivateState;
  if (await exists(statePath)) {
    state = parseState(await readPrivate(statePath));
    assert.ok(
      await exists(resolve(directory, "data")),
      "private ledger history missing; reconcile before any replacement",
    );
  } else {
    const standalone: unknown = JSON.parse(
      await readFile("docs/evidence/coin-testnet/acceptance.json", "utf8"),
    );
    assert.ok(object(standalone) && standalone.completed === true);
    const initial = await adapter.balances(accounts.custody.address);
    assert.equal(
      initial.usdc,
      4_000_000n,
      "prior custody float must remain unallocated",
    );
    const secret = () => randomBytes(24).toString("hex");
    state = {
      port: await availablePort(),
      fixture: randomUUID(),
      password: secret(),
      token: createSessionToken().token,
      passwords: {
        postgres: secret(),
        yaparena_owner: secret(),
        yaparena_runtime: secret(),
      },
    };
    await persist(statePath, state);
    const passwordFile = resolve(directory, "bootstrap-password");
    await writeFile(passwordFile, state.passwords.postgres, { mode: 0o600 });
    assert.match(
      (await exec("pg_config", ["--version"])).stdout,
      /^PostgreSQL (17|18)\./,
    );
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
  }
  const pgUrl = (role: keyof PrivateState["passwords"], name = database) => {
    const url = new URL(`postgresql://127.0.0.1:${state.port}/${name}`);
    url.username = role;
    url.password = state.passwords[role];
    return url.href;
  };
  const running = await exec("pg_ctl", [
    "--pgdata",
    resolve(directory, "data"),
    "status",
  ]).then(
    () => true,
    () => false,
  );
  if (!running)
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--log",
      resolve(directory, "postgres.log"),
      "--options",
      `-p ${state.port} -h 127.0.0.1 -k ${directory} -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0`,
      "--wait",
      "start",
    ]);
  phase = "provision isolated owner/runtime database";
  const administrator = new pg.Client({
    connectionString: pgUrl("postgres", "postgres"),
  });
  await administrator.connect();
  try {
    if (
      !(
        await administrator.query(
          "SELECT 1 FROM pg_database WHERE datname=$1",
          [database],
        )
      ).rowCount
    )
      await administrator.query(`CREATE DATABASE ${database}`);
  } finally {
    await administrator.end();
  }
  const provisioner = new pg.Client({ connectionString: pgUrl("postgres") });
  await provisioner.connect();
  try {
    await provisionDatabase(provisioner, state.passwords);
    const migrator = new pg.Client({
      connectionString: pgUrl("yaparena_owner"),
    });
    await migrator.connect();
    try {
      if (state.userId) {
        // This persistent disposable trial may receive reviewed additive
        // migrations while an already-broadcast transaction awaits finality.
        // Preserve their actual execution history. Never auto-migrate a resume
        // or weaken the normal runner's order checks for a fresh database.
        const expected = (await readdir("migrations"))
          .filter((name) => /^\d+.*\.js$/.test(name))
          .map((name) => name.slice(0, -3))
          .sort();
        const applied = await migrator.query<{ name: string }>(
          "SELECT name FROM yaparena_migrations.pgmigrations ORDER BY name",
        );
        assert.deepEqual(
          applied.rows.map((row) => row.name),
          expected,
          "resumed trial requires an explicit reviewed additive migration before continuing",
        );
      } else {
        await runner({
          dbClient: migrator,
          dir: "migrations",
          direction: "up",
          schema: "yaparena",
          migrationsSchema: "yaparena_migrations",
          migrationsTable: "pgmigrations",
          logger: quiet,
          log() {},
        });
      }
    } finally {
      await migrator.end();
    }
    await provisionDatabase(provisioner);
  } finally {
    await provisioner.end();
  }
  owner = new pg.Pool({ connectionString: pgUrl("yaparena_owner") });
  runtime = new pg.Pool({ connectionString: pgUrl("yaparena_runtime") });
  const ownerPool = owner,
    runtimePool = runtime;
  if (!state.userId) {
    await ownerPool.query(
      "UPDATE coin_sandbox_controls SET rail='base-sepolia' WHERE singleton=true",
    );
  }
  // Sign-in runs the same post-callback function as the Auth0 callback, with
  // this fixture's stable synthetic email-code identity.
  const identity = {
    subject: `email|testnet-${state.fixture}`,
    email: `${state.fixture}@example.test`,
    method: "email" as const,
    authTime: Math.floor(Date.now() / 1000),
  };
  const sessions = createSessionRepository(runtimePool);
  if (!(await sessions.findUserByTokenHash(hashSessionToken(state.token)))) {
    const signedIn = await createAuth0Accounts(runtimePool).signIn(
      identity,
      { purpose: "sign_in" },
      {
        tokenHash: hashSessionToken(state.token),
        expiresAt: new Date(Date.now() + 7_200_000),
      },
    );
    assert.equal(signedIn.kind, "session");
    if (signedIn.kind === "session") {
      assert.ok(!state.userId || state.userId === signedIn.user.id);
      state.userId = signedIn.user.id;
      await persist(statePath, state, true);
    }
  }
  const userId = state.userId;
  assert.ok(userId);
  const context = { userId, sessionTokenHash: hashSessionToken(state.token) };
  const proofs = createAccountOperationRepository(runtimePool);
  // Decision 0009, point 8: each confirmation stands for a fresh sign-in by
  // this account's subject after the challenge was created.
  async function confirmed(purpose: string, terms: Record<string, string>) {
    const issued = await proofs.create({ ...context, purpose, terms });
    await proofs.confirm({
      id: issued.id,
      userId: context.userId,
      identity: {
        subject: identity.subject,
        authTime: Math.ceil(Date.now() / 1000),
      },
    });
    return {
      id: issued.id,
      approval: await proofs.prepare({
        ...context,
        id: issued.id,
        purpose,
        terms,
        requestId: randomUUID(),
      }),
    };
  }
  const config = {
    rail: "base-sepolia" as const,
    depositDestination: accounts.custody.address,
    withdrawalFee: "0",
  };
  // Decision 0013: the account's first request (the funding quote below)
  // opens its sandbox; no opening confirmation exists any more.
  const app = createCoinSandboxRepository(runtimePool, config);
  const operator = createCoinSandboxOperatorRepository(ownerPool, config);
  const funding = await app.quoteFunding(context, {
    idempotencyKey: "actual-chain-funded-issuance-v1",
    amount: "6000000",
  });
  phase = "prepare or recover incoming test deposit";
  const fundingPath = resolve(directory, "funding-signed.json");
  let funded: PreparedTestTransfer;
  if (await exists(fundingPath))
    funded = parsePrepared(await readPrivate(fundingPath));
  else {
    const nonce = await reader.getTransactionCount({
      address: accounts.funder.address,
      blockTag: "latest",
    });
    funded = await adapter.prepareTransfer(
      {
        environment: "sandbox",
        chainId: 84532,
        token: baseSepoliaAsset.token,
        from: accounts.funder.address,
        to: accounts.custody.address,
        amount: 6_000_000n,
      },
      accounts.funder,
      { nonce, operationId: funding.id },
    );
    await persist(fundingPath, funded);
  }
  assert.equal(funded.operationId, funding.id);
  assert.equal(funded.amount, 6_000_000n);
  assert.equal(funded.from, accounts.funder.address);
  assert.equal(funded.to, accounts.custody.address);
  await validatePreparedTestTransfer(funded);
  await adapter.broadcastPrepared(funded);
  const fundingObservation = await adapter.inspectTransfer(
    funded,
    funded.hash,
    funded.nonce,
  );
  let payout: PreparedTestTransfer | null = null,
    payoutObservation: TestTransferObservation | null = null;
  if (fundingObservation.status === "completed") {
    phase = "credit finalized deposit exactly once";
    const fundingReceipt = createBaseSepoliaReceipt(funded, fundingObservation);
    await operator.confirmFunding({
      userId,
      requestId: funding.id,
      receipt: fundingReceipt,
    });
    const repeat = await operator.confirmFunding({
      userId,
      requestId: funding.id,
      receipt: fundingReceipt,
    });
    assert.equal(repeat.created, false);
    const quoted = await app.quoteWithdrawal(context, {
      idempotencyKey: "actual-chain-password-approved-payout-v1",
      gross: "5000000",
      destination: accounts.recipient.address,
    });
    let withdrawal = await app.getRequest(context, quoted.id);
    if (withdrawal.status === "quoted") {
      phase = "verify fresh exact withdrawal confirmation";
      const { approval } = await confirmed(
        "withdrawal.request",
        withdrawalApprovalTerms(withdrawal),
      );
      withdrawal = await app.requestWithdrawal(context, {
        requestId: withdrawal.id,
        approval,
      });
    }
    if (withdrawal.status === "review")
      withdrawal = await operator.review({
        userId,
        requestId: withdrawal.id,
        decision: "approve",
        idempotencyKey: "manual-actual-chain-review-v1",
      });
    phase = "persist immutable signed payout reservation before broadcast";
    const existing = (
      await ownerPool.query<{
        transactionId: string;
        nonce: string;
        signedBytes: string;
      }>(
        'SELECT transaction_id AS "transactionId",nonce::text,signed_bytes AS "signedBytes" FROM coin_nonce_reservations WHERE request_id=$1',
        [withdrawal.id],
      )
    ).rows[0];
    if (existing)
      payout = parsePrepared({
        environment: "sandbox",
        chainId: 84532,
        token: baseSepoliaAsset.token,
        from: accounts.custody.address,
        to: withdrawal.terms.destination,
        amount: withdrawal.terms.net,
        operationId: withdrawal.id,
        nonce: Number(existing.nonce),
        hash: existing.transactionId,
        serializedTransaction: existing.signedBytes,
      });
    else {
      const nonce = await reader.getTransactionCount({
        address: accounts.custody.address,
        blockTag: "latest",
      });
      payout = await adapter.prepareTransfer(
        {
          environment: "sandbox",
          chainId: 84532,
          token: baseSepoliaAsset.token,
          from: accounts.custody.address,
          to: accounts.recipient.address,
          amount: BigInt(withdrawal.terms.net!),
        },
        accounts.custody,
        { nonce, operationId: withdrawal.id },
      );
      await operator.reserveSignedPayout({
        userId,
        requestId: withdrawal.id,
        prepared: payout,
      });
    }
    const duplicateReservation = await operator.reserveSignedPayout({
      userId,
      requestId: withdrawal.id,
      prepared: payout,
    });
    assert.equal(duplicateReservation.created, false);
    phase = "broadcast reserved original payout and reconcile";
    await adapter.broadcastPrepared(payout);
    payoutObservation = await adapter.inspectTransfer(
      payout,
      payout.hash,
      payout.nonce,
    );
    const event = {
      id: `chain:${payout.hash}:${payoutObservation.status}`,
      externalId: withdrawal.id,
      termsDigest: withdrawal.termsDigest,
      source: "reconciliation" as const,
      status: payoutObservation.status,
      finalNoTransfer: payoutObservation.finalNoTransfer,
      transactionId:
        payoutObservation.status === "completed" ? payout.hash : null,
    };
    const receipt =
      payoutObservation.status === "completed"
        ? createBaseSepoliaReceipt(payout, payoutObservation)
        : undefined;
    await operator.observe({
      userId,
      requestId: withdrawal.id,
      event,
      receipt,
    });
    const repeated = await operator.observe({
      userId,
      requestId: withdrawal.id,
      event,
      receipt,
    });
    assert.equal(repeated.created, false);
  }
  phase = "external and application balance reconciliation";
  const balances = {
    funder: await adapter.balances(accounts.funder.address),
    custody: await adapter.balances(accounts.custody.address),
    recipient: await adapter.balances(accounts.recipient.address),
  };
  const summary = await app.summary(context);
  const completed =
    fundingObservation.status === "completed" &&
    payoutObservation?.status === "completed";
  if (completed) {
    assert.equal(balances.funder.usdc, 9_000_000n);
    assert.equal(balances.custody.usdc, 5_000_000n);
    assert.equal(balances.recipient.usdc, 6_000_000n);
    assert.equal(summary.balances.cashAvailable, "1000000");
    assert.equal(summary.balances.pending, "0");
    assert.equal(summary.balances.reserved, "0");
    assert.equal(
      BigInt(summary.balances.cashAvailable) + 4_000_000n,
      balances.custody.usdc,
    );
  }
  const evidence = {
    at: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    scope:
      "Actual valueless Base Sepolia transfers integrated with real isolated PostgreSQL runtime/owner repositories, synthetic password authentication and manual test review. Not hosted/provider/live acceptance.",
    completed,
    asset: baseSepoliaAsset,
    priorUnallocatedCustodyAtomic: "4000000",
    fee: {
      testUsdcAtomic: "0",
      gas: "valueless operator test ETH; not a live fee quote",
    },
    funding: {
      requestId: funding.id,
      transactionId: funded.hash,
      amount: "6000000",
      observation: fundingObservation,
    },
    payout: payout
      ? {
          requestId: payout.operationId,
          transactionId: payout.hash,
          amount: String(payout.amount),
          observation: payoutObservation,
        }
      : null,
    balances,
    application: {
      balances: summary.balances,
      rail: summary.rail,
      simulation: summary.simulation,
    },
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "scripts/verify-coin-testnet-ledger.ts",
          "src/features/account-wallet/base-sepolia.ts",
          "dist/features/account-wallet/sandbox-repository.js",
        ].map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]),
      ),
    ),
    outstanding: completed
      ? []
      : [
          fundingObservation.status === "completed"
            ? "finalized reserved payout reconciliation"
            : "finalized incoming deposit before any issuance/payout",
        ],
  };
  const reportPath = resolve(artifactDirectory, "acceptance.json");
  const pendingReportPath = `${reportPath}.next`;
  await writeFile(
    pendingReportPath,
    await format(
      JSON.stringify(evidence, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
      { parser: "json" },
    ),
  );
  await rename(pendingReportPath, reportPath);
  console.log(
    JSON.stringify({
      completed,
      funding: fundingObservation.status,
      payout: payoutObservation?.status ?? "not prepared",
      applicationBalances: summary.balances,
      evidence: "docs/evidence/coin-testnet/ledger/acceptance.json",
    }),
  );
  if (!completed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category: error instanceof Error ? error.name : "unclassified",
      databaseCode:
        object(error) &&
        typeof error.code === "string" &&
        /^[0-9A-Z]{5}$/.test(error.code)
          ? error.code
          : null,
      migrationOrder:
        error instanceof Error &&
        /^Not run migration [0-9A-Za-z_-]+ is preceding already run migration [0-9A-Za-z_-]+$/.test(
          error.message,
        )
          ? error.message
          : null,
      action:
        "Preserve the private cluster, operation records and keys; no signing inputs or credentials printed.",
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.all([runtime?.end(), owner?.end()]);
  await lock.close();
  await rm(lockPath);
  // Deliberately retain this isolated cluster and its immutable nonce history
  // while chain outcomes are pending. Never delete/reinitialize to retry.
}
