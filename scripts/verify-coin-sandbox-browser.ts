// Coin sandbox browser acceptance against a real local backend. It creates
// its own native PostgreSQL cluster, migrates it, serves the built
// account-coins.js on a fixture coins page at /coins and mounts the real
// coin sandbox and auth routers. Sign-in confirmation (Decision 0009, point 8)
// runs against the in-process OpenID Connect issuer (oidc-test-issuer.ts),
// whose stand-in Universal Login page Chrome drives: opening the sandbox, a
// withdrawal and a recovery cost consent are each confirmed by signing in
// again, and a cancelled provider sign-in, a sign-in as another account, a
// forged or replayed return and a confirmation that returns after its five
// minutes change nothing. Grants, simulated funding, debate rounds, error
// reports, the correction hold, account switches, logout and keyboard, mobile
// and zoom checks run at desktop and mobile widths.
//
//   npm run build
//   node scripts/verify-coin-sandbox-browser.ts
//
// PostgreSQL 17 or 18 binaries (initdb, pg_ctl, pg_config) must be on PATH;
// BROWSER_CHROME_PATH overrides the Chrome executable. Screenshots and
// results.json go to COIN_BROWSER_ARTIFACT_DIR (default
// /tmp/yaparena-coin-sandbox-browser), outside the repository: attach them to
// the pull request or CI artifacts. COIN_BROWSER_DEBUG=1 also prints the
// underlying error on failure. All identities and funds are synthetic.
// It never reads .env or a database URL and does not establish hosted Auth0,
// provider-chain, physical-device or screen-reader acceptance.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import cookieParser from "cookie-parser";
import express from "express";
import pg from "pg";
import { runner } from "node-pg-migrate";
import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "playwright-core";
import axe from "axe-core";
import type {} from "pino-http";
import { provisionDatabase } from "./provision-database.ts";
import { startIssuer, type TestIssuer } from "./oidc-test-issuer.ts";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createAuth0Client } from "../dist/platform/auth/auth0.js";
import { createAuth0Accounts } from "../dist/platform/auth/auth0-accounts.js";
import { createSignInState } from "../dist/platform/auth/sign-in-state.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import {
  createAuthRouter,
  createRequireAuthentication,
} from "../dist/platform/auth/router.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";
import {
  createSandboxErrorReports,
  createSandboxErrorReportOperator,
} from "../dist/features/account-wallet/sandbox-reports.js";

const exec = promisify(execFile),
  secret = () => randomBytes(24).toString("hex");
const passwords = {
  postgres: secret(),
  yaparena_owner: secret(),
  yaparena_runtime: secret(),
};
const databaseName = "revocation_test_coin_browser",
  clientId = "coin-browser-client-0123456789",
  clientSecret = `coin-browser-secret-${secret()}`;
const directory = await mkdtemp("/private/tmp/yaparena-coin-browser-");
const evidenceDirectory = resolve(
  process.env.COIN_BROWSER_ARTIFACT_DIR ?? "/tmp/yaparena-coin-sandbox-browser",
);
await mkdir(evidenceDirectory, { recursive: true });
let browser: Browser | undefined,
  runtime: pg.Pool | undefined,
  owner: pg.Pool | undefined,
  issuer: TestIssuer | undefined,
  lastPage: Page | undefined;
let server: ReturnType<express.Express["listen"]> | undefined,
  started = false,
  phase = "provision isolated native PostgreSQL";
const checks: string[] = [],
  errors: string[] = [],
  failures: { route: string; status: number }[] = [];
const accessibilityFailures: {
  phase: string;
  id: string;
  impact: string | null | undefined;
}[] = [];
const layoutFailures: {
  phase: string;
  viewport: number;
  documentWidth: number;
  elements: { tag: string; id: string; left: number; right: number }[];
}[] = [];
const quiet = { info() {}, warn() {}, error() {} };
const evidenceSources = [
  "scripts/verify-coin-sandbox-browser.ts",
  "scripts/oidc-test-issuer.ts",
  "public/account-coins.js",
  "public/session-coordination.js",
  "public/account-auth.css",
  "frontend/account-coins.ts",
  "frontend/session-coordination.ts",
  "frontend/auth-events.ts",
  "migrations/1792426018000_add-sign-in-confirmation.js",
  ...[
    "sandbox-repository",
    "sandbox-router",
    "sandbox-reports",
    "debate-sandbox",
    "grant-accounting",
    "ledger",
    "external-operations",
  ].flatMap((name) => [
    `src/features/account-wallet/${name}.ts`,
    `dist/features/account-wallet/${name}.js`,
  ]),
  ...[
    "account-operations",
    "auth0",
    "auth0-accounts",
    "router",
    "sessions",
    "sign-in-pages",
    "sign-in-state",
  ].flatMap((name) => [
    `src/platform/auth/${name}.ts`,
    `dist/platform/auth/${name}.js`,
  ]),
];
// The account page the coin sandbox returns to after a confirmation.
const accountReturn = "/coins#coin-sandbox",
  confirmationKey = "yaparena-coin-confirmation",
  settled =
    "Sandbox balances refreshed. Simulated withdrawals require manual operator review.",
  spentConfirmation = "confirmation expired or invalid; start again";
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    socket.close((error) => (error ? fail(error) : done())),
  );
  return port;
}
function databaseUrl(port: number, role: keyof typeof passwords, name: string) {
  const url = new URL(`postgresql://127.0.0.1:${port}/${name}`);
  url.username = role;
  url.password = passwords[role];
  return url.href;
}
async function sourceHash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function selectCookie(
  context: BrowserContext,
  origin: string,
  token: string,
) {
  await context.addCookies([
    {
      name: "session",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function announceAccount(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("yap:provider-logout"));
    window.dispatchEvent(new Event("yap:account-changed"));
  });
}
async function openDetails(details: Locator) {
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
// Call before the action: the operation is created (201) and the page then
// navigates to its confirmation link with the account page as the return.
// The response body is gone once the page navigates, so the operation comes
// from the link the browser followed.
function expectConfirmation(page: Page, creation: string | RegExp) {
  const created = page.waitForResponse(posted(creation)),
    navigated = page.waitForRequest(
      (sent) =>
        sent.isNavigationRequest() &&
        new URL(sent.url()).pathname === "/api/auth/confirm",
    );
  return (async () => {
    const [response, navigation] = await Promise.all([created, navigated]);
    assert.equal(response.status(), 201);
    const link = new URL(navigation.url()),
      id = link.searchParams.get("operation");
    assert.ok(id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id));
    assert.equal(link.searchParams.get("return"), accountReturn);
    return { id, confirmPath: `/api/auth/confirm?operation=${id}` };
  })();
}
async function errorOf(response: APIResponse) {
  const body: unknown = await response.json();
  return body !== null && typeof body === "object" && "error" in body
    ? body.error
    : undefined;
}
function posted(path: string | RegExp) {
  return (response: Response) =>
    response.request().method() === "POST" &&
    (typeof path === "string"
      ? new URL(response.url()).pathname === path
      : path.test(new URL(response.url()).pathname));
}
function observe(page: Page) {
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push({
        route: new URL(response.url()).pathname.replace(
          /[a-f0-9]{8}-[a-f0-9-]{27,}/g,
          ":id",
        ),
        status: response.status(),
      });
  });
}
async function automatedA11y(page: Page) {
  await page.waitForFunction(() => Boolean(window.axe));
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run("main, dialog[open]", {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      })
    ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
  );
  for (const entry of violations)
    accessibilityFailures.push({ phase, ...entry });
  assert.deepEqual(violations, []);
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    elements: Array.from(document.querySelectorAll("main *"))
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        left: Math.floor(element.getBoundingClientRect().left),
        right: Math.ceil(element.getBoundingClientRect().right),
      }))
      .filter((element) => element.right > innerWidth || element.left < 0)
      .slice(0, 15),
  }));
  if (layout.documentWidth > layout.viewport)
    layoutFailures.push({ phase, ...layout });
  assert.ok(layout.documentWidth <= layout.viewport);
  const dialogFits = await page.evaluate(() =>
    Array.from(document.querySelectorAll("dialog[open]")).every((dialog) => {
      const rectangle = dialog.getBoundingClientRect();
      return rectangle.left >= 0 && rectangle.right <= innerWidth;
    }),
  );
  assert.equal(dialogFits, true);
}

