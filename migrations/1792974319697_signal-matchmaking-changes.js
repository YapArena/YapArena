export const shorthands = undefined;

// Per-user live queue updates (Decision 0011). A change to a player's ticket or offer notifies
// `yaparena_user_v1` with only the player's user id, at commit. The web process re-reads that
// player's state and pushes it to their open streams. Presence updates touch neither column list,
// so they send nothing.
export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION yaparena.signal_matchmaking_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      IF TG_TABLE_NAME = 'matchmaking_tickets' THEN
        PERFORM pg_notify('yaparena_user_v1', NEW.user_id::text);
      ELSE
        PERFORM pg_notify('yaparena_user_v1', NEW.user_a_id::text);
        PERFORM pg_notify('yaparena_user_v1', NEW.user_b_id::text);
      END IF;
      RETURN NULL;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.signal_matchmaking_change() FROM PUBLIC;

    CREATE TRIGGER matchmaking_tickets_signal
      AFTER INSERT OR UPDATE OF status, closed_reason, debate_id
      ON yaparena.matchmaking_tickets
      FOR EACH ROW EXECUTE FUNCTION yaparena.signal_matchmaking_change();
    CREATE TRIGGER match_offers_signal
      AFTER INSERT OR UPDATE OF status, accepted_a_at, accepted_b_at
      ON yaparena.match_offers
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
  throw new Error("Matchmaking change signals are retained; forward-fix");
};
