export const shorthands = undefined;

// Decision 0018, PR 2b: the mic in the turn engine.
//
// A debate whose rules snapshot says the mic is on runs each live mic as its
// own turns: question, answer, follow-up, answer, then a resume turn for the
// debater who was not asked (E1, E4, E8). mic_runs records when the engine
// started a mic and the turn it cut (E5, E6); the cut turn's window is
// refunded after the start commits (E10), so cut_void stays pending until
// that refund is done or refused. mic_turns records which turn numbers are
// mic turns, the asker's on-screen text (E9) and how long each turn ran, so
// mic turns do not count toward the debate's maximum length.
//
// debate_media is left as it is: its triggers already publish every turn change.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.mic_runs (
      mic_id uuid PRIMARY KEY REFERENCES yaparena.mic_mics(id),
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      cut_turn_number integer CHECK (cut_turn_number >= 1),
      cut_side text CHECK (cut_side IN ('A', 'B')),
      lost_ms integer CHECK (lost_ms >= 0),
      cut_void text CHECK (cut_void IN ('pending', 'done', 'refused')),
      -- A mic started at a turn boundary cut nothing.
      CHECK ((cut_turn_number IS NULL) = (cut_side IS NULL)
        AND (cut_turn_number IS NULL) = (lost_ms IS NULL)
        AND (cut_turn_number IS NULL) = (cut_void IS NULL))
    );
    CREATE INDEX mic_runs_pending_void ON yaparena.mic_runs (debate_id)
      WHERE cut_void = 'pending';

    CREATE TABLE yaparena.mic_turns (
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      mic_id uuid NOT NULL REFERENCES yaparena.mic_runs(mic_id),
      kind text NOT NULL
        CHECK (kind IN ('question', 'answer', 'followup', 'answer2', 'resume')),
      -- debate_media.active_side during the turn: the asker's camp for the
      -- asker's turns (E11), the target for answers, the other side to resume.
      side text NOT NULL CHECK (side IN ('A', 'B')),
      allotted_ms integer NOT NULL CHECK (allotted_ms > 0),
      text text CHECK (text IS NULL OR char_length(text) BETWEEN 1 AND 200),
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      ended_at timestamptz,
      used_ms integer CHECK (used_ms BETWEEN 0 AND allotted_ms),
      PRIMARY KEY (debate_id, turn_number),
      UNIQUE (mic_id, kind),
      CHECK ((ended_at IS NULL) = (used_ms IS NULL)),
      CHECK (text IS NULL OR kind IN ('question', 'followup'))
    );

    -- Only the engine's own steps: a pending refund settles once, a turn's
    -- text changes while it runs, and a turn ends once.
    CREATE FUNCTION yaparena.mic_turn_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_TABLE_NAME = 'mic_runs' THEN
        IF (to_jsonb(NEW) - 'cut_void') IS DISTINCT FROM (to_jsonb(OLD) - 'cut_void')
          OR NOT (OLD.cut_void = 'pending' AND NEW.cut_void IN ('done', 'refused')) THEN
          RAISE EXCEPTION 'mic runs only settle their cut once' USING ERRCODE='23514';
        END IF;
      ELSIF (to_jsonb(NEW) - ARRAY['text', 'ended_at', 'used_ms'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['text', 'ended_at', 'used_ms'])
        OR OLD.ended_at IS NOT NULL THEN
        RAISE EXCEPTION 'an ended mic turn does not change' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER mic_run_guard BEFORE UPDATE ON yaparena.mic_runs
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_turn_guard();
    CREATE TRIGGER mic_turn_guard BEFORE UPDATE ON yaparena.mic_turns
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_turn_guard();

    REVOKE ALL ON FUNCTION yaparena.mic_turn_guard() FROM PUBLIC;
    ALTER TABLE yaparena.mic_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_turns ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.mic_runs, yaparena.mic_turns FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.mic_runs, yaparena.mic_turns TO yaparena_runtime;
    GRANT UPDATE (cut_void) ON yaparena.mic_runs TO yaparena_runtime;
    GRANT UPDATE (text, ended_at, used_ms) ON yaparena.mic_turns TO yaparena_runtime;
    CREATE POLICY sandbox_access ON yaparena.mic_runs TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_turns TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.mic_runs, yaparena.mic_turns FROM %I',
          role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.mic_turn_guard() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

// The turns themselves stay in debate_media and event_history; dropping these
// tables loses only which turns were the mic's.
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE yaparena.mic_turns;
    DROP TABLE yaparena.mic_runs;
    DROP FUNCTION yaparena.mic_turn_guard();
  `);
};
