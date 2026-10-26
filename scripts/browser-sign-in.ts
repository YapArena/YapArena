// Browser verifiers sign in through the local test identity entry
// (scripts/test-identity-entry.ts), which calls the same post-callback sign-in
// function as the Auth0 callback. The context's request client shares the
// browser's cookie jar, so the session cookie it receives signs in the pages.
import type { APIResponse, BrowserContext } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";

// The server closes an idle keep-alive connection after a few seconds. A
// request sent on it just as it closes fails with "socket hang up" before the
// server reads it, for example right after a verifier waits on a child
// process. Retry only such resets, a bounded number of times; callers send the
// same idempotency key on every attempt.
export async function retryOnReset(
  send: () => Promise<APIResponse>,
  attempts = 3,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (
        attempt >= attempts ||
        !/socket hang up|ECONNRESET/i.test((error as Error).message)
      )
        throw error;
      await delay(250 * attempt);
    }
  }
}

export async function signInForTest(
  context: BrowserContext,
  base: string,
  email: string,
  method: "email" | "google" = "email",
) {
  const response = await context.request.post(
    `${base}/api/test-identity/sign-in`,
    { data: { email, method } },
  );
  if (!response.ok())
    throw new Error(`test sign-in failed with HTTP ${response.status()}`);
  const body: { user: { id: string }; created: boolean } =
    await response.json();
  return body;
}

// Every page asks a signed-in account without a profile to pick its handle
// first (frontend/profile-setup.ts). Verifiers that test something else give
// their accounts a profile before opening a page.
export async function createProfileForTest(
  context: BrowserContext,
  base: string,
  profile: {
    handle: string;
    displayName: string;
    bio?: string;
    publicationState?: "draft" | "published";
  },
) {
  const response = await context.request.post(`${base}/api/me/profile`, {
    data: { publicationState: "draft", ...profile },
  });
  if (response.status() !== 201)
    throw new Error(`test profile failed with HTTP ${response.status()}`);
}

// The entry the verifiers start instead of dist/server.js. It refuses
// production, Render, provider settings and non-loopback origins.
export const testIdentityEntry = "scripts/test-identity-entry.ts";
