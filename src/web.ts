import type { Express } from "express";
import { createCoinSandboxRepository } from "./features/account-wallet/sandbox-repository.ts";
import { createSandboxWebhookRouter } from "./features/account-wallet/sandbox-webhooks.ts";
import { createSandboxErrorReports } from "./features/account-wallet/sandbox-reports.ts";
import { createAccountWallet } from "./features/account-wallet/repository.ts";
import { createPublicBotRepository } from "./features/a4/public-bots.ts";
import { createApp } from "./app.ts";
import { createMessageRepository } from "./features/messages/repository.ts";
import { createDiscoveryRepository } from "./features/discovery/repository.ts";
import { loadAbuseControlConfig } from "./platform/abuse-config.ts";
import { loadAuth0Config } from "./platform/auth/auth0-config.ts";
import { createAuth0Client } from "./platform/auth/auth0.ts";
import {
  createSharedAbuseLimiter,
  createSharedRateLimits,
} from "./platform/shared-abuse.ts";
import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { createRuntime } from "./platform/runtime.ts";
import { createMetrics } from "./platform/metrics.ts";
import { createCommunityStreams } from "./features/community/streams.ts";
import { createServices } from "./services.ts";
import { createUserStreams } from "./platform/user-streams.ts";
import { RESULTS_CHANNEL } from "./features/account-wallet/debate-sandbox.ts";

