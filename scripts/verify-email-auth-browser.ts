// Local browser journeys for Auth0 sign-in (Decision 0009). The real web
// service composition (dist/web.js) runs in-process against a local OpenID
// Connect issuer that stands in for Universal Login, and Chrome drives:
// email-code sign-in, Google linking through an email code, sign-out through
// the provider's logout endpoint, a cancelled sign-in, and the guest header
// and account page at desktop and mobile widths.
//
//   npm run build
//   A4_TEST_DATABASE_URL=... node scripts/verify-email-auth-browser.ts
//
// A4_TEST_DATABASE_URL is a migrated disposable runtime database, as the
// isolation harness provides. Hosted Auth0 behaviour is checked separately
// (scripts/verify-account-hosted-browser.ts and the staging checklist).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { startIssuer } from "./oidc-test-issuer.ts";
import { createWebServer } from "../dist/web.js";

const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
assert.ok(runtimeUrl, "A4_TEST_DATABASE_URL must name a disposable database");
assert.ok(
  ["localhost", "127.0.0.1"].includes(new URL(runtimeUrl).hostname),
  "browser journeys use a local disposable database only",
);
const artifactDir =
  process.env.AUTH_BROWSER_ARTIFACT_DIR ?? "/tmp/yaparena-auth0-browser";
const clientId = "browser-client-0123456789";
const clientSecret = "browser-client-secret-0123456789";
const checks: string[] = [];
let stage = "start";

const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = (reserve.address() as AddressInfo).port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const issuer = await startIssuer({ clientId, clientSecret });
const server = createWebServer({
  PATH: process.env.PATH,
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: String(port),
  APP_ORIGIN: origin,
  DATABASE_URL: runtimeUrl,
  LOG_LEVEL: "silent",
  API_RATE_LIMIT: "10000",
  AUTH_RATE_LIMIT: "1000",
  RUN_BACKGROUND_JOBS: "false",
  AUTH0_ISSUER_BASE_URL: issuer.issuer.slice(0, -1),
  AUTH0_CLIENT_ID: clientId,
  AUTH0_CLIENT_SECRET: clientSecret,
});
let browser: Browser | undefined;
const errors: string[] = [];

