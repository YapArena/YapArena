export const shorthands = undefined;

// Decision 0012 (pull request 1c): replay joining (F10).
//
// recording_clocks keeps the wall-clock instant a debate's recording file
// starts, as LiveKit reports it when the recording completes. A turn window's
// span in the recording is then [opens_at, closes_at] minus that instant, in
// whole milliseconds and never below zero.
//
// From a five-day debate's live end until its 120-hour close, a viewer may
// join a turn window after its live cutoff by giving the replay position they
// are watching. The position must lie inside that window's span, and the
// viewer must not already hold a position in a later turn's window of the
// debate: replay viewers never return to earlier rounds. Per-round debates,
// manual rounds and live debates take live positions only. A replay order
// records its position (coin_debate_orders.replay_position_ms).
//
// coin_debate_order_guard() starts from 1792978459788_add-turn-window-rules.js.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.recording_clocks (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id),
      egress_id text NOT NULL CHECK (length(egress_id) BETWEEN 1 AND 100),
      started_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER recording_clock_history BEFORE UPDATE OR DELETE ON yaparena.recording_clocks
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    ALTER TABLE yaparena.coin_debate_orders
      ADD COLUMN replay_position_ms integer
        CHECK (replay_position_ms IS NULL OR replay_position_ms >= 0);

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_order_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE round yaparena.coin_debate_rounds%ROWTYPE;
    BEGIN
      SELECT * INTO round FROM yaparena.coin_debate_rounds WHERE id = NEW.round_id;
      IF NEW.replay_position_ms IS NULL THEN
        IF NOT FOUND OR round.state <> 'open' OR clock_timestamp() < round.opens_at
          OR clock_timestamp() >= round.closes_at THEN
          RAISE EXCEPTION 'sandbox debate is past cutoff' USING ERRCODE='23514';
        END IF;
      ELSE
        -- F10: the window playing at that replay position, between the live
        -- end and the 120-hour close of a five-day debate.
        IF NOT FOUND OR round.state <> 'open' OR round.turn_number IS NULL
          OR round.reveal_mode <> 'five_day' OR clock_timestamp() < round.closes_at
          OR NOT EXISTS (SELECT 1 FROM yaparena.debates d WHERE d.id = round.debate_id
            AND d.status IN ('ended', 'replay', 'finalized')
            AND d.live_ended_at + INTERVAL '120 hours' > clock_timestamp())
          OR NOT EXISTS (SELECT 1 FROM yaparena.recording_clocks c
            WHERE c.debate_id = round.debate_id
              AND NEW.replay_position_ms BETWEEN
                greatest(0, floor(extract(epoch FROM round.opens_at - c.started_at) * 1000))
                AND floor(extract(epoch FROM round.closes_at - c.started_at) * 1000)) THEN
          RAISE EXCEPTION 'this window is not playing at that replay position' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM yaparena.coin_debate_orders o
            JOIN yaparena.coin_debate_rounds later ON later.id = o.round_id
            WHERE later.debate_id = round.debate_id AND o.user_id = NEW.user_id
              AND later.turn_number > round.turn_number) THEN
          RAISE EXCEPTION 'a later turn''s window was already joined' USING ERRCODE='23514';
        END IF;
      END IF;
      -- F14: debaters may not take a position in their own debate.
      IF EXISTS (SELECT 1 FROM yaparena.debates d
          JOIN yaparena.public_profiles p
            ON p.id IN (d.speaker_a_profile_id, d.speaker_b_profile_id)
          WHERE d.id = round.debate_id AND p.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'debaters cannot take a position in their own debate' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    ALTER TABLE yaparena.recording_clocks ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.recording_clocks FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.recording_clocks TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.recording_clocks TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.recording_clocks FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Sandbox participation history must be retained; forward-fix",
  );
};
