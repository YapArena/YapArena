export const shorthands = undefined;

// Decision 0012 (pull request 1b): the founder's market rules for Yap Coins
// debate rounds.
//
// F11 reveal mode. A debate is five-day (the default, and the only mode of a
// user-created debate) or per-round. Only the owner records per-round, for a
// founder-created debate, before the debate's first round: the first round
// locks the mode. Each round copies its debate's mode when it is created, so
// the mode is fixed per round like its cutoff. A five-day round takes orders
// until its cutoff, then stays open but locked; it prices and settles only at
// the debate's 120-hour close (the live end plus 120 elapsed hours). Rounds
// created before this migration revealed at their cutoff and stay per-round.
//
// A five-day manual round stays open after its cutoff, so the one-open-manual-
// round index now covers per-round rounds only. For five-day rounds the
// application, under the coin transition lock, opens a new manual round only
// when none is still taking orders.
//
// F14: a debater cannot take a position in their own debate.
//
// coin_debate_round_guard() starts from 1792971645611_add-turn-trading-windows.js
// and coin_debate_order_guard() from 1792426006100_add-coin-debate-rounds.js.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.coin_debate_reveal_modes (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id),
      mode text NOT NULL CHECK (mode IN ('five_day', 'per_round')),
      reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
      recorded_by text NOT NULL DEFAULT current_user,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE FUNCTION yaparena.coin_debate_reveal_mode_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF current_user <> 'yaparena_owner' OR NEW.recorded_by <> current_user THEN
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
    CREATE TRIGGER coin_debate_reveal_mode_guard BEFORE INSERT ON yaparena.coin_debate_reveal_modes
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_debate_reveal_mode_guard();
    CREATE TRIGGER coin_debate_reveal_mode_history BEFORE UPDATE OR DELETE
      ON yaparena.coin_debate_reveal_modes
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    ALTER TABLE yaparena.coin_debate_rounds
      ADD COLUMN reveal_mode text NOT NULL DEFAULT 'per_round'
        CHECK (reveal_mode IN ('five_day', 'per_round'));
    ALTER TABLE yaparena.coin_debate_rounds ALTER COLUMN reveal_mode SET DEFAULT 'five_day';
    CREATE FUNCTION yaparena.coin_debate_round_reveal_mode() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      -- The debate's recorded mode, never one the inserting code chose.
      NEW.reveal_mode := COALESCE((SELECT m.mode FROM yaparena.coin_debate_reveal_modes m
        WHERE m.debate_id = NEW.debate_id), 'five_day');
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_debate_round_reveal_mode BEFORE INSERT ON yaparena.coin_debate_rounds
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_debate_round_reveal_mode();

    DROP INDEX yaparena.coin_debate_open;
    CREATE UNIQUE INDEX coin_debate_open ON yaparena.coin_debate_rounds(debate_id)
      WHERE state = 'open' AND turn_number IS NULL AND reveal_mode = 'per_round';

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
          NEW.result->>'voidReason' = 'debate_unavailable' AND EXISTS (
            SELECT 1 FROM yaparena.debates d WHERE d.id = OLD.debate_id
              AND d.status IN ('cancelled', 'void_review'))))
        OR NEW.revealed_at>clock_timestamp() THEN
        RAISE EXCEPTION 'immutable sandbox debate terms or unauthorized outcome' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_order_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM yaparena.coin_debate_rounds WHERE id=NEW.round_id
        AND state='open' AND clock_timestamp()>=opens_at AND clock_timestamp()<closes_at) THEN
        RAISE EXCEPTION 'sandbox debate is past cutoff' USING ERRCODE='23514';
      END IF;
      -- F14: debaters may not take a position in their own debate.
      IF EXISTS (SELECT 1 FROM yaparena.coin_debate_rounds r
          JOIN yaparena.debates d ON d.id = r.debate_id
          JOIN yaparena.public_profiles p
            ON p.id IN (d.speaker_a_profile_id, d.speaker_b_profile_id)
          WHERE r.id = NEW.round_id AND p.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'debaters cannot take a position in their own debate' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    REVOKE ALL ON FUNCTION yaparena.coin_debate_reveal_mode_guard(),
      yaparena.coin_debate_round_reveal_mode() FROM PUBLIC;
    ALTER TABLE yaparena.coin_debate_reveal_modes ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.coin_debate_reveal_modes FROM PUBLIC;
    GRANT SELECT ON yaparena.coin_debate_reveal_modes TO yaparena_runtime;
    CREATE POLICY sandbox_access ON yaparena.coin_debate_reveal_modes TO yaparena_runtime
      USING (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.coin_debate_reveal_modes FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.coin_debate_reveal_mode_guard(),
          yaparena.coin_debate_round_reveal_mode() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Sandbox participation history must be retained; forward-fix",
  );
};
