export const shorthands = undefined;

// The replay encoder (src/replay-worker.ts) logs in as its own role instead
// of yaparena_runtime. Provisioning creates the login; this migration grants
// only what the encoder's queries and the triggers its publication fires
// need. "*" is the whole table; a list is those columns only.
//
// - Its queue: media_replay_jobs and media_replay_attempts.
// - Eligibility reads, and row locks for publication: debate_media, debates,
//   topics. Lock-only UPDATE grants pair with a policy that refuses every
//   write (WITH CHECK (false)).
// - Publication: debates.status from ended to replay, its event_history row,
//   and the community delivery cursor the lifecycle triggers advance. Those
//   triggers run with the encoder's privileges.
// - The applied migration list, read at startup.
export const encoderRole = "yaparena_encoder";
export const encoderGrants = Object.freeze({
  media_replay_jobs: {
    select: "*",
    insert: ["id", "debate_id", "source_key", "caption_hash"],
    update: [
      "state",
      "attempts",
      "next_attempt_at",
      "lease_id",
      "lease_expires_at",
      "package_key",
      "source_etag",
      "manifest_digest",
      "failure_code",
      "updated_at",
    ],
    delete: true,
  },
  media_replay_attempts: {
    select: "*",
    insert: ["id", "job_id", "package_key", "protect_until"],
    update: [
      "state",
      "protect_until",
      "cleanup_after",
      "cleanup_token",
      "cleanup_lease_at",
    ],
    delete: true,
  },
  debate_media: {
    select: [
      "debate_id",
      "state",
      "recording_status",
      "egress_id",
      "recording_key",
      "captions_vtt",
    ],
    update: ["debate_id"], // FOR UPDATE lock only
  },
  debates: {
    select: ["id", "topic_id", "status", "publication_state", "is_demo"],
    update: ["status", "updated_at"],
  },
  topics: {
    select: ["id", "publication_state"],
    update: ["id"], // FOR SHARE lock only
  },
  event_history: {
    insert: ["debate_id", "action", "from_status", "to_status", "reason"],
  },
  community_rooms: {
    select: ["room_id", "cursor"],
    insert: ["room_id", "cursor"],
    update: ["cursor"],
  },
  community_room_events: {
    insert: [
      "room_id",
      "cursor",
      "kind",
      "message_id",
      "message_revision",
      "refresh",
    ],
  },
});
export const encoderSequences = Object.freeze(["event_history_id_seq"]);

const columns = (list) => `(${list.join(", ")})`;
export function encoderGrantClauses(spec) {
  const clauses = [];
  if (spec.select)
    clauses.push(
      spec.select === "*" ? "SELECT" : `SELECT ${columns(spec.select)}`,
    );
  if (spec.insert)
    clauses.push(
      spec.insert === "*" ? "INSERT" : `INSERT ${columns(spec.insert)}`,
    );
  if (spec.update) clauses.push(`UPDATE ${columns(spec.update)}`);
  if (spec.delete) clauses.push("DELETE");
  return clauses.join(", ");
}

// A room with a replay job. Completion locks the room before it re-checks the
// job, so a job cancelled meanwhile still gets its quiet rollback.
const replayRoom = (column) =>
  `EXISTS (SELECT 1 FROM yaparena.media_replay_jobs j WHERE j.debate_id = ${column})`;
const eligibleMedia =
  "state = 'ended' AND recording_status = 'ready' AND egress_id IS NOT NULL";
const eligibleEvent =
  "publication_state = 'published' AND NOT is_demo AND status IN ('ended','replay','finalized')";

