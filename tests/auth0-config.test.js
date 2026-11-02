import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAuth0Config } from "../dist/platform/auth/auth0-config.js";
import { loadAbuseControlConfig } from "../dist/platform/abuse-config.js";
import {
  Auth0UnavailableError,
  createAuth0Client,
  createLoginSecrets,
  normalizeEmail,
  signInMethod,
} from "../dist/platform/auth/auth0.js";
import {
  createBindingValue,
  safeReturnPath,
  validBindingValue,
} from "../dist/platform/auth/sign-in-state.js";
import { createWebServer } from "../dist/web.js";
import { startIssuer } from "../scripts/oidc-test-issuer.ts";

const auth0 = {
  AUTH0_ISSUER_BASE_URL: "https://staging-tenant.us.auth0.com",
  AUTH0_CLIENT_ID: "abcdefghijklmnopqrstuvwxyz012345",
  AUTH0_CLIENT_SECRET: "a-client-secret-that-is-long-enough",
};

describe("Auth0 settings", () => {
  it("is optional outside production and required in production", () => {
    assert.equal(loadAuth0Config({ NODE_ENV: "development" }), undefined);
    assert.throws(
      () => loadAuth0Config({ NODE_ENV: "production" }),
      /production requires AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET/,
    );
    // The jobs worker never loads these settings.
    assert.equal(
      loadAuth0Config({ NODE_ENV: "production" }, { required: false }),
      undefined,
    );
    const config = loadAuth0Config({ NODE_ENV: "production", ...auth0 });
    assert.equal(config.issuer.href, "https://staging-tenant.us.auth0.com/");
    assert.equal(config.clientId, auth0.AUTH0_CLIENT_ID);
    assert.ok(Object.isFrozen(config));
  });

  it("refuses partial or malformed settings", () => {
    for (const missing of Object.keys(auth0)) {
      const env = { NODE_ENV: "development", ...auth0 };
      delete env[missing];
      assert.throws(
        () => loadAuth0Config(env),
        /requires AUTH0_ISSUER_BASE_URL/,
      );
    }
    for (const [issuer, pattern] of [
      ["not a url", /absolute URL/],
      ["http://tenant.example.test", /HTTPS/],
      ["ftp://tenant.example.test", /HTTPS/],
      ["https://tenant.example.test/path", /an origin/],
      ["https://tenant.example.test/?x=1", /an origin/],
      ["https://user:pass@tenant.example.test", /an origin/],
    ])
      assert.throws(
        () =>
          loadAuth0Config({
            NODE_ENV: "development",
            ...auth0,
            AUTH0_ISSUER_BASE_URL: issuer,
          }),
        pattern,
        issuer,
      );
    assert.throws(
      () =>
        loadAuth0Config({
          NODE_ENV: "development",
          ...auth0,
          AUTH0_CLIENT_ID: "bad id",
        }),
      /AUTH0_CLIENT_ID/,
    );
    assert.throws(
      () =>
        loadAuth0Config({
          NODE_ENV: "development",
          ...auth0,
          AUTH0_CLIENT_SECRET: "short",
        }),
      /AUTH0_CLIENT_SECRET/,
    );
  });

  it("admits a loopback HTTP issuer only outside production", () => {
    const local = { ...auth0, AUTH0_ISSUER_BASE_URL: "http://127.0.0.1:4010" };
    assert.equal(
      loadAuth0Config({ NODE_ENV: "test", ...local }).issuer.protocol,
      "http:",
    );
    assert.throws(
      () => loadAuth0Config({ NODE_ENV: "production", ...local }),
      /HTTPS/,
    );
  });

  it("makes only the production service refuse an *.auth0.com issuer", () => {
    // Staging runs NODE_ENV=production on its tenant domain.
    assert.ok(loadAuth0Config({ NODE_ENV: "production", ...auth0 }));
    for (const issuer of [
      "https://staging-tenant.us.auth0.com",
      "https://tenant.auth0.com",
      "https://AUTH0.COM",
    ])
      assert.throws(
        () =>
          loadAuth0Config({
            NODE_ENV: "production",
            PRODUCTION_SERVICE: "true",
            ...auth0,
            AUTH0_ISSUER_BASE_URL: issuer,
          }),
        /custom domain/,
        issuer,
      );
    assert.equal(
      loadAuth0Config({
        NODE_ENV: "production",
        PRODUCTION_SERVICE: "true",
        ...auth0,
        AUTH0_ISSUER_BASE_URL: "https://login.yaparena.example",
      }).issuer.hostname,
      "login.yaparena.example",
    );
    assert.throws(
      () =>
        loadAuth0Config({
          NODE_ENV: "production",
          PRODUCTION_SERVICE: "yes",
          ...auth0,
        }),
      /PRODUCTION_SERVICE must be "true" or unset/,
    );
    assert.throws(
      () =>
        loadAuth0Config({
          NODE_ENV: "development",
          PRODUCTION_SERVICE: "true",
        }),
      /requires NODE_ENV=production/,
    );
  });

  it("stops the web service from starting in production without Auth0", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://yaparena_runtime@localhost:5432/yaparena",
      APP_ORIGIN: "https://arena.example",
    };
    assert.throws(() => createWebServer(base), /production requires AUTH0_/);
    assert.throws(
      () =>
        createWebServer({
          NODE_ENV: "development",
          DATABASE_URL: base.DATABASE_URL,
          ...auth0,
        }),
      /Auth0 sign-in requires APP_ORIGIN/,
    );
  });
});

