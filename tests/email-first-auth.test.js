import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createSharedAbuseLimiter } from "../dist/platform/shared-abuse.js";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  formatYapCoins,
  createAccountWallet,
  grantProgress,
} from "../dist/features/account-wallet/repository.js";
import {
  captureAuthReturn,
  completeAuthReturn,
  parseAuthReturnIntent,
  readAuthReturn,
  rememberAuthReturn,
  safeAuthReturn,
} from "../frontend/auth-return.ts";
import { createEmailAuthSecurity } from "../dist/platform/auth/browser-security.js";

it("admits no sign-in provider origins while preserving media CSP and frame isolation", async () => {
  const app = express()
    .use(
      createEmailAuthSecurity("production", {
        connect: [
          "wss://live.example",
          "https://live.example",
          "https://replay.example",
        ],
        playback: ["https://replay.example"],
      }),
    )
    .get("/live", (_req, res) => res.send("public fixture"));
  const response = await request(app).get("/live");
  const policy = response.headers["content-security-policy"];
  // Auth0 sign-in is a full-page redirect: no provider scripts, frames,
  // CAPTCHA widgets or connections are admitted.
  assert.match(
    policy,
    /connect-src 'self' wss:\/\/live\.example https:\/\/live\.example https:\/\/replay\.example;/,
  );
  assert.match(policy, /frame-src 'self';/);
  assert.match(policy, /script-src 'self';/);
  assert.doesNotMatch(policy, /privy|hcaptcha|challenges\.cloudflare|auth0/);
  assert.match(policy, /media-src 'self' blob: https:\/\/replay\.example/);
  assert.match(policy, /worker-src 'self' blob:/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /walletconnect|unsafe-eval/);
});