export const up = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF current_user <> 'yaparena_owner' THEN
      RAISE EXCEPTION 'Use the separately provisioned migration identity';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yaparena_encoder') THEN
      RAISE EXCEPTION 'Provision the yaparena_encoder identity first'
        USING HINT = 'Run scripts/provision-database.ts with DATABASE_ENCODER_PASSWORD, then migrate again.';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yaparena_encoder'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolcanlogin))
      OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE
        m.member = 'yaparena_encoder'::regrole OR
        (m.roleid = 'yaparena_encoder'::regrole AND NOT EXISTS (SELECT 1 FROM pg_roles administrator
            WHERE administrator.oid = m.member AND administrator.rolname = 'postgres'
              AND (administrator.rolsuper OR administrator.rolcreaterole)
              AND m.admin_option
              AND NOT COALESCE((to_jsonb(m)->>'inherit_option')::boolean, true)
              AND NOT COALESCE((to_jsonb(m)->>'set_option')::boolean, true)))) THEN
      RAISE EXCEPTION 'Encoder role attributes or memberships are unsafe';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'yaparena'::regnamespace
      AND relname IN (${Object.keys(encoderGrants)
        .map((table) => `'${table}'`)
        .join(",")}) AND NOT relrowsecurity) THEN
      RAISE EXCEPTION 'Row level security is off on a table the encoder uses';
    END IF;
  END $$`);

  // Start from nothing, so a grant made before this migration cannot widen it.
  pgm.sql(`DO $$ DECLARE object record; BEGIN
    FOR object IN SELECT c.relname, c.relkind FROM pg_class c
      WHERE c.relnamespace = 'yaparena'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') LOOP
      EXECUTE format('REVOKE ALL ON %s yaparena.%I FROM yaparena_encoder',
        CASE WHEN object.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, object.relname);
    END LOOP;
  END $$`);
  pgm.sql(
    "REVOKE ALL ON ALL ROUTINES IN SCHEMA yaparena, yaparena_migrations FROM yaparena_encoder",
  );
  pgm.sql(
    "REVOKE ALL ON yaparena_migrations.pgmigrations FROM yaparena_encoder",
  );

  pgm.sql(
    "GRANT USAGE ON SCHEMA yaparena, yaparena_migrations TO yaparena_encoder",
  );
  pgm.sql(
    "GRANT SELECT ON yaparena_migrations.pgmigrations TO yaparena_encoder",
  );
  for (const [table, spec] of Object.entries(encoderGrants))
    pgm.sql(
      `GRANT ${encoderGrantClauses(spec)} ON yaparena.${table} TO yaparena_encoder`,
    );
  for (const sequence of encoderSequences)
    pgm.sql(`GRANT USAGE ON SEQUENCE yaparena.${sequence} TO yaparena_encoder`);

  // The guard checked that every table above has row level security on.
  // These policies name only the encoder and add nothing for any other role.
  pgm.sql(`
    CREATE POLICY encoder_queue ON yaparena.media_replay_jobs TO yaparena_encoder
      USING (true) WITH CHECK (true);
    CREATE POLICY encoder_retention_delete ON yaparena.media_replay_jobs AS RESTRICTIVE
      FOR DELETE TO yaparena_encoder USING (state = 'cancelled'
        AND updated_at < clock_timestamp() - INTERVAL '30 days');
    CREATE POLICY encoder_queue ON yaparena.media_replay_attempts TO yaparena_encoder
      USING (true) WITH CHECK (true);
    CREATE POLICY encoder_retention_delete ON yaparena.media_replay_attempts AS RESTRICTIVE
      FOR DELETE TO yaparena_encoder USING (state = 'cleaned' AND EXISTS (
        SELECT 1 FROM yaparena.media_replay_jobs j WHERE j.id = job_id AND j.state = 'cancelled'
          AND j.updated_at < clock_timestamp() - INTERVAL '30 days'));

    CREATE POLICY encoder_read ON yaparena.debate_media FOR SELECT TO yaparena_encoder
      USING (${eligibleMedia});
    CREATE POLICY encoder_lock ON yaparena.debate_media FOR UPDATE TO yaparena_encoder
      USING (${eligibleMedia}) WITH CHECK (false);
    CREATE POLICY encoder_read ON yaparena.topics FOR SELECT TO yaparena_encoder
      USING (publication_state = 'published');
    CREATE POLICY encoder_lock ON yaparena.topics FOR UPDATE TO yaparena_encoder
      USING (publication_state = 'published') WITH CHECK (false);
    CREATE POLICY encoder_read ON yaparena.debates FOR SELECT TO yaparena_encoder
      USING (${eligibleEvent});
    CREATE POLICY encoder_publish ON yaparena.debates FOR UPDATE TO yaparena_encoder
      USING (${eligibleEvent})
      WITH CHECK (publication_state = 'published' AND NOT is_demo AND status = 'replay');
    CREATE POLICY encoder_publish ON yaparena.event_history FOR INSERT TO yaparena_encoder
      WITH CHECK (debate_id IS NOT NULL AND request_id IS NULL AND actor_user_id IS NULL
        AND action = 'automatic_replay' AND from_status = 'ended' AND to_status = 'replay');

    CREATE POLICY encoder_read ON yaparena.community_rooms FOR SELECT TO yaparena_encoder
      USING (${replayRoom("community_rooms.room_id")});
    CREATE POLICY encoder_open ON yaparena.community_rooms FOR INSERT TO yaparena_encoder
      WITH CHECK (cursor <= 1 AND ${replayRoom("community_rooms.room_id")});
    CREATE POLICY encoder_advance ON yaparena.community_rooms FOR UPDATE TO yaparena_encoder
      USING (${replayRoom("community_rooms.room_id")})
      WITH CHECK (${replayRoom("community_rooms.room_id")});
    CREATE POLICY encoder_signal ON yaparena.community_room_events FOR INSERT TO yaparena_encoder
      WITH CHECK (kind = 'summary' AND message_id IS NULL AND message_revision IS NULL
        AND (refresh IS NULL OR refresh = 'media')
        AND ${replayRoom("community_room_events.room_id")});
  `);

  // Row policies cannot compare old and new values. The encoder only ever
  // publishes a verified replay, so its one status change is ended -> replay.
  pgm.sql(`
    CREATE FUNCTION yaparena.guard_encoder_publication() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      IF OLD.status = 'ended' AND NEW.status = 'replay' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'the replay encoder may only move an ended event to replay'
        USING ERRCODE = '42501';
    END $$;
    REVOKE ALL ON FUNCTION yaparena.guard_encoder_publication() FROM PUBLIC;
    CREATE TRIGGER encoder_publication_guard BEFORE UPDATE ON yaparena.debates
      FOR EACH ROW WHEN (current_user = 'yaparena_encoder')
      EXECUTE FUNCTION yaparena.guard_encoder_publication();
  `);
  pgm.sql(`DO $$ DECLARE role_name text; BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION yaparena.guard_encoder_publication() FROM %I', role_name);
    END LOOP;
  END $$`);
};

export const down = () => {
  throw new Error(
    "Keep the encoder role's grants on rollback; use a reviewed forward fix",
  );
};
