export const shorthands = undefined;

// Camera and microphone check taken before entering the live queue (Decision 0011). The per-debate
// check in media_device_checks still gates readiness and speaker tokens inside the room.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.account_device_checks (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      camera_ok boolean NOT NULL,
      microphone_ok boolean NOT NULL,
      checked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE yaparena.account_device_checks ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.account_device_checks FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE ON yaparena.account_device_checks TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.account_device_checks
      TO yaparena_runtime USING (true) WITH CHECK (true);
  `);
};

export const down = () => {
  throw new Error("Account device checks are retained; forward-fix");
};
