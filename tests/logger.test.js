import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  createLogger,
  createHttpLogger,
  serializeError,
} from "../dist/platform/logger.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import { verifyDatabaseState } from "../dist/platform/migrations.js";
import { createProductActionRecorder } from "../dist/features/measurement/router.js";

const password = "synthetic logging test secret";
const authorization = "Bearer synthetic-authorization-credential";
const providerSecret = "synthetic-provider-secret";
const origin = "https://arena.example";
const user = { id: "7", email: "logger@example.com", createdAt: new Date(0) };
const challengeId = "11111111-1111-4111-8111-111111111111";

function captureLogger(options = {}) {
  let output = "";
  const records = [];
  const waiters = new Set();
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      // Deliberately asynchronous: receiving the HTTP response is not a flush.
      setImmediate(() => {
        output += chunk.toString();
        for (const line of chunk.toString().trim().split("\n")) {
          if (!line) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            callback(new Error("logger output must be valid JSON"));
            return;
          }
          records.push(record);
          for (const waiter of waiters) waiter(record);
        }
        callback();
      });
    },
  });
  const logger = createLogger({ ...options, destination });
  return {
    logger,
    records,
    async flush() {
      await new Promise((resolve, reject) => {
        destination.write("", (error) => (error ? reject(error) : resolve()));
      });
    },
    async completion(requestId, status, level) {
      const matches = (record) =>
        record.reqId === requestId && record.res !== undefined;
      const record = await new Promise((resolve, reject) => {
        const existing = records.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("expected HTTP completion log was not written"));
        }, 2_000);
        const waiter = (record) => {
          if (!matches(record)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(record);
        };
        waiters.add(waiter);
      });
      await this.flush();
      assert.equal(record.res.statusCode, status);
      assert.equal(record.level, level);
      assert.equal(record.reqId, requestId);
      assert.ok(Number.isFinite(record.responseTime));
      assert.ok(record.responseTime >= 0);
      return record;
    },
    assertAbsent(values) {
      // Compare booleans so assertion diagnostics never print credentials/logs.
      for (const value of values) {
        assert.equal(
          output.includes(value),
          false,
          "captured logs must not contain a sensitive value",
        );
        assert.equal(
          output.includes(JSON.stringify(value).slice(1, -1)),
          false,
          "captured logs must not contain an encoded sensitive value",
        );
      }
    },
  };
}

it("redacts sandbox webhook authentication proofs and never logs the notification body", async () => {
  const capture = captureLogger(),
    app = express();
  app.use(createHttpLogger(capture.logger));
  app.post(
    "/api/coin-sandbox/webhook",
    express.raw({ type: "application/json" }),
    (_r, s) => s.status(202).json({ accepted: true }),
  );
  const signature = "synthetic-private-sandbox-signature",
    privateBody = "synthetic-private-financial-event";
  await request(app)
    .post("/api/coin-sandbox/webhook")
    .set("Content-Type", "application/json")
    .set("x-request-id", "sandbox-webhook-redaction")
    .set("x-yap-signature", signature)
    .send(JSON.stringify({ event: privateBody }));
  const record = await capture.completion("sandbox-webhook-redaction", 202, 30);
  capture.assertAbsent([signature, privateBody]);
  assert.equal(record.req.headers["x-yap-signature"], "[REDACTED]");
});

it("redacts the browser's account comparison hint from sign-out logs", async () => {
  const capture = captureLogger(),
    app = express(),
    accountHint = "synthetic-private-account-comparison";
  app.use(createHttpLogger(capture.logger));
  app.post("/api/auth/logout", (_r, s) => s.status(204).end());
  await request(app)
    .post("/api/auth/logout")
    .set("x-request-id", "logout-account-comparison-redaction")
    .set("x-yaparena-expected-account", accountHint);
  const record = await capture.completion(
    "logout-account-comparison-redaction",
    204,
    30,
  );
  capture.assertAbsent([accountHint]);
  assert.equal(record.req.headers["x-yaparena-expected-account"], "[REDACTED]");
});

