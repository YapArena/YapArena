export const shorthands = undefined;

// Decision 0015 (D8): the last-answer endorsement rate, stored as insert-only
// points. The recorder appends one point per counted turn window once it is
// revealed: the topic figure (each account's last revealed answer on the
// topic, counted once), the debate figure through that turn, and how answers
// changed, over the topic and over the debate. Point order is insertion order
// (id), serialized per topic by an advisory lock; history is never rewritten,
// so points can't be updated or deleted.
//
// Migrate before deploying the version with the recorder: an insert into a
// missing table fails.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.endorsement_points (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      round_id uuid NOT NULL UNIQUE REFERENCES yaparena.coin_debate_rounds(id),
      topic_id uuid NOT NULL REFERENCES yaparena.topics(id),
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      revealed_at timestamptz NOT NULL,
      topic_yes integer NOT NULL,
      topic_accounts integer NOT NULL,
      debate_yes integer NOT NULL,
      debate_accounts integer NOT NULL,
      switching jsonb NOT NULL CHECK (jsonb_typeof(switching) = 'object'),
      debate_switching jsonb NOT NULL CHECK (jsonb_typeof(debate_switching) = 'object'),
      method text NOT NULL DEFAULT 'last-answer-v1'
        CHECK (length(method) BETWEEN 1 AND 40),
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (0 <= topic_yes AND topic_yes <= topic_accounts),
      CHECK (0 <= debate_yes AND debate_yes <= debate_accounts),
      CHECK (debate_accounts <= topic_accounts)
    );
    CREATE INDEX endorsement_points_topic ON yaparena.endorsement_points(topic_id, id);
    CREATE TRIGGER endorsement_point_history BEFORE UPDATE OR DELETE
      ON yaparena.endorsement_points
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    ALTER TABLE yaparena.endorsement_points ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.endorsement_points FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.endorsement_points TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.endorsement_points TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.endorsement_points FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error("Endorsement history must be retained; forward-fix");
};
