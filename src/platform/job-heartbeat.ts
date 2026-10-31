import type { Pool } from "pg";

// The jobs worker beats every 15 seconds while its jobs keep ticking; web calls
// it stale after a minute, four missed beats.
export const heartbeatIntervalMs = 15_000;
export const heartbeatStaleSeconds = 60;

export function createJobHeartbeat(database: Pick<Pool, "query">) {
  return Object.freeze({
    async beat() {
      await database.query(
        `INSERT INTO job_heartbeats (name, beat_at) VALUES ('jobs', clock_timestamp())
         ON CONFLICT (name) DO UPDATE SET beat_at = EXCLUDED.beat_at`,
      );
    },
    /** Seconds since the last beat, or null before the first one. */
    async age() {
      const result = await database.query<{ age: number }>(
        `SELECT extract(epoch FROM clock_timestamp() - beat_at)::float8 AS age
         FROM job_heartbeats WHERE name = 'jobs'`,
      );
      return result.rows[0]?.age ?? null;
    },
  });
}
