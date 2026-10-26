export const shorthands = undefined;

// Decision 0012, pull request 2: live transcription of the active speaker.
//
// debater_settings is account-level: the language a debater speaks (French
// or English) and their consent to transcription and the public AI outline.
// Matchmaking checks it at queue entry and challenge acceptance.
//
// transcription_dispatches records the one transcriber agent dispatch per
// debate, so warm-up at readiness and the call at start never dispatch twice.
//
// transcription_updates is the ingest receipt per (debate, agent job,
// sequence): a retried update returns its first answer and stores nothing.
// Receipts only matter while a job runs and are pruned after seven days.
//
// transcript_segments is append-only: one row per final segment and provider,
// with word timings, the trading window its speech ended in (null when it
// ended after the window's cutoff or no window exists), and provider latency
// and audio length for the provider comparison. Shadow-provider rows never
// drive the outline. Rows are deleted only by retention or account deletion.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.debater_settings (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      language text NOT NULL CHECK (language IN ('fr', 'en')),
      consent_version text CHECK (consent_version IS NULL OR consent_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      consented_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((consent_version IS NULL) = (consented_at IS NULL))
    );

    CREATE TABLE yaparena.transcription_dispatches (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id),
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'failed')),
      dispatch_id text CHECK (dispatch_id IS NULL OR length(dispatch_id) <= 200),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (state <> 'dispatched' OR dispatch_id IS NOT NULL)
    );

    CREATE TABLE yaparena.transcription_updates (
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      job_id text NOT NULL CHECK (job_id ~ '^[A-Za-z0-9_-]{1,100}$'),
      sequence integer NOT NULL CHECK (sequence >= 0),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      response jsonb NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (debate_id, job_id, sequence)
    );
    CREATE INDEX transcription_updates_age ON yaparena.transcription_updates(accepted_at);

    CREATE TABLE yaparena.transcript_segments (
      id bigserial PRIMARY KEY,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      turn_number integer NOT NULL CHECK (turn_number >= 1),
      window_id uuid REFERENCES yaparena.coin_debate_rounds(id),
      side text NOT NULL CHECK (side IN ('A', 'B')),
      speaker_user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      language text NOT NULL CHECK (language IN ('fr', 'en')),
      provider text NOT NULL CHECK (provider IN ('deepgram', 'elevenlabs')),
      role text NOT NULL CHECK (role IN ('primary', 'shadow')),
      job_id text NOT NULL,
      sequence integer NOT NULL,
      segment_index smallint NOT NULL CHECK (segment_index BETWEEN 0 AND 49),
      spoken_start_at timestamptz NOT NULL,
      spoken_end_at timestamptz NOT NULL,
      text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
      words jsonb NOT NULL CHECK (jsonb_typeof(words) = 'array'),
      latency_ms integer CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
      audio_ms integer NOT NULL CHECK (audio_ms BETWEEN 0 AND 600000),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (spoken_end_at >= spoken_start_at),
      UNIQUE (debate_id, job_id, sequence, segment_index)
    );
    CREATE INDEX transcript_segments_turn ON yaparena.transcript_segments(debate_id, turn_number, spoken_start_at);
    CREATE INDEX transcript_segments_speaker ON yaparena.transcript_segments(speaker_user_id);
    CREATE INDEX transcript_segments_age ON yaparena.transcript_segments(created_at);

    CREATE FUNCTION yaparena.transcript_append_only() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path = pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      RAISE EXCEPTION 'transcripts and ingest receipts are append-only' USING ERRCODE = '23514';
    END $$;
    REVOKE ALL ON FUNCTION yaparena.transcript_append_only() FROM PUBLIC;
    CREATE TRIGGER transcript_segments_append_only BEFORE UPDATE ON yaparena.transcript_segments
      FOR EACH ROW EXECUTE FUNCTION yaparena.transcript_append_only();
    CREATE TRIGGER transcription_updates_append_only BEFORE UPDATE ON yaparena.transcription_updates
      FOR EACH ROW EXECUTE FUNCTION yaparena.transcript_append_only();

    GRANT SELECT, INSERT, UPDATE ON yaparena.debater_settings TO yaparena_runtime;
    GRANT SELECT, INSERT, UPDATE ON yaparena.transcription_dispatches TO yaparena_runtime;
    GRANT SELECT, INSERT, DELETE ON yaparena.transcription_updates, yaparena.transcript_segments
      TO yaparena_runtime;
    GRANT USAGE ON SEQUENCE yaparena.transcript_segments_id_seq TO yaparena_runtime;

    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.transcript_append_only() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
  for (const table of [
    "debater_settings",
    "transcription_dispatches",
    "transcription_updates",
    "transcript_segments",
  ])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING (true) WITH CHECK (true)`);
};

export const down = () => {
  throw new Error("Transcripts and consent records are retained; forward-fix");
};
