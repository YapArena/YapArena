export const shorthands = undefined;

// Web push for "Notify me" (first-run build plan PR 10). A browser that allowed notifications
// saves its push subscription: the push service's address and the browser's two public keys,
// which encrypt each message so only that browser can read it. One row per address, owned by
// the account that saved it last; an account keeps at most a few, and a subscription the push
// service reports gone (404 or 410) is deleted. Rows go with the account.
//
// When the reminder step notifies a requester, it queues one delivery per subscription in the
// same transaction; the jobs worker sends it and deletes the row. Deliveries go with their
// subscription or debate, and expire within minutes because the debate is starting.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.web_push_subscriptions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      endpoint text NOT NULL UNIQUE
        CHECK (char_length(endpoint) <= 2048 AND endpoint LIKE 'https://%'),
      p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
      auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22}$'),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX web_push_subscriptions_user
      ON yaparena.web_push_subscriptions (user_id, updated_at DESC);
    ALTER TABLE yaparena.web_push_subscriptions ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.web_push_subscriptions FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE, DELETE ON yaparena.web_push_subscriptions TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.web_push_subscriptions
      TO yaparena_runtime USING (true) WITH CHECK (true);

    CREATE TABLE yaparena.web_push_deliveries (
      subscription_id bigint NOT NULL
        REFERENCES yaparena.web_push_subscriptions(id) ON DELETE CASCADE,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_until timestamptz,
      PRIMARY KEY (subscription_id, debate_id)
    );
    CREATE INDEX web_push_deliveries_created
      ON yaparena.web_push_deliveries (created_at);
    CREATE INDEX web_push_deliveries_debate
      ON yaparena.web_push_deliveries (debate_id);
    ALTER TABLE yaparena.web_push_deliveries ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.web_push_deliveries FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE, DELETE ON yaparena.web_push_deliveries TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.web_push_deliveries
      TO yaparena_runtime USING (true) WITH CHECK (true);
  `);
};

export const down = () => {
  throw new Error("Push subscriptions are account records; forward-fix");
};