describe("exact platform-currency presentation", () => {
  it("preserves exact atomic USDC arithmetic at 100 YC per USDC, including large values", async () => {
    assert.equal(formatYapCoins("1000000"), "100");
    assert.equal(formatYapCoins("1"), "0.0001");
    assert.equal(formatYapCoins("-1"), "-0.0001");
    assert.equal(formatYapCoins("-10001"), "-1.0001");
    assert.equal(formatYapCoins("10001"), "1.0001");
    assert.equal(
      formatYapCoins("1000000000000000000000000000000"),
      "100000000000000000000000000",
    );
    const empty = createAccountWallet({ query: async () => ({ rows: [] }) });
    assert.deepEqual(await empty.balances("1"), {
      available: "0",
      reserved: "0",
      pending: "0",
      promotional: "0",
      withdrawable: "0",
      grants: [],
    });
    const funded = createAccountWallet({
      query: async (sql) => ({
        rows: sql.includes("coin_grant_lots")
          ? []
          : [
              { kind: "available", amount: "1000000" },
              { kind: "backing", amount: "-1000000" },
            ],
      }),
    });
    assert.equal((await funded.balances("1")).available, "100");
  });
  it("shows exact independent grant progress, losses and permanent qualification", () => {
    const base = {
      id: "welcome",
      kind: "welcome",
      target: "25000000",
      net: "10000000",
      peak: "10000000",
    };
    assert.deepEqual(grantProgress(base), {
      id: "welcome",
      label: "Welcome grant",
      target: "2500",
      netProfit: "1000",
      remaining: "1500",
      qualified: false,
      percent: 40,
    });
    const daily = grantProgress({
      ...base,
      id: "daily",
      kind: "daily",
      target: "5000000",
      net: "0",
      peak: "0",
    });
    assert.equal(daily.remaining, "500");
    assert.equal(daily.percent, 0);
    const qualified = grantProgress({
      ...base,
      net: "10000000",
      peak: "25000000",
    });
    assert.equal(qualified.qualified, true);
    assert.equal(qualified.percent, 100);
    assert.equal(qualified.remaining, "0");
    const loss = grantProgress({ ...base, net: "-10000", peak: "0" });
    assert.equal(loss.netProfit, "-1");
    assert.equal(loss.remaining, "2501");
    assert.equal(loss.percent, 0);
    assert.equal(
      grantProgress({ ...base, net: "30000000", peak: "30000000" }).percent,
      100,
    );
    assert.equal(
      grantProgress({ ...base, net: "30000000", peak: "0" }).percent,
      100,
    );
    assert.throws(() => grantProgress({ ...base, target: "0" }));
  });
  it("returns to the exact local debate fragment and rejects redirect escape paths", () => {
    const origin = "https://arena.example";
    assert.equal(
      safeAuthReturn("/debates/test?round=1#commit", origin),
      "/debates/test?round=1#commit",
    );
    for (const path of [
      null,
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/account?next=/account",
      "/\n/evil.example",
      // Parsing turns these into "//evil.example", another site.
      "/.//evil.example",
      "/%2e//evil.example",
      "/a/..//evil.example",
    ])
      assert.equal(safeAuthReturn(path, origin), null);
    assert.equal(safeAuthReturn("/./debates/test", origin), "/debates/test");
  });
  it("keeps only expiring local confirmation intent and public action locators", () => {
    const origin = "https://arena.example",
      now = 1000000,
      intent = {
        version: 1,
        next: "/debates/test?round=4#commit",
        expiresAt: now + 15 * 60 * 1000,
        phase: "oauth",
        action: { kind: "follow", type: "topics", slug: "test-topic" },
      },
      parse = (value) =>
        parseAuthReturnIntent(JSON.stringify(value), origin, now);
    assert.deepEqual(parse(intent), intent);
    // A debate's "Notify me" button is a public action locator too.
    const notify = { ...intent, action: { kind: "debate-notify" } };
    assert.deepEqual(parse(notify), notify);
    for (const patch of [
      { version: 2 },
      { expiresAt: now },
      { expiresAt: now + 15 * 60 * 1000 + 1 },
      { expiresAt: Infinity },
      { phase: "submit" },
      { next: "//elsewhere.example" },
      { next: "/account?next=/debates/test" },
      { action: { kind: "submit", selector: "form" } },
      { action: { kind: "follow", type: "wallets", slug: "test-topic" } },
      { action: { kind: "follow", type: "topics", slug: "../private" } },
      { action: { kind: "page", amount: "5000000" } },
      { credentials: "must-not-be-stored" },
    ])
      assert.equal(parse({ ...intent, ...patch }), null);
    for (const value of [null, "{", "[]", "x".repeat(4097)])
      assert.equal(parseAuthReturnIntent(value, origin, now), null);
    assert.equal(
      parseAuthReturnIntent(JSON.stringify(intent), origin, intent.expiresAt),
      null,
    );
  });
  it("offers same-page completion to the controller without navigation or another action", () => {
    const stored = new Map(),
      navigation = [],
      historyUpdates = [],
      events = new EventTarget(),
      completion = [],
      fixtures = {
        location: {
          origin: "https://arena.example",
          pathname: "/debates/test",
          search: "?round=4",
          hash: "#commit",
          assign: (value) => navigation.push(value),
        },
        history: {
          state: { dialog: "retained" },
          replaceState: (...args) => historyUpdates.push(args),
        },
        window: events,
        sessionStorage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => stored.set(key, value),
          removeItem: (key) => stored.delete(key),
        },
      },
      descriptors = new Map(
        Object.keys(fixtures).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(globalThis, key),
        ]),
      );
    try {
      for (const [key, value] of Object.entries(fixtures))
        Object.defineProperty(globalThis, key, { value, configurable: true });
      const listener = (event) => {
        completion.push(event.detail);
        event.preventDefault();
      };
      events.addEventListener("yap:auth-complete", listener);
      captureAuthReturn("/debates/test?round=4#commit", {
        kind: "community-chat",
      });
      rememberAuthReturn("/debates/test?round=4#commit");
      assert.equal(readAuthReturn().phase, "oauth");
      assert.equal(completeAuthReturn("/debates/test?round=4#commit"), true);
      assert.deepEqual(navigation, []);
      assert.deepEqual(historyUpdates, [
        [{ dialog: "retained" }, "", "/debates/test?round=4#commit"],
      ]);
      assert.deepEqual(completion, [
        { returnTo: "/debates/test?round=4#commit" },
      ]);
      assert.deepEqual(readAuthReturn().action, { kind: "community-chat" });
      assert.equal(readAuthReturn().phase, "confirmed");
      assert.deepEqual(
        Object.keys(JSON.parse(stored.get("yaparena-auth-return"))).sort(),
        ["action", "expiresAt", "next", "phase", "version"],
      );
      events.removeEventListener("yap:auth-complete", listener);
      fixtures.location.pathname = "/account";
      fixtures.location.search = "";
      fixtures.location.hash = "";
      assert.equal(completeAuthReturn("/debates/test?round=4#commit"), true);
      assert.deepEqual(navigation, ["/debates/test?round=4#commit"]);
      assert.equal(readAuthReturn().phase, "confirmed");
      assert.equal(completeAuthReturn("//elsewhere.example"), false);
      assert.deepEqual(navigation, ["/debates/test?round=4#commit"]);
      assert.equal(readAuthReturn(), null);
    } finally {
      for (const [key, descriptor] of descriptors)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
  });
});

describe("shared abuse middleware", () => {
  it("shares a budget between instances, hashes keys and fails closed during outages", async () => {
    const keys = [];
    let count = 0,
      fail = false;
    const options = {
      store: {
        async increment(key) {
          keys.push(key);
          if (fail) throw Error("secret");
          return { count: ++count, ttl: 1200 };
        },
      },
      namespace: "isolated-test",
      secret: "x".repeat(32),
      scope: "auth",
      limit: 2,
      windowMs: 2000,
    };
    const a = express(),
      b = express();
    for (const app of [a, b]) {
      app.use(createSharedAbuseLimiter(options));
      app.get("/", (_r, s) => s.sendStatus(204));
    }
    assert.equal((await request(a).get("/")).status, 204);
    assert.equal((await request(b).get("/")).status, 204);
    const throttled = await request(a).get("/");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers["retry-after"], "2");
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^isolated-test:security:limit:auth:[a-f0-9]{64}$/);
    fail = true;
    assert.equal((await request(b).get("/")).status, 503);
    assert.throws(() =>
      createSharedAbuseLimiter({ ...options, namespace: "unsafe:shared" }),
    );
    const account = express();
    account.use(createSharedAbuseLimiter({ ...options, account: true }));
    assert.equal((await request(account).get("/")).status, 401);
  });
});

