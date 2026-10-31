import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { exitOnCrash } from "./platform/process-crash.ts";
import { createReplayJobs } from "./features/media/replay-jobs.ts";
import { createReplayStorage } from "./features/media/replay-storage.ts";
import { createReplayWorker } from "./features/media/replay-worker.ts";
import { verifyReplayTools } from "./features/media/replay-packaging.ts";
import { createReplayThumbnailTask } from "./features/media/replay-thumbnail.ts";

const config = loadConfig();
if (!config.replayPackaging.enabled || !config.media)
  throw new Error(
    "Enable automatic packaging with complete private media configuration before starting this worker",
  );
const logger = createLogger({ level: config.logLevel });
// This process runs encoding only. It never competes with clock/HTTP work in
// the web pool, starts listeners, or receives migration/deployment credentials.
const database = createDatabase(config.databaseUrl, logger, undefined, {
  max: 2,
  timeoutMs: 1500,
});
const storage = createReplayStorage({
  bucket: config.media.s3Bucket,
  region: config.media.s3Region,
  endpoint: config.media.s3Endpoint,
  accessKey: config.media.s3AccessKey,
  secretKey: config.media.s3SecretKey,
});
const jobs = createReplayJobs(database, config.media.replayEdgeRooms);
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
await verifyDatabaseState(database, new URL("../migrations", import.meta.url));
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
