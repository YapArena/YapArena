export const shorthands = undefined;

// Liveness for the jobs worker's uptime alert: the worker stamps its row while
// its one-second jobs keep finishing ticks, and web reports the stamp's age at
// /ready/jobs. The database clock writes and ages the stamp, so no two
// services' clocks are compared.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.job_heartbeats (
      name varchar(20) PRIMARY KEY CHECK (name IN ('jobs')),
      beat_at timestamptz NOT NULL
    );
    ALTER TABLE yaparena.job_heartbeats ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.job_heartbeats FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE ON yaparena.job_heartbeats TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.job_heartbeats
      TO yaparena_runtime USING (true) WITH CHECK (true);
  `);
};

export const down = (pgm) => {
  pgm.sql("DROP TABLE yaparena.job_heartbeats");
};