describe("Auth0 account routes", () => {
  const fail = () => {
    throw new Error("this route must not call the sign-in provider");
  };
  function setup({ active = false, configured = true } = {}) {
    const auth0 = {
      client: {
        authorizationUrl: async () =>
          new URL("https://tenant.example.test/authorize?state=x"),
        verifyCallback: fail,
        logoutUrl: (returnTo) =>
          new URL(
            `https://tenant.example.test/v2/logout?returnTo=${encodeURIComponent(returnTo)}`,
          ),
      },
      accounts: {
        signIn: fail,
        methods: async (accountId) => {
          assert.equal(accountId, "11");
          return [
            {
              method: "google",
              email: "person@example.test",
              linkedAt: new Date(0),
            },
          ];
        },
      },
      state: { create: async () => {}, consume: fail },
    };
    return createApp({
      messages: {},
      sessions: {
        findUserByTokenHash: async () => (active ? { id: "11" } : null),
        revokeSession: async () => ({ current: true }),
      },
      logger: createLogger({ enabled: false }),
      environment: "production",
      applicationOrigin: "https://arena.example",
      auth0: configured ? auth0 : undefined,
      authRateLimit: 100,
    });
  }
  it("pairs the sign-in methods with the authenticated account in one response", async () => {
    const response = await request(setup({ active: true }))
      .get("/api/auth/methods?accountId=attacker-controlled")
      .set("Cookie", "__Host-session=synthetic");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      accountId: "11",
      methods: [
        {
          method: "google",
          email: "person@example.test",
          linkedAt: new Date(0).toISOString(),
        },
      ],
    });
  });
  it("serves session reads, sign-out and sign-in", async () => {
    const app = setup({ active: true });
    assert.equal(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Cookie", "__Host-session=synthetic")
      ).status,
      200,
    );
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Origin", "https://arena.example")
      .set("Cookie", "__Host-session=synthetic");
    assert.equal(logout.status, 200);
    assert.match(
      logout.body.redirectTo,
      /^https:\/\/tenant\.example\.test\/v2\/logout\?returnTo=https%3A%2F%2Farena\.example%2F$/,
    );
    const login = await request(setup()).get(
      "/api/auth/login?connection=google",
    );
    assert.equal(login.status, 303);
    assert.match(
      login.headers["set-cookie"][0],
      /^__Host-sign-in=.*; Max-Age=600;.*HttpOnly; Secure; SameSite=Lax/,
    );
  });
  it("retires password, wallet, passkey and Privy routes, and reports configured methods", async () => {
    const app = setup();
    assert.deepEqual((await request(app).get("/api/auth/provider")).body, {
      enabled: true,
      methods: ["email", "google"],
    });
    assert.deepEqual(
      (await request(setup({ configured: false })).get("/api/auth/provider"))
        .body,
      { enabled: false, methods: [] },
    );
    assert.equal(
      (
        await request(app)
          .get("/api/auth/methods")
          .set("Cookie", "__Host-session=x")
      ).status,
      401,
    );
    for (const [method, path] of [
      ["post", "/api/auth/register"],
      ["post", "/api/auth/login"],
      ["post", "/api/auth/wallet/login/challenge"],
      ["post", "/api/auth/wallet/login/verify"],
      ["post", "/api/auth/wallet/operations"],
      ["get", "/api/auth/wallets"],
      ["get", "/api/auth/security/passkeys"],
      ["post", "/api/auth/security/operations"],
      ["post", "/api/auth/security/access/login"],
      ["post", "/api/auth/security/provider/link"],
      ["post", "/api/auth/security/provider/recovery"],
      ["post", "/api/auth/privy/exchange"],
      ["post", "/api/auth/journey"],
      ["get", "/api/auth/embedded-wallet"],
      ["post", "/api/auth/embedded-wallet"],
    ])
      assert.equal(
        (
          await request(app)
            [method](path)
            .set("Origin", "https://arena.example")
        ).status,
        404,
        path,
      );
  });
  it("explains that sign-in is unavailable without Auth0 settings", async () => {
    for (const path of [
      "/api/auth/login",
      "/api/auth/callback?state=x&code=y",
    ]) {
      const response = await request(setup({ configured: false })).get(path);
      assert.equal(response.status, 503, path);
      assert.match(response.headers["content-type"], /^text\/html/);
      assert.match(response.text, /Sign-in is temporarily unavailable/);
    }
  });
});
