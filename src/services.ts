import type { Pool } from "pg";
import { createA4Repository } from "./features/a4/repository.ts";
import { createCoinDebateSandbox } from "./features/account-wallet/debate-sandbox.ts";
import { createTreasuryMonitor } from "./features/account-wallet/treasury-monitor.ts";
import { createIdentityRepository } from "./features/identity/repository.ts";
import { createMatchingRepository } from "./features/matching/repository.ts";
import { createMatchmaking } from "./features/matching/matchmaking.ts";
import { createMediaRepository } from "./features/media/repository.ts";
import { createMediaProvider, debateRoom } from "./features/media/provider.ts";
import { AgentDispatchClient } from "livekit-server-sdk";
import { createDebaterSettings } from "./features/transcription/debater-settings.ts";
import { createTranscriberDispatcher } from "./features/transcription/dispatch.ts";
import { createTranscriptionRepository } from "./features/transcription/repository.ts";
import { createOutlineRepository } from "./features/outline/repository.ts";
import { createMediaOperations } from "./features/media/operations.ts";
import { createMediaAccountRevocation } from "./features/media/account-revocation.ts";
import { createDebateAutoStart } from "./features/media/auto-start.ts";
import { createDebateStart } from "./features/media/debate-start.ts";
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
  // Decision 0012: with the live outline on, debaters set a language and consent first.
  const requireDebaterSettings = config.liveOutline.enabled;
  const matching = createMatchingRepository(database, {
    requireDebaterSettings,
  });
  const matchmaking = config.matchmaking.enabled
    ? createMatchmaking(database, {
        liveDebateCapacity: config.matchmaking.liveDebateCapacity,
        // With media configured, players check camera and microphone before queueing.
        requireDeviceCheck: Boolean(config.media),
        requireDebaterSettings,
      })
    : undefined;
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
        { turnMetadata: config.liveOutline.enabled },
      )
    : undefined;
  // Decision 0012: live transcription. The settings exist whenever the live
  // outline is enabled; dispatch also needs LiveKit (required by config).
  const debaterSettings = config.liveOutline.enabled
    ? createDebaterSettings(database)
    : undefined;
  const transcription =
    config.liveOutline.enabled && config.media
      ? createTranscriptionRepository(database)
      : undefined;
  const outlines = transcription
    ? createOutlineRepository(database)
    : undefined;
  const transcriber =
    transcription && config.media
      ? createTranscriberDispatcher({
          repository: transcription,
          client: new AgentDispatchClient(
            config.media.livekitUrl,
            config.media.livekitKey,
            config.media.livekitSecret,
            { requestTimeout: 5 },
          ),
          agentName: config.liveOutline.agentName,
          roomName: debateRoom,
          logger,
        })
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
  // Automatic start replaces the operator start for matchmade debates (Decision 0011).
  const debateAutoStart =
    matchmaking && media && mediaProvider
      ? createDebateAutoStart({
          database,
          startDebate: createDebateStart({
            media,
            provider: mediaProvider,
            matching,
            // Decision 0012: automatic starts dispatch the transcriber too.
            dispatchTranscriber: transcriber?.dispatch,
          }),
          logger,
        })
      : undefined;
  const matchmakingJobs = matchmaking
    ? {
        async sweep() {
          const results = await Promise.allSettled([
            matchmaking.sweep(),
            debateAutoStart?.sweep(),
          ]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
        },
        pruneExpired: () => matchmaking.pruneExpired(),
      }
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
    // Everything createRuntime needs except the web-only app and community
    // streams, and the per-process background-jobs switch.
    background: {
      a4,
      coinDebates,
      coinTreasury: coinDebates
        ? createTreasuryMonitor({
            read: () => coinDebates.treasury(),
            thresholdUsdc: config.coinTreasuryAlertUsdc,
            logger,
          })
        : undefined,
      transcription:
        transcription && transcriber && outlines
          ? {
              // Warm-up dispatch, then freeze windows past their cutoff and
              // keep the frozen outline as final when no cleanup came.
              tick: async () => {
                await transcriber.tick();
                await outlines.freezeDue();
                await outlines.finalizeDue();
              },
              pruneExpired: () => transcription.pruneExpired(),
            }
          : undefined,
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
      matchmaking: matchmakingJobs,
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
