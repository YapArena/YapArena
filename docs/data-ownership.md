# Data ownership

Which module owns each table in the `yaparena` schema, which other modules also
write it, and which read it. Recorded from `src/` at `6b076ce` (2026-10-23) by
searching SQL for each live table from `migrations/`. This map documents the
current code; it does not change any query.

The owner is the module that creates the rows and maintains them. "Writes" means
`INSERT`, `UPDATE` or `DELETE` from another module. "Reads" lists other modules
that query the table directly in SQL, including joins and `EXISTS` checks;
calling the owner's functions (for example `assertActiveSession` or
`lockAccount` from `platform/auth`) is not listed. Operator, seed and verifier
scripts under `scripts/` are out of scope.

Module names are directories under `src/features/`, plus `platform/auth`.

## Cross-module access

| Table                                        | Owner         | Also written by                                      | Read by                                                                |
| -------------------------------------------- | ------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `users`                                      | platform/auth | —                                                    | account-wallet, matching, media                                        |
| `sessions`                                   | platform/auth | —                                                    | media                                                                  |
| `identity_audit_events`                      | platform/auth | identity (deletes events after 90 days)              | identity                                                               |
| `public_profiles`                            | identity      | —                                                    | community, discovery, matching, measurement                            |
| `follows`                                    | identity      | —                                                    | measurement                                                            |
| `account_roles`                              | identity      | — (assigned by migrations and scripts)               | media                                                                  |
| `topics`                                     | matching      | —                                                    | a4, account-wallet, community, discovery, identity, measurement, media |
| `debates`                                    | matching      | media (live end and automatic replay status)         | a4, account-wallet, community, discovery, measurement, media           |
| `event_participants`                         | matching      | media (deactivates participants when an event ends)  | community, measurement, media                                          |
| `event_history`                              | matching      | media (live and replay transitions)                  | —                                                                      |
| `match_requests`                             | matching      | —                                                    | measurement                                                            |
| `account_notifications`                      | matching      | community, platform/auth                             | —                                                                      |
| `account_device_checks`                      | media         | —                                                    | matching (live queue entry)                                            |
| `debate_media`                               | media         | —                                                    | account-wallet (turn windows), discovery, matching, measurement        |
| `community_rooms`                            | community     | media (replay completion creates and locks the room) | media                                                                  |
| `moderation_cases`                           | community     | —                                                    | measurement                                                            |
| `a4_rounds`, `a4_sessions`, `a4_submissions` | a4            | —                                                    | discovery (homepage ordering by settled premium)                       |

`debates` and `topics` are defined by the public discovery migration, but
discovery only reads them; matching creates topics and events and runs the
scheduling lifecycle.

## Tables used only by their owner

| Owner          | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform/auth  | `provider_identities`, `account_operations`, `auth_controls`, `auth_login_transactions`, `auth_pending_links`                                                                                                                                                                                                                                                                                                                                 |
| matching       | `event_rule_versions`, `matchmaking_tickets`, `match_offers` (resolved queue rows are deleted after 30 days)                                                                                                                                                                                                                                                                                                                                  |
| media          | `media_device_checks`, `media_replay_jobs`, `media_replay_attempts`, `media_account_grants`, `media_account_revocations`                                                                                                                                                                                                                                                                                                                      |
| community      | `community_audit_events`, `community_restrictions`, `community_room_events`, `community_submission_receipts`, `event_chat_controls`, `event_chat_messages`, `event_likes`, `event_like_changes`, `moderation_appeals`                                                                                                                                                                                                                         |
| measurement    | `product_measurement_affiliations`, `product_measurement_affiliation_audit`, `product_measurement_consents`, `product_measurement_events`, `product_measurement_watch_sessions`                                                                                                                                                                                                                                                               |
| a4             | `a4_accounts`, `a4_audit`, `a4_controls`, `a4_journals`, `a4_postings`, `a4_public_publishers`, `a4_requests`, `a4_synthetic_debates`, `a4_synthetic_rounds`                                                                                                                                                                                                                                                                                  |
| account-wallet | `coin_accounts`, `coin_debate_orders`, `coin_debate_rounds`, `coin_external_receipts`, `coin_grant_lots`, `coin_grant_profit_events`, `coin_journals`, `coin_nonce_reservations`, `coin_postings`, `coin_sandbox_books`, `coin_sandbox_controls`, `coin_sandbox_events`, `coin_sandbox_openings`, `coin_sandbox_report_events`, `coin_sandbox_reports`, `coin_sandbox_requests`, `coin_sandbox_system_accounts`, `coin_sandbox_webhook_inbox` |
| messages       | `messages`                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Tables with no runtime queries

These live tables are not queried from `src/`:

- `account_subjects` (platform/auth): retired-account history, maintained by
  migrations and referenced by foreign keys and the test-account reset script.
- `a4_assets` (a4): asset rows seeded by the A4 migration.
- `coin_sandbox_webhook_outcomes` (account-wallet): written by the sandbox
  operator script.
- `sponsors`: created by the public discovery migration and unused.

The legacy sign-in tables, including `wallet_identities`, were dropped by the
legacy sign-in and Privy schema removal migrations and no longer exist.
