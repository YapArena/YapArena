import { loadConfig } from "./platform/config.ts";
import { createDatabase, verifyEncoderIdentity } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { exitOnCrash } from "./platform/process-crash.ts";
import { createReplayJobs } from "./features/media/replay-jobs.ts";
import { createReplayStorage } from "./features/media/replay-storage.ts";
import { createReplayWorker } from "./features/media/replay-worker.ts";
import { verifyReplayTools } from "./features/media/replay-packaging.ts";
import { createReplayThumbnailTask } from "./features/media/replay-thumbnail.ts";

// Requires automatic packaging and private storage only: the encoder never
// needs LiveKit, the replay signing secret or the transcription ingest secret.
const config = loadConfig(process.env, { service: "encoder" });
const encoder = config.replayEncoder;
if (!encoder) throw new Error("replay encoder configuration is missing");
const logger = createLogger({ level: config.logLevel });
if (config.unusedSecrets.length > 0)
  logger.warn(
    { event: "unused_secrets", names: config.unusedSecrets },
    "this process does not use these secrets; remove them from its environment",
  );
// This process runs encoding only. It never competes with clock/HTTP work in
// the web pool, starts listeners, or receives migration/deployment credentials.
// It connects as yaparena_encoder, which can use only the replay queue and the
// rows publication touches (YA-15).
const database = createDatabase(config.databaseUrl, logger, undefined, {
  max: 2,
  timeoutMs: 1500,
});
const storage = createReplayStorage({
  bucket: encoder.bucket,
  region: encoder.region,
  endpoint: encoder.endpoint,
  accessKey: encoder.accessKey,
  secretKey: encoder.secretKey,
});
const jobs = createReplayJobs(database, encoder.replayEdgeRooms);
const worker = createReplayWorker({
  jobs,
  storage,
  logger,
  options: config.replayPackaging,
  idleWork: createReplayThumbnailTask({
    jobs,
    storage: storage.thumbnails,
    logger,
  }),
});
let stopping: Promise<void> | undefined;
function shutdown() {
  stopping ??= (async () => {
    const forced = setTimeout(() => {
      logger.fatal("replay worker shutdown deadline exceeded");
      process.exit(1);
    }, 10000);
    forced.unref();
    try {
      await worker.stop();
      storage.close();
      await database.end();
      clearTimeout(forced);
      logger.info(
        { event: "replay_worker_stopped" },
        "Automatic replay worker stopped",
      );
    } catch {
      logger.error("replay worker shutdown failed");
      process.exitCode = 1;
    }
  })();
  return stopping;
}
// A failed start reaches the crash handler, which logs it, releases the
// worker, storage and pool through shutdown, and exits with status 1.
exitOnCrash({ logger, stop: shutdown });
await verifyDatabaseState(
  database,
  new URL("../migrations", import.meta.url),
  verifyEncoderIdentity,
);
await verifyReplayTools();
worker.start();
logger.info(
  {
    event: "replay_worker_started",
    concurrency: config.replayPackaging.concurrency,
  },
  "Automatic replay worker started",
);
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
