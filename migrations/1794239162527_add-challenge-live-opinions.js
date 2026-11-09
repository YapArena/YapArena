export const shorthands = undefined;

// Live opinions for a challenge (founder, 2026-11-09). The person sending a
// direct challenge may choose per-round reveal: the crowd's opinion on each
// turn shows at its cutoff instead of at the debate's 120-hour close (F11).
// Queue matches and open requests stay five-day.
//
// The challenge keeps the choice; it cannot change after the challenge is
// sent. When the challenge is accepted, the application records per-round for
// the new debate in the same transaction that creates it. The runtime may
// record only that: per-round, for a debate this transaction created and that
// is still scheduled, booked from an accepted per-round challenge. No round can
// exist for a debate no other transaction can see yet. The owner's
// set-reveal-mode path is unchanged.
//
// coin_debate_reveal_mode_guard() starts from 1792984532958_add-turn-window-rules.js.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.match_requests
      ADD COLUMN reveal_mode text NOT NULL DEFAULT 'five_day'
        CHECK (reveal_mode IN ('five_day', 'per_round')),
      ADD CONSTRAINT match_requests_per_round_direct
        CHECK (reveal_mode = 'five_day' OR kind = 'direct');

    CREATE FUNCTION yaparena.match_request_reveal_mode_fixed() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.reveal_mode IS DISTINCT FROM OLD.reveal_mode THEN
        RAISE EXCEPTION 'a challenge keeps its reveal mode' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER match_request_reveal_mode_fixed BEFORE UPDATE OF reveal_mode
      ON yaparena.match_requests
      FOR EACH ROW EXECUTE FUNCTION yaparena.match_request_reveal_mode_fixed();

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_reveal_mode_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.recorded_by <> current_user THEN
        RAISE EXCEPTION 'only the owner records a reveal mode' USING ERRCODE='42501';
      END IF;
      IF current_user = 'yaparena_runtime' THEN
        -- The debate row was written by this transaction and is still scheduled,
        -- so no other transaction can have opened a round for it.
        IF NEW.mode = 'per_round'
          AND EXISTS (SELECT 1 FROM yaparena.debates d
            WHERE d.id = NEW.debate_id AND d.status = 'scheduled'
              AND d.xmin = pg_current_xact_id()::xid)
          AND EXISTS (SELECT 1 FROM yaparena.match_requests r
            WHERE r.debate_id = NEW.debate_id AND r.status = 'accepted'
              AND r.reveal_mode = 'per_round')
          AND NOT EXISTS (SELECT 1 FROM yaparena.coin_debate_rounds
            WHERE debate_id = NEW.debate_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'only the owner records a reveal mode' USING ERRCODE='42501';
      END IF;
      IF current_user <> 'yaparena_owner' THEN
        RAISE EXCEPTION 'only the owner records a reveal mode' USING ERRCODE='42501';
      END IF;
      -- Waits for every uncommitted round insert and blocks new ones until
      -- this commits, so no round can be created with the mode it replaces.
      LOCK TABLE yaparena.coin_debate_rounds IN SHARE ROW EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM yaparena.coin_debate_rounds WHERE debate_id = NEW.debate_id) THEN
        RAISE EXCEPTION 'the reveal mode is locked once a round opens' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    REVOKE ALL ON FUNCTION yaparena.match_request_reveal_mode_fixed() FROM PUBLIC;
    GRANT INSERT ON yaparena.coin_debate_reveal_modes TO yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.match_request_reveal_mode_fixed() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    REVOKE INSERT ON yaparena.coin_debate_reveal_modes FROM yaparena_runtime;
    CREATE OR REPLACE FUNCTION yaparena.coin_debate_reveal_mode_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF current_user <> 'yaparena_owner' OR NEW.recorded_by <> current_user THEN
        RAISE EXCEPTION 'only the owner records a reveal mode' USING ERRCODE='42501';
      END IF;
      LOCK TABLE yaparena.coin_debate_rounds IN SHARE ROW EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM yaparena.coin_debate_rounds WHERE debate_id = NEW.debate_id) THEN
        RAISE EXCEPTION 'the reveal mode is locked once a round opens' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER match_request_reveal_mode_fixed ON yaparena.match_requests;
    DROP FUNCTION yaparena.match_request_reveal_mode_fixed();
    ALTER TABLE yaparena.match_requests
      DROP CONSTRAINT match_requests_per_round_direct,
      DROP COLUMN reveal_mode;
  `);
};