describe("Redis abuse-control settings", () => {
  const redis = {
    REDIS_SECURITY_URL: "rediss://security.example:6380",
    REDIS_NAMESPACE: "staging",
    REDIS_KEY_SECRET: "k".repeat(32),
  };
  it("loads complete settings independently of any sign-in provider", () => {
    assert.equal(loadAbuseControlConfig({}), undefined);
    assert.deepEqual(
      { ...loadAbuseControlConfig({ NODE_ENV: "production", ...redis }) },
      {
        redisUrl: redis.REDIS_SECURITY_URL,
        namespace: "staging",
        keySecret: redis.REDIS_KEY_SECRET,
      },
    );
    assert.ok(
      loadAbuseControlConfig({
        ...redis,
        REDIS_SECURITY_URL: "redis://127.0.0.1:6379",
      }),
    );
  });
  it("refuses partial, insecure or malformed settings", () => {
    assert.throws(
      () => loadAbuseControlConfig({ REDIS_NAMESPACE: "x" }),
      /require REDIS_SECURITY_URL/,
    );
    assert.throws(
      () => loadAbuseControlConfig({ ...redis, REDIS_SECURITY_URL: "::" }),
      /absolute URL/,
    );
    assert.throws(
      () =>
        loadAbuseControlConfig({
          NODE_ENV: "production",
          ...redis,
          REDIS_SECURITY_URL: "redis://security.example:6379",
        }),
      /TLS/,
    );
    assert.throws(
      () =>
        loadAbuseControlConfig({ ...redis, REDIS_SECURITY_URL: "http://x" }),
      /TLS/,
    );
    assert.throws(
      () => loadAbuseControlConfig({ ...redis, REDIS_NAMESPACE: "Bad!" }),
      /namespace or key secret/,
    );
    assert.throws(
      () => loadAbuseControlConfig({ ...redis, REDIS_KEY_SECRET: "short" }),
      /namespace or key secret/,
    );
  });
});

