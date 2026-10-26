import type { Server } from "node:http";
import type { Express } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { createSessionRepository } from "./auth/sessions.ts";
import type { createIdentityRepository } from "../features/identity/repository.ts";
import type { createMatchingRepository } from "../features/matching/repository.ts";
import type { createMediaRepository } from "../features/media/repository.ts";
import type { createMediaProvider } from "../features/media/provider.ts";
import type { createCommunityRepository } from "../features/community/repository.ts";
import type { createMeasurementRepository } from "../features/measurement/repository.ts";
import type { loadConfig } from "./config.ts";

export function createRuntime({
  app,
  a4,
  coinDebates,
  transcription,
  database,
  sessions,
  accountSecurityCleanup,
  mediaAccountRevocation,
  identity,
  matching,
  matchmaking,
  community,
  communityStreams,
  matchmakingStreams,
  measurement,
  media,
  mediaProvider,
  mediaOperations,
  logger,
  config,
  verifyDatabase,
  backgroundJobs = true,
  cleanupIntervalMs = 60 * 60 * 1_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  app?: Express;
  a4?: { tick(): Promise<void> };
  coinDebates?: { tick(): Promise<unknown> };
  // Decision 0012: transcriber warm-up dispatch and transcript retention.
  transcription?: {
    tick(): Promise<unknown>;
    pruneExpired(): Promise<unknown>;
  };
  database: Pick<Pool, "end">;
  sessions: Pick<ReturnType<typeof createSessionRepository>, "deleteExpired">;
  accountSecurityCleanup?: () => Promise<void>;
  mediaAccountRevocation?: { flush(): Promise<unknown> };
  identity?: Pick<
    ReturnType<typeof createIdentityRepository>,
    "deleteExpiredAudit"
  >;
  matching?: Pick<
    ReturnType<typeof createMatchingRepository>,
    "expireRequests"
  >;
  matchmaking?: { sweep(): Promise<unknown>; pruneExpired(): Promise<unknown> };
  community?: Pick<
    ReturnType<typeof createCommunityRepository>,
    "pruneExpired"
  >;
  communityStreams?: { start(): Promise<void>; stop(): Promise<void> };
  matchmakingStreams?: { start(): Promise<void>; stop(): Promise<void> };
  measurement?: Pick<
    ReturnType<typeof createMeasurementRepository>,
    "pruneExpired"
  >;
  media?: Pick<
    ReturnType<typeof createMediaRepository>,
    "tick" | "claimRecordingStops" | "recordingStopFailed"
  >;
  mediaProvider?: Pick<
    ReturnType<typeof createMediaProvider>,
    "stopRecording" | "setTurn"
  >;
  mediaOperations?: { tick(): Promise<void>; stop(): Promise<void> };
  logger: Pick<Logger, "info" | "error">;
  config: Pick<ReturnType<typeof loadConfig>, "port" | "host">;
  verifyDatabase: () => Promise<void>;
  backgroundJobs?: boolean;
  cleanupIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  let server: Server | undefined;
  let a4Timer: NodeJS.Timeout | undefined;
  let a4Task: Promise<void> | undefined;
  let a4Ticking = false;
  let speakerTimer: NodeJS.Timeout | undefined;
  let speakerTask: Promise<void> | undefined;
  let speakerWorking = false;
  let transcriptionTimer: NodeJS.Timeout | undefined;
  let transcriptionTask: Promise<void> | undefined;
  let transcriptionWorking = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let mediaTimer: NodeJS.Timeout | undefined;
  let mediaTicking = false;
  let mediaTask: Promise<void> | undefined;
  let matchmakingTimer: NodeJS.Timeout | undefined;
  let matchmakingTask: Promise<void> | undefined;
  let matchmakingWorking = false;
  let stopping = false;
  const completedJobs = new Set<string>();

  // One line per job after its first completed run lets operators confirm that
  // this process runs the job; failures are logged separately as errors.
  function completed(job: string) {
    if (completedJobs.has(job)) return;
    completedJobs.add(job);
    logger.info({ job }, "background job ran");
  }

  async function tickMedia() {
    if (!media || mediaTicking || stopping) return;
    mediaTicking = true;
    try {
      const result = mediaOperations
        ? (await mediaOperations.tick(), undefined)
        : await media.tick();
      if (mediaProvider && result) {
        for (const turn of result.turns)
          await mediaProvider.setTurn(turn.debateId, turn.side);
        for (const debateId of result.ended)
          await mediaProvider.setTurn(debateId, null);
      }
    } catch (error) {
      logger.error({ error }, "media clock failed");
    }
    try {
      if (mediaProvider) {
        const due = await media.claimRecordingStops();
        for (const stop of due) {
          if (stopping) break;
          try {
            await mediaProvider.stopRecording(stop.egressId);
          } catch (error) {
            logger.error(
              { error, debateId: stop.debateId },
              "recording stop failed",
            );
            await media.recordingStopFailed(stop.debateId);
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "recording stop queue failed");
    } finally {
      mediaTicking = false;
      completed("media-clock");
    }
  }

  async function cleanupSessions() {
    try {
      const deleted = await sessions.deleteExpired();
      if (deleted > 0) logger.info({ deleted }, "expired sessions deleted");
    } catch (error) {
      logger.error({ error }, "expired session cleanup failed");
    }
    if (accountSecurityCleanup) {
      try {
        await accountSecurityCleanup();
      } catch (error) {
        logger.error({ error }, "expired account authorization cleanup failed");
      }
    }
    if (identity) {
      try {
        await identity.deleteExpiredAudit();
      } catch (error) {
        logger.error({ error }, "identity audit cleanup failed");
      }
    }
    if (matching) {
      try {
        await matching.expireRequests();
      } catch (error) {
        logger.error({ error }, "debate request expiry failed");
      }
    }
    if (matchmaking) {
      try {
        await matchmaking.pruneExpired();
      } catch (error) {
        logger.error({ error }, "matchmaking retention cleanup failed");
      }
    }
    if (community) {
      try {
        await community.pruneExpired();
      } catch (error) {
        logger.error({ error }, "community retention cleanup failed");
      }
    }
    if (measurement) {
      try {
        await measurement.pruneExpired();
      } catch (error) {
        logger.error({ error }, "product measurement retention cleanup failed");
      }
    }
    if (transcription) {
      try {
        await transcription.pruneExpired();
      } catch (error) {
        logger.error({ error }, "transcript retention cleanup failed");
      }
    }
    completed("cleanup");
  }

  return Object.freeze({
    async start() {
      await verifyDatabase();
      await communityStreams?.start();
      await matchmakingStreams?.start();

      if (app) {
        server = await new Promise<Server>((resolve, reject) => {
          const listeningServer = app.listen(config.port, config.host, () =>
            resolve(listeningServer),
          );
          listeningServer.once("error", reject);
        });
      }

      if (backgroundJobs) {
        if (mediaAccountRevocation) {
          speakerTimer = setIntervalFn(() => {
            if (speakerWorking || stopping) return speakerTask;
            speakerWorking = true;
            speakerTask = mediaAccountRevocation
              .flush()
              .then(() => {})
              .catch((error) =>
                logger.error({ error }, "speaker access revocation failed"),
              )
              .finally(() => {
                speakerWorking = false;
                completed("speaker-revocation");
              });
            return speakerTask;
          }, 1000);
          if (app) speakerTimer.unref();
        }
        if (a4 || coinDebates) {
          a4Timer = setIntervalFn(() => {
            if (a4Ticking || stopping) return a4Task;
            a4Ticking = true;
            a4Task = Promise.allSettled([a4?.tick(), coinDebates?.tick()])
              .then((results) => {
                for (const result of results)
                  if (result.status === "rejected")
                    logger.error(
                      { error: result.reason },
                      "A4 recovery tick failed",
                    );
              })
              .finally(() => {
                a4Ticking = false;
                completed("a4-recovery");
              });
            return a4Task;
          }, 1000);
          if (app) a4Timer.unref();
        }
        if (transcription) {
          transcriptionTimer = setIntervalFn(() => {
            if (transcriptionWorking || stopping) return transcriptionTask;
            transcriptionWorking = true;
            transcriptionTask = transcription
              .tick()
              .then(() => {})
              .catch((error) =>
                logger.error({ error }, "transcriber dispatch failed"),
              )
              .finally(() => {
                transcriptionWorking = false;
                completed("transcriber-dispatch");
              });
            return transcriptionTask;
          }, 1000);
          if (app) transcriptionTimer.unref();
        }
        cleanupTimer = setIntervalFn(cleanupSessions, cleanupIntervalMs);
        if (app) cleanupTimer.unref();
        if (media) {
          mediaTimer = setIntervalFn(() => {
            if (!mediaTicking) mediaTask = tickMedia();
            return mediaTask;
          }, 1000);
          if (app) mediaTimer.unref();
        }
        if (matchmaking) {
          // Offer deadlines are 30 seconds, so the queue is swept every second.
          matchmakingTimer = setIntervalFn(() => {
            if (matchmakingWorking || stopping) return matchmakingTask;
            matchmakingWorking = true;
            matchmakingTask = matchmaking
              .sweep()
              .then(() => {})
              .catch((error) =>
                logger.error({ error }, "matchmaking sweep failed"),
              )
              .finally(() => {
                matchmakingWorking = false;
                completed("matchmaking");
              });
            return matchmakingTask;
          }, 1000);
          if (app) matchmakingTimer.unref();
        }
      }
      return server;
    },

    async stop() {
      stopping = true;
      if (a4Timer) clearIntervalFn(a4Timer);
      if (speakerTimer) clearIntervalFn(speakerTimer);
      if (transcriptionTimer) clearIntervalFn(transcriptionTimer);
      await speakerTask;
      await transcriptionTask;
      await a4Task;
      if (cleanupTimer) clearIntervalFn(cleanupTimer);
      if (mediaTimer) clearIntervalFn(mediaTimer);
      if (matchmakingTimer) clearIntervalFn(matchmakingTimer);
      await Promise.all([mediaTask, matchmakingTask, mediaOperations?.stop()]);
      await communityStreams?.stop();
      await matchmakingStreams?.stop();

      if (server) {
        const listeningServer = server;
        await new Promise<void>((resolve, reject) => {
          listeningServer.close((error) => (error ? reject(error) : resolve()));
        });
      }

      await database.end();
    },
  });
}
