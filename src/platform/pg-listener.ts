import pg from "pg";
import type { Logger } from "pino";
import { verifyRuntimeIdentity } from "./database.ts";

// One LISTEN connection per listener and process, on one or more channels. `wake` receives each
// notification's payload and channel, and no payload after every (re)connect so callers
// resynchronize. The defaults are the community room channel; the per-user live updates listen
// on all of their channels through one connection (Decisions 0011 and interface 10).
export function createPgListener(
  connectionString: string,
  logger: Pick<Logger, "warn">,
  wake: (payload?: string, channel?: string) => void,
  count: (kind: string) => void,
  {
    channel = "yaparena_community_v1",
    channels = [channel],
    name = "community",
  }: { channel?: string; channels?: readonly string[]; name?: string } = {},
) {
  // LISTEN takes an identifier, not a parameter, so only plain names are accepted.
  if (
    !channels.length ||
    channels.some((entry) => !/^[a-z][a-z0-9_]{0,62}$/.test(entry))
  )
    throw new Error("listener channel must be a plain identifier");
  const listening = new Set(channels);
  let current: pg.Client | undefined;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let connecting: Promise<void> | undefined;
  function reconnect() {
    if (stopped || retry) return;
    const delay =
      Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) *
      (0.75 + Math.random() * 0.5);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
    retry.unref();
  }
  function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      const client = new pg.Client({
        connectionString,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
        connectionTimeoutMillis: 5000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
        query_timeout: 5000,
        application_name: `yaparena-${name}-listener`,
      });
      current = client;
      let failed = false;
      function lost() {
        if (failed || stopped) return;
        failed = true;
        count("listener_failure");
        logger.warn(`${name} listener connection lost`);
        if (current === client) current = undefined;
        void client.end().catch(() => {});
        reconnect();
      }
      client.on("error", lost);
      client.on("end", lost);
      client.on("notification", (notification) => {
        if (!failed && listening.has(notification.channel))
          wake(notification.payload, notification.channel);
      });
      try {
        await client.connect();
        await verifyRuntimeIdentity(client);
        // Autocommit LISTEN must finish before durable inspection (including reconnect).
        for (const entry of listening) await client.query(`LISTEN ${entry}`);
        if (stopped || failed) {
          await client.end();
          return;
        }
        attempt = 0;
        count("listener_connected");
        wake();
      } catch {
        lost();
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  return {
    start: connect,
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (current) {
        const client = current;
        const deadline = setTimeout(
          () => client.connection.stream.destroy(),
          1500,
        );
        try {
          await client.end().catch(() => {});
        } finally {
          clearTimeout(deadline);
        }
      }
      await connecting;
    },
  };
}
