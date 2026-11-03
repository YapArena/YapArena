# Server-only database boundary (F04)

F04 remains an open P0 deployment gate until the hosted checks below are recorded. Local SQL
verification and a documented requirement to disable the Data API do not prove hosted isolation.
Express continues to authenticate users and authorize their actions; Supabase hosts PostgreSQL.

## Identities and ownership

`yaparena_owner` is the dedicated migration login and owns application objects. It has no
superuser, BYPASSRLS, CREATEDB, CREATEROLE or replication attributes. Administrative provisioning
creates it; ordinary migrations cannot create roles. Only a controlled administrative operator may
be a member of this role. Never grant it to runtime, browser roles, `authenticator`, or a shared
application group.

`yaparena_runtime` is a distinct login with no elevated attributes, object ownership or membership
in another role. PostgreSQL 16+ gives its creator an inbound ADMIN-only membership. Provisioning,
migration and startup accept this only for the existing `postgres` administrator, with ADMIN true
and INHERIT/SET explicitly false. Every other inbound grant and every outbound runtime grant is
rejected. Missing option fields on older PostgreSQL versions fail closed.
Startup checks the real session/current user, ownership, membership, schema
CREATE, and read-only migration metadata access before accepting traffic. Web and worker processes
receive **only this identity's `DATABASE_URL`**. They reject known provisioning, migration,
inspection and fixture secrets in their environment.

`yaparena_encoder` is the replay encoder's login (security audit finding YA-15), under the same
attribute, membership, ownership and CREATE rules as runtime. Migration
`1793675904690_add-replay-encoder-role` grants it the replay queue, column reads of published,
finished events, their topics and ready recordings, the `ended` to `replay` status change with its
`event_history` row, and the community delivery cursor that publication's triggers advance. Its
policies name only this role; lock-only UPDATE grants on `topics` and `debate_media` pair with
policies that refuse every write, and a trigger limits its status change to `ended` to `replay`.
At startup the encoder also refuses any privilege outside that set, so the runtime URL or a grant
made by hand stops it before it claims jobs. It receives only its own `DATABASE_URL`. This guard does not discover arbitrary secret
names: operators must also inspect the actual service secret configuration and mounted files.

Repository application tables, their owned sequences/indexes and trigger functions live
in `yaparena`. Migration history lives in `yaparena_migrations.pgmigrations`. Neither private schema
may appear in hosted exposed schemas. Application connections and trigger functions use
`pg_catalog, yaparena, pg_temp`; provider/public objects cannot shadow application table names.

The additive `1791158400000_isolate_server_database` migration resets schema, relation, sequence,
column and routine ACLs within these two application-only schemas, including PUBLIC, browser,
service and inherited-group grants. It does not change provider-owned `auth`, `storage`, `realtime`,
`extensions`, `graphql*` or shared `public` objects/defaults. Administrative provisioning adopts
only the explicit repository manifest. Unexpected duplicates, object kinds or external view
dependencies stop provisioning for review. Inventory first; resolve ambiguous or extra application
objects explicitly rather than extending this script to every object owned by `postgres`.

Provisioning preserves Supabase's standard `authenticator` broker grant to `service_role`: a direct
SET-only grant with ADMIN/INHERIT disabled, a NOINHERIT broker, and the normal non-login service
role attributes. Browser `anon`/`authenticated` escalation and broker access to owner/runtime or
other privileged roles remain rejected. Extra indirect routes or altered grant flags stop the
operation. Existing tables and routines move to their private schema before ownership transfer;
the migration owner never needs CREATE in `public`.

Runtime table grants follow actual repository queries in the migration's `runtimeGrants` manifest.
They exclude TRUNCATE, REFERENCES, TRIGGER, grant options and arbitrary DDL. `users` grants UPDATE
on `id` for row locking and, through F03, on `auth_generation` for session revocation;
password/email changes are not granted. The original manifest is extended by later additive migrations.
`sponsors` currently has no runtime grant. Sequence USAGE supports generated IDs without permitting
`setval`. Runtime can only SELECT migration metadata and cannot use its sequence.

The current database-level PUBLIC TEMPORARY grant still permits runtime to create temporary
objects. Persistent application/schema/role DDL is denied, but this is not an absolute DDL ban.
Before closing the strict no-DDL acceptance item, review a scoped database-level TEMPORARY change
and explicit grants needed by provider identities. Do not revoke a shared provider database grant
without reviewing its operational effects.

