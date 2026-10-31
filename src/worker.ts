import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { createMetrics } from "./platform/metrics.ts";
import { exitOnCrash } from "./platform/process-crash.ts";
import { createBackgroundWorker } from "./services.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();
const database = createDatabase(config.databaseUrl, logger, (seconds) =>
  metrics.poolWait.observe(seconds),
);
const worker = createBackgroundWorker({
  config,
  database,
  logger,
  metrics,
});

let stopping: Promise<void> | undefined;
function shutdown(signal: string) {
  stopping ??= (async () => {
    logger.info({ signal }, "worker shutdown requested");
    const forcedExit = setTimeout(() => {
      logger.fatal("forced worker shutdown");
      process.exit(1);
    }, 10_000);
    forcedExit.unref();
    try {
      await worker.stop();
      clearTimeout(forcedExit);
    } catch (error) {
      logger.error({ error }, "worker shutdown failed");
      process.exitCode = 1;
    }
  })();
  return stopping;
}
// Installed before start so a failed start is logged safely too.
exitOnCrash({ logger, stop: () => shutdown("crash") });

await worker.start();
logger.info(
  {
    environment: config.environment,
    media: Boolean(config.media),
  },
  "background worker started",
);

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
