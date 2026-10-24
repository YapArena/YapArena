import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Guest-only acceptance against the named staging deployment (Decision 0009).
// No email code is sent, no Google account is used and no account, session or
// financial action is created. Starting a sign-in stores one 10-minute,
// unconsumed sign-in state row per request; nothing else is written.
const origin = "https://yaparena-staging-web.onrender.com";
const expectedRevision = process.env.ACCOUNT_HOSTED_EXPECTED_REVISION;
assert.match(expectedRevision ?? "", /^[a-f0-9]{40}$/);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  expectedRevision,
  revision,
  "run from the exact revision selected for staging acceptance",
);
const probeRedis = process.env.ACCOUNT_HOSTED_REDIS_PROBE === "approved";
const metricsHeaders: Record<string, string> = process.env.METRICS_TOKEN
  ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` }
  : {};
assert.ok(
  process.env.ACCOUNT_HOSTED_REDIS_PROBE === undefined || probeRedis,
  "Redis probe accepts only the explicit approved value",
);
// Evidence stays outside the repository (CONTRIBUTING: evidence belongs in
// the pull request or CI artifacts).
const directory = resolve(
  process.env.ACCOUNT_HOSTED_ARTIFACT_DIR ?? "/tmp/yaparena-account-hosted",
);
const checks: string[] = [];
const failures: string[] = [];
const assetHashes: Record<string, string> = {};
const sourceHashes: Record<string, string> = {};
let stage = "validate served assets";
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const assets = [
  "session-coordination.js",
  "auth-return.js",
  "site-header.js",
  "site.js",
  "account.js",
  "profile-setup.js",
  "account-coins.js",
  "account-auth.css",
  "site-header.css",
  "site.css",
  "arena.css",
];
const startedAt = Date.now();
const deadline = startedAt + 150_000;
function remaining(maximum = 15_000) {
  const duration = Math.min(maximum, deadline - Date.now());
  assert.ok(duration > 0, "hosted acceptance deadline reached");
  return duration;
}
async function request(path: string, init: RequestInit = {}) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  return fetch(origin + path, {
    redirect: "error",
    ...init,
    signal: AbortSignal.timeout(remaining()),
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}
function noStore(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
}
function guestCookies(response: Response, allowMediaGuard: boolean) {
  const cookies = response.headers.getSetCookie();
  if (!allowMediaGuard) {
    assert.equal(cookies.length, 0, "private guest route issues no cookies");
    return;
  }
  assert.ok(cookies.length <= 1, "at most the media-admission guard is issued");
  for (const cookie of cookies)
    assert.match(
      cookie,
      /^yap_media_guard=[a-f0-9]{32}\.\d{13}\.[A-Za-z0-9_-]{43};/,
      "only the non-authentication media-admission guard is issued",
    );
}
type RedisMetrics = { ok: number; observations: number; seconds: number };
function redisMetrics(body: string): RedisMetrics {
  function value(pattern: RegExp) {
    const match = pattern.exec(body);
    assert.ok(match, "required aggregate Redis metric is present");
    const result = Number(match[1]);
    assert.ok(Number.isFinite(result) && result >= 0);
    return result;
  }
  assert.match(body, /^# TYPE yaparena_redis_security_total counter$/m);
  return {
    ok: /^yaparena_redis_security_total\{outcome="ok"\} /m.test(body)
      ? value(/^yaparena_redis_security_total\{outcome="ok"\} ([0-9.eE+-]+)$/m)
      : 0,
    observations: value(
      /^yaparena_redis_security_seconds_count ([0-9.eE+-]+)$/m,
    ),
    seconds: value(/^yaparena_redis_security_seconds_sum ([0-9.eE+-]+)$/m),
  };
}
let redisObservation: {
  before: RedisMetrics;
  after: RedisMetrics;
  minimumAdditionalSuccessfulOperations: number;
} | null = null;
let providerMetadata: Record<string, string | boolean> | null = null;

// Starts a sign-in without following it and checks the authorization request
// and the browser-binding cookie. Returns the provider's authorization URL.
async function startSignIn(connection: "email" | "google") {
  const response = await request(
    `/api/auth/login?connection=${connection}&return=%2Fdebates`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 303, `${connection} sign-in redirects`);
  noStore(response);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.protocol, "https:");
  const parameters = location.searchParams;
  assert.equal(parameters.get("response_type"), "code");
  assert.equal(parameters.get("redirect_uri"), `${origin}/api/auth/callback`);
  assert.equal(parameters.get("scope"), "openid email");
  assert.equal(parameters.get("code_challenge_method"), "S256");
  for (const key of ["state", "nonce", "code_challenge"])
    assert.ok((parameters.get(key) ?? "").length >= 43, key);
  assert.match(parameters.get("client_id") ?? "", /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(
    parameters.get("connection"),
    connection === "google" ? "google-oauth2" : "email",
  );
  assert.equal(parameters.has("prompt"), false);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1, "only the sign-in binding cookie is set");
  const [pair, ...attributes] = cookies[0]!.split(";").map((p) => p.trim());
  assert.match(pair ?? "", /^__Host-sign-in=[A-Za-z0-9_-]{43}$/);
  for (const attribute of [
    "Max-Age=600",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ])
    assert.ok(attributes.includes(attribute), attribute);
  assert.equal(
    attributes.some((part) => /^Domain=/i.test(part)),
    false,
  );
  return location;
}

const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--autoplay-policy=user-gesture-required"],
});
const timer = setTimeout(() => void browser.close(), remaining(150_000));
try {
  await mkdir(directory, { recursive: true });
  for (const file of [
    "scripts/verify-account-hosted-browser.ts",
    "src/platform/auth/router.ts",
    "src/platform/auth/auth0.ts",
    "src/platform/shared-abuse.ts",
    "src/platform/auth/browser-security.ts",
    "frontend/site-header.ts",
  ])
    sourceHashes[file] = sha(await readFile(file));
  for (const file of assets) {
    const local = sha(await readFile(resolve("public", file)));
    const response = await request(`/assets/${file}`);
    assert.equal(response.status, 200, `hosted asset status: ${file}`);
    const hosted = sha(Buffer.from(await response.arrayBuffer()));
    assert.equal(hosted, local, `hosted bytes match local build: ${file}`);
    assetHashes[file] = local;
  }
  checks.push(
    `all ${assets.length} hosted header/account assets match the selected local build`,
  );

  stage = "public health and database readiness";
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal(object(await health.json()).status, "ok");
  const ready = await request("/ready");
  assert.equal(ready.status, 200);
  assert.equal(object(await ready.json()).status, "ready");
  checks.push("public health and PostgreSQL-backed readiness return 200");

  stage = "sign-in configuration and authorization requests";
  const configuration = await request("/api/auth/provider");
  assert.equal(configuration.status, 200);
  noStore(configuration);
  assert.deepEqual(await configuration.json(), {
    enabled: true,
    methods: ["email", "google"],
  });
  const email = await startSignIn("email");
  const google = await startSignIn("google");
  assert.equal(google.origin, email.origin);
  stage = "provider discovery metadata";
  const discovery = await fetch(
    `${email.origin}/.well-known/openid-configuration`,
    { redirect: "error", signal: AbortSignal.timeout(remaining()) },
  );
  assert.equal(discovery.status, 200);
  const metadata = object(await discovery.json());
  assert.equal(metadata.issuer, `${email.origin}/`);
  assert.equal(
    new URL(String(metadata.authorization_endpoint)).href,
    `${email.origin}${email.pathname}`,
  );
  assert.ok(
    Array.isArray(metadata.code_challenge_methods_supported) &&
      metadata.code_challenge_methods_supported.includes("S256"),
  );
  providerMetadata = {
    issuer: String(metadata.issuer),
    customDomain: !/\.auth0\.com$/i.test(email.hostname),
    pkceS256: true,
  };
  checks.push(
    "sign-in redirects to the provider with PKCE S256, state, nonce, exact callback and connection, and a host-only Lax 10-minute binding cookie",
  );

  stage = "forged callback";
  const forged = await request(
    "/api/auth/callback?code=synthetic&state=synthetic-state-that-was-never-issued",
  );
  assert.equal(forged.status, 400);
  noStore(forged);
  assert.equal(forged.headers.getSetCookie().length, 0);
  checks.push("an unissued callback state is refused without a cookie");

  stage = "anonymous protected-route responses";
  for (const path of [
    "/api/auth/me",
    "/api/auth/sessions",
    "/api/auth/methods",
    "/api/coin-sandbox/summary",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 401, `anonymous protected route: ${path}`);
    noStore(response);
    guestCookies(response, path === "/api/auth/me");
  }
  for (const path of ["/api/auth/privy/exchange", "/api/auth/journey"]) {
    const response = await request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.equal(response.status, 404, `retired route: ${path}`);
  }
  checks.push(
    "private routes deny a fresh guest with 401/no-store; Privy exchange and journey routes are gone",
  );

  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    stage = `${name} guest browser`;
    const context = await browser.newContext({ viewport, permissions: [] });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(20_000);
    const page = await context.newPage();
    let pageErrors = 0;
    let unexpectedMutations = 0;
    let providerScripts = 0;
    page.on("pageerror", () => pageErrors++);
    page.on("request", (entry) => {
      const url = new URL(entry.url());
      if (
        url.origin === origin &&
        !["GET", "HEAD", "OPTIONS"].includes(entry.method()) &&
        url.pathname !== "/api/measurement/discovery"
      )
        unexpectedMutations++;
      if (url.origin !== origin && entry.resourceType() === "script")
        providerScripts++;
    });
    const home = await page.goto(origin + "/debates", {
      waitUntil: "domcontentloaded",
    });
    stage = `${name} CSP without provider origins`;
    assert.equal(home?.status(), 200);
    const csp = home?.headers()["content-security-policy"] ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /privy|hcaptcha|challenges\.cloudflare/);
    stage = `${name} signed-out header`;
    const guest = page.locator("[data-header-guest]");
    await guest.waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    // One Sign in button opens the account page, which offers both methods.
    assert.equal(
      await guest
        .getByRole("link", { name: "Sign in", exact: true })
        .getAttribute("href"),
      "/account?next=%2Fdebates",
    );
    const headerOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(headerOverflow, false, "guest header fits viewport");
    await page.screenshot({ path: resolve(directory, `debates-${name}.png`) });
    stage = `${name} account page sign-in`;
    const account = await page.goto(origin + "/account?next=%2Flive", {
      waitUntil: "domcontentloaded",
    });
    assert.equal(account?.status(), 200);
    const signIn = page.locator("#account-sign-in");
    await signIn.waitFor({ state: "visible" });
    assert.equal(
      await signIn
        .getByRole("link", { name: "Continue with email", exact: true })
        .getAttribute("href"),
      "/api/auth/login?connection=email&return=%2Flive",
    );
    for (const retired of [
      "#email-auth",
      "#embedded-wallet",
      "#wallet-login",
      "#email-register",
    ])
      assert.equal(await page.locator(retired).count(), 0, retired);
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, "guest account fits viewport");
    await page.screenshot({
      path: resolve(directory, `account-${name}.png`),
      fullPage: true,
    });
    stage = `${name} provider sign-in page opens`;
    await Promise.all([
      page.waitForURL((url) => url.origin === email.origin, {
        timeout: remaining(),
      }),
      signIn
        .getByRole("link", { name: "Continue with email", exact: true })
        .click(),
    ]);
    await page.screenshot({ path: resolve(directory, `provider-${name}.png`) });
    stage = `${name} page exception and mutation counters`;
    assert.equal(pageErrors, 0, "no uncaught page exceptions");
    assert.equal(
      unexpectedMutations,
      0,
      "guest inspection sends no account mutation",
    );
    await context.close();
    checks.push(
      `${name}: the guest header's Sign in button and the account page's Google and email links keep return paths, no island/wallet/legacy sign-in, CSP and layout, and the provider's sign-in page opens (${providerScripts} provider scripts there)`,
    );
  }

  if (probeRedis) {
    stage = "guarded retired-register Redis probe";
    const beforeResponse = await request("/metrics", {
      headers: metricsHeaders,
    });
    assert.equal(beforeResponse.status, 200);
    const before = redisMetrics(await beforeResponse.text());
    const response = await request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.ok([404, 410].includes(response.status));
    assert.equal(response.headers.has("set-cookie"), false);
    const afterResponse = await request("/metrics", {
      headers: metricsHeaders,
    });
    assert.equal(afterResponse.status, 200);
    const after = redisMetrics(await afterResponse.text());
    assert.ok(after.ok >= before.ok + 1);
    assert.ok(after.observations >= before.observations + 1);
    assert.ok(after.seconds >= before.seconds);
    redisObservation = {
      before,
      after,
      minimumAdditionalSuccessfulOperations: 1,
    };
    checks.push(
      "a retired password-registration request issued no cookie and passed through the shared Redis sign-in limiter",
    );
  }
} catch {
  // Raw browser/provider exceptions can contain URLs, query parameters or data.
  failures.push(
    `hosted guest acceptance failed during ${stage}; no raw provider/browser error was recorded`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await browser.close();
  const evidence = {
    observedAt: new Date().toISOString(),
    passed: failures.length === 0,
    origin,
    expectedRevision,
    localRevision: revision,
    revisionEvidence:
      "Expected operator-selected revision plus exact served asset hashes; this does not independently attest server commit identity.",
    elapsedMs: Date.now() - startedAt,
    checks,
    failures,
    sourceHashes,
    assetHashes,
    providerMetadata,
    redisObservation,
    limitations: [
      "Guest browser only; no email code, Google sign-in, account creation, linking, confirmation or financial action.",
      "Headless emulated viewports; no physical device, screen-reader or full WCAG conformance claim.",
      "Redis probe is behavioral; it is not raw hosted INFO, a hosted outage drill or a multi-instance topology test.",
    ],
  };
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, "acceptance.json");
  await writeFile(
    destination + ".tmp",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await rename(destination + ".tmp", destination);
  console.log(
    `${evidence.passed ? "PASS" : "FAIL"} hosted guest acceptance: ${checks.length} groups; evidence in ${directory}`,
  );
}
