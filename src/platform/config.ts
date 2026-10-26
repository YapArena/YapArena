const environments = new Set(["development", "test", "production"]);
const logLevels = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

function parseInteger(
  value: string,
  name: string,
  { minimum, maximum }: { minimum: number; maximum: number },
) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function parseTrustProxy(value: string | undefined): number | false {
  if (value === undefined || value === "false") return false;
  return parseInteger(value, "TRUST_PROXY", { minimum: 1, maximum: 10 });
}

function parseMetricsToken(value: string | undefined) {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(value))
    throw new Error(
      "METRICS_TOKEN must be 32 to 512 URL-safe or base64 characters",
    );
  return value;
}

function parseMedia(environment: NodeJS.ProcessEnv, nodeEnvironment: string) {
  const names = [
    "LIVEKIT_URL",
    "LIVEKIT_PUBLIC_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "MEDIA_S3_REGION",
    "MEDIA_S3_BUCKET",
    "MEDIA_S3_ACCESS_KEY",
    "MEDIA_S3_SECRET_KEY",
  ] as const;
  if (
    Boolean(environment.MEDIA_REPLAY_EDGE_URL) !==
    Boolean(environment.MEDIA_REPLAY_SIGNING_SECRET)
  )
    throw new Error(
      "replay edge URL and signing secret must be configured together",
    );
  if (environment.MEDIA_REPLAY_EDGE_URL) {
    const edge = new URL(environment.MEDIA_REPLAY_EDGE_URL);
    if (
      edge.protocol !== "https:" ||
      edge.origin !== environment.MEDIA_REPLAY_EDGE_URL ||
      edge.username ||
      edge.password ||
      environment.MEDIA_REPLAY_SIGNING_SECRET!.length < 32
    )
      throw new Error(
        "replay edge requires an HTTPS origin and a secret of at least 32 characters",
      );
  }
  let replayEdgeRooms: readonly string[] | undefined;
  if (environment.MEDIA_REPLAY_EDGE_ROOMS) {
    const rooms = environment.MEDIA_REPLAY_EDGE_ROOMS.split(",");
    if (
      !environment.MEDIA_REPLAY_EDGE_URL ||
      rooms.length > 100 ||
      rooms.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            id,
          ),
      )
    )
      throw new Error(
        "replay edge rooms require a configured edge and at most 100 lower-case UUIDs",
      );
    replayEdgeRooms = Object.freeze([...new Set(rooms)]);
  }
  const set = names.filter((name) => Boolean(environment[name]));
  if (set.length === 0) {
    if (environment.MEDIA_REPLAY_EDGE_URL)
      throw new Error("replay edge requires media configuration");
    return undefined;
  }
  if (set.length !== names.length)
    throw new Error(`media configuration requires ${names.join(", ")}`);
  const livekitUrl = new URL(environment.LIVEKIT_URL!);
  const livekitPublicUrl = new URL(environment.LIVEKIT_PUBLIC_URL!);
  if (!(
    ["http:", "https:"].includes(livekitUrl.protocol) &&
    ["ws:", "wss:"].includes(livekitPublicUrl.protocol)
  ))
    throw new Error("invalid LiveKit URLs");
  if (
    nodeEnvironment === "production" &&
    (livekitUrl.protocol !== "https:" || livekitPublicUrl.protocol !== "wss:")
  )
    throw new Error("production media requires HTTPS and WSS");
  let s3Region = environment.MEDIA_S3_REGION!;
  if (environment.MEDIA_S3_ENDPOINT) {
    if (!environment.MEDIA_S3_PUBLIC_ENDPOINT)
      throw new Error(
        "custom media S3 endpoint requires a public playback endpoint",
      );
    const endpoint = new URL(environment.MEDIA_S3_ENDPOINT);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      (nodeEnvironment === "production" && endpoint.protocol !== "https:")
    )
      throw new Error("invalid media S3 endpoint");
    if (endpoint.hostname.endsWith(".r2.cloudflarestorage.com"))
      s3Region = "auto";
  }
  if (environment.MEDIA_S3_PUBLIC_ENDPOINT) {
    const endpoint = new URL(environment.MEDIA_S3_PUBLIC_ENDPOINT);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      (nodeEnvironment === "production" && endpoint.protocol !== "https:")
    )
      throw new Error("invalid public media S3 endpoint");
  }
  return Object.freeze({
    livekitUrl: environment.LIVEKIT_URL!,
    livekitPublicUrl: environment.LIVEKIT_PUBLIC_URL!,
    livekitKey: environment.LIVEKIT_API_KEY!,
    livekitSecret: environment.LIVEKIT_API_SECRET!,
    s3Endpoint: environment.MEDIA_S3_ENDPOINT,
    s3PublicEndpoint: environment.MEDIA_S3_PUBLIC_ENDPOINT,
    s3Region,
    s3Bucket: environment.MEDIA_S3_BUCKET!,
    s3AccessKey: environment.MEDIA_S3_ACCESS_KEY!,
    s3SecretKey: environment.MEDIA_S3_SECRET_KEY!,
    replayEdgeUrl: environment.MEDIA_REPLAY_EDGE_URL,
    replaySigningSecret: environment.MEDIA_REPLAY_SIGNING_SECRET,
    replayEdgeRooms,
  });
}

