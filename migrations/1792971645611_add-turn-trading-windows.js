export const shorthands = undefined;

// Decision 0012: during a live debate each speaking turn is one Yap Coins
// trading window. The coin loop opens it with the turn's deadline as its
// cutoff, which never moves (a paused turn keeps its window's cutoff). Rounds
// stay immutable: the existing update guard compares every column except the
// outcome, so the new turn columns are fixed at creation like the cutoff.
//
// Manual five-minute rounds keep their own one-open-per-debate rule, so a
// manual round opened before the debate went live cannot hold back its first
// turn windows. Each (debate, turn) has at most one window.
//
// The coin loop also voids open rounds of a cancelled or under-review debate.
// The runtime may void only those, with reason debate_unavailable; every other
// void stays an owner command.
//
// Opening, settling and voiding a round now emit a reference-only 'window'
// room signal (docs/community-delivery.md). capture_room_signal() below starts
// from 1792817943415_publish-media-and-round-room-events.js and adds only the
// coin_debate_rounds branch.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.coin_debate_rounds
      ADD COLUMN turn_number integer CHECK (turn_number IS NULL OR turn_number >= 1),
      ADD COLUMN turn_side text CHECK (turn_side IS NULL OR turn_side IN ('A', 'B')),
      ALTER COLUMN creator_id DROP NOT NULL,
      ADD CONSTRAINT coin_debate_round_origin CHECK (
        (turn_number IS NULL AND turn_side IS NULL AND creator_id IS NOT NULL)
        OR (turn_number IS NOT NULL AND turn_side IS NOT NULL AND creator_id IS NULL));
    DROP INDEX yaparena.coin_debate_open;
    CREATE UNIQUE INDEX coin_debate_open ON yaparena.coin_debate_rounds(debate_id)
      WHERE state = 'open' AND turn_number IS NULL;
    CREATE UNIQUE INDEX coin_debate_turn_window
      ON yaparena.coin_debate_rounds(debate_id, turn_number) WHERE turn_number IS NOT NULL;
    CREATE INDEX coin_debate_open_by_debate ON yaparena.coin_debate_rounds(debate_id)
      WHERE state = 'open';

    CREATE OR REPLACE FUNCTION yaparena.coin_debate_round_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF OLD.state<>'open' OR NEW.state NOT IN ('settled','void')
        OR (to_jsonb(NEW)-ARRAY['state','result','revealed_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['state','result','revealed_at'])
        OR (NEW.state='settled' AND clock_timestamp()<OLD.closes_at)
        OR (NEW.state='void' AND current_user<>'yaparena_owner' AND NOT (
          NEW.result->>'voidReason' = 'debate_unavailable' AND EXISTS (
            SELECT 1 FROM yaparena.debates d WHERE d.id = OLD.debate_id
              AND d.status IN ('cancelled', 'void_review'))))
        OR NEW.revealed_at>clock_timestamp() THEN
        RAISE EXCEPTION 'immutable sandbox debate terms or unauthorized outcome' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    ALTER TABLE yaparena.community_room_events
      DROP CONSTRAINT community_room_events_refresh,
      ADD CONSTRAINT community_room_events_refresh
        CHECK (refresh IS NULL OR (kind = 'summary' AND message_id IS NULL
          AND refresh IN ('media', 'round', 'activity', 'window'))) NOT VALID;
    ALTER TABLE yaparena.community_room_events
      VALIDATE CONSTRAINT community_room_events_refresh;

    CREATE OR REPLACE FUNCTION yaparena.capture_room_signal() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    DECLARE room uuid; rooms uuid[]; projection text; next_cursor bigint;
      run_owner record; signalled text; entry text;
    BEGIN
      IF TG_TABLE_NAME = 'debate_media' THEN
        -- Only columns in the public media snapshot produce a signal.
        IF TG_OP = 'UPDATE' AND (NEW.state, NEW.active_side, NEW.turn_number,
            NEW.turn_deadline_at, NEW.remaining_ms, NEW.active_ms, NEW.last_resumed_at,
            NEW.revision, NEW.recording_status, NEW.captions_vtt IS NULL)
          IS NOT DISTINCT FROM (OLD.state, OLD.active_side, OLD.turn_number,
            OLD.turn_deadline_at, OLD.remaining_ms, OLD.active_ms, OLD.last_resumed_at,
            OLD.revision, OLD.recording_status, OLD.captions_vtt IS NULL) THEN
          RETURN NULL;
        END IF;
        projection := 'media';
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
      ELSIF TG_TABLE_NAME = 'debates' THEN
        -- The media snapshot also reports the event status and replay publication.
        IF (NEW.status, NEW.publication_state, NEW.is_demo)
          IS NOT DISTINCT FROM (OLD.status, OLD.publication_state, OLD.is_demo) THEN
          RETURN NULL;
        END IF;
        projection := 'media';
        room := NEW.id;
      ELSIF TG_TABLE_NAME = 'a4_rounds' THEN
        IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL; END IF;
        SELECT s.debate_id, s.mode, s.creator_id INTO run_owner
          FROM a4_sessions s WHERE s.id = NEW.session_id;
        IF run_owner.mode = 'human' THEN
          -- Human-only rounds are shared with every signed-in viewer of the debate.
          projection := 'round';
        ELSIF NEW.state = 'settled' AND EXISTS (
            SELECT 1 FROM a4_public_publishers p WHERE p.user_id = run_owner.creator_id) THEN
          -- A private sandbox is silent until a consenting creator's result is public.
          projection := 'activity';
        ELSE
          RETURN NULL;
        END IF;
        room := run_owner.debate_id;
      ELSIF TG_TABLE_NAME = 'a4_sessions' THEN
        IF NEW.mode <> 'human' OR (TG_OP = 'UPDATE'
            AND NEW.state IS NOT DISTINCT FROM OLD.state) THEN
          RETURN NULL;
        END IF;
        projection := 'round';
        room := NEW.debate_id;
      ELSIF TG_TABLE_NAME = 'a4_public_publishers' THEN
        -- Consent adds or removes settled sandbox results in each affected room.
        projection := 'activity';
        SELECT array_agg(DISTINCT s.debate_id ORDER BY s.debate_id) INTO rooms
          FROM a4_sessions s
          WHERE s.creator_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END
            AND s.mode IN ('mixed', 'observer')
            AND EXISTS (SELECT 1 FROM a4_rounds r WHERE r.session_id = s.id AND r.state = 'settled');
      ELSIF TG_TABLE_NAME = 'a4_synthetic_rounds' THEN
        projection := 'activity';
        room := NEW.debate_id;
      ELSIF TG_TABLE_NAME = 'coin_debate_rounds' THEN
        -- A Yap Coins round or turn window opened, settled or was voided. The
        -- signal carries only its timing; viewers re-read the window list.
        IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
          RETURN NULL;
        END IF;
        projection := 'window';
        room := NEW.debate_id;
      END IF;
      IF room IS NOT NULL THEN rooms := ARRAY[room]; END IF;
      -- Clients re-read the current projection, so one signal per room and
      -- projection covers a whole transaction. The list is transaction-local.
      signalled := COALESCE(current_setting('yaparena.room_signals', true), '');
      FOREACH room IN ARRAY COALESCE(rooms, ARRAY[]::uuid[]) LOOP
        entry := projection || ':' || room::text || ';';
        CONTINUE WHEN position(entry IN signalled) > 0;
        signalled := signalled || entry;
        -- Row update held to COMMIT: the next allocator waits for commit/rollback.
        INSERT INTO community_rooms (room_id, cursor) VALUES (room, 1)
          ON CONFLICT (room_id) DO UPDATE SET cursor = community_rooms.cursor + 1
          RETURNING cursor INTO next_cursor;
        INSERT INTO community_room_events (room_id, cursor, kind, refresh)
          VALUES (room, next_cursor, 'summary', projection);
        PERFORM pg_notify('yaparena_community_v1', room::text);
      END LOOP;
      PERFORM set_config('yaparena.room_signals', signalled, true);
      RETURN NULL;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.capture_room_signal() FROM PUBLIC;

    -- Settlement and voiding hold account, book and ledger locks; the room
    -- counter is still taken last, at COMMIT.
    CREATE CONSTRAINT TRIGGER room_signal_coin_round
      AFTER INSERT OR UPDATE OF state ON yaparena.coin_debate_rounds
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
  `);
};

export const down = () => {
  throw new Error(
    "Sandbox participation history and the room log are retained; forward-fix",
  );
};
