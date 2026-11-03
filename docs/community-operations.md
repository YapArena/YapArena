# Community operations

This runbook covers Work Package 5 community behavior in a local or test environment. Follow
[decision 0005](decisions/0005-community-moderation-distribution.md) for roles, reason codes,
content states, retention, and appeal rules. This package does not authorize sponsor or financial
features. The [media readiness gate](media-trial-report.md#work-package-5-readiness-gate) remains
open; no production rollout is approved by these checks.

## Rollout and access

Apply `1785924000000_add_community_moderation.js` after the earlier migrations and before
serving the new app. The migration adds community tables and indexes without rewriting earlier
records. It enables row-level security on the new tables. Keep Supabase's Data API disabled as
documented in [Render staging](render-staging.md); do not grant `anon` or `authenticated`
direct table access. The app uses its server-held PostgreSQL connection and checks authorization
on each request. The existing global API limit and production origin check also apply.

Assign `moderator` through the reviewed account-role procedure. Keep at least two moderators so
an appeal can be decided by someone other than the first reviewer. An `operator` role is for
debate media actions; it grants no case-review permission. Remove a moderator role through the
same procedure when access ends. Audit identity-role changes using `identity_audit_events`.

On rollback, redeploy the previous app image while retaining the additive community tables.
Review any cases and appeals created after the rollout before restoring an older image, because
it will not provide their review UI. Do not drop the migration as a rollback step. The old
discovery code may display legacy sponsor data; keep sponsor records empty while sponsor
identification is deferred.

## Chat submission migration and rollout

`1791244800000_add_chat_submissions.js` is additive and must run after
`1791158400000_isolate_server_database.js`, as the owner through `scripts/migrate-database.ts`.
Follow the [database isolation runbook](security/database-isolation.md),
[image release procedure](operations.md#release-and-deploy-an-image), and
[staging deployment sequence](render-staging.md#deploy-the-web-service). Apply migrations before
serving the new reviewed server/assets. The first F04 schema transition still requires traffic and
workers stopped; this chat migration does not relax that requirement. Do not run migration or
fixture credentials in web/worker processes.

F04 code is already merged in PR #20. For a target already running that migration, use the existing
owner/runtime identities and apply only pending migrations; do not repeat initial provisioning or
the F04 schema move. Confirm the target's applied migration list separately from Git merge status.

The migration adds nullable UUID submission keys, a partial account/event/key unique index, and a
non-null bigint moderation revision defaulting to zero. Existing text is untouched. Its private
SECURITY INVOKER trigger uses `pg_catalog, yaparena, pg_temp` and has no public, browser or callable
runtime EXECUTE grant. Existing query-specific table grants and backend RLS remain in effect; no
new table or Data API access is added. Index creation takes a table lock: schedule the migration
for an appropriate quiet/maintenance window on a large chat table and observe migration duration.

Older schema-compatible server images and already-open older clients can still insert keyless rows;
those requests receive the usual allowance checks and cannot be deduplicated. During mixed-server
rollout new clients require the new message protocol. Promote the matching server and assets
together; do not route new keyed writes to an old server which would silently ignore their key.
On app rollback retain this migration and its keys. Pause live chat through the moderation workflow
before rolling back to a server without submission support, and require clients to refresh before
resuming legacy posting. Otherwise retrying a new client's pending request against old code could
create a second acceptance. Prefer a compatible forward fix. Migration `down` refuses to discard
keys. Acknowledgment/recovery UI on already-open new pages is not supported by an older server.

Monitor bounded HTTP statuses/latency and redacted request IDs. Keep payloads, submission UUIDs and
drafts out of logs and analytics. Acknowledge a stored key even if chat ended/paused, posting roles or profiles changed, or
an account was restricted; verify current sign-in and event/topic publication first. Private
acceptance lookup is scoped to the account from its session. A payload conflict needs explicit user
review, never an automatic new key. Removed acknowledgments expose no removed text.

Migration `1791345540042_preserve-chat-idempotency.js` adds a private, body-free receipt binding
the authenticated sender, room and key to the canonical message ID and SHA-256 request fingerprint.
It backfills currently retained keyed messages. An AFTER trigger records the binding in the same
transaction and prevents rebinding at PostgreSQL even after the chat body is purged. Message
identity fields are immutable. Receipt reads precede allowance checks; unchanged retries return
the canonical message or its newer removed tombstone, and conflicting text remains HTTP 409.
Pending reconciliation also returns purged canonical tombstones. No retry inserts another row,
advances the room counter or recreates removed content.

Receipts contain private sender/key metadata and a request fingerprint, not anonymous data; they
never enter public fanout or logs. They retain for the room/account lifetime, independently of
365-day chat/evidence retention and the seven-day stream log. Physical room/account deletion
cascades receipts; runtime has no receipt DELETE or binding/hash UPDATE permission. Existing
keys purged before this migration cannot be reconstructed. Apply the additive migration as owner
before deploying the matching image. An older image may reject a purged-key retry with 5xx, but
the receipt constraint prevents a duplicate; pause chat before rollback to incompatible code.
The migration backfill/index takes a table lock: schedule and measure it on large catalogs.

Reload recovery is intentionally unsupported:
recoverable submissions and drafts stay in page memory, not local storage, offline cache or logs.
Keep the page open when delivery is unconfirmed. **Retry unchanged** resends the original text/key;
**Recover to draft** appends text, never replaces later typing, and does not send it. Sending an unchanged recovered draft retries the original key; editing or appending to existing
text creates a new logical submission; an earlier uncertain message may still arrive.

Chat 429 responses identify `CHAT_COOLDOWN` or `CHAT_HOURLY_LIMIT`, provide server-computed
`retryAfterSeconds`/`retryAt`, and send `Retry-After` in seconds. The longer remaining interval wins
when both one-per-ten-seconds and thirty-per-hour windows apply across events. Removed messages
still count in these windows. Countdown and disabled controls guide the user; direct API requests
are always checked again. A successful send keeps the next draft editable and a later rejection
never clears it. HTTP 400/401/403/404/409 indicate rejection; HTTP 408, 5xx, lost/invalid responses
and transport timeouts indicate uncertainty. No reconnect event retries a submission or sends a
draft. An accepted unchanged retry returns the original ID without charging either window.

The feed keeps at most 500 visible server rows and watches up to 1,000 IDs for moderation changes.
Unconfirmed/rejected local rows remain recoverable for the page lifetime. Catch-up drains bounded
stream or durable HTTP batches; the room cursor advances only after applying that transport,
never POST confirmations or earlier-history loads. When retention evicts the latest tail while a reader stays in history, **Jump to latest**
reloads current history. Confirming a pending row reuses its DOM row and does not add unread count.
Connection messages announce changes once, and feed announcements report brief new-message counts.

## Participant and moderator journeys

The feature-gated durable transport, protocol, lock order and rollout procedure are documented in
[Durable public community delivery](community-delivery.md). With the flag enabled, a page uses one
public stream, HTTP history pagination and private pending/own-like reconciliation. HTTP polling
runs only during degraded delivery. With the flag disabled, new pages use bounded durable HTTP
updates. The stream reference log has its own seven-day retention; it does not change the chat or
moderation evidence policies below.

1. Open a published event page. Guests can read visible chat, copy the canonical event link,
   open its QR code, and load `/overlay/<event-slug>` for a basic broadcast title card. The
   overlay contains no likes, chat counts, score, sponsor, hidden tally, or result.
2. A signed-in participant with a published profile can post plain-text chat while the event
   is live and chat is open. Any participant can like a published event once. The page labels
   these as visible interest, not official support. A guest or restricted account sees a clear
   sign-in or restriction error for writes. Chat becomes read-only when the event leaves `live`.
   The feed sits beside the watch view on desktop and directly below it on mobile. New messages
   arrive through the enabled public stream, with two-second durable polling during degraded operation. The client keeps an ordered room cursor,
   drains missed pages after reconnect, avoids duplicate IDs, and preserves the reader's scroll
   position until they choose **Jump to latest**. A submitted message appears immediately with its delivery state. The composer
   remains editable; uncertain or rejected submissions offer explicit unchanged retry and draft
   recovery. Recovery appends to later typing rather than replacing it. Pauses and removals appear without a page refresh.
3. A participant reports a chat message or event with a reason and context. The report is
   private and appears in `/account/moderation`. Repeat reports for the same target return a
   conflict; more than five reports in 24 hours return HTTP 429. More than ten actual like-state
   changes in an hour also return HTTP 429; repeating the current like state is idempotent.
4. A moderator opens `/moderation`, reviews the target and private report context, and records
   a reason and note. The available actions are dismiss, remove chat, restrict a chat author
   for seven days, or pause event chat. Chat removal hides the message publicly while the
   original remains in private evidence and the audit trail records the transition. A pause
   affects chat only, never the event clock or video. Reporters and affected chat authors
   receive an account notification. Select the Actioned filter and use the active pause case
   to resume chat with another note. A moderator participating in the event cannot resume it.
5. An affected chat author visits `/account/moderation` and may appeal a removal or account
   restriction once within 30 days. A different moderator reviews the open appeal. Overturning
   a removal restores that case's message; overturning a restriction revokes that case's
   restriction. Upholding it leaves the action in place. The appellant receives an account
   notification. A repeated or late appeal is rejected.

6. To hide a topic, profile or debate from public pages, a moderator uses **Content
   visibility** on `/moderation`: choose the item, enter its slug, handle, or the debate's slug
   or ID, a reason and a note, then **Hide from public pages**. **Restore** returns the state
   the hide replaced. Recent changes are listed below the form, and owners receive an account
   notification. Ask another moderator when you created, own or debated in the item. A
   restricted account cannot change its profile, create topics, challenge, queue or take a
   debate seat until the restriction ends (Decision 0005, 2026-11-02).

Case and appeal decisions are serialized by database row locks. Account writes use a per-account
transaction lock, so parallel chat, like, and report requests cannot bypass account limits.
The moderator API has no event-result or future-settlement method.

Allowlisted community/media reads now use the separate delivery admission budgets in
[media delivery controls](media-delivery-controls.md#shared-network-admission), including
lease/room, browser, shared-network and process bounds. These replace the earlier 600/minute/IP
read allowance for those routes. Authenticated write and per-account limits remain separate;
hosted concurrent audience and shared-network acceptance still require measured trials.

## Failure handling and retention

- HTTP 401 means sign in. HTTP 403 means the role, profile, self-review, or active restriction
  disallows the action. HTTP 404 hides a nonpublic event or missing target. HTTP 409 means the
  state changed or a duplicate request already exists. HTTP 429 means the account limit is
  reached; wait for the stated window. On HTTP 5xx or network failure, refresh state before
  retrying a decision. A retry never applies a case action twice.
- Triage urgent threats or privacy reports from the open queue first. Preserve the case ID,
  UTC times, reason, reviewer, and redacted request logs for an incident. Do not paste chat
  content or personal details into public issues or screenshots. If chat itself is unsafe,
  pause chat through an event report; the moderator cannot pause the media clock.
- The hourly maintenance job prunes resolved cases and associated appeals/audit after 365
  days, then old chat, likes, and like-change records after 365 days. Open cases or appeals hold their targets until
  review completes. The job logs failures and retries at the next interval. Before a longer
  legal hold is approved, export only a redacted case summary through the approved private
  process; there is no public export endpoint.

## Verification

Run `npm run check` and the PostgreSQL integration exercise in the CI integration job. Locally,
after building and applying migrations to a disposable local database, run
`node scripts/verify-community.ts` in an operator fixture process. Supply an owner connection
as `DATABASE_FIXTURE_URL` and a runtime connection as both `DATABASE_URL` and
`COMMUNITY_RUNTIME_URL`; otherwise fixture setup/cleanup can fail under runtime privileges,
or queries use the owner and do not establish runtime-role behavior. The exercise creates and removes synthetic users and a synthetic
event. It checks concurrent posts and likes, report limits, removal, preserved private evidence,
restriction, pause/resume, appeal independence, and no change to event status or rule snapshot.

Run `npm run verify:community-delivery` for disposable real PostgreSQL transactions, LISTEN recovery,
multi-viewer browser races and the five-minute 500-viewer soak. CI runs a 30-second smoke soak.
The [delivery guide](community-delivery.md#repeatable-validation-and-hosted-procedure) describes
Docker and host-PostgreSQL modes and hosted checks; local success alone does not authorize rollout.

A self-contained synthetic trial builds on separate owner/runtime logins and verifies an existing
keyless row through the new migration, eight concurrent identical submissions, competing payloads,
quota preservation, both posting windows, private correlation, access denial and moderation
revisions. After `npm run build`, use Node.js 24 and run:

```sh
node scripts/verify-community-local.ts
```

It creates and removes a volume-free PostgreSQL 18.4 Docker cluster, runs `verify-community.ts` with
runtime queries and owner-only fixture setup/cleanup, starts the runtime server, then runs browser
journeys and `verify-chat-client.ts`. It never reads `.env` or accepts hosted database URLs. If
Docker is unavailable and PostgreSQL 17/18 tools are installed, the same isolated trial supports:

```sh
COMMUNITY_POSTGRES_MODE=host node scripts/verify-community-local.ts
```

For a fast native Unicode setup check with PostgreSQL 17/18 binaries on PATH:

```sh
npm run verify:community-native-setup
```

This command forces `LC_ALL=C LANG=C COMMUNITY_POSTGRES_MODE=host`, invokes the same
native `initdb` path, provisions and migrates a fresh disposable database, then stops
before browser/load work. Native community, isolation and replay harnesses explicitly
initialize UTF-8 while preserving their inherited locale. The community probe checks
server/client UTF8, the C database locale when requested, 500 characters/1,500 bytes,
and exact runtime-role insertion/readback of `"界".repeat(500)` through the existing
`varchar(500)` chat column. It rolls back before other fixtures execute. Invalid
encoding fails before the expensive phases, and the enclosing cleanup still runs.
The required CI integration job runs this native smoke in addition to the unchanged
Docker/browser/load gates. It is not a substitute for the full community command.
See [the dated fix and verification record](evidence/native-postgres-utf8/2026-10-18.md).

The host mode creates a temporary SCRAM-authenticated cluster and stops/removes it afterward;
it never changes an existing database. `COMMUNITY_CLIENT_ONLY=1` selects the deterministic browser
portion after SQL verification. Screenshots go to a unique `/tmp/yaparena-chat-*-evidence` directory
or `BROWSER_ARTIFACT_DIR`. Chrome must be installed or selected by `BROWSER_CHROME_PATH`. These runs
exercise local synthetic behavior; they do not establish hosted isolation or audience capacity.

For a local browser trial, start the app and run:

```sh
BROWSER_DATABASE_PORT=55433 node --env-file=.env scripts/verify-community-browser.ts
```

Set `BROWSER_BASE_URL`, `BROWSER_DATABASE_PORT`, `BROWSER_CHROME_PATH`, and
`BROWSER_ARTIFACT_DIR` if your local ports or Chrome path differ. The script refuses a nonlocal
database, registers synthetic test accounts, grants temporary moderator roles, exercises chat,
likes, reports, removal, appeal, and restoration, scans the new UI with axe-core, checks mobile
overflow, and removes its fixture. It saves screenshots to `/private/tmp` by default. It additionally tests deterministic POST/feed races, ambiguous delivery, immutable retries,
new draft preservation, IME/focus, history/cursor/retention, zoom, narrow and reduced-height viewports.
It tests responsive layout at a phone-sized viewport; it does not stand in for physical-device media,
touch, screen-reader, caption, or replay testing.

The [local browser trial record](community-trial-report.md) contains the observed results and
screenshots. Repeat the community journey with staging test accounts on desktop and mobile
devices before promotion. Verify keyboard focus, screen-reader announcements, touch targets,
chat reconnect behavior, moderation queue latency, QR scanning, Open Graph previews on the
target sharing apps, and overlay legibility in the broadcast compositor. Record any failures
and the deployed commit. Complete the separate measured media trial before calling the full
package production ready.