describe("sign-in helpers", () => {
  it("accepts same-origin relative return paths only", () => {
    const origin = "https://arena.example";
    for (const [value, expected] of [
      ["/debates/ai?tab=live#chat", "/debates/ai?tab=live#chat"],
      ["/account", "/account"],
      ["/", "/"],
      ["//evil.example", null],
      ["/\\evil.example", null],
      ["https://evil.example/", null],
      ["javascript:alert(1)", null],
      ["/api/auth/login", null],
      ["/api", null],
      ["/a b", null],
      [`/${"a".repeat(2048)}`, null],
      ["", null],
      [undefined, null],
      [["/debates"], null],
    ])
      assert.equal(safeReturnPath(value, origin), expected, String(value));
  });
  it("checks the parsed return path, not only the input", () => {
    const origin = "https://arena.example";
    for (const [value, expected] of [
      // Dot segments collapse into "//host", which a browser reads as
      // another site.
      ["/.//evil.example", null],
      ["/%2e//evil.example", null],
      ["/%2E//evil.example", null],
      ["/..//evil.example", null],
      ["/a/..//evil.example", null],
      ["/x/../..//evil.example", null],
      ["/.//evil.example/x?y=1#z", null],
      ["/.//arena.example@evil.example/", null],
      // Routing ignores case, so these are API routes.
      ["/API/auth/login", null],
      ["/Api", null],
      ["/./api/me", null],
      // Percent-encoding would lengthen the stored path past its limit.
      [`/${"é".repeat(1000)}`, null],
      // Ordinary dot segments still resolve to a local page.
      ["/./debates/ai", "/debates/ai"],
      ["/topics/../debates", "/debates"],
      ["/apis", "/apis"],
    ])
      assert.equal(safeReturnPath(value, origin), expected, String(value));
  });
  it("derives the method from the Auth0 subject and normalizes email", () => {
    assert.equal(signInMethod("email|abc"), "email");
    assert.equal(signInMethod("google-oauth2|123"), "google");
    for (const subject of [
      "auth0|123",
      "github|1",
      "email|",
      "email|a|b",
      `email|${"a".repeat(260)}`,
    ])
      assert.equal(signInMethod(subject), null, subject);
    assert.equal(normalizeEmail("  Person@Example.COM "), "person@example.com");
    for (const value of [
      null,
      1,
      "",
      "no-at-sign",
      "a b@c.d",
      `${"a".repeat(320)}@x.y`,
    ])
      assert.equal(normalizeEmail(value), null, String(value));
  });
  it("creates independent secrets and browser bindings", () => {
    const first = createLoginSecrets();
    const second = createLoginSecrets();
    assert.notEqual(first.state, second.state);
    assert.notEqual(first.nonce, second.nonce);
    assert.match(first.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
    const binding = createBindingValue();
    assert.ok(validBindingValue(binding));
    for (const value of [undefined, "short", `${binding}x`, 1])
      assert.equal(validBindingValue(value), false);
  });
});

describe("Auth0 client", () => {
  const clientId = "client-0123456789";
  const clientSecret = "client-secret-0123456789";
  it("builds fresh-sign-in authorization and logout addresses", async () => {
    const issuer = await startIssuer({ clientId, clientSecret });
    try {
      const client = createAuth0Client(
        { issuer: new URL(issuer.issuer), clientId, clientSecret },
        { redirectUri: "https://arena.example/api/auth/callback" },
      );
      const secrets = createLoginSecrets();
      const url = await client.authorizationUrl({
        ...secrets,
        connection: "email",
        loginHint: "person@example.test",
        prompt: "login",
        maxAge: 0,
      });
      assert.deepEqual(
        Object.fromEntries(
          [...url.searchParams].filter(([key]) =>
            [
              "connection",
              "login_hint",
              "prompt",
              "max_age",
              "scope",
              "response_type",
            ].includes(key),
          ),
        ),
        {
          connection: "email",
          login_hint: "person@example.test",
          prompt: "login",
          max_age: "0",
          scope: "openid email",
          response_type: "code",
        },
      );
      const google = await client.authorizationUrl({
        ...secrets,
        connection: "google",
      });
      assert.equal(google.searchParams.get("connection"), "google-oauth2");
      assert.equal(
        client.logoutUrl("https://arena.example/").href,
        `${issuer.issuer}v2/logout?client_id=${clientId}&returnTo=https%3A%2F%2Farena.example%2F`,
      );
    } finally {
      await issuer.close();
    }
  });
  it("reports discovery failures as unavailable and retries after a pause", async () => {
    let now = 0;
    let calls = 0;
    const client = createAuth0Client(
      {
        issuer: new URL("https://tenant.example.test"),
        clientId,
        clientSecret,
      },
      {
        redirectUri: "https://arena.example/api/auth/callback",
        now: () => now,
        fetch: async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
      },
    );
    const secrets = createLoginSecrets();
    await assert.rejects(
      client.authorizationUrl(secrets),
      Auth0UnavailableError,
    );
    assert.equal(calls, 1);
    now = 14_999;
    await assert.rejects(
      client.authorizationUrl(secrets),
      Auth0UnavailableError,
    );
    assert.equal(calls, 1, "no provider call during the pause");
    now = 15_000;
    await assert.rejects(
      client.verifyCallback(new URLSearchParams("code=x&state=y"), secrets),
      Auth0UnavailableError,
    );
    assert.equal(calls, 2);
  });
});
