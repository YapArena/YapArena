export const shorthands = undefined;

// Every topic has one category from the founder's list (2026-11-06; Decision 0003).
// The ids are stored and served; the browser shows their names
// (src/features/discovery/topic-categories.ts, which must keep this list).
// Existing topics take the default, 'other'. Adding a category later needs a
// new migration that replaces the checks below.
//
// The creator picks the category when creating a topic; afterwards only the
// owner changes it, with scripts/set-topic-category.ts and a reason. The
// runtime keeps its table-level UPDATE on topics for publication, so a trigger
// refuses a category change by any other role. Each change is kept in
// topic_category_changes, which only the owner reads and writes, and goes with
// its topic when a topic is deleted.
const categories = [
  "politics",
  "society",
  "cities",
  "technology",
  "work",
  "climate",
  "education",
  "economy",
  "other",
];
export const topicCategories = Object.freeze(categories);
const list = categories.map((category) => `'${category}'`).join(", ");

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.topics ADD COLUMN category varchar(20) NOT NULL DEFAULT 'other'
      CONSTRAINT topics_category CHECK (category IN (${list}));
    CREATE INDEX topics_published_category
      ON yaparena.topics (category, created_at DESC, id DESC)
      WHERE publication_state = 'published';

    CREATE TABLE yaparena.topic_category_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      topic_id uuid NOT NULL REFERENCES yaparena.topics(id) ON DELETE CASCADE,
      from_category varchar(20) NOT NULL CHECK (from_category IN (${list})),
      to_category varchar(20) NOT NULL CHECK (to_category IN (${list})),
      reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
      recorded_by text NOT NULL DEFAULT current_user,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT topic_category_changes_change CHECK (from_category <> to_category)
    );
    CREATE INDEX topic_category_changes_topic
      ON yaparena.topic_category_changes (topic_id, created_at, id);

    CREATE FUNCTION yaparena.topic_category_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF current_user <> 'yaparena_owner' THEN
        RAISE EXCEPTION 'only the owner changes a topic category' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER topic_category_guard BEFORE UPDATE OF category ON yaparena.topics
      FOR EACH ROW WHEN (OLD.category IS DISTINCT FROM NEW.category)
      EXECUTE FUNCTION yaparena.topic_category_guard();

    CREATE FUNCTION yaparena.topic_category_change_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'topic category changes are append-only' USING ERRCODE='42501';
      END IF;
      IF current_user <> 'yaparena_owner' OR NEW.recorded_by <> current_user THEN
        RAISE EXCEPTION 'only the owner records a topic category change' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER topic_category_change_guard BEFORE INSERT OR UPDATE
      ON yaparena.topic_category_changes
      FOR EACH ROW EXECUTE FUNCTION yaparena.topic_category_change_guard();

    REVOKE ALL ON FUNCTION yaparena.topic_category_guard(),
      yaparena.topic_category_change_guard() FROM PUBLIC;
    ALTER TABLE yaparena.topic_category_changes ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.topic_category_changes FROM PUBLIC;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.topic_category_changes FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.topic_category_guard(),
          yaparena.topic_category_change_guard() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Topic categories and their changes are records; forward-fix",
  );
};
