import type { Pool } from "pg";
import { createA4Repository } from "./features/a4/repository.ts";
import { createCoinDebateSandbox } from "./features/account-wallet/debate-sandbox.ts";
import { createIdentityRepository } from "./features/identity/repository.ts";
import { createMatchingRepository } from "./features/matching/repository.ts";
import { createMediaRepository } from "./features/media/repository.ts";
import { createMediaProvider } from "./features/media/provider.ts";
import { createMediaOperations } from "./features/media/operations.ts";
import { createMediaAccountRevocation } from "./features/media/account-revocation.ts";
import { createReplayJobs } from "./features/media/replay-jobs.ts";
import { createCommunityRepository } from "./features/community/repository.ts";
import { createMeasurementRepository } from "./features/measurement/repository.ts";
import { createSessionRepository } from "./platform/auth/sessions.ts";
import type { AbuseControlConfig } from "./platform/abuse-config.ts";
import { createAuth0Accounts } from "./platform/auth/auth0-accounts.ts";
import { createSignInState } from "./platform/auth/sign-in-state.ts";
import { createAccountOperationRepository } from "./platform/auth/account-operations.ts";
import { createRedisAbuseStore } from "./platform/shared-abuse.ts";
import type { loadConfig } from "./platform/config.ts";
import type { createLogger } from "./platform/logger.ts";
import type { createMetrics } from "./platform/metrics.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { createRuntime } from "./platform/runtime.ts";

type ServiceOptions = {
  config: ReturnType<typeof loadConfig>;
  abuseConfig?: AbuseControlConfig;
  database: Pool;
  logger: ReturnType<typeof createLogger>;
  metrics: ReturnType<typeof createMetrics>;
};

// Builds the repositories, providers and background jobs shared by the web
// server and the background worker, so both processes run identical jobs.
export function createServices({
  config,
  abuseConfig,
  database,
  logger,
  metrics,
}: ServiceOptions) {
  const identity = createIdentityRepository(database);
  const matching = createMatchingRepository(database);
  const community = createCommunityRepository(database);
  const measurement = createMeasurementRepository(database);
  const a4 = createA4Repository(database, config.a4Mode, config.a4Funding);
  const media = config.media
    ? createMediaRepository(database, {
        enabled: config.replayPackaging.enabled,
        allowedRooms: config.media.replayEdgeRooms,
      })
    : undefined;
  const replayJobs = config.replayPackaging.enabled
    ? createReplayJobs(database)
    : undefined;
  const baseMediaProvider = config.media
    ? createMediaProvider(
        config.media,
        replayJobs
          ? (key) => replayJobs.ready(key.split("/")[1]!, key)
          : undefined,
      )
    : undefined;
  const mediaOperations =
    media && baseMediaProvider
      ? createMediaOperations({
          database,
          media,
          provider: baseMediaProvider,
          logger,
          count: (kind) => metrics.mediaControl.inc({ kind }),
        })
      : undefined;
  const mediaProvider = mediaOperations?.provider;
  const mediaAccountRevocation = mediaProvider
    ? createMediaAccountRevocation(database, {
        supportsTokenRevocation: mediaProvider.supportsTokenRevocation,
        mintSpeakerToken: (debateId, suffix, side) =>
          mediaProvider.token(debateId, suffix, true, side),
        removeSpeaker: (debateId, identity) =>
          mediaProvider.removeSpeaker(debateId, identity),
        timeoutMs: 6000,
        observe: ({ result, seconds }) => {
          metrics.mediaControl.inc({ kind: `speaker_revocation_${result}` });
          metrics.authLatency.observe({ phase: "speaker_revocation" }, seconds);
        },
      })
    : undefined;
  const abuseStore = abuseConfig
    ? createRedisAbuseStore({
        url: abuseConfig.redisUrl,
        observe: (outcome, seconds) => {
          metrics.redisOutcome.inc({ outcome });
          metrics.redisLatency.observe(seconds);
        },
      })
    : undefined;
  // Decision 0009: requests never call Auth0. Only the web service holds the
  // Auth0 client; mapping, linking and sign-in state need just the database.
  const auth0Accounts = createAuth0Accounts(database);
  const signInState = createSignInState(database);
  const sessions = createSessionRepository(database);
  const accountSecurity = {
    operations: createAccountOperationRepository(database),
  };
  const coinDebates = config.coinSandboxEnabled
    ? createCoinDebateSandbox(database, "simulation", {
        turnWindows: config.turnWindowsEnabled,
      })
    : undefined;

  return Object.freeze({
    identity,
    matching,
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
    // Everything createRuntime needs except the web-only app and community
    // streams, and the per-process background-jobs switch.
    background: {
      a4,
      coinDebates,
      database,
      sessions,
      accountSecurityCleanup: async () => {
        await Promise.all([
          accountSecurity.operations.deleteExpired(),
          signInState.deleteExpired(),
        ]);
      },
      mediaAccountRevocation,
      identity,
      matching,
      community,
      measurement,
      media,
      mediaProvider,
      mediaOperations,
      logger,
      config,
      verifyDatabase: () =>
        verifyDatabaseState(
          database,
          new URL("../migrations", import.meta.url),
        ),
    },
    close() {
      abuseStore?.close();
    },
  });
}

// The dedicated worker runs every background job regardless of
// RUN_BACKGROUND_JOBS; it never listens for HTTP or starts community streams.
export function createBackgroundWorker({
  config,
  database,
  logger,
  metrics,
  ...runtimeOptions
}: ServiceOptions &
  Partial<
    Pick<
      Parameters<typeof createRuntime>[0],
      "verifyDatabase" | "setIntervalFn" | "clearIntervalFn"
    >
  >) {
  // The jobs worker needs no sign-in or Redis settings (Decision 0009,
  // point 11): it never serves a request.
  const services = createServices({ config, database, logger, metrics });
  const runtime = createRuntime({ ...services.background, ...runtimeOptions });
  return Object.freeze({
    start: runtime.start,
    async stop() {
      await runtime.stop();
      services.close();
    },
  });
}
