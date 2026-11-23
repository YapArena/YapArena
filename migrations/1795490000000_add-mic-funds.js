export const shorthands = undefined;

// Decision 0018, PR 3: keep the asker on, extensions, and the mic's money
// when a debate ends.
//
// A fund (mic_funds) opens with the asker's question turn and with each
// extension question (extq) turn, at the mic's price (X1, X2, X10). Viewers'
// pledges to it (mic_fund_pledges) are holds on their own Yap Coins, like
// question pledges. Reaching the price pays the debaters at once (funded,
// X11); the clock marks a fund that its closing turn ended unfunded as
// closing, and a separate transaction refunds its holds (failed, X7). A
// debate that ends refunds its open funds (refunded, D9) and records that
// its mic money is settled in mic_debate_ends, with the mic turn the end cut
// and whether that turn's window has been refunded.
//
// mic_turns takes the extension turns, which repeat (X8), and mic_pledges
// the refund reason of a question still open when the debate ended (D7).
// Rows only move forward, as in the earlier mic tables.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.mic_turns DROP CONSTRAINT mic_turns_kind_check,
      ADD CONSTRAINT mic_turns_kind_check CHECK (kind IN
        ('question', 'answer', 'followup', 'answer2', 'extq', 'exta', 'resume'));
    ALTER TABLE yaparena.mic_turns DROP CONSTRAINT mic_turns_check2,
      ADD CONSTRAINT mic_turns_text_kind_check
        CHECK (text IS NULL OR kind IN ('question', 'followup', 'extq'));
    -- The four exchange turns and the resume turn run once per mic; the
    -- extension turns as often as they are funded.
    ALTER TABLE yaparena.mic_turns DROP CONSTRAINT mic_turns_mic_id_kind_key;
    CREATE UNIQUE INDEX mic_turns_once ON yaparena.mic_turns (mic_id, kind)
      WHERE kind NOT IN ('extq', 'exta');
    ALTER TABLE yaparena.mic_pledges DROP CONSTRAINT mic_pledges_refund_reason_check,
      ADD CONSTRAINT mic_pledges_refund_reason_check CHECK (refund_reason IN
        ('withdrawn', 'question_removed', 'camp_fired', 'debate_ended'));

    CREATE TABLE yaparena.mic_funds (
      id uuid PRIMARY KEY,
      mic_id uuid NOT NULL REFERENCES yaparena.mic_mics(id),
      debate_id uuid NOT NULL,
      -- The asker's turn it opened with: the question or an extension question.
      opened_turn_number integer NOT NULL CHECK (opened_turn_number >= 1),
      closes_after text NOT NULL CHECK (closes_after IN ('followup', 'extq')),
      price bigint NOT NULL CHECK (price > 0 AND price % 10000 = 0),
      state text NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'closing', 'funded', 'failed', 'refunded')),
      opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (debate_id, opened_turn_number)
        REFERENCES yaparena.mic_turns(debate_id, turn_number),
      UNIQUE (debate_id, opened_turn_number)
    );
    -- One open fund per mic at a time.
    CREATE UNIQUE INDEX mic_funds_one_open ON yaparena.mic_funds (mic_id)
      WHERE state = 'open';
    CREATE INDEX mic_funds_mic ON yaparena.mic_funds (mic_id, opened_turn_number);
    CREATE INDEX mic_funds_closing ON yaparena.mic_funds (debate_id)
      WHERE state = 'closing';

    CREATE TABLE yaparena.mic_fund_pledges (
      id uuid PRIMARY KEY,
      fund_id uuid NOT NULL REFERENCES yaparena.mic_funds(id),
      user_id bigint NOT NULL REFERENCES yaparena.users(id),
      -- What the viewer asked to pledge, and what was held: the rest of the
      -- price when they asked for more (X12).
      requested bigint NOT NULL CHECK (requested > 0 AND requested % 10000 = 0),
      amount bigint NOT NULL
        CHECK (amount > 0 AND amount % 10000 = 0 AND amount <= requested),
      state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'paid', 'refunded')),
      -- Unfunded when its turn ended (X7), or the debate ended (D9).
      refund_reason text CHECK (refund_reason IN ('fund_closed', 'debate_ended')),
      funding jsonb NOT NULL CHECK (jsonb_typeof(funding) = 'object'),
      -- The client's request id, hashed with the account (idempotency).
      request_id text NOT NULL UNIQUE CHECK (request_id ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((state = 'refunded') = (refund_reason IS NOT NULL))
    );
    CREATE INDEX mic_fund_pledges_fund ON yaparena.mic_fund_pledges (fund_id);
    CREATE INDEX mic_fund_pledges_user ON yaparena.mic_fund_pledges (user_id);

    CREATE TABLE yaparena.mic_debate_ends (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id),
      -- The mic turn running when the debate ended, its window refunded
      -- after the cleanup commits.
      cut_turn_number integer,
      cut_void text CHECK (cut_void IN ('pending', 'done', 'refused')),
      settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (debate_id, cut_turn_number)
        REFERENCES yaparena.mic_turns(debate_id, turn_number),
      CHECK ((cut_turn_number IS NULL) = (cut_void IS NULL))
    );
    CREATE INDEX mic_debate_ends_pending_void ON yaparena.mic_debate_ends (debate_id)
      WHERE cut_void = 'pending';

    CREATE FUNCTION yaparena.mic_fund_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_TABLE_NAME = 'mic_funds' THEN
        IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state')
          OR NOT ((OLD.state = 'open' AND NEW.state IN ('closing', 'funded', 'refunded'))
            OR (OLD.state = 'closing' AND NEW.state IN ('failed', 'refunded'))) THEN
          RAISE EXCEPTION 'mic funds only move forward' USING ERRCODE='23514';
        END IF;
      ELSIF TG_TABLE_NAME = 'mic_fund_pledges' THEN
        IF (to_jsonb(NEW) - ARRAY['state', 'refund_reason'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'refund_reason'])
          OR NOT (OLD.state = 'held' AND NEW.state IN ('paid', 'refunded')) THEN
          RAISE EXCEPTION 'mic funds only move forward' USING ERRCODE='23514';
        END IF;
      ELSIF (to_jsonb(NEW) - 'cut_void') IS DISTINCT FROM (to_jsonb(OLD) - 'cut_void')
        OR NOT (OLD.cut_void = 'pending' AND NEW.cut_void IN ('done', 'refused')) THEN
        RAISE EXCEPTION 'mic funds only move forward' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER mic_fund_state BEFORE UPDATE ON yaparena.mic_funds
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_fund_guard();
    CREATE TRIGGER mic_fund_pledge_state BEFORE UPDATE ON yaparena.mic_fund_pledges
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_fund_guard();
    CREATE TRIGGER mic_debate_end_state BEFORE UPDATE ON yaparena.mic_debate_ends
      FOR EACH ROW EXECUTE FUNCTION yaparena.mic_fund_guard();

    REVOKE ALL ON FUNCTION yaparena.mic_fund_guard() FROM PUBLIC;
    ALTER TABLE yaparena.mic_funds ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_fund_pledges ENABLE ROW LEVEL SECURITY;
    ALTER TABLE yaparena.mic_debate_ends ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.mic_funds, yaparena.mic_fund_pledges,
      yaparena.mic_debate_ends FROM PUBLIC;
    GRANT SELECT, INSERT ON yaparena.mic_funds, yaparena.mic_fund_pledges,
      yaparena.mic_debate_ends TO yaparena_runtime;
    GRANT UPDATE (state) ON yaparena.mic_funds TO yaparena_runtime;
    GRANT UPDATE (state, refund_reason) ON yaparena.mic_fund_pledges TO yaparena_runtime;
    GRANT UPDATE (cut_void) ON yaparena.mic_debate_ends TO yaparena_runtime;
    CREATE POLICY sandbox_access ON yaparena.mic_funds TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_fund_pledges TO yaparena_runtime
      USING (true) WITH CHECK (true);
    CREATE POLICY sandbox_access ON yaparena.mic_debate_ends TO yaparena_runtime
      USING (true) WITH CHECK (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.mic_funds, yaparena.mic_fund_pledges,
          yaparena.mic_debate_ends FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.mic_fund_guard() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

// The ledger keeps every hold, refund and payment as journals and book
// events. Going down drops the funds and puts the earlier constraints back,
// which fails while extension turns or debate-end refunds exist.
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE yaparena.mic_debate_ends;
    DROP TABLE yaparena.mic_fund_pledges;
    DROP TABLE yaparena.mic_funds;
    DROP FUNCTION yaparena.mic_fund_guard();
    ALTER TABLE yaparena.mic_pledges DROP CONSTRAINT mic_pledges_refund_reason_check,
      ADD CONSTRAINT mic_pledges_refund_reason_check CHECK (refund_reason IN
        ('withdrawn', 'question_removed', 'camp_fired'));
    DROP INDEX yaparena.mic_turns_once;
    ALTER TABLE yaparena.mic_turns ADD CONSTRAINT mic_turns_mic_id_kind_key UNIQUE (mic_id, kind);
    ALTER TABLE yaparena.mic_turns DROP CONSTRAINT mic_turns_text_kind_check,
      ADD CONSTRAINT mic_turns_check2 CHECK (text IS NULL OR kind IN ('question', 'followup'));
    ALTER TABLE yaparena.mic_turns DROP CONSTRAINT mic_turns_kind_check,
      ADD CONSTRAINT mic_turns_kind_check CHECK (kind IN
        ('question', 'answer', 'followup', 'answer2', 'resume'));
  `);
};
