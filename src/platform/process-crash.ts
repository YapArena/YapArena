import type { Logger } from "pino";

// Logs an uncaught exception or unhandled rejection through the logger's
// credential-safe error serializer, stops the service and exits with status 1.
// Without this, Node prints the raw error, message and all, to stderr. The
// process state is unknown after a crash, so the stop has a deadline; a further
// crash while it runs is logged but starts no second stop.
export function exitOnCrash({
  logger,
  stop,
  deadlineMs = 10_000,
  target = process,
}: {
  logger: Pick<Logger, "fatal" | "error">;
  stop: () => Promise<void>;
  deadlineMs?: number;
  target?: Pick<NodeJS.Process, "on" | "exit" | "exitCode">;
}) {
  let stopping = false;
  function crash(error: unknown, origin: string) {
    logger.fatal({ error, origin }, "process crashed");
    if (stopping) return;
    stopping = true;
    target.exitCode = 1;
    const deadline = setTimeout(() => target.exit(1), deadlineMs);
    deadline.unref();
    void Promise.resolve()
      .then(stop)
      .catch((stopError: unknown) => {
        logger.error({ error: stopError }, "shutdown after crash failed");
      })
      .finally(() => {
        clearTimeout(deadline);
        target.exit(1);
      });
  }
  // A rejected top-level await arrives here with origin "unhandledRejection".
  target.on("uncaughtException", crash);
  target.on("unhandledRejection", (reason) =>
    crash(reason, "unhandledRejection"),
  );
}