it("redacts the financial browser session comparison hint from HTTP logs", async () => {
  const capture = captureLogger(),
    app = express(),
    sessionHint = "synthetic-private-financial-session";
  app.use(createHttpLogger(capture.logger));
  app.post("/api/coin-sandbox/withdrawals", (_r, s) =>
    s.status(409).json({ error: "account changed" }),
  );
  await request(app)
    .post("/api/coin-sandbox/withdrawals")
    .set("x-request-id", "financial-session-comparison-redaction")
    .set("x-yaparena-session", sessionHint);
  const record = await capture.completion(
    "financial-session-comparison-redaction",
    409,
    40,
  );
  capture.assertAbsent([sessionHint]);
  assert.equal(record.req.headers["x-yaparena-session"], "[REDACTED]");
  assert.equal(record.req.url, "/api/coin-sandbox/withdrawals");
});

// One-use values a sign-in carries through the provider round trip.
const authorizationCode = "synthetic-authorization-code";
const nonce = "synthetic-nonce-value-0123456789abcdefghijklmnop";

// Auth0 sign-in with a fake provider client: the real login, callback and
// logout routes run, so their cookies, codes and redirects reach the logger.
function auth0Fixture(sessionRecords, signIn) {
  const transactions = new Map();
  return {
    client: {
      async authorizationUrl(request) {
        return new URL(
          `https://tenant.example.test/authorize?state=${request.state}&nonce=${request.nonce}&code_challenge=${request.codeVerifier}`,
        );
      },
      async verifyCallback(query, checks) {
        assert.equal(query.get("code"), authorizationCode);
        assert.equal(query.get("state"), checks.state);
        return {
          subject: "email|logger",
          email: user.email,
          method: "email",
          authTime: 1,
        };
      },
      logoutUrl: (returnTo) =>
        new URL(
          `https://tenant.example.test/v2/logout?returnTo=${encodeURIComponent(returnTo)}`,
        ),
    },
    state: {
      async create(input) {
        transactions.set(input.secrets.state, input);
      },
      async consume(state, binding) {
        const input = transactions.get(state);
        transactions.delete(state);
        return input && input.binding === binding
          ? {
              purpose: "sign_in",
              returnPath: input.returnPath,
              userId: null,
              operationId: null,
              pendingLinkId: null,
              secrets: { ...input.secrets, nonce },
            }
          : null;
      },
    },
    accounts: {
      async signIn(identity, context, grant) {
        if (signIn) return signIn(identity, context, grant);
        sessionRecords.set(grant.tokenHash, user);
        return {
          kind: "session",
          user: { ...user, authGeneration: "0" },
          created: false,
          linked: [],
        };
      },
      methods: async () => [],
    },
  };
}

// Starts and completes a sign-in, returning the callback response and the
// values that must never appear in logs.
async function signInThroughCallback(app, capture, label) {
  const login = await loggedResponse(
    capture,
    request(app).get("/api/auth/login?connection=email&return=%2Fdebates"),
    `${label}-login`,
    303,
  );
  const location = new URL(login.headers.location);
  const state = location.searchParams.get("state");
  const binding = login.headers["set-cookie"]
    .find((cookie) => /^(?:__Host-)?sign-in=/.test(cookie))
    .split(";")[0];
  const callback = await loggedResponse(
    capture,
    request(app)
      .get(`/api/auth/callback?code=${authorizationCode}&state=${state}`)
      .set("Cookie", binding),
    `${label}-callback`,
    200,
  );
  return {
    callback,
    secrets: [
      authorizationCode,
      state,
      location.searchParams.get("nonce"),
      location.searchParams.get("code_challenge"),
      binding,
      binding.split("=")[1],
    ],
  };
}

function fixture({
  environment = "development",
  withAuth0 = true,
  signIn,
  ...overrides
} = {}) {
  const capture = captureLogger();
  const sessionRecords = new Map();
  const consents = new Set();
  const app = createApp({
    auth0: withAuth0 ? auth0Fixture(sessionRecords, signIn) : undefined,
    messages: {},
    database: { query: async () => ({ rows: [] }) },
    sessions: {
      revokeSession: async (_userId, hash) => ({
        current: sessionRecords.delete(hash),
      }),
      create: async (_userId, hash) => sessionRecords.set(hash, user),
      findUserByTokenHash: async (hash) => sessionRecords.get(hash) ?? null,
      deleteByTokenHash: async (hash) => sessionRecords.delete(hash),
    },
    measurement: {
      grant: async (hash) => consents.add(hash),
      hasConsent: async (hash) => consents.has(hash),
      withdraw: async (hash) => consents.delete(hash),
      summary: async () => ({ events: [], watch: [] }),
    },
    identity: { getRoles: async () => ["participant"] },
    logger: capture.logger,
    environment,
    applicationOrigin: origin,
    ...overrides,
  });
  return { app, capture, sessionRecords, consents };
}

