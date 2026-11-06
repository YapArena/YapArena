export const shorthands = undefined;

// "Notify me" (first-run build plan PR 9): a signed-in viewer asks for an in-app notice when a
// scheduled debate starts. One request per account and debate. The worker's reminder step
// notifies the requesters once, with the speakers; requests stop mattering when their debate
// starts or is called off, and the hourly matchmaking cleanup deletes them then. Rows belong to
// the account and to the debate, and go with either.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.debate_notify_requests (
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, debate_id)
    );
    CREATE INDEX debate_notify_requests_debate
      ON yaparena.debate_notify_requests (debate_id);
    ALTER TABLE yaparena.debate_notify_requests ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.debate_notify_requests FROM PUBLIC;
    GRANT SELECT, INSERT, DELETE ON yaparena.debate_notify_requests TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.debate_notify_requests
      TO yaparena_runtime USING (true) WITH CHECK (true);
  `);
};

export const down = () => {
  throw new Error("Notify-me requests are account records; forward-fix");
};