All application tables have RLS enabled. Existing community/measurement RLS remains enabled.
Policies explicitly target `yaparena_runtime`, with USING and WITH CHECK permitting the backend's
authorized queries. `account_roles` allows reads and insertion of only `participant`, supporting
the assignment trigger without enabling runtime operator/moderator assignment. Operator role
provisioning remains a separate controlled owner operation. Existing table owners bypass RLS when
performing migrations; runtime never bypasses it. FORCE status is inventoried, not used as a
substitute for identity separation. Application trigger functions remain SECURITY INVOKER with fixed search
paths and no externally callable EXECUTE grants. Runtime's data privileges allow their audit and
completion writes; no SECURITY DEFINER bypass is introduced.

A compromised runtime process still has the backend's granted data permissions. This separation
protects schema/role administration and direct browser access, not application data against arbitrary
execution inside the trusted backend. Express's ownership and role checks remain necessary.

## Inventory before and after a release

Provide `DATABASE_INSPECTION_URL` through a protected operator environment, then run:

```sh
npm run inventory:database > /secure/evidence/database-privileges.json
```

The executable uses a read-only transaction and
`scripts/database-privilege-inventory.sql` (PostgreSQL 17+). It exports catalog identifiers, role
attributes, direct/effective memberships, schema privileges, relation/column/sequence/routine ACLs,
effective browser/runtime grants, owners, RLS/FORCE/policies, view and catalog routine dependencies,
SECURITY DEFINER status/search paths, explicit defaults and base defaults for every observed object
creator, publications and extensions. It reads every non-system schema, including provider schemas.
It exports no application rows, URLs, passwords, arbitrary role settings or routine bodies; policy
string literals are redacted and routine bodies hashed. Treat even sanitized catalog evidence as
internal operational information.

SQL catalogs cannot enumerate all access paths hidden in dynamic SQL, string routine bodies,
external services or Edge Functions. Review every callable SECURITY DEFINER routine's source in a
controlled session, including provider routines, and record whether it can reach application data.
Review public/inherited grants and views outside the private schemas. `pg_depend` covers view
dependencies and parsed routine dependencies; absence of a routine dependency is not proof its
body cannot access data. Provider-owned access paths require a separately approved, scoped fix.
The provisioning external-view check is a stop condition, not a comprehensive routine analyzer.

Only `yaparena_owner` may create future application objects. Historical provider/admin creators and
their defaults remain visible in the inventory but are not modified globally. Do not create new
application objects with Dashboard `postgres`; its defaults can differ from the migration role.

## Fresh installation and existing-schema upgrade

Before upgrading an existing hosted installation, obtain separate authorization, back up and
restore-test it, stop traffic/background jobs, and record a pre-change inventory. Provisioning moves
objects and migration history before migrations run; old application binaries that query `public`
cannot run through this transition. Keep the application stopped until hardening and checks pass.

Use a privileged administrative **operator process**, separate from the migration job and web/worker.
Supply `DATABASE_ADMIN_URL`, `DATABASE_OWNER_PASSWORD`, `DATABASE_RUNTIME_PASSWORD` and
`DATABASE_ENCODER_PASSWORD` through its
secret manager, and run `node scripts/provision-database.ts`. Passwords must be distinct, strong and
URL-encoded when constructing connection URLs outside this script. PostgreSQL statement/audit
logging must redact provisioning passwords; use the provider's approved password-setting procedure
if your administrative session logs full CREATE ROLE statements. The script neither prints passwords
nor rotates existing ones. Existing unsafe identities cause failure; inspect and repair them under
separate authorization. New login creation is required only on first provision.

The provisioning transaction creates the private schemas, transfers exact application ownership,
moves legacy public tables/history/functions, and configures the three logins' database search paths.
It does not delete rows, rewrite applied migrations, reassign all provider-owned objects or grant
runtime membership. A fresh database has no existing tables; node-pg-migrate subsequently creates
them directly in the private schemas. Existing migration names/history and synthetic upgrade rows
are preserved.

Next, in a **different one-off process**, supply the owner URL as that process's `DATABASE_URL` and
run `node scripts/migrate-database.ts` (or `npm run migrate`). This retains node-pg-migrate, its
transactional migrations and advisory lock, with application schema `yaparena` and history schema
`yaparena_migrations`. It validates the migration identity and logs a sanitized completion/failure.
Never execute the raw migration CLI with runtime credentials or its default public schema.

Finally, give web/worker only the runtime URL, and the encoder only its own URL, and start the
reviewed new application image. Inspect
service environment/mounts to ensure owner/admin passwords, migration URLs and combined operator
files are absent. Record startup, `/ready`, real account journeys and an after-change inventory.

## Local and CI checks

```sh
npm run check
npm run verify:database-isolation
```