function clientCookie(response, name, environment, { cleared = false } = {}) {
  const cookies = response.headers["set-cookie"];
  assert.ok(Array.isArray(cookies), "the client must still receive cookies");
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(typeof cookie === "string", "the expected cookie must be returned");
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Strict"));
  assert.ok(cookie.includes("Path=/"));
  assert.equal(cookie.includes("Secure"), environment === "production");
  assert.equal(cookie.includes("Domain="), false);
  const pair = cookie.split(";")[0];
  const token = pair.slice(name.length + 1);
  if (cleared) {
    assert.equal(token.length, 0);
    assert.ok(cookie.includes("Expires=Thu, 01 Jan 1970"));
  } else {
    const pattern = name.endsWith("measurement")
      ? /^[0-9a-f]{64}$/
      : /^[A-Za-z0-9_-]{43}$/;
    assert.ok(pattern.test(token), "the returned bearer must remain valid");
  }
  return { cookie, pair, token };
}

function assertRedactedCookies(record) {
  const cookies = record.res.headers["set-cookie"];
  assert.ok(
    cookies === undefined || cookies === "[REDACTED]",
    "the entire Set-Cookie field must be removed or redacted",
  );
}

// A logged error keeps only fields whose shape no credential has (F01): never
// its message, stack text, nested messages or provider properties.
const safeErrorShape = {
  redacted: (value) => value === true,
  type: (value) => /^[A-Za-z_$][\w$]{0,63}$/.test(value),
  // Only an OperatorError's message, which is written in code, is kept.
  message: (value, error) =>
    error.type === "OperatorError" && typeof value === "string",
  name: (value) => /^(?:[A-Z][a-z]{1,20}){1,6}$/.test(value),
  code: (value) => /^[0-9A-Z_]{2,64}$/.test(value),
  status: (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  frames: (value) =>
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every((frame) =>
      /^(?:\[external\]|[\w$.<>[\] ]+ \([^\s()]+:\d+\)|[^\s()]+:\d+)$/.test(
        frame,
      ),
    ),
  cause: (value) => (assertRedactedError(value), true),
  errors: (value) =>
    Array.isArray(value) &&
    value.length <= 3 &&
    (value.forEach(assertRedactedError), true),
};

function assertRedactedError(error) {
  assert.ok(
    error !== null && typeof error === "object" && error.redacted === true,
    "error diagnostics must be replaced with a safe summary",
  );
  for (const [field, value] of Object.entries(error))
    assert.ok(
      Object.hasOwn(safeErrorShape, field) &&
        safeErrorShape[field](value, error),
      "a logged error keeps only safe fields in their safe shape",
    );
}

async function loggedResponse(capture, httpRequest, requestId, status) {
  const response = await httpRequest
    .set("X-Request-Id", requestId)
    .set("Origin", origin);
  assert.equal(response.status, status);
  assert.equal(response.headers["x-request-id"], requestId);
  const record = await capture.completion(
    requestId,
    status,
    status >= 500 ? 50 : status >= 400 ? 40 : 30,
  );
  if (response.headers["set-cookie"]) assertRedactedCookies(record);
  return response;
}

function credentialError(signature = "synthetic-wallet-signature") {
  const error = new Error(`provider rejected ${providerSecret}`, {
    cause: new Error(`signature ${signature}`, {
      cause: new Error(`password ${password}`),
    }),
  });
  // Provider/database errors can carry request bodies, headers and diagnostics.
  Object.assign(error, {
    name: providerSecret,
    code: providerSecret,
    password,
    signature,
    headers: { authorization, cookie: "session=synthetic-error-cookie" },
    config: { credentials: providerSecret },
    diagnostics: { request: { password, signature } },
    errors: [new Error(`aggregate ${providerSecret}`)],
  });
  error.stack = `provider stack ${providerSecret}`;
  Object.defineProperty(error, "message", { enumerable: true });
  return error;
}

describe("credential-safe HTTP logs", () => {
  it("omits account OAuth query credentials from HTTP completion logs", async () => {
    const { app, capture } = fixture();
    const requestId = "logger-oauth-return";
    await request(app)
      .get("/account?code=synthetic-oauth-secret&state=synthetic-state")
      .set("X-Request-Id", requestId);
    const record = await capture.completion(requestId, 404, 40);
    assert.equal(record.req.url, "/account");
    capture.assertAbsent(["synthetic-oauth-secret", "synthetic-state"]);
  });
  it("redacts sign-in cookies, codes, state and provider redirects with the real app logger", async () => {
    const { app, capture, sessionRecords } = fixture({ withAuth0: true });
    const { callback, secrets } = await signInThroughCallback(
      app,
      capture,
      "logger-sign-in",
    );
    const cookie = clientCookie(callback, "session", "development");
    assert.ok(sessionRecords.has(hashSessionToken(cookie.token)));
    const login = await capture.completion("logger-sign-in-login", 303, 30);
    assert.equal(login.req.url, "/api/auth/login");
    assert.equal(login.res.headers.location, "[REDACTED]");
    const record = await capture.completion("logger-sign-in-callback", 200, 30);
    assert.equal(record.req.url, "/api/auth/callback");
    assert.deepEqual(record.req.query, {});
    capture.assertAbsent([cookie.cookie, cookie.token, ...secrets]);
    assertRedactedCookies(record);
  });

  for (const environment of ["development", "production"]) {
    const sessionName =
      environment === "production" ? "__Host-session" : "session";
    const measurementName =
      environment === "production" ? "__Host-measurement" : "measurement";

    it(`preserves Auth0 sign-in and logout in ${environment}`, async () => {
      const { app, capture, sessionRecords } = fixture({
        environment,
        withAuth0: true,
      });
      const first = await signInThroughCallback(app, capture, "first");
      const firstCookie = clientCookie(
        first.callback,
        sessionName,
        environment,
      );
      assert.ok(sessionRecords.has(hashSessionToken(firstCookie.token)));
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", firstCookie.pair),
        "first-user",
        200,
      );
      const second = await signInThroughCallback(app, capture, "second");
      const secondCookie = clientCookie(
        second.callback,
        sessionName,
        environment,
      );
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", secondCookie.pair),
        "second-user",
        200,
      );
      const logout = await loggedResponse(
        capture,
        request(app).post("/api/auth/logout").set("Cookie", secondCookie.pair),
        "logout",
        200,
      );
      assert.equal(logout.headers["set-cookie"], undefined);
      assert.match(logout.body.redirectTo, /\/v2\/logout\?returnTo=/);
      assert.equal(
        sessionRecords.has(hashSessionToken(secondCookie.token)),
        false,
      );
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", secondCookie.pair),
        "revoked-user",
        401,
      );
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", firstCookie.pair),
        "other-device",
        200,
      );
      capture.assertAbsent([
        firstCookie.cookie,
        firstCookie.token,
        secondCookie.cookie,
        secondCookie.token,
        ...first.secrets,
        ...second.secrets,
      ]);
    });

    it(`preserves measurement consent grant and withdrawal in ${environment}`, async () => {
      const { app, capture, consents } = fixture({ environment });
      const granted = await loggedResponse(
        capture,
        request(app).post("/api/measurement/consent").send({ consent: true }),
        "consent-grant",
        201,
      );
      const cookie = clientCookie(granted, measurementName, environment);
      const hash = createHash("sha256").update(cookie.token).digest("hex");
      assert.ok(consents.has(hash));
      const status = await loggedResponse(
        capture,
        request(app).get("/api/measurement/consent").set("Cookie", cookie.pair),
        "consent-status",
        200,
      );
      assert.equal(status.body.consented, true);
      const withdrawn = await loggedResponse(
        capture,
        request(app)
          .delete("/api/measurement/consent")
          .set("Cookie", cookie.pair),
        "consent-withdraw",
        200,
      );
      assert.equal(withdrawn.body.consented, false);
      const cleared = clientCookie(withdrawn, measurementName, environment, {
        cleared: true,
      });
      assert.equal(consents.has(hash), false);
      const after = await loggedResponse(
        capture,
        request(app).get("/api/measurement/consent").set("Cookie", cookie.pair),
        "consent-after-withdrawal",
        200,
      );
      assert.equal(after.body.consented, false);
      capture.assertAbsent([cookie.cookie, cookie.token, cleared.cookie]);
    });

    it(`redacts multiple session and measurement cookies together in ${environment}`, async () => {
      const { app, capture } = fixture({ environment, withAuth0: true });
      const combined = express();
      const measurementToken = createHash("sha256")
        .update("synthetic extra cookie")
        .digest("hex");
      combined.use((_request, response, next) => {
        response.cookie(measurementName, measurementToken, {
          httpOnly: true,
          secure: environment === "production",
          sameSite: "strict",
          path: "/",
        });
        next();
      });
      // The real app middleware serializes both the existing and new headers.
      combined.use(app);
      const { callback: response, secrets } = await signInThroughCallback(
        combined,
        capture,
        "multiple-cookies",
      );
      assert.equal(response.headers["set-cookie"].length, 2);
      const session = clientCookie(response, sessionName, environment);
      const measurement = clientCookie(response, measurementName, environment);
      capture.assertAbsent([
        session.cookie,
        session.token,
        measurement.cookie,
        measurement.token,
        ...secrets,
      ]);
    });
  }

  it("retains incoming Cookie and Authorization header redaction", async () => {
    const { app, capture } = fixture();
    const incomingToken = "synthetic-incoming-cookie";
    await loggedResponse(
      capture,
      request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${incomingToken}`)
        .set("Authorization", authorization),
      "incoming-credentials",
      401,
    );
    const record = capture.records.find((record) => record.res);
    assert.ok(record.req.headers.cookie === "[REDACTED]");
    assert.ok(record.req.headers.authorization === "[REDACTED]");
    assert.equal(record.req.headers["x-request-id"], "incoming-credentials");
    capture.assertAbsent([incomingToken, authorization]);
  });

  it("does not log one-use sign-in values or request bodies on failed sign-in and sign-out requests", async () => {
    const { app, capture } = fixture();
    const forgedState = "synthetic-forged-state-0123456789abcdefghijklmno";
    await loggedResponse(
      capture,
      request(app).get(
        `/api/auth/callback?code=${authorizationCode}&state=${forgedState}`,
      ),
      "forged-callback",
      400,
    );
    await loggedResponse(
      capture,
      request(app).get("/api/auth/login?connection=unknown&return=%2Fsecret"),
      "unknown-connection",
      400,
    );
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/logout")
        .set("Content-Type", "application/json")
        .send(`{"secret":"${password}",`),
      "invalid-json",
      400,
    );
    capture.assertAbsent([
      authorizationCode,
      forgedState,
      password,
      "%2Fsecret",
    ]);
    assert.ok(capture.records.every((record) => record.req.body === undefined));
  });

  it("keeps rate-limit responses at warning level without logging sign-in values", async () => {
    const { app, capture } = fixture({ authRateLimit: 1 });
    const first = await loggedResponse(
      capture,
      request(app).get("/api/auth/login?connection=email"),
      "first-login",
      303,
    );
    await loggedResponse(
      capture,
      request(app).get(
        `/api/auth/callback?code=${authorizationCode}&state=limited-state`,
      ),
      "limited-callback",
      429,
    );
    capture.assertAbsent([
      authorizationCode,
      "limited-state",
      new URL(first.headers.location).searchParams.get("state"),
    ]);
  });

  it("sanitizes explicit application error logs across sign-in and consent routes", async () => {
    const signature = "synthetic-error-signature";
    const error = credentialError(signature);
    const fail = async () => {
      throw error;
    };
    {
      const { app, capture } = fixture({ signIn: fail });
      const login = await request(app).get("/api/auth/login?connection=email");
      const state = new URL(login.headers.location).searchParams.get("state");
      const binding = login.headers["set-cookie"][0].split(";")[0];
      const response = await loggedResponse(
        capture,
        request(app)
          .get(`/api/auth/callback?code=${authorizationCode}&state=${state}`)
          .set("Authorization", authorization)
          .set("Cookie", `${binding}; session=synthetic-error-cookie`),
        "unexpected-sign-in-error",
        500,
      );
      assert.ok(response.body.error === "internal server error");
      const explicit = capture.records.find(
        (record) => record.msg === "unhandled request error",
      );
      assert.ok(explicit);
      assert.equal(explicit.reqId, "unexpected-sign-in-error");
      assert.equal(explicit.level, 50);
      assertRedactedError(explicit.error);
      assertRedactedError(
        capture.records.find(
          (record) => record.res && record.reqId === "unexpected-sign-in-error",
        ).err,
      );
      capture.assertAbsent([
        password,
        signature,
        providerSecret,
        authorization,
        authorizationCode,
        state,
        "synthetic-error-cookie",
      ]);
    }
    {
      const { app, capture } = fixture({ measurement: { grant: fail } });
      const response = await loggedResponse(
        capture,
        request(app)
          .post("/api/measurement/consent")
          .set("Authorization", authorization)
          .set("Cookie", "session=synthetic-error-cookie")
          .send({ consent: true }),
        "unexpected-consent-error",
        500,
      );
      assert.ok(response.body.error === "internal server error");
      const explicit = capture.records.find(
        (record) => record.msg === "unhandled request error",
      );
      assert.ok(explicit);
      assertRedactedError(explicit.error);
      capture.assertAbsent([
        password,
        signature,
        providerSecret,
        authorization,
        "synthetic-error-cookie",
      ]);
    }
  });

  for (const mode of ["response.err", "response error event"]) {
    it(`sanitizes automatic HTTP errors from ${mode}`, async () => {
      const capture = captureLogger();
      const app = express();
      const error = credentialError();
      app.use(createHttpLogger(capture.logger));
      app.get("/provider-error", (_request, response) => {
        response.cookie("session", "synthetic-automatic-cookie");
        response.status(502);
        if (mode === "response.err") response.err = error;
        else {
          response.flushHeaders();
          response.emit("error", error);
        }
        response.end();
      });
      await loggedResponse(
        capture,
        request(app).get("/provider-error").set("Authorization", authorization),
        "automatic-error",
        502,
      );
      assert.equal(capture.records.length, 1);
      assertRedactedError(capture.records[0].err);
      assert.ok(capture.records[0].msg === "request errored");
      capture.assertAbsent([
        password,
        "synthetic-wallet-signature",
        providerSecret,
        authorization,
        "synthetic-error-cookie",
        "synthetic-automatic-cookie",
      ]);
    });
  }

  it("sanitizes provider error fields and free-text diagnostics on root and child loggers", async () => {
    const capture = captureLogger();
    const error = credentialError();
    const fields = [
      "error",
      "err",
      "permissionError",
      "pauseError",
      "stopError",
    ];
    for (const logger of [
      capture.logger,
      capture.logger.child({ reqId: "provider-error" }),
    ]) {
      logger.error(
        Object.fromEntries(fields.map((field) => [field, error])),
        "provider operation failed",
      );
      logger.warn(
        { error: `provider diagnostic ${providerSecret}` },
        "provider reported an error",
      );
    }
    await capture.flush();
    assert.equal(capture.records.length, 4);
    for (const record of capture.records) {
      for (const field of fields) {
        if (field in record) assertRedactedError(record[field]);
      }
    }
    capture.assertAbsent([
      password,
      "synthetic-wallet-signature",
      providerSecret,
      authorization,
      "synthetic-error-cookie",
    ]);
  });

  it("sanitizes nonfatal product-event errors while preserving their context", async () => {
    const capture = captureLogger();
    const recorder = createProductActionRecorder({
      environment: "development",
      measurement: {
        recordAction: async () => {
          throw credentialError();
        },
      },
    });
    const measurementToken = "ab".repeat(32);
    await recorder(
      {
        cookies: { measurement: measurementToken },
        user,
        log: capture.logger.child({ reqId: "product-event" }),
      },
      { type: "follow", resourceId: challengeId },
    );
    await capture.flush();
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].level, 40);
    assert.equal(capture.records[0].reqId, "product-event");
    assert.equal(capture.records[0].eventType, "follow");
    assertRedactedError(capture.records[0].error);
    capture.assertAbsent([
      password,
      providerSecret,
      "synthetic-wallet-signature",
      authorization,
      measurementToken,
    ]);
  });

  it("excludes health, readiness and metrics completion logs", async () => {
    const { app, capture } = fixture({ jobHeartbeat: { age: async () => 1 } });
    for (const path of ["/health", "/ready", "/ready/jobs", "/metrics"]) {
      const response = await request(app).get(path);
      assert.equal(response.status, 200);
      assert.ok(/^[0-9a-f-]{36}$/.test(response.headers["x-request-id"]));
    }
    await capture.flush();
    assert.equal(capture.records.length, 0);
  });

  it("retains sanitized explicit readiness failures without a completion log", async () => {
    const { app, capture } = fixture({
      database: {
        query: async () => {
          throw credentialError();
        },
      },
    });
    const response = await request(app)
      .get("/ready")
      .set("X-Request-Id", "failed-readiness");
    assert.equal(response.status, 503);
    await capture.flush();
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].reqId, "failed-readiness");
    assert.equal(capture.records[0].level, 50);
    assert.equal(capture.records[0].res, undefined);
    assertRedactedError(capture.records[0].error);
    capture.assertAbsent([
      password,
      "synthetic-wallet-signature",
      providerSecret,
      authorization,
    ]);
  });

  it("respects disabled logging and configured log levels", async () => {
    for (const options of [{ enabled: false }, { level: "error" }]) {
      const capture = captureLogger(options);
      capture.logger.info("info event");
      capture.logger.warn("warning event");
      capture.logger.error({ error: credentialError() }, "error event");
      await capture.flush();
      assert.equal(capture.records.length, options.enabled === false ? 0 : 1);
      if (capture.records.length) assertRedactedError(capture.records[0].error);
      capture.assertAbsent([password, providerSecret, authorization]);
    }
  });
});

describe("credential-safe error diagnostics", () => {
  class DatabaseError extends Error {}

  function cancelledQuery() {
    const error = new DatabaseError(`canceling statement for ${password}`, {
      cause: Object.assign(new Error(`socket ${providerSecret}`), {
        code: "ECONNRESET",
      }),
    });
    error.code = "57014";
    return error;
  }

  async function logged(values) {
    const capture = captureLogger();
    for (const value of values)
      capture.logger.error({ error: value }, "operation failed");
    await capture.flush();
    assert.equal(capture.records.length, values.length);
    for (const record of capture.records) assertRedactedError(record.error);
    return { capture, errors: capture.records.map(({ error }) => error) };
  }

  it("keeps the class, code, status, frames and causes of a logged error", async () => {
    const upload = Object.assign(
      new Error(`upload rejected ${providerSecret}`),
      {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      },
    );
    const {
      capture,
      errors: [query, provider],
    } = await logged([cancelledQuery(), upload]);
    assert.equal(query.type, "DatabaseError");
    assert.equal(query.code, "57014");
    assert.match(
      query.frames[0],
      /^cancelledQuery \(tests\/logger\.test\.js:\d+\)$/,
    );
    assert.equal(query.cause.type, "Error");
    assert.equal(query.cause.code, "ECONNRESET");
    assert.match(query.cause.frames[0], /^cancelledQuery \(/);
    assert.deepEqual(
      [provider.type, provider.name, provider.status],
      ["Error", "NoSuchKey", 404],
    );
    capture.assertAbsent([
      password,
      providerSecret,
      "canceling statement",
      "upload rejected",
    ]);
  });

  it("drops messages, stack text and provider properties at every depth", async () => {
    // A frame-shaped line in a message must never surface as a frame.
    const forgedFrame = `    at ${providerSecret} (${new URL(`../${providerSecret}.js`, import.meta.url).href}:1:1)`;
    const multiline = new Error(`first line\n${forgedFrame}`);
    const rewritten = new Error(`token ${providerSecret}\n${forgedFrame}`);
    assert.ok(rewritten.stack.includes(forgedFrame));
    rewritten.message = "message rewritten after the stack was read";
    const credentialShaped = Object.assign(new Error("credential-shaped"), {
      name: "Hunter2Password",
      code: "sk_live_51HxAbC",
      status: "500",
      statusCode: 99999,
    });
    const throwing = new Error(`getter ${providerSecret}`);
    Object.defineProperty(throwing, "code", {
      get() {
        throw new Error(providerSecret);
      },
    });
    const proxy = new Proxy(new Error(providerSecret), {
      get() {
        throw new Error(providerSecret);
      },
    });
    const cyclic = new Error(`cycle ${providerSecret}`);
    cyclic.cause = cyclic;
    const aggregate = new AggregateError(
      Array.from(
        { length: 5 },
        (_, attempt) => new Error(`attempt ${attempt} ${providerSecret}`),
      ),
      `all failed ${providerSecret}`,
    );
    const { capture, errors } = await logged([
      multiline,
      rewritten,
      credentialShaped,
      throwing,
      proxy,
      cyclic,
      aggregate,
      credentialError(),
      `diagnostic ${providerSecret}`,
      null,
    ]);
    const [first, second, shaped, getter, trapped, cycle, all, provider] =
      errors;
    assert.ok(first.frames.length > 0);
    assert.equal(second.frames, undefined);
    assert.deepEqual(shaped, {
      redacted: true,
      type: "Error",
      frames: shaped.frames,
    });
    assert.deepEqual(getter, { redacted: true, type: "Error" });
    assert.deepEqual(trapped, { redacted: true, type: "Error" });
    assert.ok(cycle.cause.cause.cause);
    assert.equal(cycle.cause.cause.cause.cause, undefined);
    assert.equal(all.type, "AggregateError");
    assert.equal(all.errors.length, 3);
    // The fixture's name, code and stack all hold the provider secret.
    assert.equal(provider.name, undefined);
    assert.equal(provider.code, undefined);
    assert.equal(provider.frames, undefined);
    assert.equal(provider.cause.cause.type, "Error");
    assert.deepEqual(errors.slice(8), [
      { redacted: true, type: "string" },
      { redacted: true, type: "null" },
    ]);
    capture.assertAbsent([
      password,
      providerSecret,
      "synthetic-wallet-signature",
      authorization,
      "synthetic-error-cookie",
      "first line",
      "rewritten",
      "credential-shaped",
      "Hunter2Password",
      "sk_live_51HxAbC",
      "all failed",
    ]);
  });

  it("logs the operator guidance of a failed start, and no other message", async () => {
    // Runbooks tell operators to look for this text when a deploy fails.
    const pending = await verifyDatabaseState(
      {
        query: async (sql) => ({
          rows: sql.includes("current_user") ? [{ safe: true }] : [],
        }),
      },
      new URL("../migrations", import.meta.url),
    ).then(
      () => assert.fail("an unmigrated database must fail the start"),
      (error) => error,
    );
    const {
      capture,
      errors: [operator, plain],
    } = await logged([
      pending,
      new Error(pending.message),
      new Error(`pending ${providerSecret}`),
    ]);
    assert.equal(operator.type, "OperatorError");
    assert.match(
      operator.message,
      /^database migrations are pending: \d+_\S+(?:, \d+_\S+)*$/,
    );
    assert.equal(plain.message, undefined);
    capture.assertAbsent([providerSecret]);
  });

  it("keeps only codes and names in a recognised shape", () => {
    const codes = {
      23505: true,
      ECONNREFUSED: true,
      EAI_AGAIN: true,
      ENOTFOUND: true,
      ERR_INVALID_ARG_TYPE: true,
      UND_ERR_CONNECT_TIMEOUT: true,
      OAUTH_RESPONSE_BODY_ERROR: true,
      JBSWY3DPEHPK3PXP: false,
      sk_live_51HxAbC: false,
      invalid_grant: false,
      [providerSecret]: false,
    };
    for (const [code, kept] of Object.entries(codes))
      assert.equal(
        serializeError(Object.assign(new Error("x"), { code })).code,
        kept ? code : undefined,
      );
    assert.equal(
      serializeError(Object.assign(new Error("x"), { code: 42 })).code,
      undefined,
    );
    const names = {
      NoSuchKey: true,
      AbortError: true,
      TimeoutError: true,
      Hunter2: false,
      HTTPError: false,
      error: false,
      [providerSecret]: false,
    };
    for (const [name, kept] of Object.entries(names))
      assert.equal(
        serializeError(Object.assign(new Error("x"), { name })).name,
        kept ? name : undefined,
      );
    assert.equal(serializeError(new TypeError("x")).type, "TypeError");
    assert.equal(serializeError(Object.create(null)).type, undefined);
    assert.equal(
      serializeError({ stack: `    at leak (/app/${providerSecret}.js:1:1)` })
        .frames,
      undefined,
    );
    assert.equal(
      serializeError({ statusCode: 503, response: { body: providerSecret } })
        .status,
      503,
    );
  });
});
