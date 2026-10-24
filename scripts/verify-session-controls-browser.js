import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

// Synthetic local-only accounts; launch a fresh profile, never inspect an existing
// browser profile or dump cookies. The caller runs an isolated migrated preview.
const origin =
  process.env.REVOCATION_BROWSER_ORIGIN || "http://localhost:53023";
const target = new URL(origin);
if (
  !/^https?:$/.test(target.protocol) ||
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw new Error("Browser verification requires a local isolated preview");
const output =
  process.env.REVOCATION_BROWSER_EVIDENCE ||
  "/private/tmp/yaparena-f03-browser-evidence";
const email = `f03-browser-${randomUUID()}@example.test`;
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const first = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const second = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const a = await first.newPage(),
    b = await second.newPage();
  // Both devices sign in to one account through the local test identity
  // entry (scripts/test-identity-entry.ts).
  const signIn = async (context) => {
    const response = await context.request.post(
      `${origin}/api/test-identity/sign-in`,
      { data: { email } },
    );
    if (!response.ok()) throw new Error(`test sign-in: ${response.status()}`);
  };
  await signIn(first);
  // A private profile keeps the handle pop-up off the sign-out controls.
  const profile = await first.request.post(`${origin}/api/me/profile`, {
    data: {
      handle: `f03-${randomUUID().slice(0, 8)}`,
      displayName: "Session check",
    },
  });
  if (profile.status() !== 201)
    throw new Error(`test profile: ${profile.status()}`);
  await a.goto(`${origin}/account`);
  await a.locator("#signed-in:not([hidden])").waitFor();
  await a
    .locator("#account-notice")
    .filter({ hasText: "Account ready." })
    .waitFor();
  await signIn(second);
  await b.goto(`${origin}/account`);
  await b.locator("#signed-in:not([hidden])").waitFor();
  // A second tab on device A shares its cookie and must follow its sign-out.
  const sibling = await first.newPage();
  await sibling.goto(`${origin}/account`);
  await sibling.locator("#signed-in:not([hidden])").waitFor();
  assert.equal(await a.locator("#sign-out-all").count(), 0);
  assert.equal(await a.locator("#sign-out-others").count(), 0);
  await a.screenshot({ path: `${output}/signed-in-controls.png` });
  await a.locator("#sign-out").click();
  await a.locator("#signed-out:not([hidden])").waitFor();
  // No reload or focus: the yaparena-account broadcast updates the sibling.
  await sibling.locator("#signed-out:not([hidden])").waitFor();
  await a.screenshot({ path: `${output}/this-device-signed-out.png` });
  await a.reload();
  await a.locator("#signed-out:not([hidden])").waitFor();
  // Device B keeps its own session.
  await b.reload();
  await b.locator("#signed-in:not([hidden])").waitFor();
  await b
    .locator("#account-notice")
    .filter({ hasText: "Account ready." })
    .waitFor();
  await b.locator("#sign-out").click();
  await b.locator("#signed-out:not([hidden])").waitFor();
  await b.reload();
  await b.locator("#signed-out:not([hidden])").waitFor();
  console.log(
    "Two-context browser controls PASS: sign out ended only device A, its second tab followed without reload, device B stayed signed in until it signed out; screenshots saved.",
  );
} finally {
  await browser?.close();
}
