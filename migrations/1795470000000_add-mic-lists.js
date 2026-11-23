export const shorthands = undefined;

// Decision 0018: borrow the microphone, the list and its holds.
//
// A debate's list (mic_lists) takes viewers' questions (mic_questions). Each
// question carries its author's wager and other viewers' pledges (mic_pledges);
// every pledge is a hold on the pledger's own Yap Coins in the coin ledger, its
// exact sources kept in funding. A camp's #1 fires once per list (mic_mics):
// its pledges are paid to the debaters and the camp's other questions refunded.
//
// Rows only move forward: a list from open to closed, a question from open,
// a pledge from held, a mic from queued to live to done. Nothing else in a row
// changes after it is written, and the runtime cannot delete one.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.mic_lists (
      id uuid PRIMARY KEY,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      n integer NOT NULL CHECK (n >= 1),
      extra boolean NOT NULL DEFAULT false,
      state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      opened_round integer NOT NULL CHECK (opened_round >= 1),
      opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (debate_id, n),
      UNIQUE (id, debate_id)
    );
    -- One open list per debate.
    CREATE UNIQUE INDEX mic_lists_open ON yaparena.mic_lists (debate_id)
      WHERE state = 'open';

    CREATE TABLE yaparena.mic_questions (
      id uuid PRIMARY KEY,
      list_id uuid NOT NULL,
      debate_id uuid NOT NULL,
      author_id bigint NOT NULL REFERENCES yaparena.users(id),
      target text NOT NULL CHECK (target IN ('A', 'B')),
      body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
      seq bigint NOT NULL CHECK (seq >= 1),
      state text NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'fired', 'removed', 'refunded')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (list_id, debate_id) REFERENCES yaparena.mic_lists(id, debate_id),
      UNIQUE (list_id, seq)
    );
    -- L21: one open question per viewer per list.
    CREATE UNIQUE INDEX mic_questions_one_open ON yaparena.mic_questions (list_id, author_id)
      WHERE state = 'open';
    CREATE INDEX mic_questions_debate ON yaparena.mic_questions (debate_id);

    CREATE TABLE yaparena.mic_pledges (
      id uuid PRIMARY KEY,
      question_id uuid NOT NULL REFERENCES yaparena.mic_questions(id),
      user_id bigint NOT NULL REFERENCES yaparena.users(id),
      amount bigint NOT NULL CHECK (amount > 0 AND amount % 10000 = 0),
      wager boolean NOT NULL,
      add_text text CHECK (add_text IS NULL OR char_length(add_text) BETWEEN 1 AND 200),
      state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'paid', 'refunded')),
      -- Why a refunded pledge was refunded: its own withdrawal, its question's
      -- wager withdrawn, or another question of its camp fired (L11, L14, L20).
      refund_reason text CHECK (refund_reason IN ('withdrawn', 'question_removed', 'camp_fired')),
      funding jsonb NOT NULL CHECK (jsonb_typeof(funding) = 'object'),
      -- The client's request id, hashed with the account (idempotency).
      request_id text NOT NULL UNIQUE CHECK (request_id ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((state = 'refunded') = (refund_reason IS NOT NULL)),
      CHECK (NOT wager OR add_text IS NULL)
    );
    -- One wager per question.
    CREATE UNIQUE INDEX mic_pledges_one_wager ON yaparena.mic_pledges (question_id)
      WHERE wager;
    CREATE INDEX mic_pledges_user ON yaparena.mic_pledges (user_id);

    CREATE TABLE yaparena.mic_mics (
      id uuid PRIMARY KEY,
      list_id uuid NOT NULL,
      debate_id uuid NOT NULL,
      camp text NOT NULL CHECK (camp IN ('A', 'B')),
      question_id uuid NOT NULL UNIQUE REFERENCES yaparena.mic_questions(id),
      holder_id bigint NOT NULL REFERENCES yaparena.users(id),
      target text NOT NULL CHECK (target IN ('A', 'B')),
      state text NOT NULL CHECK (state IN ('queued', 'live', 'done')),
      price bigint NOT NULL CHECK (price > 0 AND price % 10000 = 0),
      request_id text NOT NULL UNIQUE CHECK (request_id ~ '^[0-9a-f]{64}$'),
      fired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (list_id, debate_id) REFERENCES yaparena.mic_lists(id, debate_id),
      -- L10: one mic per camp per list.
      UNIQUE (list_id, camp),
      CHECK (camp <> target)
    );
    -- F12: one mic live at a time in a debate.
    CREATE UNIQUE INDEX mic_mics_one_live ON yaparena.mic_mics (debate_id)
      WHERE state = 'live';

    CREATE FUNCTION yaparena.mic_state_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF (to_jsonb(NEW) - ARRAY['state', 'refund_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'refund_reason'])
        OR NOT (
          (TG_TABLE_NAME = 'mic_lists' AND OLD.state = 'open' AND NEW.state = 'closed')
          OR (TG_TABLE_NAME = 'mic_questions' AND OLD.state = 'open'
            AND NEW.state IN ('fired', 'removed', 'refunded'))
          OR (TG_TABLE_NAME = 'mic_pledges' AND OLD.state = 'held'
            AND NEW.state IN ('paid', 'refunded'))
          OR (TG_TABLE_NAME = 'mic_mics' AND ((OLD.state = 'queued' AND NEW.state IN ('live', 'done'))
            OR (OLD.state = 'live' AND NEW.state = 'done')))) THEN
        RAISE EXCEPTION 'mic rows only move forward' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER mic_list_state BEFORE UPDATE ON yaparena.mic_lists
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_state_guard();
    CREATE TRIGGER mic_question_state BEFORE UPDATE ON yaparena.mic_questions
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_state_guard();
    CREATE TRIGGER mic_pledge_state BEFORE UPDATE ON yaparena.mic_pledges
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_state_guard();
    CREATE TRIGGER mic_mic_state BEFORE UPDATE ON yaparena.mic_mics
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_state_guard();

    REVOKE ALL ON FUNCTION yaparena.mic_state_guard() FROM PUBLIC;
    ALTER TABLE yaparena.mic_lists ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_questions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_pledges ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_mics ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.mic_lists, yaparena.mic_questions, yaparena.mic_pledges,
      yaparena.mic_mics FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.mic_lists, yaparena.mic_questions,
      yaparena.mic_pledges, yaparena.mic_mics TO yaparena_runtime;
    GRANT UPDATE (state) ON yaparena.mic_lists, yaparena.mic_questions,
      yaparena.mic_mics TO yaparena_runtime;
    GRANT UPDATE (state, refund_reason) ON yaparena.mic_pledges TO yaparena_runtime;
    CREATE POLICY sandbox_access ON yaparena.mic_lists TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_questions TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_pledges TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_mics TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.mic_lists, yaparena.mic_questions,
          yaparena.mic_pledges, yaparena.mic_mics FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.mic_state_guard() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

// The ledger keeps every hold, refund and payment as journals and book
// events, so dropping these tables loses only the list's own records.
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE yaparena.mic_mics;
    DROP TABLE yaparena.mic_pledges;
    DROP TABLE yaparena.mic_questions;
    DROP TABLE yaparena.mic_lists;
    DROP FUNCTION yaparena.mic_state_guard();
  `);
};
