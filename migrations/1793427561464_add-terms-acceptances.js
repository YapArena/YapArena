export const shorthands = undefined;

// The handle pop-up asks a new account to confirm it is at least the minimum
// age and accepts the Terms of Use and Privacy Policy (founder, 2026-10-30).
// One row per account and terms version, written in the same statement that
// creates the profile; a later version adds a row rather than replacing one.
// Rows belong to the account and are deleted with it.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.terms_acceptances (
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      terms_version text NOT NULL CHECK (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      minimum_age smallint NOT NULL CHECK (minimum_age BETWEEN 13 AND 21),
      accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (user_id, terms_version)
    );
    GRANT SELECT, INSERT ON yaparena.terms_acceptances TO yaparena_runtime;
    ALTER TABLE yaparena.terms_acceptances ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_access ON yaparena.terms_acceptances TO yaparena_runtime
      USING (true) WITH CHECK (true);
  `);
};

export const down = () => {
  throw new Error("Terms acceptances are account records; forward-fix");
};