async function newPage(viewport = { width: 1440, height: 1000 }) {
  const context = await browser!.newContext({ viewport });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
async function dismissConsent(page: Page) {
  const dismiss = page.getByRole("button", { name: "Reject all", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
}
async function account(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    return response.ok
      ? ((await response.json()) as { user: { id: string } }).user.id
      : null;
  });
}
// The provider page stands in for Universal Login: whoever setNext names
// completes the sign-in when "Sign in" is pressed.
async function completeAtProvider(
  page: Page,
  identity: { subject: string; email: string },
) {
  await page.waitForURL((url) => `${url.origin}/` === issuer.issuer);
  issuer.setNext(identity);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The header's Sign in button opens the account page; it offers both methods.
async function signInFromHeader(page: Page, method: "Google" | "email") {
  await page
    .locator("[data-header-guest]")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  await page
    .locator("#account-sign-in")
    .getByRole("link", { name: `Continue with ${method}`, exact: true })
    .click();
}

try {
  await server.start();
  await mkdir(artifactDir, { recursive: true });
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });

  stage = "guest header and account page";
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
    ["narrow", { width: 320, height: 640 }],
  ] as const) {
    const page = await newPage(viewport);
    await page.goto(`${origin}/debates`);
    const guest = page.locator("[data-header-guest]");
    await guest.waitFor({ state: "visible" });
    // One Sign in button opens the account page, which offers both methods.
    assert.equal(
      await guest
        .getByRole("link", { name: "Sign in", exact: true })
        .getAttribute("href"),
      "/account?next=%2Fdebates",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      `${name} header fits`,
    );
    assert.equal(
      await page.evaluate(() => {
        const visible = [
          ...document.querySelectorAll<HTMLElement>(
            ".site-header .brand > *, [data-header-guest] a",
          ),
        ]
          .map((node) => node.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
        return visible.some((a, i) =>
          visible.some(
            (b, j) =>
              i < j &&
              a.left < b.right - 1 &&
              b.left < a.right - 1 &&
              a.top < b.bottom - 1 &&
              b.top < a.bottom - 1,
          ),
        );
      }),
      false,
      `${name} brand and sign-in button do not overlap`,
    );
    await page.screenshot({ path: `${artifactDir}/header-${name}.png` });
    await page.goto(`${origin}/account?next=%2Flive`);
    await page.locator("#account-sign-in").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#account-sign-in")
        .getByRole("link", { name: "Continue with email", exact: true })
        .getAttribute("href"),
      "/api/auth/login?connection=email&return=%2Flive",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      `${name} account page fits`,
    );
    await page.screenshot({
      path: `${artifactDir}/account-${name}.png`,
      fullPage: true,
    });
    await page.context().close();
  }
  checks.push(
    "the guest header's one Sign in button and the account page's Google and email links keep return paths at desktop and mobile widths",
  );

  stage = "email-code sign-in returns signed in";
  const email = `browser-${randomUUID()}@example.test`;
  const emailIdentity = { subject: `email|${randomUUID()}`, email };
  const first = await newPage();
  await first.goto(`${origin}/debates`);
  await dismissConsent(first);
  await signInFromHeader(first, "email");
  assert.equal(await first.locator("[data-connection]").textContent(), "email");
  await completeAtProvider(first, emailIdentity);
  await first.waitForURL(`${origin}/debates`);
  await first.locator("[data-header-member]").waitFor({ state: "visible" });
  checks.push(
    "email-code sign-in from the header returns to the starting page signed in",
  );

  stage = "a new account picks its name and handle first";
  const setup = first.locator("dialog.profile-setup");
  await setup.waitFor({ state: "visible" });
  const suggested = email.split("@")[0]!.slice(0, 40).replace(/-+$/, "");
  // The suggestion arrives with the sign-in methods, then its check.
  await setup.getByText(`@${suggested} is free.`).waitFor();
  assert.equal(
    await setup.getByLabel("Handle", { exact: true }).inputValue(),
    suggested,
    "the sign-in email suggests the first handle",
  );
  await first.keyboard.press("Escape");
  assert.equal(await setup.isVisible(), true, "Escape keeps the step open");
  assert.equal(
    await setup.getByRole("progressbar").getAttribute("aria-valuetext"),
    "Step 1 of 2",
  );
  assert.equal(
    await setup.getByRole("switch").count(),
    0,
    "no visibility choice",
  );
  await setup.getByLabel("Handle", { exact: true }).click();
  await setup.getByRole("button", { name: "About handles" }).hover();
  await setup
    .getByRole("tooltip")
    .filter({ hasText: "Handles never change" })
    .first()
    .waitFor();
  const handle = `b-${randomUUID().slice(0, 8)}`;
  // Typing a username, key by key, leaves the handle alone.
  await setup
    .getByLabel("Username", { exact: true })
    .pressSequentially("Browser Person");
  assert.equal(
    await setup.getByLabel("Handle", { exact: true }).inputValue(),
    suggested,
    "the username never rewrites the handle",
  );
  await setup.getByLabel("Handle", { exact: true }).fill("Browser Person!");
  assert.equal(
    await setup.getByLabel("Handle", { exact: true }).inputValue(),
    "browser-person",
    "handles normalize as people type",
  );
  // Going back to a handle already checked shows its answer again.
  await setup.getByLabel("Handle", { exact: true }).fill(suggested);
  await setup.getByText(`@${suggested} is free.`).waitFor({ timeout: 1000 });
  await setup.getByLabel("Handle", { exact: true }).fill(handle);
  await setup.getByText(`@${handle} is free.`).waitFor();
  await setup.getByRole("button", { name: "Continue" }).click();
  await setup.getByRole("button", { name: "Claim my handle" }).waitFor();
  assert.equal(
    await setup.getByRole("progressbar").getAttribute("aria-valuetext"),
    "Step 2 of 2",
  );
  // The handle is claimed only after the age and terms confirmation.
  assert.equal(
    await setup.getByRole("button", { name: "Claim my handle" }).isDisabled(),
    true,
    "claiming waits for the terms tick",
  );
  await setup.getByRole("checkbox", { name: /18 or older/ }).check();
  await setup.getByRole("button", { name: "Claim my handle" }).click();
  await setup.getByText("Welcome to the arena, Browser").waitFor();
  await first.screenshot({ path: `${artifactDir}/profile-setup-done.png` });
  await setup.getByRole("button", { name: "Start exploring" }).click();
  await setup.waitFor({ state: "detached" });
  assert.equal(
    (await first.locator("[data-header-account]").textContent())?.trim(),
    "BP",
  );
  checks.push(
    "a new account must pick a username and permanent handle in the pop-up (Escape keeps it open, a progress bar shows the step, hovering a label explains handles); the email suggests a handle, the username never rewrites it, input normalizes, availability shows, and the profile is public",
  );
  const accountId = await account(first);
  assert.ok(accountId, "the strict session cookie arrives after the provider");
  assert.equal(
    await first.evaluate(() => document.cookie.includes("session=")),
    false,
    "the session cookie is HTTP-only",
  );
  await first.goto(`${origin}/account#security`);
  await first.locator("#signed-in").waitFor({ state: "visible" });
  const emailMethod = first
    .locator("#sign-in-methods .settings-method")
    .filter({ hasText: "Email code" });
  await emailMethod.getByText(email, { exact: true }).waitFor();
  await first
    .locator("#activity-list")
    .getByText("Created your profile")
    .waitFor();
  assert.equal(
    await first
      .locator("#activity-list")
      .getByText(/\w+\.\w+/)
      .count(),
    0,
    "activity shows no raw event names",
  );
  for (const retired of [
    "#embedded-wallet",
    "#email-auth",
    "#provider-settings",
  ])
    assert.equal(await first.locator(retired).count(), 0, retired);
  checks.push(
    "the session is HTTP-only; Sign-in & security lists the method and readable activity, and no wallet card",
  );

  stage = "Google sign-in links through an email code";
  const second = await newPage();
  await second.goto(`${origin}/live`);
  await dismissConsent(second);
  await signInFromHeader(second, "Google");
  assert.equal(
    await second.locator("[data-connection]").textContent(),
    "google-oauth2",
  );
  await completeAtProvider(second, {
    subject: `google-oauth2|${randomUUID()}`,
    email,
  });
  // No session yet: the provider asks for the email code first.
  await second.locator("[data-connection]").getByText("email").waitFor();
  assert.equal(await second.locator("[data-login-hint]").textContent(), email);
  assert.equal(
    (await second.context().cookies()).some((c) => c.name === "session"),
    false,
    "no session before the email code",
  );
  await completeAtProvider(second, emailIdentity);
  await second.waitForURL(`${origin}/live`);
  assert.equal(await account(second), accountId, "linked to the same account");
  await second.locator("[data-header-member]").waitFor({ state: "visible" });
  assert.equal(
    await second.locator("dialog.profile-setup").count(),
    0,
    "an account with a profile skips the pop-up",
  );
  await second.goto(`${origin}/account#security`);
  await second
    .locator("#sign-in-methods .settings-method")
    .filter({ hasText: "Google" })
    .getByText(email, { exact: true })
    .waitFor();
  await second.goto(`${origin}/account#notifications`);
  await second
    .locator("#account-notifications")
    .getByText("Google sign-in was linked", { exact: false })
    .waitFor();
  checks.push(
    "a Google sign-in for a known address creates no session until the email code, then links to the same account with a notice",
  );

  stage = "sign out ends this device and the provider session";
  await second.locator("[data-header-account]").click();
  await second.locator("[data-header-logout]").click();
  await second.waitForURL(`${origin}/`);
  await second.locator("[data-header-guest]").waitFor({ state: "visible" });
  assert.equal(issuer.logouts.length, 1);
  assert.equal(issuer.logouts[0]!.searchParams.get("returnTo"), `${origin}/`);
  assert.equal(issuer.logouts[0]!.searchParams.get("client_id"), clientId);
  assert.equal(await account(first), accountId, "the other device stays");
  checks.push(
    "sign out deletes this device's session, visits the provider logout and returns home; the other device stays signed in",
  );

  stage = "cancelled sign-in";
  const third = await newPage();
  await third.goto(`${origin}/debates`);
  await signInFromHeader(third, "Google");
  await third.waitForURL((url) => `${url.origin}/` === issuer.issuer);
  await third.getByRole("button", { name: "Cancel", exact: true }).click();
  await third.getByRole("heading", { name: "Sign-in cancelled" }).waitFor();
  assert.equal(await account(third), null);
  await third.getByRole("link", { name: "Back to YAP Arena" }).click();
  await third.waitForURL(`${origin}/debates`);
  checks.push(
    "a cancelled sign-in explains itself and returns without a session",
  );

  assert.deepEqual(errors, [], "no uncaught page errors");
  console.log(
    `Auth0 browser journeys PASS (${checks.length}); evidence ${artifactDir}`,
  );
} catch (error) {
  console.error(`Auth0 browser journeys FAIL during ${stage}`);
  throw error;
} finally {
  await writeFile(
    `${artifactDir}/browser-evidence.json`,
    JSON.stringify({ stage, checks, errors }, null, 2) + "\n",
  ).catch(() => {});
  await browser?.close();
  await server.stop();
  await issuer.close();
}