// Builds the web service. dist/server.js runs it for every deployment; the
// local test identity entry under scripts/ wraps the same application.
export function createWebServer(
  env: NodeJS.ProcessEnv,
  {
    wrap,
  }: {
    // Mounts extra routes in front of the application before it listens.
    wrap?: (
      app: Express,
      parts: ReturnType<typeof createServices> & {
        config: ReturnType<typeof loadConfig>;
      },
    ) => Express;
  } = {},
) {
  const config = loadConfig(env);
  // Production refuses to start without Auth0 (Decision 0009, point 11).
  const auth0Config = loadAuth0Config(env);
  if (auth0Config && !config.applicationOrigin)
    throw new Error("Auth0 sign-in requires APP_ORIGIN");
  const abuseConfig = loadAbuseControlConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const metrics = createMetrics();
  const database = createDatabase(config.databaseUrl, logger, (seconds) =>
    metrics.poolWait.observe(seconds),
  );
  const communityStreams = config.communityStream.enabled
    ? createCommunityStreams(
        database,
        config.databaseUrl,
        logger,
        metrics.community,
        config.communityStream,
      )
    : undefined;
  const services = createServices({
    config,
    abuseConfig,
    database,
    logger,
    metrics,
  });
  const {
    identity,
    matching,
    matchmaking,
    debateAutoStart,
    community,
    measurement,
    a4,
    media,
    mediaProvider,
    mediaAccountRevocation,
    abuseStore,
    auth0Accounts,
    signInState,
    sessions,
    accountSecurity,
    coinDebates,
    debaterSettings,
    transcription,
    transcriber,
    outlines,
  } = services;
  // Web only: the jobs worker serves no streams. Personal live updates (interface 10): the live
  // queue's state, and results notices that the round settlement signals (B reads the results).
  const userStreams = config.userStream.enabled
    ? createUserStreams({
        databaseUrl: config.databaseUrl,
        logger,
        kinds: {
          ...(matchmaking
            ? { state: { read: (userId) => matchmaking.state(userId) } }
            : {}),
          results: {},
        },
        channels: {
          yaparena_user_v1: "state",
          [RESULTS_CHANNEL]: "results",
        },
        presence: matchmaking
          ? (userIds) => matchmaking.touchMany(userIds)
          : undefined,
      })
    : undefined;
  const sharedLimits = abuseConfig && abuseStore;
  const app = createApp({
    coinWebhook: config.coinSandboxWebhookSecret
      ? createSandboxWebhookRouter({
          database,
          rail: "simulation",
          secret: config.coinSandboxWebhookSecret,
        })
      : undefined,
    coinSandbox: coinDebates
      ? {
          sandbox: createCoinSandboxRepository(database, {
            rail: "simulation",
          }),
          debates: coinDebates,
          operations: accountSecurity.operations,
          reports: createSandboxErrorReports(database, "simulation"),
        }
      : undefined,
    turnWindows: config.turnWindowsEnabled ? coinDebates : undefined,
    debaterSettings,
    transcriptionIngest:
      transcription && config.liveOutline.ingestSecret
        ? {
            repository: transcription,
            outlines,
            secret: config.liveOutline.ingestSecret,
          }
        : undefined,
    dispatchTranscriber: transcriber?.dispatch,
    outlines,
    messages: createMessageRepository(database),
    database,
    a4,
    publicBots: createPublicBotRepository(database),
    discovery: createDiscoveryRepository(database),
    identity,
    matching,
    matchmaking,
    userStreams,
    debateAutoStart,
    media,
    mediaProvider,
    mediaAccountRevocation,
    mediaAdmissionSecret: config.media?.livekitSecret,
    community,
    communityStreams,
    metrics,
    metricsToken: config.metricsToken,
    measurement,
    sessions,
    logger,
    environment: config.environment,
    homepageReferenceEnabled: config.homepageReferenceEnabled,
    applicationOrigin: config.applicationOrigin,
    trustProxy: config.trustProxy,
    requestBodyLimit: config.requestBodyLimit,
    apiRateLimit: config.apiRateLimit,
    authRateLimit: config.authRateLimit,
    rateLimitWindowMs: config.rateLimitWindowMs,
    sessionDurationMs: config.sessionDurationMs,
    auth0: auth0Config
      ? {
          client: createAuth0Client(auth0Config, {
            redirectUri: new URL("/api/auth/callback", config.applicationOrigin)
              .href,
          }),
          accounts: auth0Accounts,
          state: signInState,
        }
      : undefined,
    accountSecurity,
    accountWallet: createAccountWallet(database),
    sharedAccountLimiter: sharedLimits
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: abuseConfig.namespace,
          secret: abuseConfig.keySecret,
          scope: "account",
          account: true,
          limit: 30,
          windowMs: 15 * 60 * 1000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
    sharedRateLimits: sharedLimits
      ? createSharedRateLimits({
          store: abuseStore,
          namespace: abuseConfig.namespace,
          secret: abuseConfig.keySecret,
          logger,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
    sharedAuthLimiter: sharedLimits
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: abuseConfig.namespace,
          secret: abuseConfig.keySecret,
          scope: "auth",
          limit: 120,
          windowMs: 15 * 60 * 1_000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
  });

  const runtime = createRuntime({
    ...services.background,
    app: wrap ? wrap(app, { ...services, config }) : app,
    communityStreams,
    userStreams,
    backgroundJobs: config.backgroundJobs,
  });

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    config,
    logger,
    async start() {
      await runtime.start();
      logger.info(
        {
          environment: config.environment,
          host: config.host,
          port: config.port,
          backgroundJobs: config.backgroundJobs,
          auth0: Boolean(auth0Config),
        },
        "server started",
      );
    },
    stop() {
      stopping ??= runtime.stop().then(() => services.close());
      return stopping;
    },
  });
}

// Runs a web service until SIGTERM or SIGINT, then stops it within 10 seconds.
export async function runWebServer(server: ReturnType<typeof createWebServer>) {
  await server.start();
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    server.logger.info({ signal }, "shutdown requested");
    const forcedExit = setTimeout(() => {
      server.logger.fatal("forced shutdown");
      process.exit(1);
    }, 10_000);
    forcedExit.unref();
    try {
      await server.stop();
      clearTimeout(forcedExit);
    } catch (error) {
      server.logger.error({ error }, "server shutdown failed");
      process.exitCode = 1;
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
