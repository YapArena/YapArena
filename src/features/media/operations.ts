import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import { runExclusiveDatabaseJob } from "../../platform/database-jobs.ts";
import type { createMediaRepository } from "./repository.ts";
import type { createMediaProvider } from "./provider.ts";
import type { TurnHint } from "../transcription/protocol.ts";

type Desired = {
  revision: number;
  side: "A" | "B" | null;
  // Decision 0012: the durable turn, written to room metadata as a hint.
  hint?: TurnHint;
};
async function desired(client: PoolClient, id: string): Promise<Desired> {
  const result = await client.query<Desired>(
    `SELECT m.revision,
    CASE WHEN m.state='running' AND d.status='live' AND d.publication_state='published'
      AND t.publication_state='published' THEN m.active_side ELSE NULL END AS side,
    json_build_object('v',1,'debateStatus',d.status,'mediaState',m.state,
      'turnNumber',m.turn_number,'activeSide',m.active_side,
      'turnDeadlineAt',m.turn_deadline_at) AS hint
    FROM debate_media m JOIN debates d ON d.id=m.debate_id JOIN topics t ON t.id=d.topic_id
    WHERE m.debate_id=$1`,
    [id],
  );
  return result.rows[0] ?? { revision: -1, side: null };
}

export function createMediaOperations<
  Provider extends Pick<ReturnType<typeof createMediaProvider>, "setTurn"> &
    Partial<Pick<ReturnType<typeof createMediaProvider>, "recordingResult">>,
>({
  database,
  media,
  provider,
  logger,
  count = () => {},
  now = () => performance.now(),
  wait = delay,
}: {
  database: Pool;
  media: ReturnType<typeof createMediaRepository>;
  provider: Provider;
  logger: Pick<Logger, "warn">;
  count?: (
    kind:
      | "clock_acquired"
      | "clock_contended"
      | "permission_repair"
      | "permission_failure",
  ) => void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
}) {
  const inFlight = new Map<
    string,
    { requested: number; work: Promise<void> }
  >();
  const failures = new Set<Promise<void>>();
  let stopping = false;
  let lastRepair = -Infinity;
  let lastRecordingProbe = -Infinity;
  let probe: Promise<void> | undefined;
  let probeAbort: AbortController | undefined;
  let after = "00000000-0000-0000-0000-000000000000";
  let afterEnded = after;
  let afterRecording = after;

  function reconcile(id: string): Promise<void> {
    const existing = inFlight.get(id);
    if (existing) {
      existing.requested++;
      return existing.work;
    }
    if (stopping || inFlight.size >= 16)
      return Promise.reject(new Error("media permission work unavailable"));
    const item = { requested: 1, work: undefined as unknown as Promise<void> };
    const work = (async () => {
      for (let attempt = 0; attempt < 12 && !stopping; attempt++) {
        const result = await runExclusiveDatabaseJob(
          database,
          `media-permission:${id}`,
          async (client) => {
            // Only this advisory lock precedes provider I/O. Business writers never
            // acquire it, so provider calls cannot invert their row-lock order.
            for (
              let revisionAttempt = 0;
              revisionAttempt < 4 && !stopping;
              revisionAttempt++
            ) {
              const generation = item.requested;
              const current = await desired(client, id);
              await provider.setTurn(id, current.side, current.hint);
              const latest = await desired(client, id);
              if (
                latest.revision === current.revision &&
                latest.side === current.side &&
                generation === item.requested
              )
                return;
            }
            if (!stopping) await provider.setTurn(id, null);
            throw new Error(
              "media permissions changed repeatedly during reconciliation",
            );
          },
        );
        if (result.acquired) {
          count("permission_repair");
          return;
        }
        await wait(100 + Math.random() * 100);
      }
      throw new Error("media permission lock unavailable");
    })().finally(() => inFlight.delete(id));
    item.work = work;
    inFlight.set(id, item);
    return work;
  }

  function repair(id: string) {
    const failure = reconcile(id)
      .catch(async () => {
        count("permission_failure");
        logger.warn(
          "media permission reconciliation failed; retrying from durable state",
        );
        // Fail closed in the application too. Browser microphone policy observes
        // this pause even while a provider outage prevents immediate remote repair.
        if (stopping) return;
        const state = await media.get(id).catch(() => null);
        if (state?.state === "running")
          await media
            .pause(
              id,
              null,
              "Speaker permissions unavailable; debate paused automatically.",
            )
            .catch(() => {});
      })
      .finally(() => failures.delete(failure));
    failures.add(failure);
  }

  return Object.freeze({
    provider: Object.freeze({
      ...provider,
      setTurn: (id: string, _capturedSide: "A" | "B" | null) => {
        void _capturedSide;
        return reconcile(id);
      },
    }),
    reconcile,
    async tick() {
      if (stopping) return;
      // Ownership covers database advancement only. Provider latency never holds
      // the global clock lock or delays other rooms' clock advancement.
      const result = await runExclusiveDatabaseJob(
        database,
        "media-clock",
        () => media.tick(),
      );
      count(result.acquired ? "clock_acquired" : "clock_contended");
      if (result.acquired) {
        for (const turn of result.value.turns) repair(turn.debateId);
        for (const id of result.value.ended) repair(id);
      }
      if (now() - lastRepair >= 5000) {
        lastRepair = now();
        const rooms = await database.query<{ id: string }>(
          `SELECT debate_id AS id FROM debate_media
          WHERE debate_id > $1 AND state IN ('running','paused')
          ORDER BY debate_id LIMIT 8`,
          [after],
        );
        after =
          rooms.rows.length === 8
            ? rooms.rows.at(-1)!.id
            : "00000000-0000-0000-0000-000000000000";
        for (const room of rooms.rows) repair(room.id);
        const ended = await database.query<{ id: string }>(
          `SELECT debate_id AS id FROM debate_media
          WHERE debate_id > $1 AND state='ended' AND updated_at > clock_timestamp()-INTERVAL '10 minutes'
          ORDER BY debate_id LIMIT 4`,
          [afterEnded],
        );
        afterEnded =
          ended.rows.length === 4
            ? ended.rows.at(-1)!.id
            : "00000000-0000-0000-0000-000000000000";
        for (const room of ended.rows) repair(room.id);
      }
      if (
        provider.recordingResult &&
        !probe &&
        now() - lastRecordingProbe >= 30_000
      ) {
        lastRecordingProbe = now();
        probeAbort = new AbortController();
        probe = (async () => {
          const pending = await media.pendingRecordingResults(afterRecording);
          afterRecording =
            pending.length === 5
              ? pending.at(-1)!.debateId
              : "00000000-0000-0000-0000-000000000000";
          for (const recording of pending) {
            if (stopping) return;
            try {
              const result = await provider.recordingResult!(
                recording.egressId,
                recording.key,
                probeAbort!.signal,
              );
              if (result)
                await media.recordingEnded(
                  recording.egressId,
                  result.success,
                  result.key,
                );
            } catch {
              if (!stopping)
                logger.warn(
                  "recording completion check failed; continuing bounded reconciliation",
                );
            }
          }
        })()
          .catch(() =>
            logger.warn(
              "recording completion reconciliation failed; retrying automatically",
            ),
          )
          .finally(() => {
            probe = undefined;
          });
      }
    },
    async stop() {
      stopping = true;
      probeAbort?.abort();
      await Promise.allSettled([...inFlight.values()].map((item) => item.work));
      await Promise.allSettled(failures);
      await probe;
    },
  });
}
