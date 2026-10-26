export const shorthands = undefined;

// Direct challenges (Decision 0011): a challenge is either "now" (an online target has two minutes
// to answer) or proposes one to three times. Either side can counter with new times until one
// accepts the other's. Players may hold several pending challenges. Presence lets a "now"
// challenge reach a target who is on the site.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.match_requests
      ADD COLUMN mode varchar(10) NOT NULL DEFAULT 'scheduled',
      ADD COLUMN respond_by timestamptz,
      ADD CONSTRAINT match_requests_mode CHECK (mode IN ('now', 'scheduled')),
      ALTER COLUMN scheduled_at DROP NOT NULL,
      -- Only a "now" challenge may wait without a time; the open list always had one.
      ADD CONSTRAINT match_requests_agreed_time CHECK (
        scheduled_at IS NOT NULL OR (kind = 'direct' AND mode = 'now'));
    DROP INDEX yaparena.match_requests_one_open_outgoing;
    CREATE INDEX match_requests_open_initiator
      ON yaparena.match_requests (initiator_user_id) WHERE status = 'open';
    CREATE INDEX match_requests_respond_by
      ON yaparena.match_requests (respond_by) WHERE status = 'open' AND respond_by IS NOT NULL;

    CREATE TABLE yaparena.challenge_time_proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES yaparena.match_requests(id) ON DELETE CASCADE,
      proposed_by bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      starts_at timestamptz NOT NULL,
      status varchar(12) NOT NULL
        CHECK (status IN ('open', 'accepted', 'superseded', 'closed')),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX challenge_time_proposals_request
      ON yaparena.challenge_time_proposals (request_id, status, starts_at);
    CREATE UNIQUE INDEX challenge_time_proposals_one_time
      ON yaparena.challenge_time_proposals (request_id, starts_at) WHERE status = 'open';

    CREATE TABLE yaparena.matchmaking_presence (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const table of ["challenge_time_proposals", "matchmaking_presence"])
    pgm.sql(`
      ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON yaparena.${table} FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE ON yaparena.${table} TO yaparena_runtime;
      CREATE POLICY backend_access ON yaparena.${table}
        TO yaparena_runtime USING (true) WITH CHECK (true);
    `);
  // Challenge changes reach both players' live streams, like queue changes.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION yaparena.signal_matchmaking_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    DECLARE initiator bigint; target bigint;
    BEGIN
      IF TG_TABLE_NAME = 'matchmaking_tickets' THEN
        PERFORM pg_notify('yaparena_user_v1', NEW.user_id::text);
      ELSIF TG_TABLE_NAME = 'match_offers' THEN
        PERFORM pg_notify('yaparena_user_v1', NEW.user_a_id::text);
        PERFORM pg_notify('yaparena_user_v1', NEW.user_b_id::text);
      ELSE
        IF TG_TABLE_NAME = 'match_requests' THEN
          initiator := NEW.initiator_user_id;
          target := NEW.target_user_id;
        ELSE
          SELECT r.initiator_user_id, r.target_user_id INTO initiator, target
            FROM match_requests r WHERE r.id = NEW.request_id;
        END IF;
        PERFORM pg_notify('yaparena_user_v1', initiator::text);
        IF target IS NOT NULL THEN
          PERFORM pg_notify('yaparena_user_v1', target::text);
        END IF;
      END IF;
      RETURN NULL;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.signal_matchmaking_change() FROM PUBLIC;
    CREATE TRIGGER match_requests_signal
      AFTER INSERT OR UPDATE OF status, mode, respond_by, scheduled_at
      ON yaparena.match_requests
      FOR EACH ROW WHEN (NEW.kind = 'direct')
      EXECUTE FUNCTION yaparena.signal_matchmaking_change();
    CREATE TRIGGER challenge_time_proposals_signal
      AFTER INSERT OR UPDATE OF status ON yaparena.challenge_time_proposals
      FOR EACH ROW EXECUTE FUNCTION yaparena.signal_matchmaking_change();
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.signal_matchmaking_change() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error("Challenge scheduling is retained; forward-fix");
};
