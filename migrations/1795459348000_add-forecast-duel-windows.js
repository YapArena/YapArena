export const shorthands = undefined;

// Decision 0017: forecast duels settle live turn windows.
//
// Viewers present. A signed-in account watching a live debate sends a heartbeat.
// debate_viewers keeps each account's latest heartbeat per debate ("present now":
// a recent heartbeat). coin_window_viewers records, once, each account seen while
// a turn window was open ("present during the window"); a duel window settles
// only when enough accounts were present at any point in it. Debaters are
// excluded when the counts are read, against the debate's current seats, so a
// seat that changes hands mid-debate is counted correctly.
//
// Reveal. A round opened under the duel rule (terms rule 'fd-v1') reveals at its
// own cutoff, whatever the debate's recorded mode: results show after each close,
// and replay viewers, who would answer after the result is public, are refused
// (the replay order guard accepts five-day rounds only).
//
// Cut turns. The runtime may void an open turn window with reason 'turn_cut', for
// a turn cut short (a mic, a departing debater, the debate ending): every position
// is refunded in full. Other runtime voids keep their existing rule.
//
// coin_debate_round_guard() starts from 1792984532958_add-turn-window-rules.js and
// coin_debate_round_reveal_mode() from the same migration.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.debate_viewers (
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (debate_id, user_id),
      CHECK (last_seen_at >= first_seen_at)
    );
    CREATE INDEX debate_viewers_recent ON yaparena.debate_viewers (debate_id, last_seen_at);

    CREATE TABLE yaparena.coin_window_viewers (
      round_id uuid NOT NULL REFERENCES yaparena.coin_debate_rounds(id),
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (round_id, user_id)
    );
    CREATE FUNCTION yaparena.coin_window_viewer_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      -- Only while the turn window is open and before its cutoff.
      IF NOT EXISTS (SELECT 1 FROM yaparena.coin_debate_rounds r
          WHERE r.id = NEW.round_id AND r.turn_number IS NOT NULL AND r.state = 'open'
            AND clock_timestamp() >= r.opens_at AND clock_timestamp() < r.closes_at) THEN
        RAISE EXCEPTION 'this window is not open' USING ERRCODE='23514';
      END IF;
      NEW.seen_at := clock_timestamp();
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_window_viewer_guard BEFORE INSERT ON yaparena.coin_window_viewers
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_window_viewer_guard();
    CREATE TRIGGER coin_window_viewer_history BEFORE UPDATE OR DELETE
      ON yaparena.coin_window_viewers
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_round_reveal_mode() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      -- Decision 0017: a duel round reveals at its own cutoff. Otherwise the
      -- debate's recorded mode, never one the inserting code chose.
      NEW.reveal_mode := CASE WHEN NEW.terms->>'rule' = 'fd-v1' THEN 'per_round'
        ELSE COALESCE((SELECT m.mode FROM yaparena.coin_debate_reveal_modes m
          WHERE m.debate_id = NEW.debate_id), 'five_day') END;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_round_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF OLD.state<>'open' OR NEW.state NOT IN ('settled','void')
        OR (to_jsonb(NEW)-ARRAY['state','result','revealed_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['state','result','revealed_at'])
        OR (NEW.state='settled' AND clock_timestamp()<OLD.closes_at)
        -- F11: a five-day round settles only at its debate's 120-hour close.
        OR (NEW.state='settled' AND OLD.reveal_mode='five_day' AND NOT EXISTS (
          SELECT 1 FROM yaparena.debates d WHERE d.id = OLD.debate_id
            AND d.status IN ('ended', 'replay', 'finalized')
            AND d.live_ended_at + INTERVAL '120 hours' <= clock_timestamp()))
        OR (NEW.state='void' AND current_user<>'yaparena_owner' AND NOT (
          (NEW.result->>'voidReason' = 'debate_unavailable' AND EXISTS (
            SELECT 1 FROM yaparena.debates d WHERE d.id = OLD.debate_id
              AND d.status IN ('cancelled', 'void_review')))
          -- Decision 0017: a turn cut short refunds its window.
          OR (NEW.result->>'voidReason' = 'turn_cut' AND OLD.turn_number IS NOT NULL)))
        OR NEW.revealed_at>clock_timestamp() THEN
        RAISE EXCEPTION 'immutable sandbox debate terms or unauthorized outcome' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    REVOKE ALL ON FUNCTION yaparena.coin_window_viewer_guard() FROM PUBLIC;
    ALTER TABLE yaparena.debate_viewers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.coin_window_viewers ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.debate_viewers, yaparena.coin_window_viewers FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.debate_viewers, yaparena.coin_window_viewers
      TO yaparena_runtime;
    GRANT UPDATE (last_seen_at) ON yaparena.debate_viewers TO yaparena_runtime;
    CREATE POLICY sandbox_access ON yaparena.debate_viewers TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.coin_window_viewers TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.debate_viewers, yaparena.coin_window_viewers FROM %I',
          role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.coin_window_viewer_guard() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Sandbox participation history must be retained; forward-fix",
  );
};
