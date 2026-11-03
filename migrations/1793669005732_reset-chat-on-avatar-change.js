export const shorthands = undefined;

// Chat shows each author's avatar (Decision 0014), so a changed avatar resets
// the rooms where that person wrote, as a changed username already does. The
// function body is 1791335211412's with avatar_id added to the profile check;
// the profile trigger now also fires on avatar_id.
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION yaparena.capture_community_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    DECLARE room uuid; rooms uuid[]; next_cursor bigint; message bigint;
      message_revision bigint; kind text := 'summary';
    BEGIN
      IF TG_TABLE_NAME = 'event_chat_messages' THEN
        IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state
          AND NEW.body IS NOT DISTINCT FROM OLD.body THEN RETURN NEW; END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
        message := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
        message_revision := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision + 1 ELSE NEW.revision END;
        kind := 'message';
      ELSIF TG_TABLE_NAME IN ('event_likes', 'event_chat_controls') THEN
        IF TG_TABLE_NAME = 'event_chat_controls' THEN
          IF TG_OP = 'INSERT' AND NEW.state = 'open' THEN RETURN NEW; END IF;
          IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
        END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
      ELSIF TG_TABLE_NAME = 'debates' THEN
        IF TG_OP = 'UPDATE' AND (NEW.status,NEW.publication_state,NEW.is_demo,NEW.topic_id)
          IS NOT DISTINCT FROM (OLD.status,OLD.publication_state,OLD.is_demo,OLD.topic_id) THEN RETURN NEW; END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      ELSIF TG_TABLE_NAME = 'topics' THEN
        IF NEW.publication_state IS NOT DISTINCT FROM OLD.publication_state THEN RETURN NEW; END IF;
        SELECT array_agg(id ORDER BY id) INTO rooms FROM debates WHERE topic_id = NEW.id;
      ELSIF TG_TABLE_NAME = 'public_profiles' THEN
        IF (NEW.display_name,NEW.publication_state,NEW.avatar_id) IS NOT DISTINCT FROM
          (OLD.display_name,OLD.publication_state,OLD.avatar_id) THEN RETURN NEW; END IF;
        SELECT array_agg(DISTINCT debate_id ORDER BY debate_id) INTO rooms
          FROM event_chat_messages WHERE author_user_id = NEW.user_id;
        kind := 'reset';
      END IF;
      IF room IS NOT NULL THEN rooms := ARRAY[room]; END IF;
      FOREACH room IN ARRAY COALESCE(rooms, ARRAY[]::uuid[]) LOOP
        -- Row update held to COMMIT: the next allocator waits for commit/rollback.
        INSERT INTO community_rooms (room_id,cursor) VALUES (room,1)
          ON CONFLICT (room_id) DO UPDATE SET cursor = community_rooms.cursor + 1
          RETURNING cursor INTO next_cursor;
        IF TG_TABLE_NAME = 'event_chat_messages' AND TG_OP <> 'DELETE' THEN
          NEW.stream_revision := next_cursor;
        END IF;
        INSERT INTO community_room_events (room_id,cursor,kind,message_id,message_revision)
          VALUES (room,next_cursor,kind,message,message_revision);
        PERFORM pg_notify('yaparena_community_v1',room::text);
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER community_capture_profile ON yaparena.public_profiles;
    CREATE TRIGGER community_capture_profile
      AFTER UPDATE OF display_name,publication_state,avatar_id ON yaparena.public_profiles
      FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
  `);
};

export const down = () => {
  throw new Error("Chat delivery triggers are forward-fix only");
};
