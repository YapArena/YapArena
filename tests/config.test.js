import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../dist/platform/config.js";

describe("configuration", () => {
  const databaseUrl = "postgresql://user:password@localhost:5432/database";
  const communityStream = {
    enabled: false,
    maxStreams: 500,
    maxRooms: 50,
    maxConcurrentReads: 4,
    reconcileMs: 5000,
    heartbeatMs: 15000,
    bufferBytes: 65536,
  };
  const replayPackaging = {
    enabled: false,
    concurrency: 1,
    pollMs: 5000,
    leaseMs: 60000,
    heartbeatMs: 15000,
    maxJobMs: 1800000,
    maxInputBytes: 2147483648,
    maxOutputBytes: 4294967296,
    maxDurationSeconds: 7200,
    maxFiles: 11000,
  };
  it("requires session-compatible streaming credentials and bounded capacities", () => {
    const value = loadConfig({
      DATABASE_URL: databaseUrl,
      COMMUNITY_STREAM_ENABLED: "true",
      COMMUNITY_MAX_STREAMS: "100",
      COMMUNITY_MAX_ROOMS: "10",
    });
    assert.equal(value.communityStream.enabled, true);
    assert.equal(value.communityStream.maxStreams, 100);
    for (const env of [
      { COMMUNITY_STREAM_ENABLED: "yes" },
      { COMMUNITY_MAX_STREAMS: "0" },
      { COMMUNITY_MAX_ROOMS: "1001" },
      {
        COMMUNITY_STREAM_ENABLED: "true",
        DATABASE_URL: databaseUrl.replace("5432", "6543"),
      },
    ])
      assert.throws(() => loadConfig({ DATABASE_URL: databaseUrl, ...env }));
  });

  it("enables the live queue only on request and bounds its capacity", () => {
    assert.deepEqual(
      loadConfig({
        DATABASE_URL: databaseUrl,
        MATCHMAKING_ENABLED: "true",
        LIVE_DEBATE_CAPACITY: "100",
      }).matchmaking,
      { enabled: true, liveDebateCapacity: 100 },
    );
    for (const env of [
      { MATCHMAKING_ENABLED: "yes" },
      { LIVE_DEBATE_CAPACITY: "0" },
      { LIVE_DEBATE_CAPACITY: "1001" },
      {
        MATCHMAKING_ENABLED: "true",
        DATABASE_URL: databaseUrl.replace("5432", "6543"),
      },
    ])
      assert.throws(() => loadConfig({ DATABASE_URL: databaseUrl, ...env }));
  });

  it("runs personal live updates with the live queue, and otherwise only on request", () => {
    const load = (env) => loadConfig({ DATABASE_URL: databaseUrl, ...env });
    assert.deepEqual(load({}).userStream, { enabled: false });
    assert.deepEqual(load({ MATCHMAKING_ENABLED: "true" }).userStream, {
      enabled: true,
    });
    assert.deepEqual(
      load({ MATCHMAKING_ENABLED: "true", USER_STREAM_ENABLED: "false" })
        .userStream,
      { enabled: true },
    );
    assert.deepEqual(load({ USER_STREAM_ENABLED: "true" }).userStream, {
      enabled: true,
    });
    assert.throws(() => load({ USER_STREAM_ENABLED: "on" }), /true or false/);
    assert.throws(
      () =>
        load({
          USER_STREAM_ENABLED: "true",
          DATABASE_URL: databaseUrl.replace("5432", "6543"),
        }),
      /live updates LISTEN/,
    );
  });

  it("provides safe development defaults", () => {
    assert.deepEqual(loadConfig({ DATABASE_URL: databaseUrl }), {
      environment: "development",
      homepageReferenceEnabled: false,
      landingFontFile: undefined,
      coinSandboxEnabled: false,
      turnWindowsEnabled: false,
      coinSandboxWebhookSecret: undefined,
      host: "0.0.0.0",
      port: 3000,
      databaseUrl,
      logLevel: "info",
      applicationOrigin: undefined,
      trustProxy: false,
      metricsToken: undefined,
      requestBodyLimit: "10kb",
      apiRateLimit: 300,
      authRateLimit: 10,
      rateLimitWindowMs: 900000,
      sessionDurationMs: 604800000,
      media: undefined,
      replayPackaging,
      backgroundJobs: true,
      communityStream,
      matchmaking: { enabled: false, liveDebateCapacity: 2 },
      userStream: { enabled: false },
      liveOutline: {
        enabled: false,
        agentName: "yaparena-transcriber",
        ingestSecret: undefined,
      },
      a4Mode: "disabled",
      a4Funding: { starterCoins: 1000, refillCoins: 1000, botCoins: 1000 },
    });
  });

  it("loads values from the environment", () => {
    assert.deepEqual(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8080",
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "warn",
        APP_ORIGIN: "https://service.example.com",
        TRUST_PROXY: "1",
        REQUEST_BODY_LIMIT: "20kb",
        API_RATE_LIMIT: "500",
        AUTH_RATE_LIMIT: "20",
        RATE_LIMIT_WINDOW_MS: "60000",
        SESSION_DURATION_MS: "3600000",
        METRICS_TOKEN: "scraper-token-0123456789abcdefghijkl",
        LANDING_FONT_FILE: "/etc/secrets/landing-headline-font.b64",
      }),
      {
        environment: "production",
        homepageReferenceEnabled: false,
        landingFontFile: "/etc/secrets/landing-headline-font.b64",
        coinSandboxEnabled: false,
        turnWindowsEnabled: false,
        coinSandboxWebhookSecret: undefined,
        host: "127.0.0.1",
        port: 8080,
        databaseUrl,
        logLevel: "warn",
        applicationOrigin: "https://service.example.com",
        trustProxy: 1,
        metricsToken: "scraper-token-0123456789abcdefghijkl",
        requestBodyLimit: "20kb",
        apiRateLimit: 500,
        authRateLimit: 20,
        rateLimitWindowMs: 60000,
        sessionDurationMs: 3600000,
        media: undefined,
        replayPackaging,
        backgroundJobs: true,
        communityStream,
        matchmaking: { enabled: false, liveDebateCapacity: 2 },
        userStream: { enabled: false },
        liveOutline: {
          enabled: false,
          agentName: "yaparena-transcriber",
          ingestSecret: undefined,
        },
        a4Mode: "disabled",
        a4Funding: { starterCoins: 1000, refillCoins: 1000, botCoins: 1000 },
      },
    );
  });

  it("accepts only a long metrics token without whitespace", () => {
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, METRICS_TOKEN: "" }).metricsToken,
      undefined,
    );
    for (const value of ["short-token", `${"a".repeat(31)} `, "a".repeat(513)])
      assert.throws(
        () => loadConfig({ DATABASE_URL: databaseUrl, METRICS_TOKEN: value }),
        /METRICS_TOKEN/,
      );
  });

  it("enables the live outline only with LiveKit media and a strong ingest secret", () => {
    const media = {
      LIVEKIT_URL: "http://localhost:7880",
      LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "secret",
      MEDIA_S3_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_PUBLIC_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_BUCKET: "replays",
      MEDIA_S3_ACCESS_KEY: "local",
      MEDIA_S3_SECRET_KEY: "local-secret",
    };
    const secret = "synthetic-transcription-ingest-secret-32b";
    assert.deepEqual(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...media,
        LIVE_OUTLINE_ENABLED: "true",
        TRANSCRIPTION_INGEST_SECRET: secret,
        TRANSCRIBER_AGENT_NAME: "yaparena-transcriber-staging",
      }).liveOutline,
      {
        enabled: true,
        agentName: "yaparena-transcriber-staging",
        ingestSecret: secret,
      },
    );
    for (const [environment, message] of [
      [{ LIVE_OUTLINE_ENABLED: "yes" }, /must be true or false/],
      [
        { LIVE_OUTLINE_ENABLED: "true", TRANSCRIPTION_INGEST_SECRET: secret },
        /requires LiveKit media/,
      ],
      [
        { ...media, LIVE_OUTLINE_ENABLED: "true" },
        /TRANSCRIPTION_INGEST_SECRET of at least 32 bytes/,
      ],
      [
        {
          ...media,
          LIVE_OUTLINE_ENABLED: "true",
          TRANSCRIPTION_INGEST_SECRET: "short",
        },
        /at least 32 bytes/,
      ],
      [{ TRANSCRIBER_AGENT_NAME: "Bad Name" }, /TRANSCRIBER_AGENT_NAME/],
    ])
      assert.throws(
        () => loadConfig({ DATABASE_URL: databaseUrl, ...environment }),
        message,
      );
  });

  it("enables turn windows only explicitly and only with the coin sandbox", () => {
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl }).turnWindowsEnabled,
      false,
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        COIN_SANDBOX_ENABLED: "true",
        TURN_WINDOWS_ENABLED: "true",
      }).turnWindowsEnabled,
      true,
    );
    assert.throws(
      () =>
        loadConfig({ DATABASE_URL: databaseUrl, TURN_WINDOWS_ENABLED: "true" }),
      /requires COIN_SANDBOX_ENABLED/,
    );
    for (const value of ["1", "TRUE", "yes"])
      assert.throws(
        () =>
          loadConfig({
            DATABASE_URL: databaseUrl,
            COIN_SANDBOX_ENABLED: "true",
            TURN_WINDOWS_ENABLED: value,
          }),
        /TURN_WINDOWS_ENABLED must be true or false/,
      );
  });

  it("enables only an explicit isolated coin sandbox and requires a strong enabled webhook secret", () => {
    const secret = "isolated-sandbox-webhook-secret-32-bytes";
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, COIN_SANDBOX_ENABLED: "true" })
        .coinSandboxEnabled,
      true,
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        COIN_SANDBOX_ENABLED: "true",
        COIN_SANDBOX_WEBHOOK_SECRET: secret,
      }).coinSandboxWebhookSecret,
      secret,
    );
    for (const value of ["live", "1", "TRUE", "simulation"])
      assert.throws(
        () =>
          loadConfig({
            DATABASE_URL: databaseUrl,
            COIN_SANDBOX_ENABLED: value,
          }),
        /COIN_SANDBOX_ENABLED/,
      );
    for (const enabled of ["false", "true"])
      assert.throws(
        () =>
          loadConfig({
            DATABASE_URL: databaseUrl,
            COIN_SANDBOX_ENABLED: enabled,
            COIN_SANDBOX_WEBHOOK_SECRET: "short",
          }),
        /COIN_SANDBOX_WEBHOOK_SECRET/,
      );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          COIN_SANDBOX_WEBHOOK_SECRET: secret,
        }),
      /COIN_SANDBOX_WEBHOOK_SECRET/,
    );
  });

  it("permits only explicit play modes and fails closed for real funds", () => {
    for (const mode of ["disabled", "yap-coins", "bots"])
      assert.equal(
        loadConfig({ DATABASE_URL: databaseUrl, A4_MODE: mode }).a4Mode,
        mode,
      );
    for (const mode of ["real", "fiat", "crypto", "true"])
      assert.throws(
        () => loadConfig({ DATABASE_URL: databaseUrl, A4_MODE: mode }),
        /real funds/,
      );
  });
  it("bounds explicit play-credit policies", () => {
    const v = loadConfig({
      DATABASE_URL: databaseUrl,
      A4_STARTER_COINS: "250",
      A4_REFILL_COINS: "50",
      A4_BOT_COINS: "105",
    });
    assert.deepEqual(v.a4Funding, {
      starterCoins: 250,
      refillCoins: 50,
      botCoins: 105,
    });
    for (const override of [
      { A4_STARTER_COINS: "0" },
      { A4_REFILL_COINS: "1000001" },
      { A4_BOT_COINS: "104" },
    ])
      assert.throws(
        () => loadConfig({ DATABASE_URL: databaseUrl, ...override }),
        /A4_/,
      );
  });
  it("rejects an unsupported environment", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "staging", DATABASE_URL: databaseUrl }),
      /NODE_ENV must be development, test, or production/,
    );
  });

  it("validates background worker configuration", () => {
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        RUN_BACKGROUND_JOBS: "false",
      }).backgroundJobs,
      false,
    );
    assert.throws(
      () =>
        loadConfig({ DATABASE_URL: databaseUrl, RUN_BACKGROUND_JOBS: "off" }),
      /RUN_BACKGROUND_JOBS/,
    );
  });

  it("rejects an empty host", () => {
    assert.throws(
      () => loadConfig({ HOST: "", DATABASE_URL: databaseUrl }),
      /HOST must not be empty/,
    );
  });

  it("rejects an invalid port", () => {
    assert.throws(
      () => loadConfig({ PORT: "not-a-port", DATABASE_URL: databaseUrl }),
      /PORT must be an integer between 1 and 65535/,
    );
  });

  it("requires a database URL", () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  });

  it("rejects provisioning and migration secrets in the runtime environment", () => {
    for (const name of [
      "DATABASE_MIGRATION_URL",
      "DATABASE_ADMIN_URL",
      "DATABASE_OWNER_PASSWORD",
      "DATABASE_RUNTIME_PASSWORD",
      "DATABASE_FIXTURE_URL",
      "DATABASE_INSPECTION_URL",
      "COIN_SANDBOX_OWNER_DATABASE_URL",
    ]) {
      assert.throws(
        () =>
          loadConfig({ DATABASE_URL: databaseUrl, [name]: "synthetic-secret" }),
        /runtime must not receive/,
      );
    }
  });

  it("rejects an invalid log level", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: "verbose" }),
      /LOG_LEVEL is invalid/,
    );
  });

  it("requires complete media credentials and secure production media URLs", () => {
    const media = {
      LIVEKIT_URL: "http://localhost:7880",
      LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "secret",
      MEDIA_S3_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_PUBLIC_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_BUCKET: "replays",
      MEDIA_S3_ACCESS_KEY: "local",
      MEDIA_S3_SECRET_KEY: "local-secret",
    };
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          MEDIA_REPLAY_PACKAGING_ENABLED: "yes",
        }),
      /must be true or false/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          MEDIA_REPLAY_PACKAGING_ENABLED: "true",
        }),
      /private replay edge/,
    );
    const automated = loadConfig({
      DATABASE_URL: databaseUrl,
      ...media,
      MEDIA_REPLAY_EDGE_URL: "https://edge.example",
      MEDIA_REPLAY_SIGNING_SECRET: "synthetic-private-replay-secret-32bytes",
      MEDIA_REPLAY_PACKAGING_ENABLED: "true",
      MEDIA_REPLAY_CONCURRENCY: "2",
      MEDIA_REPLAY_MAX_JOB_SECONDS: "90",
      MEDIA_REPLAY_MAX_INPUT_MIB: "100",
      MEDIA_REPLAY_MAX_OUTPUT_MIB: "200",
    });
    assert.equal(automated.replayPackaging.enabled, true);
    assert.equal(automated.replayPackaging.maxJobMs, 90000);
    assert.equal(automated.replayPackaging.maxInputBytes, 104857600);
    for (const env of [
      { MEDIA_REPLAY_CONCURRENCY: "3" },
      { MEDIA_REPLAY_MAX_JOB_SECONDS: "1" },
      { MEDIA_REPLAY_MAX_INPUT_MIB: "3000" },
      { MEDIA_REPLAY_MAX_OUTPUT_MIB: "5000" },
    ])
      assert.throws(
        () => loadConfig({ DATABASE_URL: databaseUrl, ...env }),
        /MEDIA_REPLAY_/,
      );
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, ...media }).media.s3Bucket,
      "replays",
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...media,
        MEDIA_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        MEDIA_S3_PUBLIC_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        MEDIA_S3_REGION: "Eastern North America (ENAM)",
      }).media.s3Region,
      "auto",
    );
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, ...media }).media.s3Region,
      "us-east-1",
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          LIVEKIT_URL: media.LIVEKIT_URL,
        }),
      /media configuration requires/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          LIVEKIT_PUBLIC_URL: "http://localhost:7880",
        }),
      /invalid LiveKit URLs/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_ENDPOINT: "ftp://storage",
        }),
      /invalid media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_PUBLIC_ENDPOINT: undefined,
        }),
      /custom media S3 endpoint requires a public playback endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_PUBLIC_ENDPOINT: "ftp://storage",
        }),
      /invalid public media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          LIVEKIT_URL: "ws://localhost:7880",
        }),
      /invalid LiveKit URLs/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /production media requires/,
    );
    const production = {
      ...media,
      LIVEKIT_URL: "https://media.example",
      LIVEKIT_PUBLIC_URL: "wss://media.example",
      MEDIA_S3_ENDPOINT: "https://storage.example",
      MEDIA_S3_PUBLIC_ENDPOINT: "https://storage.example",
    };
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...production,
        NODE_ENV: "production",
        APP_ORIGIN: "https://arena.example",
      }).media.livekitUrl,
      "https://media.example",
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...production,
          MEDIA_S3_ENDPOINT: "http://storage.example",
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /invalid media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...production,
          MEDIA_S3_PUBLIC_ENDPOINT: "http://storage.example",
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /invalid public media S3 endpoint/,
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...production,
        MEDIA_S3_ENDPOINT: undefined,
        MEDIA_S3_PUBLIC_ENDPOINT: undefined,
        NODE_ENV: "production",
        APP_ORIGIN: "https://arena.example",
      }).media.s3Endpoint,
      undefined,
    );
  });

  it("requires an HTTPS application origin in production", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "production", DATABASE_URL: databaseUrl }),
      /APP_ORIGIN must be an HTTPS origin in production/,
    );
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DATABASE_URL: databaseUrl,
          APP_ORIGIN: "http://service.example.com",
        }),
      /APP_ORIGIN must be an HTTPS origin in production/,
    );
  });

  it("rejects invalid security configuration", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, TRUST_PROXY: "true" }),
      /TRUST_PROXY must be an integer/,
    );
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, API_RATE_LIMIT: "0" }),
      /API_RATE_LIMIT must be an integer/,
    );
    assert.throws(
      () =>
        loadConfig({ DATABASE_URL: databaseUrl, REQUEST_BODY_LIMIT: "huge" }),
      /REQUEST_BODY_LIMIT must use kb or mb units/,
    );
  });
});

