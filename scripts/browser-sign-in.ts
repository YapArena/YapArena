// Browser verifiers sign in through the local test identity entry
// (scripts/test-identity-entry.ts), which calls the same post-callback sign-in
// function as the Auth0 callback. The context's request client shares the
// browser's cookie jar, so the session cookie it receives signs in the pages.
import type { BrowserContext } from "playwright-core";

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
