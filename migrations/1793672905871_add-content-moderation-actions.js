export const shorthands = undefined;

// Moderators hide and restore topics, profiles and debates in the app (YA-07). Each change is
// a content action that keeps the state it replaced, so restoring returns the item to it. Its
// audit event joins the community audit trail beside case events, and goes with the action.
// Actions are pruned after 365 days like resolved cases, except each item's latest one.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.content_moderation_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_type text NOT NULL CHECK (target_type IN ('topic', 'profile', 'debate')),
      target_id uuid NOT NULL,
      action text NOT NULL CHECK (action IN ('hide', 'unhide')),
      from_state varchar(12) NOT NULL CHECK (from_state IN ('draft', 'published', 'hidden')),
      to_state varchar(12) NOT NULL CHECK (to_state IN ('draft', 'published', 'hidden')),
      reason_code varchar(20) CHECK (reason_code IN
        ('harassment', 'hate', 'threat', 'spam', 'privacy', 'other')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT content_moderation_actions_hide CHECK (action <> 'hide' OR
        (to_state = 'hidden' AND from_state <> 'hidden' AND reason_code IS NOT NULL)),
      CONSTRAINT content_moderation_actions_unhide CHECK (action <> 'unhide' OR
        (from_state = 'hidden' AND to_state <> 'hidden' AND reason_code IS NULL))
    );
    CREATE INDEX content_moderation_actions_target
      ON yaparena.content_moderation_actions (target_type, target_id, created_at DESC, id DESC);
    CREATE INDEX content_moderation_actions_created
      ON yaparena.content_moderation_actions (created_at, id);
    ALTER TABLE yaparena.community_audit_events
      ALTER COLUMN case_id DROP NOT NULL,
      ADD COLUMN content_action_id uuid
        REFERENCES yaparena.content_moderation_actions(id) ON DELETE CASCADE,
      ADD CONSTRAINT community_audit_events_subject
        CHECK (num_nonnulls(case_id, content_action_id) = 1);
    CREATE INDEX community_audit_events_content_action
      ON yaparena.community_audit_events (content_action_id)
      WHERE content_action_id IS NOT NULL;
    GRANT SELECT, INSERT, DELETE ON yaparena.content_moderation_actions TO yaparena_runtime;
    ALTER TABLE yaparena.content_moderation_actions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_access ON yaparena.content_moderation_actions TO yaparena_runtime
      USING (true) WITH CHECK (true);
  `);
};

export const down = () => {
  throw new Error("Content moderation actions are audit records; forward-fix");
};
