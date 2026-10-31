import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp, handleError } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { pingDatabase } from "../dist/platform/database.js";

describe("yaparena API", () => {
  const logger = createLogger({ enabled: false });
  const createdAt = "2026-08-04T17:00:00.000Z";
  const messages = {
    isReady: mock.fn(async () => {}),
    create: mock.fn(async (_userId, name, message) => ({
      id: "1",
      name,
      message,
      createdAt,
    })),
    list: mock.fn(async () => [
      {
        id: "1",
        name: "Example User",
        message: "Hello, Example User!",
        createdAt,
      },
    ]),
  };
  const users = {
    create: async () => ({}),
    findByEmail: async () => null,
  };
  const sessions = {
    create: async () => ({}),
    findUserByTokenHash: async () => ({ id: "7" }),
    deleteByTokenHash: async () => false,
  };
  const database = { query: mock.fn(async () => ({ rows: [] })) };
  const app = createApp({ messages, database, users, sessions, logger });

  function authenticated(method, path) {
    return request(app)[method](path).set("Cookie", "session=test-token");
  }

  it("reports that it is healthy", async () => {
    const response = await request(app).get("/health");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-powered-by"], undefined);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  });

  it("serves public turn windows only when they are enabled", async () => {
    const id = "33333333-3333-4333-8333-333333333333",
      path = `/api/public/debates/${id}/windows`;
    assert.equal((await request(app).get(path)).status, 404);
    const enabled = createApp({
      messages,
      database,
      users,
      sessions,
      logger,
      turnWindows: {
        publicWindows: async () => ({ debateId: id, windows: [] }),
      },
    });
    const response = await request(enabled).get(path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { debateId: id, windows: [] });
  });

  it("mounts transcriber ingest before JSON parsing and outside the API limit", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const { signIngest, ingestHeaders } =
      await import("../dist/features/transcription/protocol.js");
    const secret = "synthetic-transcription-ingest-secret-32b";
    const enabled = createApp({
      messages,
      database,
      users,
      sessions,
      logger,
      apiRateLimit: 1,
      transcriptionIngest: {
        secret,
        repository: {
          ingest: async () => ({ status: 409, body: { code: "stale_turn" } }),
          session: async (debateId) => ({ debateId }),
        },
      },
    });
    const body = JSON.stringify({ jobId: "AJ_1" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const timestamp = String(Date.now());
      const response = await request(enabled)
        .post(`/api/internal/transcription/debates/${id}/session`)
        .set("Content-Type", "application/json")
        .set(ingestHeaders.timestamp, timestamp)
        .set(ingestHeaders.signature, signIngest(secret, timestamp, body))
        .send(body);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { debateId: id });
    }
    assert.equal(
      (
        await request(app)
          .post(`/api/internal/transcription/debates/${id}/session`)
          .set("Content-Type", "application/json")
          .send(body)
      ).status,
      404,
    );
  });

  it("does not require a shared staging password for public requests", async () => {
    const response = await request(app).get("/unknown");
    assert.equal(response.status, 404);
    assert.equal(response.headers["www-authenticate"], undefined);
  });

  it("allows only configured media origins in the browser policy", async () => {
    const mediaProvider = {
      publicUrl: "ws://localhost:7880",
      playbackOrigin: "http://localhost:8333",
    };
    const mediaApp = createApp({
      messages,
      users,
      sessions,
      logger,
      mediaProvider,
    });
    const response = await request(mediaApp).get("/health");
    const policy = response.headers["content-security-policy"];
    assert.match(policy, /connect-src 'self' ws:\/\/localhost:7880/);
    assert.match(policy, /http:\/\/localhost:7880/);
    assert.match(policy, /media-src 'self' blob: http:\/\/localhost:8333/);
    assert.doesNotMatch(policy, /upgrade-insecure-requests/);
    const productionApp = createApp({
      messages,
      users,
      sessions,
      logger,
      mediaProvider: {
        publicUrl: "wss://media.example",
        playbackOrigin: "https://storage.example",
      },
      environment: "production",
      applicationOrigin: "https://arena.example",
    });
    const productionPolicy = (await request(productionApp).get("/health"))
      .headers["content-security-policy"];
    assert.match(productionPolicy, /connect-src 'self' wss:\/\/media.example/);
    assert.match(productionPolicy, /https:\/\/media.example/);
    assert.match(productionPolicy, /upgrade-insecure-requests/);
  });

  it("reports that it is ready for traffic", async () => {
    database.query.mock.resetCalls();
    messages.isReady.mock.resetCalls();
    const response = await request(app).get("/ready");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ready" });
    assert.deepEqual(database.query.mock.calls[0].arguments, ["SELECT 1"]);
    assert.equal(messages.isReady.mock.callCount(), 0);
  });

  it("bounds the readiness database ping with a short deadline", async () => {
    const started = performance.now();
    await assert.rejects(
      pingDatabase({ query: () => new Promise(() => {}) }, 20),
      /database readiness timed out/,
    );
    assert.ok(performance.now() - started < 1_000);
    await pingDatabase({ query: async () => ({ rows: [] }) });
  });

  it("requires the configured bearer token for metrics", async () => {
    const token = "scraper-token-0123456789abcdefghijkl";
    for (const environment of ["development", "production"]) {
      const protectedApp = createApp({
        messages,
        users,
        sessions,
        logger,
        environment,
        applicationOrigin: "https://arena.example",
        metricsToken: token,
      });
      for (const authorization of [
        undefined,
        `Bearer ${token}x`,
        `Bearer ${token.slice(1)}`,
        token,
        `Basic ${token}`,
      ]) {
        const denied = request(protectedApp).get("/metrics");
        if (authorization) denied.set("Authorization", authorization);
        const response = await denied;
        assert.equal(response.status, 401);
        assert.equal(
          response.headers["www-authenticate"],
          'Bearer realm="metrics"',
        );
        assert.doesNotMatch(response.text, /yaparena_/);
      }
      const response = await request(protectedApp)
        .get("/metrics")
        .set("Authorization", `Bearer ${token}`);
      assert.equal(response.status, 200);
      assert.match(response.text, /yaparena_process_cpu_user_seconds_total/);
    }
  });

  it("hides metrics in production until a token is configured", async () => {
    const productionApp = createApp({
      messages,
      users,
      sessions,
      logger,
      environment: "production",
      applicationOrigin: "https://arena.example",
    });
    const response = await request(productionApp).get("/metrics");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: "resource not found" });
  });

  it("exposes bounded Prometheus HTTP and process metrics", async () => {
    await request(app).get("/health");
    const response = await request(app).get("/metrics");

    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/plain;/);
    assert.match(response.headers["content-type"], /version=0\.0\.4/);
    assert.match(response.text, /yaparena_process_cpu_user_seconds_total/);
    assert.match(
      response.text,
      /yaparena_http_requests_total\{method="GET",route="\/health",status_code="200"\}/,
    );
    assert.match(
      response.text,
      /yaparena_http_request_duration_seconds_count\{method="GET",route="\/health",status_code="200"\}/,
    );
    assert.doesNotMatch(response.text, /route="\/metrics"/);
  });

  it("reports when it is not ready for traffic", async () => {
    const unavailableApp = createApp({
      messages,
      database: {
        query: async () => {
          throw new Error("database unavailable");
        },
      },
      users,
      sessions,
      logger,
    });
    const response = await request(unavailableApp).get("/ready");

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: "not ready" });
    const unconfigured = await request(
      createApp({ messages, users, sessions, logger }),
    ).get("/ready");
    assert.equal(unconfigured.status, 503);
  });

  it("reports whether the jobs worker is beating, apart from readiness", async () => {
    const jobsApp = (age) =>
      createApp({
        messages,
        database,
        users,
        sessions,
        logger,
        jobHeartbeat: { age },
      });
    for (const [age, status, body] of [
      [async () => 7.4, 200, { status: "ok", ageSeconds: 7 }],
      [async () => 60, 200, { status: "ok", ageSeconds: 60 }],
      [async () => 61, 503, { status: "stale", ageSeconds: 61 }],
      [async () => -0.2, 200, { status: "ok", ageSeconds: 0 }],
      [async () => null, 503, { status: "stale", ageSeconds: null }],
      [
        async () => {
          throw new Error("database unavailable");
        },
        503,
        { status: "unknown" },
      ],
    ]) {
      const response = await request(jobsApp(age)).get("/ready/jobs");
      assert.equal(response.status, status);
      assert.deepEqual(response.body, body);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    // A stopped worker never makes web itself report not ready.
    const ready = await request(jobsApp(async () => null)).get("/ready");
    assert.equal(ready.status, 200);
    const unmounted = await request(app).get("/ready/jobs");
    assert.equal(unmounted.status, 404);
  });

  it("preserves an incoming request ID", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "test-request-id");

    assert.equal(response.headers["x-request-id"], "test-request-id");
  });

  it("creates a message", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "Example User",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: "1",
      name: "Example User",
      message: "Hello, Example User!",
      createdAt,
    });
  });

  it("rejects an empty name", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("handles a missing request body", async () => {
    const response = await authenticated("post", "/api/messages");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("rejects a name longer than 80 characters", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "x".repeat(81),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("lists messages with default pagination", async () => {
    const response = await authenticated("get", "/api/messages");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      items: [
        {
          id: "1",
          name: "Example User",
          message: "Hello, Example User!",
          createdAt,
        },
      ],
      pagination: { limit: 20, offset: 0 },
    });
  });

  it("accepts custom pagination", async () => {
    const response = await authenticated(
      "get",
      "/api/messages?limit=5&offset=10",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.pagination, { limit: 5, offset: 10 });
  });

  it("rejects an invalid pagination limit", async () => {
    const response = await authenticated("get", "/api/messages?limit=101");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "limit must be an integer between 1 and 100",
    });
  });

  it("rejects an invalid pagination offset", async () => {
    const response = await authenticated("get", "/api/messages?offset=-1");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "offset must be an integer between 0 and 10000",
    });
  });

  it("returns JSON for unknown routes", async () => {
    const response = await request(app).get("/does-not-exist");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: "resource not found",
    });
  });

  it("rejects malformed JSON", async () => {
    const response = await request(app)
      .post("/api/messages")
      .set("Content-Type", "application/json")
      .send('{"name":');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "request body contains invalid JSON",
    });
  });

  it("hides unexpected error details", () => {
    let statusCode;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    const errorLog = mock.fn();

    handleError(
      new Error("secret internal detail"),
      { log: { error: errorLog } },
      response,
      () => {},
    );

    assert.equal(statusCode, 500);
    assert.deepEqual(responseBody, { error: "internal server error" });
    assert.equal(errorLog.mock.callCount(), 1);
  });

  it("rate limits the general API independently of authentication", async () => {
    const limitedApp = createApp({
      messages,
      users,
      sessions,
      logger,
      apiRateLimit: 1,
    });

    assert.equal((await request(limitedApp).get("/health")).status, 200);
    assert.equal((await request(limitedApp).get("/health")).status, 429);
  });
});