// Decision 0012: live transcription, captions and the AI outline. The
// transcriber agent runs on LiveKit Cloud, so the server needs media
// configured, and the agent authenticates to ingest with its own secret.
function parseLiveOutline(environment: NodeJS.ProcessEnv, media: boolean) {
  const enabled = environment.LIVE_OUTLINE_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled))
    throw new Error("LIVE_OUTLINE_ENABLED must be true or false");
  const agentName =
    environment.TRANSCRIBER_AGENT_NAME ?? "yaparena-transcriber";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(agentName))
    throw new Error(
      "TRANSCRIBER_AGENT_NAME must be lowercase letters, digits and dashes",
    );
  const ingestSecret = environment.TRANSCRIPTION_INGEST_SECRET;
  if (enabled === "true") {
    if (!media)
      throw new Error(
        "LIVE_OUTLINE_ENABLED requires LiveKit media configuration",
      );
    if (!ingestSecret || Buffer.byteLength(ingestSecret) < 32)
      throw new Error(
        "LIVE_OUTLINE_ENABLED requires TRANSCRIPTION_INGEST_SECRET of at least 32 bytes",
      );
  }
  return Object.freeze({
    enabled: enabled === "true",
    agentName,
    ingestSecret: enabled === "true" ? ingestSecret! : undefined,
  });
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const homepageReference = environment.HOMEPAGE_REFERENCE_ENABLED ?? "false";
  const coinSandbox = environment.COIN_SANDBOX_ENABLED ?? "false";
  if (!["true", "false"].includes(coinSandbox))
    throw new Error("COIN_SANDBOX_ENABLED must be true or false");
  const coinSandboxWebhookSecret = environment.COIN_SANDBOX_WEBHOOK_SECRET;
  if (
    coinSandboxWebhookSecret &&
    (coinSandbox !== "true" || Buffer.byteLength(coinSandboxWebhookSecret) < 32)
  )
    throw new Error(
      "COIN_SANDBOX_WEBHOOK_SECRET requires enabled simulation and a secret of at least 32 bytes",
    );
  // Decision 0012: one Yap Coins trading window per live speaking turn.
  const turnWindows = environment.TURN_WINDOWS_ENABLED ?? "false";
  if (!["true", "false"].includes(turnWindows))
    throw new Error("TURN_WINDOWS_ENABLED must be true or false");
  if (turnWindows === "true" && coinSandbox !== "true")
    throw new Error("TURN_WINDOWS_ENABLED requires COIN_SANDBOX_ENABLED");
  if (!["true", "false"].includes(homepageReference))
    throw new Error("HOMEPAGE_REFERENCE_ENABLED must be true or false");
  if (homepageReference === "true" && nodeEnvironment === "production")
    throw new Error("homepage reference data is development/test only");
  const host = environment.HOST ?? "0.0.0.0";
  const rawPort = environment.PORT ?? "3000";
  const port = parseInteger(rawPort, "PORT", { minimum: 1, maximum: 65535 });
  const databaseUrl = environment.DATABASE_URL;
  const logLevel = environment.LOG_LEVEL ?? "info";
  const applicationOrigin = environment.APP_ORIGIN;
  const trustProxy = parseTrustProxy(environment.TRUST_PROXY);
  const metricsToken = parseMetricsToken(environment.METRICS_TOKEN);
  const requestBodyLimit = environment.REQUEST_BODY_LIMIT ?? "10kb";
  const apiRateLimit = parseInteger(
    environment.API_RATE_LIMIT ?? "300",
    "API_RATE_LIMIT",
    {
      minimum: 1,
      maximum: 100_000,
    },
  );
  const authRateLimit = parseInteger(
    environment.AUTH_RATE_LIMIT ?? "10",
    "AUTH_RATE_LIMIT",
    {
      minimum: 1,
      maximum: 10_000,
    },
  );
  const rateLimitWindowMs = parseInteger(
    environment.RATE_LIMIT_WINDOW_MS ?? "900000",
    "RATE_LIMIT_WINDOW_MS",
    { minimum: 1_000, maximum: 86_400_000 },
  );
  const sessionDurationMs = parseInteger(
    environment.SESSION_DURATION_MS ?? "604800000",
    "SESSION_DURATION_MS",
    { minimum: 60_000, maximum: 31_536_000_000 },
  );
  const media = parseMedia(environment, nodeEnvironment);
  const packagingEnabled =
    environment.MEDIA_REPLAY_PACKAGING_ENABLED ?? "false";
  if (!["true", "false"].includes(packagingEnabled))
    throw new Error("MEDIA_REPLAY_PACKAGING_ENABLED must be true or false");
  if (packagingEnabled === "true" && !media?.replayEdgeUrl)
    throw new Error(
      "automatic replay packaging requires configured media and private replay edge",
    );
  const replayPackaging = Object.freeze({
    enabled: packagingEnabled === "true",
    concurrency: parseInteger(
      environment.MEDIA_REPLAY_CONCURRENCY ?? "1",
      "MEDIA_REPLAY_CONCURRENCY",
      { minimum: 1, maximum: 2 },
    ),
    pollMs: 5000,
    leaseMs: 60000,
    heartbeatMs: 15000,
    maxJobMs:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_JOB_SECONDS ?? "1800",
        "MEDIA_REPLAY_MAX_JOB_SECONDS",
        { minimum: 60, maximum: 7200 },
      ) * 1000,
    maxInputBytes:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_INPUT_MIB ?? "2048",
        "MEDIA_REPLAY_MAX_INPUT_MIB",
        { minimum: 1, maximum: 2048 },
      ) *
      1024 ** 2,
    maxOutputBytes:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_OUTPUT_MIB ?? "4096",
        "MEDIA_REPLAY_MAX_OUTPUT_MIB",
        { minimum: 1, maximum: 4096 },
      ) *
      1024 ** 2,
    maxDurationSeconds: 7200,
    maxFiles: 11000,
  });
  const a4Mode = environment.A4_MODE ?? "disabled";
  if (!["disabled", "yap-coins", "bots"].includes(a4Mode))
    throw new Error(
      "A4_MODE must be disabled, yap-coins or bots; real funds are unavailable",
    );
  const a4Funding = Object.freeze({
    starterCoins: parseInteger(
      environment.A4_STARTER_COINS ?? "1000",
      "A4_STARTER_COINS",
      { minimum: 1, maximum: 1000000 },
    ),
    refillCoins: parseInteger(
      environment.A4_REFILL_COINS ?? "1000",
      "A4_REFILL_COINS",
      { minimum: 1, maximum: 1000000 },
    ),
    botCoins: parseInteger(environment.A4_BOT_COINS ?? "1000", "A4_BOT_COINS", {
      minimum: 105,
      maximum: 1000000,
    }),
  });
  const backgroundJobs = environment.RUN_BACKGROUND_JOBS ?? "true";
  const liveOutline = parseLiveOutline(environment, Boolean(media));
  const streamEnabled = environment.COMMUNITY_STREAM_ENABLED ?? "false";
  if (!["true", "false"].includes(streamEnabled))
    throw new Error("COMMUNITY_STREAM_ENABLED must be true or false");
  const communityStream = Object.freeze({
    enabled: streamEnabled === "true",
    maxStreams: parseInteger(
      environment.COMMUNITY_MAX_STREAMS ?? "500",
      "COMMUNITY_MAX_STREAMS",
      { minimum: 1, maximum: 10000 },
    ),
    maxRooms: parseInteger(
      environment.COMMUNITY_MAX_ROOMS ?? "50",
      "COMMUNITY_MAX_ROOMS",
      { minimum: 1, maximum: 1000 },
    ),
    maxConcurrentReads: 4,
    reconcileMs: 5000,
    heartbeatMs: 15000,
    bufferBytes: 65536,
  });

  const matchmakingEnabled = environment.MATCHMAKING_ENABLED ?? "false";
  if (!["true", "false"].includes(matchmakingEnabled))
    throw new Error("MATCHMAKING_ENABLED must be true or false");
  const matchmaking = Object.freeze({
    enabled: matchmakingEnabled === "true",
    liveDebateCapacity: parseInteger(
      environment.LIVE_DEBATE_CAPACITY ?? "2",
      "LIVE_DEBATE_CAPACITY",
      { minimum: 1, maximum: 1000 },
    ),
  });

  if (!environments.has(nodeEnvironment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  if (backgroundJobs !== "true" && backgroundJobs !== "false") {
    throw new Error("RUN_BACKGROUND_JOBS must be true or false");
  }

  if (host.trim() === "") {
    throw new Error("HOST must not be empty");
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (communityStream.enabled && new URL(databaseUrl).port === "6543")
    throw new Error(
      "community LISTEN requires a direct or session-pooler connection",
    );
  if (matchmaking.enabled && new URL(databaseUrl).port === "6543")
    throw new Error(
      "live queue LISTEN requires a direct or session-pooler connection",
    );
  if (
    environment.DATABASE_MIGRATION_URL ||
    environment.DATABASE_ADMIN_URL ||
    environment.DATABASE_OWNER_PASSWORD ||
    environment.DATABASE_RUNTIME_PASSWORD ||
    environment.DATABASE_FIXTURE_URL ||
    environment.DATABASE_INSPECTION_URL ||
    environment.COIN_SANDBOX_OWNER_DATABASE_URL
  ) {
    throw new Error(
      "runtime must not receive database provisioning or migration secrets",
    );
  }

  if (!logLevels.has(logLevel)) {
    throw new Error("LOG_LEVEL is invalid");
  }

  if (nodeEnvironment === "production") {
    try {
      const origin = new URL(applicationOrigin ?? "");
      if (origin.origin !== applicationOrigin || origin.protocol !== "https:")
        throw new Error();
    } catch {
      throw new Error("APP_ORIGIN must be an HTTPS origin in production");
    }
  }

  if (!/^\d+(?:\.\d+)?(?:kb|mb)$/iu.test(requestBodyLimit)) {
    throw new Error("REQUEST_BODY_LIMIT must use kb or mb units");
  }

  return Object.freeze({
    environment: nodeEnvironment,
    homepageReferenceEnabled: homepageReference === "true",
    coinSandboxEnabled: coinSandbox === "true",
    turnWindowsEnabled: turnWindows === "true",
    coinSandboxWebhookSecret,
    host,
    port,
    databaseUrl,
    logLevel,
    applicationOrigin,
    trustProxy,
    metricsToken,
    requestBodyLimit,
    apiRateLimit,
    authRateLimit,
    rateLimitWindowMs,
    sessionDurationMs,
    media,
    replayPackaging,
    backgroundJobs: backgroundJobs === "true",
    communityStream,
    matchmaking,
    liveOutline,
    a4Funding,
    a4Mode: a4Mode as "disabled" | "yap-coins" | "bots",
  });
}
