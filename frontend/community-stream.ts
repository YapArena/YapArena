import type { CommunityFrame } from "./community-types.js";

/** Public projections that a room signal asks the page to re-read. */
export type RoomTopic = "media" | "round" | "activity" | "window" | "outline";
export const roomTopics: readonly RoomTopic[] = [
  "media",
  "round",
  "activity",
  "window",
  "outline",
];
export interface RoomSignalDetail {
  room: string;
  /** Decimal room cursor of the applied frame that carried the signal. */
  cursor: string;
  topics: readonly RoomTopic[];
}
export interface RoomStreamDetail {
  room: string;
  /** True while the EventSource delivers applied frames or heartbeats. */
  live: boolean;
}
declare global {
  interface WindowEventMap {
    "yap:room-signal": CustomEvent<RoomSignalDetail>;
    "yap:room-stream": CustomEvent<RoomStreamDetail>;
    "yap:room-stream-query": CustomEvent<{ room: string }>;
  }
}
// Media and A4 run in other bundles; window events connect them to the page's
// single EventSource, which community.js owns.
export type RoomEvents = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "dispatchEvent"
>;
const pageEvents = (): RoomEvents | undefined =>
  typeof window === "undefined" ? undefined : window;

interface StreamOptions {
  room: string;
  apply: (
    frame: CommunityFrame,
    mode: "stream" | "poll",
  ) => void | Promise<void>;
  unavailable: () => void;
  status: (label: string) => void;
  degraded: (active: boolean) => void;
  beforeConnect: () => void;
  EventSourceClass?: typeof EventSource;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  random?: () => number;
  signals?: RoomEvents | undefined;
}
// One EventSource/page. The application cursor advances only after apply succeeds;
// EventSource's last received ID is never trusted as an application acknowledgment.
export function createCommunityStream({
  room,
  apply,
  unavailable,
  status,
  degraded,
  beforeConnect,
  EventSourceClass = globalThis.EventSource,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  random = Math.random,
  signals = pageEvents(),
}: StreamOptions) {
  let source: EventSource | undefined;
  let timer: number | undefined;
  let freshness: number | undefined;
  let cursor: string | null = null;
  let stopped = false;
  let attempt = 0;
  let generation = 0;
  let applied = false;
  let live = false;
  function announceHealth() {
    signals?.dispatchEvent(
      new CustomEvent("yap:room-stream", { detail: { room, live } }),
    );
  }
  function setLive(value: boolean) {
    if (live === value) return;
    live = value;
    announceHealth();
  }
  // Modules that load after the stream started ask for its current state.
  signals?.addEventListener("yap:room-stream-query", (event) => {
    if (event.detail.room === room) announceHealth();
  });
  // Signals follow successful application, in cursor order. A snapshot can
  // stand in for skipped references, so it asks every projection to re-read.
  function announceSignals(frame: CommunityFrame, at: bigint) {
    const changes = frame.changes ?? [];
    const topics =
      frame.kind === "snapshot"
        ? roomTopics
        : roomTopics.filter((topic) =>
            changes.some(
              (change) => "refresh" in change && change.refresh === topic,
            ),
          );
    if (topics.length)
      signals?.dispatchEvent(
        new CustomEvent("yap:room-signal", {
          detail: { room, cursor: String(at), topics },
        }),
      );
  }
  let lastFresh = now();
  let applying = Promise.resolve();
  let applyingSince: number | null = null;
  function close() {
    generation++;
    source?.close();
    source = undefined;
    clearTimer(freshness);
    applying = Promise.resolve();
    applyingSince = null;
  }
  function failed() {
    close();
    setLive(false);
    if (stopped) return;
    status("Connection interrupted. Polling while reconnecting…");
    degraded(true);
    clearTimer(timer);
    timer = setTimer(
      connect,
      Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) *
        (0.75 + random() * 0.5),
    );
  }
  function checkFreshness() {
    if (stopped) return;
    if (
      now() - lastFresh > 45000 ||
      (applyingSince !== null && now() - applyingSince > 45000)
    ) {
      failed();
      return;
    }
    freshness = setTimer(checkFreshness, 5000);
  }
  function connect() {
    if (stopped) return;
    close();
    clearTimer(timer);
    beforeConnect();
    degraded(false);
    status(
      cursor
        ? "Reconnecting community updates…"
        : "Connecting community updates…",
    );
    if (!EventSourceClass) {
      failed();
      return;
    }
    const epoch = generation;
    source = new EventSourceClass(
      `/api/community/events/${room}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    lastFresh = now() - 35000; // Ten seconds to the first application frame/heartbeat.
    freshness = setTimer(checkFreshness, 5000);
    source.addEventListener("community", (event) => {
      applying = applying
        .then(async () => {
          if (epoch !== generation || stopped) return;
          await receive(
            JSON.parse((event as MessageEvent<string>).data) as CommunityFrame,
            (event as MessageEvent<string>).lastEventId,
            "stream",
            epoch,
          );
        })
        .catch(() => {
          if (epoch === generation) failed();
        });
    });
    source.addEventListener("heartbeat", (event) => {
      if (epoch !== generation || stopped) return;
      try {
        if (
          (
            JSON.parse((event as MessageEvent<string>).data) as {
              version?: number;
            }
          ).version !== 1
        )
          throw new Error();
        // Resume with no new records is valid only after earlier state was applied.
        if (applied) {
          lastFresh = now();
          attempt = 0;
          degraded(false);
          status("Live updates on");
          setLive(true);
        }
      } catch {
        failed();
      }
    });
    source.addEventListener("unavailable", () => {
      if (epoch !== generation || stopped) return;
      stopped = true;
      close();
      clearTimer(timer);
      setLive(false);
      degraded(false);
      unavailable();
      status("This event is no longer public.");
    });
    source.onerror = () => {
      if (epoch === generation && !stopped) failed();
    };
  }
  async function receive(
    frame: CommunityFrame,
    receivedId: string,
    mode: "stream" | "poll",
    epoch: number,
  ) {
    if (
      frame.version !== 1 ||
      frame.roomId !== room ||
      frame.cursor !== receivedId ||
      !new RegExp(`^v1:${room}:(0|[1-9]\\d{0,18})$`).test(frame.cursor!) ||
      BigInt(frame.cursor!.split(":")[2]!) > 9223372036854775807n ||
      !["snapshot", "changes"].includes(frame.kind)
    )
      throw new Error("invalid community frame");
    const next = BigInt(frame.cursor!.split(":")[2]!);
    const previous = cursor === null ? -1n : BigInt(cursor.split(":")[2]!);
    if (next > previous || !applied) {
      applyingSince = now();
      await apply(frame, mode);
      if (epoch !== generation || stopped) return;
      cursor = frame.cursor!;
      applied = true;
      applyingSince = null;
      announceSignals(frame, next);
    }
    if (mode === "stream") {
      lastFresh = now();
      attempt = 0;
      degraded(false);
      status("Live updates on");
      setLive(true);
    }
  }
  return {
    start: connect,
    async acceptHttp(frame: CommunityFrame) {
      const epoch = generation;
      if (frame.kind === "unavailable") {
        stopped = true;
        close();
        clearTimer(timer);
        setLive(false);
        degraded(false);
        unavailable();
        status("This event is no longer public.");
        return;
      }
      await receive(frame, frame.cursor, "poll", epoch);
    },
    reconnect() {
      if (!stopped) {
        attempt = 0;
        connect();
      }
    },
    suspend() {
      close();
      clearTimer(timer);
      setLive(false);
      degraded(false);
    },
    stop() {
      stopped = true;
      close();
      clearTimer(timer);
      setLive(false);
      degraded(false);
    },
    get cursor() {
      return cursor;
    },
  };
}

// Listens for one room's signals and stream health from another bundle.
// Health starts as not live and is reported only when it changes.
export function watchRoom({
  room,
  topics,
  signal,
  health,
  events = pageEvents(),
}: {
  room: string;
  topics: readonly RoomTopic[];
  signal: (topic: RoomTopic, cursor: bigint) => void;
  health: (live: boolean) => void;
  events?: RoomEvents | undefined;
}) {
  if (!events) return () => {};
  const target = events;
  let live = false;
  function onSignal(event: CustomEvent<RoomSignalDetail>) {
    if (event.detail.room !== room) return;
    for (const topic of topics)
      if (event.detail.topics.includes(topic))
        signal(topic, BigInt(event.detail.cursor));
  }
  function onStream(event: CustomEvent<RoomStreamDetail>) {
    if (event.detail.room !== room || event.detail.live === live) return;
    live = event.detail.live;
    health(live);
  }
  target.addEventListener("yap:room-signal", onSignal);
  target.addEventListener("yap:room-stream", onStream);
  target.dispatchEvent(
    new CustomEvent("yap:room-stream-query", { detail: { room } }),
  );
  return () => {
    target.removeEventListener("yap:room-signal", onSignal);
    target.removeEventListener("yap:room-stream", onStream);
  };
}

// Coalesces signal-driven reads of one projection. read() resolves to the room
// revision the projection reported, or null when it reports none. A signal at
// or below the revision current() already reports needs no read. A read still
// behind the signal (a shared read that began before the commit, or a failed
// request) is retried with bounded backoff; later signals and polls cover the rest.
export function createSignalRefresh({
  read,
  current = () => null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retries = 3,
  retryMs = 500,
}: {
  read: () => Promise<string | null>;
  current?: () => string | null;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  retries?: number;
  retryMs?: number;
}) {
  let wanted = 0n;
  let running = false;
  let again = false;
  let attempt = 0;
  let stopped = false;
  let timer: number | undefined;
  async function run(): Promise<void> {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    clearTimer(timer);
    timer = undefined;
    running = true;
    let observed: string | null = null;
    let failed = false;
    try {
      observed = await read();
    } catch {
      failed = true;
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      return run();
    }
    const behind = failed || (observed !== null && BigInt(observed) < wanted);
    if (behind && attempt < retries && !stopped) {
      timer = setTimer(() => void run(), retryMs * 2 ** attempt++);
      return;
    }
    attempt = 0;
  }
  return {
    request(cursor = 0n) {
      const known = current();
      if (cursor > 0n && known !== null && BigInt(known) >= cursor) return;
      if (cursor > wanted) wanted = cursor;
      attempt = 0;
      void run();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}

// Delay before re-reading a projection after a known server deadline, from the
// server-adjusted clock. A deadline already due is work the server is finishing
// (a turn or round transition), followed with bounded backoff by attempt.
export function deadlineDelay(
  deadlines: readonly (string | null | undefined)[],
  serverNow: number,
  attempt = 0,
  graceMs = 2000,
) {
  let next: number | null = null;
  let due = false;
  for (const deadline of deadlines) {
    const at = deadline ? Date.parse(deadline) : NaN;
    if (!Number.isFinite(at)) continue;
    if (at <= serverNow) due = true;
    else if (next === null || at < next) next = at;
  }
  if (due && attempt <= 3) return graceMs * 2 ** attempt;
  return next === null ? null : next - serverNow + graceMs;
}

// Counts consecutive observations of the same due state, so a stalled
// transition stops being followed after the bounded backoff.
export function createDeadlineFollower(graceMs = 2000) {
  let observed = "";
  let wasDue = false;
  let attempt = 0;
  return (
    deadlines: readonly (string | null | undefined)[],
    state: string,
    serverNow: number,
  ) => {
    const due = deadlines.some(
      (deadline) => !!deadline && Date.parse(deadline) <= serverNow,
    );
    attempt = due && wasDue && state === observed ? attempt + 1 : 0;
    observed = state;
    wasDue = due;
    return deadlineDelay(deadlines, serverNow, attempt, graceMs);
  };
}

interface TimedRound {
  state: string;
  opensAt: string;
  closesAt: string;
}
// The A4 deadlines whose transitions a run view has not shown yet.
export function roundDeadlines(
  run:
    | { state?: string; revealAt?: string; rounds?: readonly TimedRound[] }
    | null
    | undefined,
) {
  const deadlines: string[] = [];
  if (!run?.rounds) return deadlines;
  for (const round of run.rounds) {
    if (round.state === "scheduled")
      deadlines.push(run.state === "running" ? round.opensAt : round.closesAt);
    else if (["open", "locked", "priced"].includes(round.state))
      deadlines.push(round.closesAt);
    else if (round.state === "pending" && run.revealAt)
      deadlines.push(run.revealAt);
  }
  return deadlines;
}
export const roundStates = (
  run: { state?: string; rounds?: readonly TimedRound[] } | null | undefined,
) => `${run?.state ?? ""}:${(run?.rounds ?? []).map((r) => r.state).join()}`;