The second command requires Docker and creates/removes its own volume-free PostgreSQL 18.4 cluster
on a random loopback port. It accepts no external database URL and does not load `.env`. All data,
passwords, wallets, event IDs and replay keys are synthetic. It exercises a fresh installation and
an upgrade from every pre-F04 migration, including legacy PUBLIC/browser/inherited/column grants,
unsafe defaults, views and a SECURITY DEFINER probe. It verifies provider fixture grants/defaults
remain intact, and external view dependencies block adoption rather than being silently rewritten.
Administrative provisioning uses a genuine non-superuser `postgres` creator and canonical provider
broker grants. Creator/broker regression cases test safe management grants and reject unsafe
delegation, inheritance, SET access and indirect escalation routes in both fresh and upgrade runs.

With PostgreSQL 17/18 binaries on PATH, `DATABASE_TEST_MODE=host npm run
verify:database-isolation` instead creates a fresh SCRAM-authenticated native cluster on a random
loopback port; it never reuses a local server. All native launchers explicitly initialize UTF-8.
This harness checks server/client UTF8 and, under `LC_ALL=C LANG=C`, unchanged C locale/collation.
Set `A4_QUALITY=true` to run the full `npm run check` with disposable A4, wallet and revocation
identities, and `A4_VERIFY=true` for the separate A4 suite in each fresh/upgrade scenario.
See [the complete local quality command](../operations.md#local-verification).

Browser SQL probes run as both `anon` and `authenticated`, including supplemental schema-USAGE
probes to distinguish schema denial from object ACL denial. They test every application table,
views, sequences and routines. Runtime tests use separate password-authenticated connections,
never SET ROLE from an administrator. They verify DDL/role/history denial, real Express password
registration/login/session/account/role checks, signed wallet login/link/unlink, messages, profiles,
follows/activity, matching/notifications, media SQL state, moderation/appeals, consent/watch/
affiliation/summary, audit/completion triggers, readiness, worker startup/jobs and future defaults.
They do not prove LiveKit/device/replay quality or hosted API behavior. Run
`DATABASE_TEST_IMAGE=postgres:17.6-bookworm npm run verify:database-isolation` separately to repeat
against PostgreSQL 17.6; the harness accepts official PostgreSQL 17/18 bookworm images only. Each
run writes sanitized fresh/upgrade catalog snapshots to the printed unique `/tmp` evidence directory.

CI runs this harness separately from the coverage suite. Existing discovery/community/browser
fixtures use the migration identity only in the disposable Compose database so fixture cleanup
does not require adding broad production runtime permissions. `DATABASE_FIXTURE_URL` is for local
fixture processes only. The running Compose app always uses the runtime login.

## Future migrations and recovery

Global and private-schema defaults for `yaparena_owner` remove PUBLIC/browser/service/inherited
grants on tables, sequences and routines. Global PUBLIC EXECUTE must be revoked because per-schema
defaults cannot subtract a global grant. Future objects fail closed: grant only the runtime query
operations and necessary sequence USAGE in the same migration that creates the object. Enable RLS
and add an explicit backend policy with appropriate USING/WITH CHECK. Do not grant all future DML
or EXECUTE, and do not expose either private schema. New ordinary views must remain private; review
their owner/RLS behavior and prefer `security_invoker` where suitable. Any new callable routine
needs reviewed grants and search path. Use `node node_modules/node-pg-migrate/bin/node-pg-migrate.js
create descriptive-name` to generate new migration files; this does not apply schema changes.

On startup failure, keep traffic stopped. Inspect sanitized inventory/migration status using a
controlled operator connection; fix missing grants/policies with a reviewed additive migration and
rerun it as owner. Never restore service by substituting owner credentials, granting owner
membership/BYPASSRLS, disabling RLS, restoring PUBLIC grants, or adding blanket SECURITY DEFINER.
The hardening migration's `down` refuses to reopen the boundary. Roll back application code only
to an image compatible with the private schemas and runtime role.

Restore into a separate preprovisioned database/cluster with the same role names. Preserve ownership,
ACLs and policies from a full backup and use a controlled administrator for restore; do not reuse
the live database as a trial. A `--no-owner --no-privileges` restore proves data restoration only and
does **not** restore this boundary. For such an archive, explicitly restore private schema/object
owners and reapply reviewed grants/policies before permitting runtime traffic; already recorded
migrations will not automatically replay. Verify real runtime login, the full catalog inventory and
the staging journeys before promotion. Rotate any previously shared owner credential under separate
authorization and invalidate old deployment copies; runtime must never receive its replacement.

## Hosted operator checklist — required to close F04

[Temporary hosted verification](evidence/f04-hosted-verification.json) records synthetic fresh and
legacy-upgrade trials on Supabase PostgreSQL 17.11, verified owner/runtime TLS logins, normal backend
journeys, catalog evidence for every non-system schema, and valid anonymous/authenticated REST,
RPC and GraphQL controls/denials. It found and corrected three defects hidden by superuser-only
provisioning tests. Those were temporary-clone observations before the staging cutover. The subsequent
[community release record](../community-delivery-trial.md#authorized-release-follow-up--2026-10-07)
verifies actual staging runtime/owner identities, private search path, client TLS and separate
migration handling; the [October 15 replay check](../replay-starter-trial-2026-10-07.md#automatic-publication-interface--2026-10-15)
records runtime-only web/worker configuration. F04 merged in PR #20 and is no longer an
unreleased migration. These observations do not complete the actual project’s Dashboard/API,
alternate-access-path, historical credential-rotation or TEMPORARY checks. F04 remains open.

Record each item with project/environment identifier, UTC date, reviewed commit/image digest and
operator. Hosted changes and probes are separate authorization scopes from this local task.

1. Confirm which Supabase project is staging versus production. Save read-only Dashboard evidence
   from **Integrations → Data API** showing the actual Enable Data API state, exposed schemas and
   automatic-exposure setting. Require disabled Data API and neither private schema exposed.
   SQL `pgrst` settings or docs alone do not establish the hosted state.
2. Record REST `/rest/v1`, GraphQL `/graphql/v1`, enabled `pg_graphql`/GraphQL configuration, Realtime
   publications/broadcast/presence, Storage policies, Edge Functions, custom API schemas/routines,
   direct/pooler access and any other database-facing service. Review whether any can access
   application tables or act with owner/service privileges. Do not infer that disabling REST disables
   every other service; inventory their actual configuration and callable paths independently.
3. Run the read-only SQL inventory before and after authorized hardening. Confirm browser identities
   have no effective application schema/table/column/view/sequence/routine privileges or owner/runtime
   memberships. Confirm runtime attributes, login identity, absence of ownership/escalation/schema
   CREATE, exact query grants, metadata SELECT only, backend RLS policies and all creator defaults.
   Review dynamic routine bodies securely and resolve every alternate path.
4. Inspect Render's actual web/worker secrets and mounts. Require runtime-only credentials; no owner
   URL under another name, shared environment group, mounted operator file or migration-on-startup.
   Confirm migrations ran in a separate operator/job process with a matching reviewed artifact.
5. Obtain authorization for a **disposable staging clone containing synthetic data**. Run the fresh/
   upgrade SQL harness equivalent on the provider's PostgreSQL version and verify backend flows via
   real runtime pooler login. Test custom-role session-pooler username format and TLS independently.
6. In that clone only, exercise valid anonymous and authenticated API identities. Confirm each
   identity is accepted against a permitted synthetic control endpoint/service before interpreting
   denials. Use a valid publishable/anon key and a valid, unexpired Supabase authenticated user JWT;
   an Express session is not that JWT. If Data API is disabled, record the provider's disabled-service
   response as well as Dashboard state, and validate identities through an enabled synthetic control
   surface under the clone's approved setup. Never treat missing/invalid-key 401 as isolation proof.
7. Probe reads and synthetic INSERT/UPDATE/DELETE for all application data categories via every
   configured schema/profile. Exercise RPC/GraphQL routines, sequence/definer alternatives and any
   enabled Realtime/Edge Function path. Record status and sanitized outcome, never keys/JWTs/URLs
   with credentials, user data or passwords. SQL role simulation supplements these HTTP probes;
   it cannot replace them. Record unavailable identities/services explicitly as pending.
8. Attach evidence and remaining gaps to the release record. F04 closes only when both repository
   SQL checks and hosted configuration/access-path checks pass. A paused project or local-only
   success leaves hosted isolation **UNVERIFIED**.

## Official references checked on 2026-10-05

[Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) distinguishes grants,
RLS, function EXECUTE and disabling the Data API.
[Supabase's exposure-default change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
does not revoke existing table grants, so project defaults cannot replace inventory.
[PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html),
[role membership](https://www.postgresql.org/docs/current/role-membership.html),
[default privileges](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html) and
[RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) support the implemented boundaries.
The Supabase changelog was checked, including the current
[minor-version changes](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes);
repository UUIDs use PostgreSQL's core `gen_random_uuid`, not an extension-schema search path.
[Render deployment commands](https://render.com/docs/deploys#pre-deploy-command) and
[Blueprint auto-deploy settings](https://render.com/docs/blueprint-spec#autodeploytrigger) inform the
manual Free-plan release sequence. Provider behavior must still be verified for the actual project.
