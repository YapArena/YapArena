import type { Logger } from "pino";
import { createPgListener } from "./pg-listener.ts";
import { createSseSink, type SseResponse, type StreamSink } from "./sse.ts";

const HEARTBEAT = Buffer.from(": heartbeat\n\n");
const userId = /^[1-9]\d{0,18}$/;
const kindName = /^[a-z][a-z0-9_]{0,31}$/;

/** One kind of personal update, sent as the SSE event of the same name. */
export interface UserStreamKind {
  /** Reads the player's current data for this kind; without it the event carries `{}`. */
  read?: (userId: string) => Promise<unknown>;
}

/**
 * The kind a notification is for. A channel's payload is a bare user id for the channel's own
 * kind, or JSON `{"user": "<id>", "kind": "<kind>"}` naming another registered kind.
 */
export function parseNotice(
  payload: string | undefined,
  channelKind: string,
  kinds: ReadonlySet<string>,
): { user: string; kind: string } | null {
  if (payload === undefined) return null;
  if (userId.test(payload))
    return kinds.has(channelKind) ? { user: payload, kind: channelKind } : null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const user = "user" in value ? String(value.user) : "";
  const kind = "kind" in value ? value.kind : undefined;
  return userId.test(user) && typeof kind === "string" && kinds.has(kind)
    ? { user, kind }
    : null;
}

// Personal live updates for signed-in players, one stream per tab at /api/me/stream (Decision
// 0011 and interface 10). Features register kinds; the database notifies a player's id on a
// kind's channel, and this process pushes that kind to each of the player's open streams. One
// LISTEN connection per process covers every channel. Personal data never goes through the
// public room streams (Decision 0006). An open stream can also count as presence.
export function createUserStreams({
  databaseUrl,
  logger,
  kinds,
  channels,
  presence,
  maxStreams = 2000,
  streamsPerUser = 4,
  heartbeatMs = 15_000,
  presenceMs = 20_000,
  listen = createPgListener,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  databaseUrl: string;
  logger: Pick<Logger, "warn">;
  kinds: Readonly<Record<string, UserStreamKind>>;
  /** Database channel → the kind its bare-id payloads are for. */
  channels: Readonly<Record<string, string>>;
  /** Marks the connected players as present. */
  presence?: (userIds: readonly string[]) => Promise<unknown>;
  maxStreams?: number;
  streamsPerUser?: number;
  heartbeatMs?: number;
  presenceMs?: number;
  listen?: typeof createPgListener;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  const kindNames = new Set(Object.keys(kinds));
  if ([...kindNames].some((kind) => !kindName.test(kind)))
    throw new Error("stream kinds must be lowercase names");
  // Kinds with a reader are re-sent after a reconnect; the others are one-off notices.
  const readable = [...kindNames].filter((kind) => kinds[kind]?.read);
  const streams = new Map<string, Set<StreamSink>>();
  const pending = new Map<string, Set<string>>();
  let total = 0;
  let flushing: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let presenceTimer: NodeJS.Timeout | undefined;

  async function push(player: string, kind: string) {
    const sinks = streams.get(player);
    if (!sinks?.size) return;
    try {
      const data = (await kinds[kind]?.read?.(player)) ?? {};
      for (const sink of [...sinks]) sink.send(kind, data);
    } catch (error) {
      logger.warn({ error, kind }, "live update failed");
    }
  }

  // Several notices for one player and kind in quick succession cost one read.
  function schedule(player?: string, kind?: string) {
    if (player === undefined)
      for (const connected of streams.keys())
        for (const entry of readable) queue(connected, entry);
    else if (kind && streams.has(player)) queue(player, kind);
    if (flushing || !pending.size) return;
    // Starting on the next turn lets one commit's notices share a single read; a notice that
    // arrives during a read triggers another, so no change is missed.
    flushing = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      while (pending.size) {
        const batch = [...pending].slice(0, 8);
        for (const [player] of batch) pending.delete(player);
        await Promise.all(
          batch.flatMap(([player, entries]) =>
            [...entries].map((entry) => push(player, entry)),
          ),
        );
      }
    })().finally(() => {
      flushing = undefined;
      if (pending.size) schedule();
    });
  }
  function queue(player: string, kind: string) {
    const entries = pending.get(player) ?? new Set<string>();
    entries.add(kind);
    pending.set(player, entries);
  }

  async function touchConnected(players: readonly string[]) {
    if (!presence || !players.length) return;
    try {
      await presence(players);
    } catch (error) {
      logger.warn({ error }, "live update presence failed");
    }
  }

  const listener = listen(
    databaseUrl,
    logger,
    (payload, channel) => {
      // No payload: the listener (re)connected, so every player is read again.
      if (payload === undefined) return schedule();
      const notice = parseNotice(
        payload,
        channels[channel ?? ""] ?? "",
        kindNames,
      );
      if (notice) schedule(notice.user, notice.kind);
    },
    () => {},
    { channels: Object.keys(channels), name: "user-streams" },
  );

  return Object.freeze({
    subscribe(player: string, response: SseResponse) {
      const sinks = streams.get(player) ?? new Set<StreamSink>();
      if (total >= maxStreams || sinks.size >= streamsPerUser) {
        response
          .status(503)
          .set("Retry-After", "10")
          .json({ error: "live updates are busy" });
        return;
      }
      const sink: StreamSink = createSseSink(
        response,
        () => {
          sinks.delete(sink);
          total -= 1;
          if (!sinks.size) streams.delete(player);
        },
        () => logger.warn("live update stream fell behind"),
      );
      sinks.add(sink);
      streams.set(player, sinks);
      total += 1;
      void touchConnected([player]);
      for (const kind of readable)
        void Promise.resolve(kinds[kind]!.read!(player)).then(
          (data) => sink.send(kind, data),
          (error: unknown) =>
            logger.warn({ error, kind }, "live update failed"),
        );
    },
    async start() {
      await listener.start();
      heartbeat = setIntervalFn(() => {
        for (const sinks of streams.values())
          for (const sink of [...sinks]) sink.sendFrame(HEARTBEAT);
      }, heartbeatMs);
      heartbeat.unref();
      if (presence) {
        presenceTimer = setIntervalFn(
          () => void touchConnected([...streams.keys()]),
          presenceMs,
        );
        presenceTimer.unref();
      }
    },
    async stop() {
      if (heartbeat) clearIntervalFn(heartbeat);
      if (presenceTimer) clearIntervalFn(presenceTimer);
      for (const sinks of [...streams.values()])
        for (const sink of [...sinks]) sink.close();
      await listener.stop();
      await flushing;
    },
  });
}

export type UserStreams = ReturnType<typeof createUserStreams>;