try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      evidenceSources.map(async (path) => [path, await sourceHash(path)]),
    ),
  );
  const postgresVersion = (
    await exec("pg_config", ["--version"])
  ).stdout.trim();
  assert.match(postgresVersion, /^PostgreSQL (17|18)\./);
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
  const port = await availablePort();
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
  const admin = new pg.Client({
    connectionString: databaseUrl(port, "postgres", "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const provisioner = new pg.Client({
    connectionString: databaseUrl(port, "postgres", databaseName),
  });
  await provisioner.connect();
  try {
    await provisionDatabase(provisioner, passwords);
    const migrationOwner = new pg.Client({
      connectionString: databaseUrl(port, "yaparena_owner", databaseName),
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
  runtime = new pg.Pool({
    connectionString: databaseUrl(port, "yaparena_runtime", databaseName),
  });
  owner = new pg.Pool({
    connectionString: databaseUrl(port, "yaparena_owner", databaseName),
  });
  const runtimePool = runtime,
    ownerPool = owner,
    sessions = createSessionRepository(runtimePool),
    operations = createAccountOperationRepository(runtimePool),
    accounts = createAuth0Accounts(runtimePool);
  const sandbox = createCoinSandboxRepository(runtimePool, {
      rail: "simulation",
    }),
    operator = createCoinSandboxOperatorRepository(ownerPool, {
      rail: "simulation",
    }),
    reports = createSandboxErrorReports(runtimePool, "simulation"),
    reportOperator = createSandboxErrorReportOperator(ownerPool, "simulation"),
    debates = createCoinDebateSandbox(runtimePool, "simulation");
  // An account made by the same post-callback function as the Auth0
  // callback, so its email subject can sign in again at the provider page.
  async function fixture() {
    const identity = {
        subject: `email|${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
      session = createSessionToken();
    const result = await accounts.signIn(
      {
        ...identity,
        method: "email",
        authTime: Math.floor(Date.now() / 1000),
      },
      { purpose: "sign_in" },
      {
        tokenHash: session.tokenHash,
        expiresAt: new Date(Date.now() + 1800000),
      },
    );
    if (result.kind !== "session")
      throw new Error("fixture account did not receive a session");
    return { userId: result.user.id, token: session.token, identity };
  }
  async function count(sql: string, values: unknown[]) {
    return (await ownerPool.query<{ n: number }>(sql, values)).rows[0]!.n;
  }
  const topic = (
    await ownerPool.query<{ id: string }>(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Browser sandbox fixture','Synthetic local fixture','Support','Oppose','published') RETURNING id",
      [`coin-browser-${randomUUID()}`],
    )
  ).rows[0]!;
  for (const proposition of [
    "First synthetic YES/NO debate",
    "Second synthetic YES/NO debate",
  ])
    await ownerPool.query(
      "INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,rules_snapshot) VALUES($1,$2,$3,'scheduled','published','preview-1','{}')",
      [topic.id, `coin-browser-${randomUUID()}`, proposition],
    );
  phase = "start the local sign-in provider and application";
  issuer = await startIssuer({ clientId, clientSecret });
  const provider = issuer;
  // The application is on localhost and the provider on 127.0.0.1, so the
  // provider's redirect to the callback is cross-site, as with Auth0.
  const applicationPort = await availablePort(),
    origin = `http://localhost:${applicationPort}`,
    authenticated = createRequireAuthentication({
      sessions,
      environment: "test",
    });
  let dailyGate:
    | {
        arrived: ReturnType<typeof deferred>;
        finish: ReturnType<typeof deferred>;
      }
    | undefined;
  let summaryGate:
    | {
        userId: string;
        arrived: ReturnType<typeof deferred>;
        finish: ReturnType<typeof deferred>;
      }
    | undefined;
  const app = express();
  app.use(express.json({ limit: "64kb" }), cookieParser());
  app.use((request, _response, next) => {
    request.id = randomUUID();
    next();
  });
  app.use("/assets", express.static(resolve("public")));
  app.get("/axe.js", (_request, response) =>
    response.type("js").send(axe.source),
  );
  app.get("/coins", (_request, response) =>
    response.send(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>YapArena coin sandbox browser acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/assets/session-coordination.js"></script><script defer src="/axe.js"></script></head><body class="account-page"><main class="container"><h1>Account and coins</h1><p>LOCAL REAL BACKEND · Synthetic accounts · Deterministic simulation · Local sign-in provider · No live funds</p><section id="account-wallet" class="coin-wallet"></section></main><script type="module" src="/assets/account-coins.js"></script></body></html>`,
    ),
  );
  app.get("/api/public/debates", async (_request, response) =>
    response.json({
      items: (
        await runtimePool.query(
          "SELECT id,proposition FROM debates WHERE topic_id=$1 ORDER BY proposition",
          [topic.id],
        )
      ).rows,
    }),
  );
  app.use(
    "/api/auth",
    createAuthRouter({
      sessions,
      environment: "test",
      applicationOrigin: origin,
      authRateLimit: 10000,
      auth0: {
        client: createAuth0Client(
          { issuer: new URL(provider.issuer), clientId, clientSecret },
          { redirectUri: `${origin}/api/auth/callback` },
        ),
        accounts,
        state: createSignInState(runtimePool),
      },
      operations,
    }),
  );
  app.use(
    "/api/coin-sandbox",
    authenticated,
    async (request, _response, next) => {
      const heldSummary = summaryGate;
      if (
        heldSummary &&
        request.path === "/summary" &&
        request.method === "GET" &&
        request.user?.id === heldSummary.userId
      ) {
        summaryGate = undefined;
        heldSummary.arrived.release();
        await heldSummary.finish.promise;
      }
      const gate = dailyGate;
      if (
        gate &&
        request.path === "/grants/daily" &&
        request.method === "POST"
      ) {
        dailyGate = undefined;
        gate.arrived.release();
        await gate.finish.promise;
      }
      next();
    },
    createCoinSandboxRouter({
      sandbox,
      debates,
      reports,
      operations,
      environment: "test",
      applicationOrigin: origin,
    }),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      errors.push(
        error instanceof Error ? error.name : "unclassified backend failure",
      );
      response.status(500).json({ error: "isolated backend failure" });
    },
  );
  server = app.listen(applicationPort, "127.0.0.1");
  await once(server, "listening");

  // The confirmation link sends the browser to the provider with
  // prompt=login and max_age=0, hinting the account's own address.
  async function atProvider(page: Page, email: string) {
    await page.waitForURL((url) => `${url.origin}/` === provider.issuer);
    const request = provider.requests.at(-1);
    assert.ok(request);
    assert.equal(request.prompt, "login");
    assert.equal(request.max_age, "0");
    assert.equal(request.login_hint, email);
    assert.equal(request.redirect_uri, `${origin}/api/auth/callback`);
  }
  async function signInAtProvider(
    page: Page,
    expected: { email: string },
    signInAs: { subject: string; email: string },
  ) {
    await atProvider(page, expected.email);
    provider.setNext(signInAs);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  // The callback's problem page explains what happened and links back.
  async function explained(
    page: Page,
    title: string,
    message: string,
    screenshot?: string,
  ) {
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    assert.equal(
      (await page.getByRole("alert").innerText()).trim(),
      message.trim(),
    );
    assert.equal(
      await page.getByRole("link", { name: "Try again", exact: true }).count(),
      0,
    );
    await page.addScriptTag({ content: axe.source });
    await automatedA11y(page);
    if (screenshot)
      await page.screenshot({
        path: resolve(evidenceDirectory, screenshot),
        fullPage: true,
      });
    await page
      .getByRole("link", { name: "Back to YAP Arena", exact: true })
      .click();
    await page.waitForURL(`${origin}${accountReturn}`);
  }
  async function storePending(page: Page, entry: Record<string, unknown>) {
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [
      confirmationKey,
      JSON.stringify(entry),
    ] as const);
  }

  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1100 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    phase = `${name}: unopened account offers confirmation by signing in again`;
    const account = await fixture(),
      replacement = await fixture(),
      currentToken = account.token,
      accountContext = {
        userId: account.userId,
        sessionTokenHash: hashSessionToken(currentToken),
      },
      context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await selectCookie(context, origin, account.token);
    const page = await context.newPage();
    lastPage = page;
    observe(page);
    async function moneyState() {
      const summary = await sandbox.summary(accountContext),
        counts = (
          await ownerPool.query<{
            journals: number;
            receipts: number;
            requests: number;
          }>(
            "SELECT (SELECT count(*)::int FROM coin_journals) AS journals,(SELECT count(*)::int FROM coin_external_receipts) AS receipts,(SELECT count(*)::int FROM coin_sandbox_requests) AS requests",
          )
        ).rows[0]!;
      return {
        balances: summary.balances,
        projection: summary.projection,
        requests: summary.requests,
        counts,
      };
    }
    const openings = () =>
      count(
        "SELECT count(*)::int n FROM coin_sandbox_openings WHERE user_id=$1",
        [account.userId],
      );
    await page.goto(`${origin}/coins`);
    const root = page.locator("#coin-sandbox"),
      notice = root.locator("[data-coin-notice]"),
      opening = root.locator("[data-coin-opening]"),
      confirmOpen = root.locator("[data-coin-confirm-open]");
    await root.getByText(settled, { exact: true }).waitFor();
    await confirmOpen.waitFor();
    assert.equal(await confirmOpen.innerText(), "Confirm by signing in again");
    assert.match(
      await opening.innerText(),
      /Confirm it's you to open the financial sandbox\. You'll sign in again once; withdrawals and recovery consents ask each time\./,
    );
    assert.equal(await root.locator("[data-coin-initialize]").isHidden(), true);
    const unopened = await sandbox.summary(accountContext);
    assert.equal(unopened.opened, false);
    const refused = await context.request.post(
      `${origin}/api/coin-sandbox/initialize`,
      {
        headers: { Origin: origin, "X-YapArena-Session": unopened.sessionId },
        data: {},
      },
    );
    assert.equal(refused.status(), 403);
    assert.equal(
      await errorOf(refused),
      "confirm by signing in again to open the financial sandbox",
    );
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `before-${name}.png`),
      fullPage: true,
    });
    // Money-moving controls stay hidden until the sandbox is opened, and the
    // server refuses them anyway.
    assert.equal(await root.locator("[data-coin-daily]").isHidden(), true);
    for (const form of [
      "[data-coin-funding]",
      "[data-coin-withdraw]",
      "[data-coin-participate]",
    ])
      assert.equal(
        await root.locator(`details:has(${form})`).isHidden(),
        true,
        form,
      );
    const refusedDaily = await context.request.post(
      `${origin}/api/coin-sandbox/grants/daily`,
      {
        headers: { Origin: origin, "X-YapArena-Session": unopened.sessionId },
        data: {},
      },
    );
    assert.equal(refusedDaily.status(), 403);
    assert.equal(
      await errorOf(refusedDaily),
      "confirm by signing in again to open the financial sandbox",
    );
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1",
        [account.userId],
      ),
      0,
    );
    checks.push(
      `${name}: an unopened account sees "Confirm by signing in again" with its explanation and no grant, purchase, withdrawal or debate controls; the real API refuses the welcome and daily grants with 403 and no grant is created`,
    );

    phase = `${name}: a cancelled provider sign-in leaves the sandbox unopened`;
    const cancelledOperation = expectConfirmation(
      page,
      "/api/coin-sandbox/opening/operations",
    );
    await confirmOpen.focus();
    await page.keyboard.press("Enter");
    await cancelledOperation;
    await atProvider(page, account.identity.email);
    await page.screenshot({
      path: resolve(evidenceDirectory, `opening-provider-${name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await explained(
      page,
      "Sign-in cancelled",
      "Sign-in was cancelled. Nothing changed.",
    );
    await root.getByText(settled, { exact: true }).waitFor();
    await confirmOpen.waitFor();
    assert.equal(await openings(), 0);

    phase = `${name}: signing in as another account confirms nothing`;
    const foreignOperation = expectConfirmation(
      page,
      "/api/coin-sandbox/opening/operations",
    );
    await confirmOpen.click();
    const foreign = await foreignOperation;
    await signInAtProvider(page, account.identity, replacement.identity);
    await explained(
      page,
      "Not confirmed",
      "You signed in with a different account, so nothing changed. Sign in as the account that started this action.",
      `opening-other-account-${name}.png`,
    );
    const stillSignedIn = await context.request.get(`${origin}/api/auth/me`);
    assert.equal(stillSignedIn.status(), 200);
    const me: unknown = await stillSignedIn.json();
    assert.ok(
      me !== null &&
        typeof me === "object" &&
        "user" in me &&
        me.user !== null &&
        typeof me.user === "object" &&
        "id" in me.user,
    );
    assert.equal(String(me.user.id), account.userId);
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM account_operations WHERE id=$1 AND confirmed_at IS NULL AND consumed_at IS NULL",
        [foreign.id],
      ),
      1,
    );
    await confirmOpen.waitFor();
    assert.equal(await openings(), 0);

    phase = `${name}: a forged return with an unconfirmed operation opens nothing`;
    const forged = page.waitForResponse(posted("/api/coin-sandbox/opening"));
    await page.goto(`${origin}/coins?confirmed=${foreign.id}#coin-sandbox`);
    assert.equal((await forged).status(), 410);
    await notice.filter({ hasText: spentConfirmation }).waitFor();
    assert.equal(page.url(), `${origin}${accountReturn}`);
    await confirmOpen.waitFor();
    assert.equal(await openings(), 0);
    assert.equal((await sandbox.summary(accountContext)).opened, false);
    checks.push(
      `${name}: a cancelled provider sign-in and a sign-in as another account's subject each return to an accessible page that explains nothing changed (no retry link, the device keeps its own session); returning with ?confirmed= for that unconfirmed operation is refused with 410 and the sandbox stays unopened`,
    );

    phase = `${name}: confirming by signing in again opens the sandbox once`;
    const openingOperation = expectConfirmation(
      page,
      "/api/coin-sandbox/opening/operations",
    );
    await confirmOpen.focus();
    await page.keyboard.press("Enter");
    const opened = await openingOperation;
    await signInAtProvider(page, account.identity, account.identity);
    await notice
      .filter({
        hasText:
          "Sandbox opened. You can now claim grants and use simulated funds.",
      })
      .waitFor();
    assert.equal(page.url(), `${origin}${accountReturn}`);
    assert.equal(await opening.isHidden(), true);
    await root.locator("[data-coin-initialize]").waitFor();
    assert.equal(await openings(), 1);
    assert.deepEqual(
      (
        await ownerPool.query<{
          operationId: string;
          subject: string;
          consumed: boolean;
        }>(
          `SELECT c.operation_id::text AS "operationId",o.confirmed_subject AS subject,o.consumed_at IS NOT NULL AS consumed
           FROM coin_sandbox_openings c JOIN account_operations o ON o.id=c.operation_id WHERE c.user_id=$1`,
          [account.userId],
        )
      ).rows,
      [
        {
          operationId: opened.id,
          subject: account.identity.subject,
          consumed: true,
        },
      ],
    );
    assert.equal(
      (await context.cookies(origin)).find(
        (cookie) => cookie.name === "session",
      )?.value,
      currentToken,
    );
    await automatedA11y(page);
    checks.push(
      `${name}: "Confirm by signing in again" reaches the provider with prompt=login, max_age=0 and the account's own address; signing in as the same account returns to /coins, opens the sandbox exactly once with that operation and subject, keeps the device's session and removes ?confirmed= from the address`,
    );

    phase = `${name}: exactly-once grants and funded issuance`;
    await root.locator("[data-coin-initialize]").focus();
    await page.keyboard.press("Enter");
    await root.locator("[data-coin-initialize]").waitFor({ state: "hidden" });
    await root.locator("[data-coin-daily]").click();
    await root.getByText(/Daily grant:/).waitFor();
    await root.locator("[data-coin-daily]").click();
    await root.getByText(settled, { exact: true }).waitFor();
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1 AND kind='daily'",
        [account.userId],
      ),
      1,
    );
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1 AND kind='welcome'",
        [account.userId],
      ),
      1,
    );
    await openDetails(root.locator("details:has([data-coin-funding])"));
    page.once("dialog", (dialog) => void dialog.accept());
    await root
      .locator("[data-coin-funding]")
      .getByRole("button", { name: "Get simulated quote", exact: true })
      .click();
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("1000 YC", { exact: true })
      .waitFor();
    const funded = await sandbox.summary(accountContext);
    assert.equal(funded.projection.purchasedPrincipal, "10000000");
    assert.equal(funded.projection.withdrawable, "10000000");
    checks.push(
      `${name}: actual runtime-role API issues one welcome/daily grant, preserves spend-only principal, and confirms a 10 simulated USDC purchase as 1000 withdrawal-eligible YC without any grant target`,
    );

    phase = `${name}: withdrawal review, confirmation by signing in again and manual-review receipt`;
    await openDetails(root.locator("details:has([data-coin-withdraw])"));
    await root
      .locator("[data-coin-withdraw] input[name=destination]")
      .fill("synthetic-external-wallet");
    let reviewMessage = "";
    page.once("dialog", (dialog) => {
      reviewMessage = dialog.message();
      void dialog.accept();
    });
    const withdrawalOperation = expectConfirmation(
      page,
      /^\/api\/coin-sandbox\/withdrawals\/[^/]+\/operations$/,
    );
    await root
      .locator("[data-coin-withdraw]")
      .getByRole("button", {
        name: "Review amount and network fee",
        exact: true,
      })
      .focus();
    await page.keyboard.press("Enter");
    const withdrawal = await withdrawalOperation;
    assert.equal(
      reviewMessage,
      "SIMULATION ONLY\nDeduct: 5.0 USDC\nNetwork fee included: 0.1 USDC\nWallet receives: 4.9 USDC\nDestination: synthetic-external-wallet\nManual review; no real payment. Continue to confirm by signing in again?",
    );
    await atProvider(page, account.identity.email);
    const awaiting = await sandbox.summary(accountContext);
    assert.equal(awaiting.balances.cashAvailable, "10000000");
    assert.equal(awaiting.balances.reserved, "0");
    await signInAtProvider(page, account.identity, account.identity);
    await root
      .locator("[data-coin-receipts]")
      .getByText(
        /withdrawal · review · deduct 5\.0 USDC, fee 0\.1 USDC, receive 4\.9 USDC/,
      )
      .waitFor();
    await notice
      .filter({
        hasText:
          "Withdrawal request confirmed. It now waits for manual review.",
      })
      .waitFor();
    assert.equal(page.url(), `${origin}${accountReturn}`);
    const withdrawn = await sandbox.summary(accountContext);
    assert.equal(withdrawn.balances.cashAvailable, "5000000");
    assert.equal(withdrawn.balances.reserved, "5000000");
    assert.equal(withdrawn.balances.pending, "0");
    const request = withdrawn.requests.find(
      (entry) => entry.kind === "withdrawal",
    );
    assert.ok(request);
    assert.equal(request.status, "review");
    assert.deepEqual(
      [request.terms.gross, request.terms.fee, request.terms.net],
      ["5000000", "100000", "4900000"],
    );
    assert.equal(request.terms.destination, "synthetic-external-wallet");
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `withdrawal-receipt-${name}.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: the withdrawal review states exactly 5 gross / 0.1 fee / 4.9 net USDC to the typed destination; nothing is reserved while the provider asks for the sign-in; after signing in again the browser returns and the transactionally reserved funds await manual review with a receipt`,
    );

    phase = `${name}: a reused withdrawal confirmation reserves nothing more`;
    const beforeReuse = await moneyState(),
      resubmissions: string[] = [],
      watchWithdrawal = (sent: Request) => {
        if (
          sent.method() === "POST" &&
          new URL(sent.url()).pathname ===
            `/api/coin-sandbox/withdrawals/${request.id}`
        )
          resubmissions.push(sent.url());
      };
    page.on("request", watchWithdrawal);
    await page.reload();
    await root.getByText(settled, { exact: true }).waitFor();
    assert.deepEqual(resubmissions, []);
    await storePending(page, {
      kind: "withdrawal",
      operationId: withdrawal.id,
      requestId: request.id,
      expiresAt: Date.now() + 240000,
    });
    const replay = page.waitForResponse(
      posted(`/api/coin-sandbox/withdrawals/${request.id}`),
    );
    await page.goto(`${origin}/coins?confirmed=${withdrawal.id}#coin-sandbox`);
    assert.equal((await replay).status(), 410);
    await notice.filter({ hasText: spentConfirmation }).waitFor();
    page.off("request", watchWithdrawal);
    assert.equal(resubmissions.length, 1);
    await page.goto(
      `${origin}${withdrawal.confirmPath}&return=${encodeURIComponent(accountReturn)}`,
    );
    await explained(
      page,
      "Confirmation expired",
      "This confirmation expired or was already used, so nothing changed. Start the action again.",
    );
    await root.getByText(settled, { exact: true }).waitFor();
    assert.deepEqual(await moneyState(), beforeReuse);
    checks.push(
      `${name}: reloading the returned page does not resubmit; replaying the consumed confirmation is refused by the real server with 410 and the confirmation link explains it expired, with balances, journals, receipts and requests unchanged`,
    );

    phase = `${name}: a confirmation returning after its five minutes reserves nothing`;
    const late = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
    });
    await selectCookie(late, origin, currentToken);
    const latePage = await late.newPage();
    lastPage = latePage;
    observe(latePage);
    await latePage.goto(`${origin}/coins`);
    const lateRoot = latePage.locator("#coin-sandbox");
    await lateRoot.getByText(settled, { exact: true }).waitFor();
    await openDetails(lateRoot.locator("details:has([data-coin-withdraw])"));
    await lateRoot
      .locator("[data-coin-withdraw] input[name=destination]")
      .fill("synthetic-late-wallet");
    latePage.once("dialog", (dialog) => void dialog.accept());
    const lateOperation = expectConfirmation(
      latePage,
      /^\/api\/coin-sandbox\/withdrawals\/[^/]+\/operations$/,
    );
    await lateRoot
      .locator("[data-coin-withdraw]")
      .getByRole("button", {
        name: "Review amount and network fee",
        exact: true,
      })
      .click();
    const lateConfirmation = await lateOperation;
    await atProvider(latePage, account.identity.email);
    // The person takes longer than five minutes: the page's clock runs six
    // minutes ahead from here, so the stored action has expired on return.
    await late.clock.install({ time: Date.now() + 360000 });
    const lateSubmissions: string[] = [];
    latePage.on("request", (sent) => {
      if (
        sent.method() === "POST" &&
        /^\/api\/coin-sandbox\/withdrawals\/[0-9a-f-]{36}$/.test(
          new URL(sent.url()).pathname,
        )
      )
        lateSubmissions.push(sent.url());
    });
    await signInAtProvider(latePage, account.identity, account.identity);
    await lateRoot
      .locator("[data-coin-notice]")
      .filter({ hasText: "That confirmation expired. Start the action again." })
      .waitFor();
    assert.equal(latePage.url(), `${origin}${accountReturn}`);
    assert.deepEqual(lateSubmissions, []);
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM account_operations WHERE id=$1 AND confirmed_at IS NOT NULL AND consumed_at IS NULL",
        [lateConfirmation.id],
      ),
      1,
    );
    const afterLate = await sandbox.summary(accountContext);
    assert.equal(afterLate.balances.reserved, "5000000");
    assert.equal(afterLate.balances.cashAvailable, "5000000");
    await late.close();
    lastPage = page;
    checks.push(
      `${name}: when the browser returns from a completed sign-in after the five-minute confirmation window (page clock six minutes ahead), it says the confirmation expired and sends no withdrawal request; nothing more is reserved`,
    );

    phase = `${name}: public error report and private evidence review`;
    const reportDescription = `Synthetic ${name} payout question <img data-report-injection src=x>`,
      privateNote = `Private synthetic review ${randomUUID()}`,
      evidenceDigest = createHash("sha256").update(privateNote).digest("hex");
    const beforeReport = await moneyState();
    await root
      .locator("[data-coin-receipts] li")
      .filter({ hasText: request.id })
      .getByRole("button", { name: "Report a problem", exact: true })
      .click();
    const reportForm = root.locator("[data-coin-report]");
    assert.equal(
      await reportForm.getByLabel("Receipt ID").inputValue(),
      request.id,
    );
    assert.equal(
      await reportForm
        .getByLabel("What happened?")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await reportForm.getByLabel("What happened?").fill(reportDescription);
    await reportForm
      .getByRole("button", { name: "Submit error report", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await root
      .locator("[data-coin-report-notice]")
      .filter({
        hasText:
          "Error report recorded for evidence review. No funds were changed.",
      })
      .waitFor();
    const submitted = await reports.list(accountContext);
    assert.equal(submitted.length, 1);
    const report = submitted[0]!;
    assert.equal(report.description, reportDescription);
    assert.equal(report.requestId, request.id);
    assert.equal(await root.locator("[data-coin-reports] img").count(), 0);
    const reviewed = await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote: "Synthetic evidence reviewed; recovery is optional.",
      evidenceDigest,
      quote: {
        amount: "100000",
        network: "simulation:usdc",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        description: "Synthetic quoted recovery cost",
      },
    });
    const reviewCost = root.getByRole("button", {
      name: "Review recovery cost",
      exact: true,
    });
    await root.locator("[data-coin-refresh]").click();
    await reviewCost.waitFor();
    const publicReport = await context.request.get(
      `${origin}/api/coin-sandbox/reports/${report.id}`,
    );
    assert.equal(publicReport.status(), 200);
    const publicBody = await publicReport.text();
    assert.equal(publicBody.includes(privateNote), false);
    assert.equal(publicBody.includes(evidenceDigest), false);
    assert.equal(publicBody.includes("evidenceDigest"), false);
    assert.equal(
      (await root.locator("[data-coin-reports]").innerText()).includes(
        privateNote,
      ),
      false,
    );
    await selectCookie(context, origin, replacement.token);
    const foreignReport = await context.request.get(
        `${origin}/api/coin-sandbox/reports/${report.id}`,
      ),
      foreignQuote = await context.request.get(
        `${origin}/api/coin-sandbox/reports/${report.id}/recovery-quotes/${reviewed.event.id}`,
      ),
      foreignReports = await context.request.get(
        `${origin}/api/coin-sandbox/reports`,
      );
    assert.equal(foreignReport.status(), 404);
    assert.equal(foreignQuote.status(), 404);
    assert.deepEqual(await foreignReports.json(), []);
    await selectCookie(context, origin, currentToken);
    assert.deepEqual(await moneyState(), beforeReport);
    checks.push(
      `${name}: a receipt opens an accessible real error-report form; literal markup stays text, owner evidence stays private, and another actual account receives no report or cost quote; reporting/review changes no funds or external records`,
    );

    phase = `${name}: recovery cost consent confirmed by signing in again records no charge`;
    const consentOperations = () =>
      count(
        "SELECT count(*)::int n FROM account_operations WHERE user_id=$1 AND purpose='recovery.cost.consent'",
        [account.userId],
      );
    let consentMessage = "";
    page.once("dialog", (dialog) => {
      consentMessage = dialog.message();
      void dialog.dismiss();
    });
    await reviewCost.focus();
    await page.keyboard.press("Enter");
    await notice
      .filter({ hasText: "Consent cancelled. Nothing recorded." })
      .waitFor();
    assert.equal(
      consentMessage,
      "Recovery cost: 0.1 USDC on simulation:usdc. Consent records your agreement only. Continue to confirm by signing in again?",
    );
    assert.equal(await consentOperations(), 0);
    page.once("dialog", (dialog) => void dialog.accept());
    const consentOperation = expectConfirmation(
      page,
      `/api/coin-sandbox/reports/${report.id}/recovery-consents/authorization`,
    );
    await reviewCost.focus();
    await page.keyboard.press("Enter");
    await consentOperation;
    await atProvider(page, account.identity.email);
    assert.equal(
      await count(
        "SELECT count(*)::int AS n FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent'",
        [report.id],
      ),
      0,
    );
    const consentResponse = page.waitForResponse(
      posted(`/api/coin-sandbox/reports/${report.id}/recovery-consents`),
    );
    await signInAtProvider(page, account.identity, account.identity);
    const recorded = await consentResponse;
    assert.equal(recorded.status(), 200);
    const consentBody: unknown = await recorded.json();
    assert.ok(
      consentBody !== null &&
        typeof consentBody === "object" &&
        "authorizesCharge" in consentBody &&
        "authorizesExternalRecovery" in consentBody,
    );
    assert.equal(consentBody.authorizesCharge, false);
    assert.equal(consentBody.authorizesExternalRecovery, false);
    await notice
      .filter({
        hasText:
          "Recovery cost consent recorded. No charge or recovery started.",
      })
      .waitFor();
    assert.equal(page.url(), `${origin}${accountReturn}`);
    await openDetails(root.locator("details:has([data-coin-reports])"));
    await root
      .locator("[data-coin-reports]")
      .getByText(
        "Recovery cost consent recorded. No charge or recovery started.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await reviewCost.count(), 0);
    const consentRows = await ownerPool.query<{
      authorized: boolean;
      cashJournalId: string | null;
    }>(
      `SELECT e.cash_journal_id AS "cashJournalId",e.session_id=s.id AND e.auth_generation=u.auth_generation AS authorized FROM coin_sandbox_report_events e JOIN users u ON u.id=e.user_id JOIN sessions s ON s.token_hash=$2 WHERE e.report_id=$1 AND e.kind='recovery_consent'`,
      [report.id, hashSessionToken(currentToken)],
    );
    assert.equal(consentRows.rows.length, 1);
    assert.deepEqual(consentRows.rows[0], {
      cashJournalId: null,
      authorized: true,
    });
    assert.deepEqual(await moneyState(), beforeReport);
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `recovery-consent-${name}.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: declining the 0.1 USDC recovery cost review records nothing; accepting it and signing in again binds the displayed quote to the current account/session, and one append-only consent authorizes neither a charge nor recovery, leaving all balances/journals/receipts/requests unchanged`,
    );

    phase = `${name}: recovery quote expires while its review is open`;
    const expiry = Date.now() + 7000;
    await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote: "Synthetic short-lived replacement quote.",
      evidenceDigest,
      quote: {
        amount: "200000",
        network: "simulation:usdc",
        expiresAt: new Date(expiry).toISOString(),
        description: "Synthetic expiring cost",
      },
    });
    await root.locator("[data-coin-refresh]").click();
    const expiredResponse = page.waitForResponse(
      posted(
        `/api/coin-sandbox/reports/${report.id}/recovery-consents/authorization`,
      ),
    );
    page.once("dialog", async (dialog) => {
      await delay(Math.max(0, expiry + 250 - Date.now()));
      await dialog.accept();
    });
    await reviewCost.click();
    assert.equal((await expiredResponse).status(), 410);
    await notice.filter({ hasText: /recovery quote expired/ }).waitFor();
    assert.equal(page.url(), `${origin}${accountReturn}`);
    assert.equal(await reviewCost.isEnabled(), true);
    await automatedA11y(page);
    await root.locator("[data-coin-refresh]").click();
    await root.getByText(settled, { exact: true }).waitFor();
    await reviewCost.waitFor({ state: "hidden" });
    assert.equal(await reviewCost.count(), 0);
    assert.equal(
      await count(
        "SELECT count(*)::int AS n FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent'",
        [report.id],
      ),
      1,
    );
    assert.equal(await consentOperations(), 1);
    assert.deepEqual(await moneyState(), beforeReport);
    checks.push(
      `${name}: a quote that genuinely expires while its review is open is refused by the real server with 410 before any confirmation is created, announces the error without leaving the page, disappears after refresh and creates no second consent or financial change`,
    );

    phase = `${name}: independent treasury and existing debate participation`;
    const historicalCount = await count(
      "SELECT count(*)::int n FROM a4_postings",
      [],
    );
    for (const purpose of ["center", "promotional"] as const)
      await operator.seedSandboxTreasury({
        userId: account.userId,
        purpose,
        amount: "50000000",
        idempotencyKey: randomUUID(),
      });
    await openDetails(root.locator("details:has([data-coin-participate])"));
    await root.locator("[data-coin-open]").click();
    await root.locator("[data-coin-participate]").waitFor({ state: "visible" });
    page.once("dialog", (dialog) => void dialog.accept());
    await root
      .locator("[data-coin-participate]")
      .getByRole("button", {
        name: "Review and commit participation",
        exact: true,
      })
      .click();
    await root
      .getByText(
        "Commitment recorded. Settlement occurs after the five-minute cutoff.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM coin_debate_orders WHERE user_id=$1",
        [account.userId],
      ),
      1,
    );
    assert.equal(
      await count("SELECT count(*)::int n FROM a4_postings", []),
      historicalCount,
    );
    checks.push(
      `${name}: owner-process simulated center/promotional treasury funds a real existing YES/NO round; first commitment and its source reservation are recorded without changing historical A4 tables`,
    );

    phase = `${name}: context switch during native confirmation rejects new-account spending`;
    const options = await root.locator("[data-coin-debate] option").all();
    assert.equal(options.length, 2);
    const second = await options[1]!.getAttribute("value");
    assert.ok(second);
    await root.locator("[data-coin-debate]").selectOption(second);
    await root.getByText("Debate rounds refreshed.", { exact: true }).waitFor();
    await root.locator("[data-coin-open]").click();
    await root.locator("[data-coin-participate]").waitFor({ state: "visible" });
    const rejection = page.waitForResponse(posted(/\/rounds\/[^/]+\/submit$/));
    page.once("dialog", async (dialog) => {
      await selectCookie(context, origin, replacement.token);
      await dialog.accept();
    });
    await root
      .locator("[data-coin-participate]")
      .getByRole("button", {
        name: "Review and commit participation",
        exact: true,
      })
      .click();
    assert.equal((await rejection).status(), 409);
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM coin_debate_orders WHERE user_id=$1",
        [replacement.userId],
      ),
      0,
    );
    assert.equal(
      (
        await sandbox.summary({
          userId: replacement.userId,
          sessionTokenHash: hashSessionToken(replacement.token),
        })
      ).balances.cashAvailable,
      "0",
    );
    const checkingReplacement = {
      userId: replacement.userId,
      arrived: deferred(),
      finish: deferred(),
    };
    summaryGate = checkingReplacement;
    await announceAccount(page);
    await checkingReplacement.arrived.promise;
    assert.equal(await root.isVisible(), false);
    for (const selector of [
      "[data-coin-balances]",
      "[data-coin-receipts]",
      "[data-coin-rounds]",
      "[data-coin-reports]",
    ])
      assert.equal(await root.locator(selector).textContent(), "");
    assert.equal(
      await root
        .locator("[data-coin-withdraw] input[name=destination]")
        .inputValue(),
      "",
    );
    checkingReplacement.finish.release();
    await confirmOpen.waitFor({ state: "visible" });
    assert.equal(await root.locator("[data-coin-initialize]").isHidden(), true);
    await root
      .locator("[data-coin-report-notice]")
      .filter({ hasText: "No deposit or payout errors reported." })
      .waitFor();
    assert.equal(await root.locator("[data-coin-reports] li").count(), 0);
    assert.equal((await root.innerText()).includes(reportDescription), false);
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    await selectCookie(context, origin, currentToken);
    await announceAccount(page);
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    assert.equal(await opening.isHidden(), true);
    checks.push(
      `${name}: real cookie switch while the native confirmation blocks browser events is rejected by comparison-only session context; a held replacement summary leaves no old balances, receipts, round, report or destination in hidden DOM, the unopened replacement sees only its own opening control, and it receives no stake or funds`,
    );

    phase = `${name}: late old-account action cannot restore private balances or disabled controls`;
    const gate = { arrived: deferred(), finish: deferred() };
    dailyGate = gate;
    await root.locator("[data-coin-daily]").click();
    await gate.arrived.promise;
    await selectCookie(context, origin, replacement.token);
    await announceAccount(page);
    await confirmOpen.waitFor({ state: "visible" });
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    const delayed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/grants/daily"),
    );
    gate.finish.release();
    await delayed;
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    assert.equal(
      await root
        .locator("[data-coin-balances] div")
        .filter({ hasText: "Purchased principal" })
        .getByText("0 YC", { exact: true })
        .count(),
      1,
    );
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    await selectCookie(context, origin, currentToken);
    await announceAccount(page);
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    checks.push(
      `${name}: delayed actual daily-claim response from the old account cannot repopulate its balances in the replacement account or leave replacement controls disabled`,
    );

    phase = `${name}: a declined withdrawal review and logout leave nothing reserved`;
    const withdrawalOperations = () =>
      count(
        "SELECT count(*)::int n FROM account_operations WHERE user_id=$1 AND purpose='withdrawal.request'",
        [account.userId],
      );
    const operationsBefore = await withdrawalOperations();
    await openDetails(root.locator("details:has([data-coin-withdraw])"));
    const destination = root.locator(
      "[data-coin-withdraw] input[name=destination]",
    );
    await destination.fill("synthetic-external-wallet");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await root
      .locator("[data-coin-withdraw]")
      .getByRole("button", {
        name: "Review amount and network fee",
        exact: true,
      })
      .click();
    await notice
      .filter({ hasText: "Withdrawal cancelled. Nothing reserved." })
      .waitFor();
    assert.equal(await withdrawalOperations(), operationsBefore);
    assert.equal(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        confirmationKey,
      ),
      null,
    );
    await destination.fill("synthetic-abandoned-wallet");
    const abandonedInput = await destination.elementHandle();
    assert.ok(abandonedInput);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("yap:provider-logout"));
    });
    assert.equal(await root.isHidden(), true);
    assert.equal(
      await abandonedInput.evaluate((input) =>
        input instanceof HTMLInputElement ? input.value : null,
      ),
      "",
    );
    await abandonedInput.dispose();
    assert.equal(
      (await sandbox.summary(accountContext)).balances.reserved,
      "5000000",
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("yap:account-changed"));
    });
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    assert.equal(await withdrawalOperations(), operationsBefore);
    checks.push(
      `${name}: declining the withdrawal review creates no confirmation and stores no pending action; the actual logout event hides the sandbox, erases the typed destination from the detached input and reserves nothing; a subsequent account refresh restores working controls`,
    );

    phase = `${name}: financial correction hold preserves report and quote access`;
    const fundingRequest = funded.requests.find(
      (entry) => entry.kind === "funding",
    );
    assert.ok(fundingRequest);
    const correctionReport = await reports.submit(accountContext, {
        requestId: fundingRequest.id,
        message: "Synthetic incorrect deposit evidence fixture.",
        idempotencyKey: randomUUID(),
      }),
      correctionReview = await reportOperator.review({
        reportId: correctionReport.report.id,
        idempotencyKey: randomUUID(),
        outcome: "erroneous_credit",
        note: privateNote,
        publicNote: "Synthetic deposit correction requires evidence review.",
        evidenceDigest,
      }),
      correctionKey = randomUUID(),
      correctionProof = await reportOperator.prepareCorrection({
        reportId: correctionReport.report.id,
        reviewId: correctionReview.event.id,
        requestId: fundingRequest.id,
        action: "correct",
        idempotencyKey: correctionKey,
      }),
      correction = await operator.correctFunding({
        userId: account.userId,
        requestId: fundingRequest.id,
        idempotencyKey: correctionKey,
        reason: "incorrect_funding",
        review: correctionProof,
      });
    assert.equal(correction.status, "uncertain");
    assert.equal(correction.financialReviewRequired, true);
    await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote:
        "Evidence and optional recovery stay accessible during the financial hold.",
      evidenceDigest,
      quote: {
        amount: "100000",
        network: "simulation:usdc",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        description: "Synthetic held-account recovery quote",
      },
    });
    const beforeHeldRefresh = await moneyState(),
      settlementRejection = page.waitForResponse(
        posted("/api/coin-sandbox/settlements"),
      );
    await root.locator("[data-coin-refresh]").click();
    assert.equal((await settlementRejection).status(), 403);
    phase = `${name}: correction hold refresh exposes the current quote`;
    await openDetails(root.locator("details:has([data-coin-reports])"));
    await reviewCost.waitFor();
    phase = `${name}: correction hold refresh announces its guard`;
    await notice.filter({ hasText: /financial activity is paused/ }).waitFor();
    phase = `${name}: correction hold keeps withdrawal guard and financial state`;
    assert.equal(await root.locator("[data-coin-reports] li").count(), 2);
    const heldSummary = await sandbox.summary(accountContext),
      deniedQuote = await context.request.post(
        `${origin}/api/coin-sandbox/withdrawals/quotes`,
        {
          headers: {
            Origin: origin,
            "X-YapArena-Session": heldSummary.sessionId,
            "Idempotency-Key": randomUUID(),
          },
          data: { gross: "5000000", destination: "synthetic-external-wallet" },
        },
      );
    assert.equal(deniedQuote.status(), 403);
    assert.deepEqual(await moneyState(), beforeHeldRefresh);
    phase = `${name}: capture held-account report evidence`;
    await page.screenshot({
      path: resolve(evidenceDirectory, `financial-hold-${name}.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: an actual evidence-reviewed uncertain funding correction holds financial mutations; Refresh sandbox still loads both reports and the owner's current recovery quote after settlement 403, while new withdrawals remain 403 and reserves/journals/receipts stay unchanged`,
    );
    phase = `${name}: keyboard, mobile and 200 percent layout zoom acceptance`;
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `after-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `zoom-200-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    checks.push(
      `${name}: keyboard activation of the opening, withdrawal and recovery confirmation controls, native-dialog review, automated WCAG2.2AA tags on the account and explanation pages and no horizontal overflow at normal and CSS200% layout zoom; not screen-reader or physical-device evidence`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  phase = "verify tested source and build remained stable during browser run";
  assert.deepEqual(
    Object.fromEntries(
      await Promise.all(
        evidenceSources.map(async (path) => [path, await sourceHash(path)]),
      ),
    ),
    sourceHashes,
  );
  await writeFile(
    resolve(evidenceDirectory, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        revision,
        revisionAtEnd: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceHashes,
        postgres: postgresVersion,
        browser: browser.version(),
        scope:
          "Real application browser assets, coin sandbox and auth routers and runtime-role PostgreSQL API in a new disposable native cluster; synthetic identities created by the Auth0 post-callback function; confirmation by signing in again through the in-process OpenID Connect issuer's stand-in Universal Login page (not hosted Auth0); deterministic financial simulation; the late-return check emulates the page clock; no hosted/provider-chain/physical-device/screen-reader acceptance; CSS200% zoom is layout emulation.",
        checks,
        errors,
        expectedRejections: failures,
        accessibilityFailures,
        layoutFailures,
      },
      null,
      2,
    ) + "\n",
  );
  await rm(resolve(evidenceDirectory, "failure.png"), { force: true });
  console.log(
    JSON.stringify({ result: "PASS", checks, evidence: evidenceDirectory }),
  );
} catch (error) {
  if (lastPage && !lastPage.isClosed())
    await lastPage
      .screenshot({
        path: resolve(evidenceDirectory, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category: error instanceof Error ? error.name : "unclassified",
      operation:
        error instanceof Error
          ? /^(?:locator|page|browserContext|browser)\.[a-zA-Z]+/.exec(
              error.message,
            )?.[0]
          : undefined,
      url: lastPage && !lastPage.isClosed() ? lastPage.url() : undefined,
      notice:
        lastPage && !lastPage.isClosed()
          ? await lastPage
              .locator("[data-coin-notice]")
              .textContent({ timeout: 1000 })
              .catch(() => null)
          : null,
      backendErrorCategories: errors,
      responseFailures: failures,
      accessibilityFailures,
      layoutFailures,
      action:
        "Inspect isolated browser harness; credentials, protocol responses and database URLs omitted.",
    }),
  );
  if (process.env.COIN_BROWSER_DEBUG === "1") console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server!.close((error) => (error ? fail(error) : done())),
    );
  }
  await issuer?.close();
  await Promise.all([runtime?.end(), owner?.end()]);
  if (started)
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--mode",
      "immediate",
      "--wait",
      "stop",
    ]);
  await rm(directory, { recursive: true, force: true });
}