it("validates the optional replay edge as an HTTPS origin with paired secrets", () => {
  for (const fields of [
    { MEDIA_REPLAY_EDGE_URL: "https://media.example" },
    { MEDIA_REPLAY_SIGNING_SECRET: "secret" },
    {
      MEDIA_REPLAY_EDGE_URL: "http://media.example",
      MEDIA_REPLAY_SIGNING_SECRET: "a".repeat(32),
    },
    {
      MEDIA_REPLAY_EDGE_URL: "https://media.example/path",
      MEDIA_REPLAY_SIGNING_SECRET: "a".repeat(32),
    },
    {
      MEDIA_REPLAY_EDGE_URL: "https://media.example",
      MEDIA_REPLAY_SIGNING_SECRET: "short",
    },
    {
      MEDIA_REPLAY_EDGE_URL: "https://media.example",
      MEDIA_REPLAY_SIGNING_SECRET: "a".repeat(32),
    },
  ])
    assert.throws(() =>
      loadConfig({ DATABASE_URL: "postgres://localhost/test", ...fields }),
    );
});
it("validates a bounded room allowlist for incremental replay rollout", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const environment = {
    DATABASE_URL: "postgres://localhost/test",
    LIVEKIT_URL: "https://live.example",
    LIVEKIT_PUBLIC_URL: "wss://live.example",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    MEDIA_S3_REGION: "auto",
    MEDIA_S3_BUCKET: "synthetic",
    MEDIA_S3_ACCESS_KEY: "key",
    MEDIA_S3_SECRET_KEY: "secret",
    MEDIA_REPLAY_EDGE_URL: "https://edge.example",
    MEDIA_REPLAY_SIGNING_SECRET: "a".repeat(32),
  };
  const config = loadConfig({
    ...environment,
    MEDIA_REPLAY_EDGE_ROOMS: `${id},${id}`,
  });
  assert.deepEqual(config.media.replayEdgeRooms, [id]);
  assert.equal(Object.isFrozen(config.media.replayEdgeRooms), true);
  for (const value of ["*", `${id},`, ` ${id}`, Array(101).fill(id).join(",")])
    assert.throws(
      () => loadConfig({ ...environment, MEDIA_REPLAY_EDGE_ROOMS: value }),
      /replay edge rooms/,
    );
  assert.throws(
    () =>
      loadConfig({
        ...environment,
        MEDIA_REPLAY_EDGE_URL: undefined,
        MEDIA_REPLAY_SIGNING_SECRET: undefined,
        MEDIA_REPLAY_EDGE_ROOMS: id,
      }),
    /replay edge rooms/,
  );
});
