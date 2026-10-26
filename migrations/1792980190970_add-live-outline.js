export const shorthands = undefined;

// Decision 0012, pull request 3: the live AI outline.
//
// outline_versions holds every accepted live version of a debate's outline:
// version numbers are contiguous per debate (outline_heads keeps the head
// under a row lock), so a browser applies version N+1 from LiveKit or asks for
// what it missed. Each row stores the turn's whole outline and the canonical
// edits that produced it. The application keeps an outline within 8 KB of
// JSON; the 16 KB checks are a backstop (jsonb's text form adds spaces).
//
// outline_windows records, per trading window, the version traders saw at the
// cutoff (frozen) and later the window's final outline (the cleanup pass, or
// the frozen one when no cleanup arrives in time).
//
// outline_flags lets a debater mark an outline item of their own turn as a
// mistake; it is public.
//
// Freezing, finalizing and flagging emit a reference-only 'outline' room
// signal. capture_room_signal() starts from
// 1792971645611_add-turn-trading-windows.js and adds only that branch.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.outline_heads (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id),
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE yaparena.outline_versions (
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      version integer NOT NULL CHECK (version >= 1),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      window_id uuid REFERENCES yaparena.coin_debate_rounds(id),
      in_window boolean NOT NULL,
      outline jsonb NOT NULL CHECK (jsonb_typeof(outline) = 'object'
        AND octet_length(outline::text) <= 16384),
      edits jsonb NOT NULL CHECK (jsonb_typeof(edits) = 'array'),
      model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
      span_start_ms integer NOT NULL CHECK (span_start_ms >= 0),
      span_end_ms integer NOT NULL CHECK (span_end_ms >= span_start_ms),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (debate_id, version)
    );
    CREATE INDEX outline_versions_turn
      ON yaparena.outline_versions(debate_id, turn_number, version DESC);
    CREATE INDEX outline_versions_age ON yaparena.outline_versions(created_at);

    CREATE TABLE yaparena.outline_windows (
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      window_id uuid NOT NULL UNIQUE REFERENCES yaparena.coin_debate_rounds(id),
      frozen_version integer,
      frozen_outline jsonb NOT NULL CHECK (octet_length(frozen_outline::text) <= 16384),
      frozen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      final_outline jsonb CHECK (final_outline IS NULL OR octet_length(final_outline::text) <= 16384),
      final_source text CHECK (final_source IN ('cleanup', 'frozen')),
      final_model text CHECK (final_model IS NULL OR length(final_model) BETWEEN 1 AND 100),
      finalized_at timestamptz,
      PRIMARY KEY (debate_id, turn_number),
      FOREIGN KEY (debate_id, frozen_version)
        REFERENCES yaparena.outline_versions(debate_id, version),
      CHECK ((final_outline IS NULL) = (final_source IS NULL)
        AND (final_outline IS NULL) = (finalized_at IS NULL))
    );

    CREATE TABLE yaparena.outline_flags (
      id bigserial PRIMARY KEY,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      item_id text NOT NULL CHECK (item_id ~ '^t[1-9][0-9]{0,4}a[1-9][0-9]{0,2}(p[1-9][0-9]{0,2})?$'),
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      side text NOT NULL CHECK (side IN ('A', 'B')),
      note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 280),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (debate_id, item_id, user_id)
    );

    -- Live versions and flags are append-only. A window's record changes only
    -- once: its final outline is set, after which it is fixed.
    CREATE FUNCTION yaparena.outline_append_only() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path = pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      -- Nested: PL/pgSQL does not short-circuit AND, and only outline_windows
      -- has these columns.
      IF TG_TABLE_NAME = 'outline_windows' AND TG_OP = 'UPDATE' THEN
        IF OLD.final_outline IS NULL AND NEW.final_outline IS NOT NULL
            AND (to_jsonb(NEW) - ARRAY['final_outline','final_source','final_model','finalized_at'])
              = (to_jsonb(OLD) - ARRAY['final_outline','final_source','final_model','finalized_at']) THEN
          RETURN NEW;
        END IF;
      END IF;
      RAISE EXCEPTION 'outline history is append-only' USING ERRCODE = '23514';
    END $$;
    REVOKE ALL ON FUNCTION yaparena.outline_append_only() FROM PUBLIC;
    CREATE TRIGGER outline_versions_append_only BEFORE UPDATE ON yaparena.outline_versions
      FOR EACH ROW EXECUTE FUNCTION yaparena.outline_append_only();
    CREATE TRIGGER outline_windows_append_only BEFORE UPDATE OR DELETE ON yaparena.outline_windows
      FOR EACH ROW EXECUTE FUNCTION yaparena.outline_append_only();
    CREATE TRIGGER outline_flags_append_only BEFORE UPDATE ON yaparena.outline_flags
      FOR EACH ROW EXECUTE FUNCTION yaparena.outline_append_only();

    ALTER TABLE yaparena.community_room_events
      DROP CONSTRAINT community_room_events_refresh,
      ADD CONSTRAINT community_room_events_refresh
        CHECK (refresh IS NULL OR (kind = 'summary' AND message_id IS NULL
          AND refresh IN ('media', 'round', 'activity', 'window', 'outline'))) NOT VALID;
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
      ELSIF TG_TABLE_NAME IN ('outline_windows', 'outline_flags') THEN
        -- A window's outline was frozen or finalized, or a debater flagged
        -- an outline item. Live outline edits travel over LiveKit instead.
        projection := 'outline';
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

    CREATE CONSTRAINT TRIGGER room_signal_outline_window
      AFTER INSERT OR UPDATE OF final_outline ON yaparena.outline_windows
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
    CREATE CONSTRAINT TRIGGER room_signal_outline_flag
      AFTER INSERT ON yaparena.outline_flags
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();

    GRANT SELECT, INSERT, UPDATE ON yaparena.outline_heads TO yaparena_runtime;
    GRANT SELECT, INSERT, DELETE ON yaparena.outline_versions TO yaparena_runtime;
    GRANT SELECT, INSERT, UPDATE (final_outline, final_source, final_model, finalized_at)
      ON yaparena.outline_windows TO yaparena_runtime;
    GRANT SELECT, INSERT, DELETE ON yaparena.outline_flags TO yaparena_runtime;
    GRANT USAGE ON SEQUENCE yaparena.outline_flags_id_seq TO yaparena_runtime;

    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.outline_append_only() FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.capture_room_signal() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
  for (const table of [
    "outline_heads",
    "outline_versions",
    "outline_windows",
    "outline_flags",
  ])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING (true) WITH CHECK (true)`);
};

export const down = () => {
  throw new Error("Outline history is retained; forward-fix");
};
