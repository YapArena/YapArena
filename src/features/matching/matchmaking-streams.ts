import type { Logger } from "pino";
import { createPgListener } from "../../platform/pg-listener.ts";
import {
  createSseSink,
  type SseResponse,
  type StreamSink,
} from "../../platform/sse.ts";
import type { MatchmakingState } from "./matchmaking.ts";

const HEARTBEAT = Buffer.from(": heartbeat\n\n");
const userId = /^[1-9]\d{0,18}$/;

// Live queue updates for signed-in players (Decision 0011). The database notifies
// `yaparena_user_v1` with a player's id when their ticket or offer changes; this process re-reads
// that player's state and pushes it to each of their open streams. Personal state never goes
// through the public room streams (Decision 0006). An open stream also counts as presence.
export function createMatchmakingStreams({
  databaseUrl,
  matchmaking,
  logger,
  maxStreams = 2000,
  streamsPerUser = 4,
  heartbeatMs = 15_000,
  presenceMs = 20_000,
  listen = createPgListener,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  databaseUrl: string;
  matchmaking: {
    state(userId: string): Promise<MatchmakingState>;
    touchMany(userIds: readonly string[]): Promise<unknown>;
  };
  logger: Pick<Logger, "warn">;
  maxStreams?: number;
  streamsPerUser?: number;
  heartbeatMs?: number;
  presenceMs?: number;
  listen?: typeof createPgListener;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  const streams = new Map<string, Set<StreamSink>>();
  const pending = new Set<string>();
  let total = 0;
  let flushing: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let presence: NodeJS.Timeout | undefined;

  async function push(player: string) {
    const sinks = streams.get(player);
    if (!sinks?.size) return;
    try {
      const state = await matchmaking.state(player);
      for (const sink of [...sinks]) sink.send("state", state);
    } catch (error) {
      logger.warn({ error }, "live queue update failed");
    }
  }

  // Several changes for one player in quick succession cost one read.
  function schedule(player?: string) {
    if (player === undefined)
      for (const connected of streams.keys()) pending.add(connected);
    else if (userId.test(player) && streams.has(player)) pending.add(player);
    if (flushing || !pending.size) return;
    // Starting on the next turn lets one commit's notices share a single read; a notice that
    // arrives during a read triggers another, so no change is missed.
    flushing = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      while (pending.size) {
        const batch = [...pending].slice(0, 8);
        for (const entry of batch) pending.delete(entry);
        await Promise.all(batch.map(push));
      }
    })().finally(() => {
      flushing = undefined;
      if (pending.size) schedule();
    });
  }

  async function touchConnected(players: readonly string[]) {
    try {
      await matchmaking.touchMany(players);
    } catch (error) {
      logger.warn({ error }, "live queue presence failed");
    }
  }

  const listener = listen(databaseUrl, logger, schedule, () => {}, {
    channel: "yaparena_user_v1",
    name: "matchmaking",
  });

  return Object.freeze({
    subscribe(player: string, response: SseResponse) {
      const sinks = streams.get(player) ?? new Set<StreamSink>();
      if (total >= maxStreams || sinks.size >= streamsPerUser) {
        response
          .status(503)
          .set("Retry-After", "10")
          .json({ error: "live queue updates are busy" });
        return;
      }
      const sink: StreamSink = createSseSink(
        response,
        () => {
          sinks.delete(sink);
          total -= 1;
          if (!sinks.size) streams.delete(player);
        },
        () => logger.warn("live queue stream fell behind"),
      );
      sinks.add(sink);
      streams.set(player, sinks);
      total += 1;
      void touchConnected([player]);
      void matchmaking.state(player).then(
        (state) => sink.send("state", state),
        (error: unknown) => logger.warn({ error }, "live queue update failed"),
      );
    },
    async start() {
      await listener.start();
      heartbeat = setIntervalFn(() => {
        for (const sinks of streams.values())
          for (const sink of [...sinks]) sink.sendFrame(HEARTBEAT);
      }, heartbeatMs);
      heartbeat.unref();
      presence = setIntervalFn(
        () => void touchConnected([...streams.keys()]),
        presenceMs,
      );
      presence.unref();
    },
    async stop() {
      if (heartbeat) clearIntervalFn(heartbeat);
      if (presence) clearIntervalFn(presence);
      for (const sinks of [...streams.values()])
        for (const sink of [...sinks]) sink.close();
      await listener.stop();
      await flushing;
    },
  });
}
