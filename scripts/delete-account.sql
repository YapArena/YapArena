-- Owner runbook step (YA-08): delete one suspended account's personal data.
-- See docs/operations.md#delete-an-account. Run it inside an interactive owner
-- session, not with psql -f (which would end the session and roll it back):
--   psql "$DATABASE_URL" -v id=<account id>
--   \i scripts/delete-account.sql
-- It stops unless the account is suspended, and it ends without COMMIT:
-- review the output, then type COMMIT; to keep it or ROLLBACK; to undo it.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog, yaparena, pg_temp;
SELECT count(*) = 1 AS suspended FROM users
 WHERE id = :id AND account_status = 'suspended' \gset
\if :suspended
\else
  \echo 'Stopped: this account is not suspended. Run scripts/suspend-account.ts first.'
  ROLLBACK;
  \quit
\endif
SELECT id FROM users WHERE id = :id FOR UPDATE;
-- Note these Auth0 subjects, then delete those users in the Auth0 dashboard.
SELECT subject FROM provider_identities WHERE user_id = :id;
-- Sign-in identities and their email addresses.
DELETE FROM provider_identities WHERE user_id = :id;
-- A profile that appears in a debate cannot be deleted, so it is replaced.
UPDATE public_profiles
   SET handle = 'deleted-' || substr(md5(id::text), 1, 12),
       display_name = 'Deleted account', bio = NULL,
       publication_state = 'hidden', updated_at = clock_timestamp()
 WHERE user_id = :id;
INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
VALUES (:id, 'account.deleted', :'id',
        jsonb_build_object('actorDatabaseRole', current_user, 'outcome', 'success'));
-- Sessions, settings, follows, notifications, consents, measurement events,
-- transcript segments and the other personal rows go with the account.
DELETE FROM users WHERE id = :id;
\echo 'Review the output above, then type COMMIT; to keep it or ROLLBACK; to undo it.'
