export const shorthands = undefined;

// Decision 0015 (D4): the founder's review of which side of a topic answers yes.
//
// Side A answers yes to the topic's question. For topics created before that rule
// was printed on the forms, the founder records each review here, from the list
// printed by scripts/topic-answer-sides.ts. The latest row of a topic wins.
// A topic whose latest review says side A is not the yes side shows its figure as
// plain Yes and No, without side labels; stored side labels are never swapped.
//
// Reviews are insert-only records. Only the owner inserts them; the runtime only
// reads them, and browser roles have no access.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.topic_answer_reviews (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      topic_id uuid NOT NULL REFERENCES yaparena.topics(id),
      side_a_is_yes boolean NOT NULL,
      reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
      reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX topic_answer_reviews_topic
      ON yaparena.topic_answer_reviews (topic_id, id);
    CREATE FUNCTION yaparena.topic_answer_review_history() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      RAISE EXCEPTION 'topic answer reviews are insert-only' USING ERRCODE='23514';
    END $$;
    CREATE TRIGGER topic_answer_review_history
      BEFORE UPDATE OR DELETE ON yaparena.topic_answer_reviews
      FOR EACH ROW EXECUTE FUNCTION yaparena.topic_answer_review_history();
    REVOKE ALL ON FUNCTION yaparena.topic_answer_review_history() FROM PUBLIC;

    ALTER TABLE yaparena.topic_answer_reviews ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.topic_answer_reviews FROM PUBLIC;
    GRANT SELECT ON yaparena.topic_answer_reviews TO yaparena_runtime;
    CREATE POLICY backend_access ON yaparena.topic_answer_reviews
      FOR SELECT TO yaparena_runtime USING (true);
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.topic_answer_reviews FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.topic_answer_review_history() FROM %I',
          role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error("Topic answer reviews must be retained; forward-fix");
};
