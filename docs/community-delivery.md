# Durable public community delivery

Pre-implementation targets recorded 2026-10-07 01:05 UTC. These are provisional trial assumptions,
not approved production capacity: 500 concurrent viewers/process, 50 active rooms, 10 public
mutations/second total, 2/second in a hot room, bursts of 20/second. Target local p95 commit-to-client
delivery is one second; reconnect recovery ten seconds; missed-notification recovery fifteen seconds.
Budget: ten ordinary pool connections plus one persistent runtime LISTEN connection/process,
four concurrent room reads, at most 100 events/read, 1,000 events of recovery before a fresh snapshot,
64 KiB/client output buffering, and at most 128 MiB additional RSS during the declared soak.
Fifteen-second heartbeats and five-second server reconciliation are independent of browser polling.
Stream events retain seven days independently of 365-day chat/evidence retention; cleanup is bounded.

Supported-browser release target: current Chrome, Firefox and Safari desktop, iOS Safari and Android
Chrome. Local headless Chrome and phone viewport checks cannot establish physical-device support.
Actual browser-to-edge HTTP/2, proxy delivery, provider connection budgets and the runtime session
pooler's LISTEN behavior require hosted evidence. Render Free is a staging plan and remains unsuitable
for promised live events. Existing isolation, media, privacy, accessibility and product gates remain.

## Prerequisite checkpoint

Before SSE edits, the shared working tree already implemented optimistic submissions, UUID v4
`clientMessageId`, immutable retry text, owner-only pending reconciliation, and revision safeguards.
The partial PostgreSQL unique index scopes keys to sender/room. Account transaction locks serialize
retries, canonical reads precede allowance/new-write checks, conflicting text fails with 409, and
removed acceptances return null bodies. The initial prerequisite implementation expired keys on
normal message retention purge; the later retention audit found this did not satisfy the strict
retry requirement. The separately reviewable receipt checkpoint described in
[community operations](community-operations.md#chat-submission-migration-and-rollout) fixes that
gap with additive migration `1791345540042_preserve-chat-idempotency.js`; no applied migration changes.

Executed with Node 24.19.0, disposable SCRAM PostgreSQL 17.10, distinct owner/runtime logins and
synthetic data: `node --test tests/community-state.test.js tests/community-repository.test.js
tests/community-router.test.js` (35/35 passed), and `COMMUNITY_POSTGRES_MODE=host node
scripts/verify-community-local.ts` (SQL/runtime/browser PASS, 2026-10-07 01:06 UTC). Baseline delivery:
desktop 2,216ms, phone viewport 2,221ms, reconnect 28ms, removal 1,669ms; these are individual polling
observations. Logs: `/tmp/yaparena-prerequisite-unit.log`, `/tmp/yaparena-prerequisites.log`.
The initial sandbox attempts failed on local sockets/shared memory; the recorded trials ran with
local process permission. No missing prerequisite implementation was found, so this checkpoint adds
no prerequisite code at that time. The retention guarantee was subsequently corrected as described
above. Existing unrelated uncommitted work was preserved; `/tmp/yaparena-before-sse.patch`
records the starting tracked diff. No commit/deployment was made.

## Implementation and writer inventory

`src/platform/sse.ts`, `room-fanout.ts`, and `pg-listener.ts` own transport, admission,
backpressure, room resources and listener lifecycle. `src/features/community/delivery.ts` and
`streams.ts` own public projections, eligibility, recovery and log retention. All writes continue
through the existing authenticated Express HTTPS endpoints in production. One EventSource is open
per visible eligible event page; background/network/page lifecycle transitions close and recreate it.
No viewer holds a database connection or a transaction for the stream lifetime.

The additive migration `1791335211412_durable-community-delivery.js` installs private reference-only
logs, room counters, chat `stream_revision`, and transaction triggers. The triggers cover existing
writers, including older schema-compatible application images:

| Public state                        | Writers inventoried                                                                                                                          | Transaction capture                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Chat creation                       | Community `postChat`; operator synthetic seed/fixture SQL                                                                                    | Chat INSERT                                                                    |
| Removal/restoration                 | Community `decideCase` / independent `decideAppeal`                                                                                          | Chat state/body UPDATE                                                         |
| Purged chat                         | Community hourly `pruneExpired`                                                                                                              | Chat DELETE                                                                    |
| Likes                               | Community idempotent `setLike`; retention cleanup                                                                                            | Like INSERT/DELETE                                                             |
| Chat pause/resume                   | Community `decideCase` / `resumeChat`                                                                                                        | Control state changes; implicit initial `open` is a no-op                      |
| Chat writability / event visibility | Matching event creation and manual `operatorTransition`; media `tick` automatic maximum-duration ending in web or worker; operator event SQL | Debate INSERT/status/publication/demo/topic UPDATE/DELETE                      |
| Topic visibility                    | Matching `publishTopic`; operator topic publication SQL                                                                                      | Topic publication UPDATE, sorted affected rooms                                |
| Public author label                 | Identity profile editing/publication                                                                                                         | Profile name/publication UPDATE, sorted affected rooms, snapshot reset         |
| Media state signal                  | Media `start`, `pause`, `resume`, `stop`, `tick`, recording results, captions; readiness, operator transitions, replay publication           | Public-snapshot column change on `debate_media` or debate lifecycle, at COMMIT |
| Human round signal                  | A4 `create`, `tick`, `control` and voiding for human-only runs; operator SQL                                                                 | Human run INSERT/state UPDATE and its round state UPDATE, at COMMIT            |
| Shared activity signal              | Settlement of a consenting creator's sandbox; publication consent; synthetic seed rounds                                                     | Round `settled`, publisher INSERT/DELETE, synthetic round INSERT               |
| Yap Coins window signal             | Coin loop window opening, settlement and automatic voiding; manual round creation; owner `void-round`                                        | `coin_debate_rounds` INSERT and state UPDATE, at COMMIT                        |

Private reports, case reasons, evidence, restrictions, notifications, audit records and like-change
allowance records do not enter this log. Restrictions and role changes remain server checks on
every write; the shared summary cannot express a viewer's personal permission. Ready-state changes
keep their existing media transport; media state and A4 rounds add the reference-only
[room signals](#media-and-a4-room-signals) below. No financial writer or
payload is added. A public like is visible interest; it is not official support. Ending a debate
makes chat read-only; it does not implement financial participation closure or settlement.

Runtime profile deletion/account export is not implemented in this project. A future account
deletion workflow must explicitly capture affected author projections before removing a profile;
do not treat the current update trigger as a general deletion system. Operator bulk maintenance
must follow the lock discipline below and use a reviewed forward migration for new writers.

## Ordering and transaction invariants

For room R, a public mutation updates `community_rooms.cursor` while holding its row lock until
commit. A competing transaction cannot allocate the next room cursor until that transaction commits
or rolls back. Commit exposes the public row and its log reference together; rollback exposes neither
and rolls back the counter increment. This provides per-room commit order, including concurrent
transactions, without relying on bigserial message IDs, sequence allocation, timestamps or NOTIFY
arrival order. There is no ordering claim across different rooms. Message IDs, revisions, counts and
room cursors are serialized as decimal strings; comparisons use BigInt, never Number.

`pg_notify('yaparena_community_v1', room_uuid)` runs in the same transaction, from the trigger. PostgreSQL
delivers the UUID-only wake-up after commit. Notifications are hints: no payload, authorization or
durability depends on them. The listener verifies `current_user` and `session_user` are the restricted
`yaparena_runtime`, commits LISTEN through autocommit, then wakes active rooms for durable catch-up.
On reconnect it repeats identity verification and LISTEN before inspecting durable state. Each web
process has one dedicated persistent listener with the same runtime URL as its ordinary pool.

Lock order for existing application writers is: account/advisory and business locks already required
by the operation; debate/control/message locks; then the room counter. Do not acquire another public
entity lock after acquiring a room counter. Matching/media already lock the debate before updating
its lifecycle, and their subsequent participant/media work cannot acquire a competing room counter.
Submission receipt locks come last, after the room counter; unchanged retry reads take no receipt
row lock. A purged keyed message updates its canonical tombstone in the same deletion transaction.
Receipts never acquire another public entity lock and are retained independently of body/log cleanup.
Chat takes the debate share lock and control lock before INSERT. An implicit open control INSERT
does not allocate an event, which avoids counter-to-control inversion with a pause. Moderation takes
the case/appeal and target message/control before capture. Profile/topic fanout acquires affected
room counters in ascending UUID order and does not subsequently lock their public entities.

Room signals run as deferred constraint triggers, so a media or A4 transaction allocates its
room counter at COMMIT, after every business row lock it took. A publication-consent change
allocates its affected rooms there in ascending UUID order. A4 commands hold the account row
`FOR UPDATE` until then, so community writers take that row `FOR KEY SHARE` with their account
lock, before any room counter, rather than in a later foreign-key check. An operator transition or
moderation decision that notifies a user after taking the room counter can still meet that user's
concurrent A4 command in the same room; PostgreSQL aborts one of the two, and both retry safely
(A4 with its request key, chat with its unchanged submission key).
Chat/like retention locks at most 50 eligible messages and 50 likes using SKIP LOCKED before either
DELETE trigger, in a separate transaction for each of at most ten rooms. Stream retention acquires
only room counters, sorted by UUID. Manual bulk SQL that mutates multiple existing rooms must prelock
its public targets and counters in this order, or split into one-room transactions; arbitrary
multi-room UPDATE/DELETE statement order is not an approved locking pattern. Database deadlock/timeout
errors roll back the complete public mutation and log; never bypass capture to retry. The trial
measures both uncontended counter writes and a controlled concurrent transaction waiting on a held
counter. See the evidence record for measured contention.

PostgreSQL documents the [LISTEN startup ordering](https://www.postgresql.org/docs/current/sql-listen.html)
and [transactional NOTIFY semantics](https://www.postgresql.org/docs/current/sql-notify.html).

## Public protocol v1

`GET /api/community/events/<UUID>/stream` is anonymous for a published non-demo event whose topic is
published. Exact same-origin headers are enforced; cross-site browser requests are rejected. It
returns `text/event-stream`, `Cache-Control: no-store, no-cache, no-transform`, and
`X-Accel-Buffering: no`. Streaming compression/buffering must remain off at every deployed hop.

Room IDs use lower-case UUIDs. SSE application IDs and explicit resume cursors have the form
`v1:<room-UUID>:<decimal-counter>`, from zero through signed-bigint maximum. Invalid syntax, overflow,
noncanonical numbers and wrong-room cursors return HTTP 400; invalid room syntax returns 404.
An explicit `?cursor=` wins over `Last-Event-ID`, including when EventSource received a frame which
the application failed to apply. A syntactically valid future cursor, a cursor older than the retained
floor, more than 1,000 events of recovery, or a projection reset yields a fresh consistent snapshot.
Admission refusal returns 503 with Retry-After; a disabled stream returns 503 with Retry-After 30.

Only these fields are emitted, using constructed allowlists rather than spreading database rows:

| Object/event                | Allowed fields                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event: community` envelope | `version: 1`, `roomId`, `cursor`, `kind: snapshot/changes`, and the corresponding `snapshot` or `changes`                                               |
| Snapshot                    | `summary`, `items` (latest ten visible messages, ascending message ID), `hasMore`                                                                       |
| Change                      | `type: message/summary`, `message` (public message or null), `summary`; a room signal adds `refresh: media/round/activity` with `message: null`         |
| Public message              | `id`, `debateId`, `authorName`, `body` (null when removed), `state`, `createdAt`, decimal `revision`, decimal `streamRevision`, `clientMessageId: null` |
| Public summary              | `eventId`, decimal-string `likes`, `chatState: open/paused`, `chatWritable`, `eventStatus`, decimal `revision`                                          |
| `event: heartbeat`          | `version: 1`; no SSE ID and no application cursor                                                                                                       |
| `event: unavailable`        | `version: 1`, `roomId`; no public content or cursor                                                                                                     |

There are no account IDs, private submission keys, reporter IDs, reports, moderation reasons or
evidence, viewer selections, hidden tallies, official support, money or financial closure data.
Author names are currently published profile labels, otherwise `Participant`. The authenticated
`my-like` and `chat/submissions?keys=...` responses stay outside shared fanout; the latter limits to
100 UUID v4 keys owned by that session and room. Its query keys and stream URLs are excluded from
ordinary completion logs. Public history normally returns `clientMessageId: null`; `own=1` is an
explicit authenticated projection and is never shared.

`GET .../updates?cursor=...` returns the same public protocol in JSON for degraded operation, plus
`more` on recovery frames; an unavailable frame has `kind: unavailable`. HTTP history
`GET .../chat?before=<message-ID>` remains available, with up to 50 rows/page. The legacy watched-ID
sync endpoint is used only for bounded reconciliation of already-loaded older rows after a snapshot.
Message-history cursors and stream commit cursors are different domains and cannot be substituted.
HTTP POST confirmations and older-history responses never advance the stream cursor.

## Consistency, redaction and browser recovery

A subscriber is registered before its initial read. One short repeatable-read read-only transaction
binds publication eligibility, the room head/floor, current summary, tail messages and recovery
references to the same snapshot. It sets a three-second statement timeout and has a four-second
connection deadline. A mutation committed during that read either appears in the snapshot or has
a greater cursor and is fetched afterwards. A wake during the read leaves the room dirty for the
next read. Five-second active-room reconciliation independently covers a completely missed wake-up.
No transaction stays open while a response waits for a viewer.

Checked-out delivery clients observe PostgreSQL client `error` events during reads
and pruning, including socket cancellation during shutdown or the connection
deadline. Query failures still propagate and failed clients are discarded on
release; the temporary listener is removed before returning the client to the
pool. The maintained cancellation regression covers both operations under both
shutdown and the unchanged four-second deadline, including listener cleanup.
See the [CI correction evidence](evidence/ci-integration/2026-10-19.md).

The durable log stores message references and revisions, never historical bodies. Recovery looks up
each referenced message's **current public state** in the same read transaction. Previously created
content currently removed is returned with a null body; purged rows become null-body tombstones.
Replay therefore never sends an old body in anticipation of a later removal. A current projection
revision can be newer than the last log reference in that batch; clients compare both moderation
and stream revisions. Only a newer authorized state change can restore a real removal. A future
resume cursor receives a consistent snapshot at the current head. Database disaster restoration
which rewinds previously applied room counters needs a separate reviewed reset/epoch procedure;
ordinary process restart recovery assumes the durable database has not been rewound.

The browser serializes applications and advances its own cursor only after successful application.
Duplicates at/below that cursor are ignored. A failure closes that EventSource and recreates it with
the last applied cursor; the browser's native received ID is not an acknowledgment. Epoch checks
reject obsolete stream applications, delayed history, snapshots and older watched responses.
Message tombstones survive outstanding HTTP work so a stale confirmation cannot resurrect removal.
Summary revisions prevent older like counts or lifecycle summaries replacing newer stream state.
Own-like selection has its own HTTP request generation guard; a like write never overwrites the
shared count with an older HTTP acknowledgment.

Fresh snapshots include only the current ten-row tail. Previously loaded rows outside that tail are
redacted immediately, then verified with at most three watched-ID requests covering at most 500 IDs.
This permits fresh visible history to return while preventing unseen moderation during a retention
gap from exposing old text. The viewport anchor is restored where retained rows permit it. The feed
keeps at most 500 server rows and tracks at most 1,000 IDs plus bounded in-flight tombstones. Pending
submissions remain in page memory, at most 100 unresolved entries; confirmed entries are evicted
with feed retention. Drafts, keyboard/IME behavior, scroll anchoring and Jump to latest are preserved.

Public stream payloads intentionally cannot bind a sender's pending UUID. A accepted HTTP response
or debounced authenticated reconciliation resolves it to the canonical row; a brief public/pending
pair may appear until that owner lookup completes. A dropped HTTP response never causes an automatic
resend. Explicit unchanged retry reuses the same key and allowance. Connection status is an accessible
status region, updated only when its text changes. Publication revocation sends unavailable, closes
delivery, clears chat/like count and disables public actions while preserving an editable local draft.
Future re-publication requires a fresh page or connection; a revoked page does not silently resume.

## Media and A4 room signals

Migration `1792817943415_publish-media-and-round-room-events.js` adds reference-only signals to
each debate's log: a `summary` row with no message reference whose new `refresh` column names the
public projection that changed. The browser re-reads that projection over HTTP, so it sees the
current state, never a historical value, and one signal covers a whole transaction (at most one per
room and projection).

| `refresh`  | Committed when                                                                                                          | Re-read projection                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `media`    | a media snapshot column changes, or the debate's status, publication or demo flag changes                               | `GET /api/media/events/<id>`            |
| `round`    | a human-only run is created or changes state, or one of its rounds changes state                                        | the signed-in A4 workspace              |
| `activity` | a consenting creator's sandbox round settles, publication consent changes, or a seed round is added                     | `GET /api/public/debates/<id>/activity` |
| `window`   | a Yap Coins round or turn window opens, settles or is voided ([Decision 0012](decisions/0012-live-argument-outline.md)) | `GET /api/public/debates/<id>/windows`  |
| `outline`  | a window's AI outline is frozen or finalized, or a debater flags an outline item                                        | `GET /api/public/debates/<id>/outline`  |

Migration `1792971645611_add-turn-trading-windows.js` adds `window`, and
`1792975658985_add-live-outline.js` adds `outline`. Live outline edits never use the log: they
reach viewers over LiveKit, and the `outline` signal is only their fallback. Yap Coins rounds are shared
by everyone on the debate, and turn windows follow the public turn clock, so the signal reveals
only timing that viewers already see. The coin loop settles a batch of rounds in one transaction,
so a batch spanning several rooms takes their counters at COMMIT in settlement order, not UUID
order. A concurrent multi-room fanout (profile or topic edit) can then deadlock with it;
PostgreSQL aborts one, the batch rolls back whole and the next one-second tick retries it.
A private sandbox emits nothing while it opens, locks or prices; a signal appears only when a
consenting creator's settled result enters the public activity. Private incident text, egress and
recording keys, receipts, balances, orders, seeds and unrevealed pricing never enter the log or a
frame. On the wire a signal is a `summary` change with `refresh` set and `message: null`. A server
image from before the migration reads only the original columns and sends the same row as a plain
summary change, and clients that predate signals apply either, so migrating before deploying
leaves chat delivery intact. Signals reveal when a human-only
round changes state, which signed-in accounts can already see; anonymous viewers learn the timing,
not the content.

`community-stream.ts` dispatches `yap:room-signal` (room, applied cursor, topics) after each
successful application, in cursor order, and `yap:room-stream` when the EventSource becomes live or
stops. A snapshot signals every topic, because it can stand in for skipped references. Polled
`/updates` frames also signal but never mark the stream live. Media re-reads on `media` signals; if
the response's `streamRevision` is still below the signal's cursor (a shared read that began before
the commit), it retries up to three times with backoff. Countdowns use server deadlines with the
offset from the response's `serverNow`; A4 run views now carry `serverNow` from the database
clock. Each page also reads about two seconds after a deadline it already knows, backing off while
the server finishes the transition. Polling at the slower intervals below runs only while the
stream is not live (disabled, disconnected, backgrounded or not eligible); media keeps a 60-second
safety read while it is live. A4 pages spread signal-driven reads over up to three seconds, so a
room's viewers do not read at once. The `/coins` page has no room stream and uses the deadline and
30-second private refresh only. The user approved these intervals, and the human-only round timing
visible to anonymous viewers, on 2026-10-24. A new server
cannot run before this migration: startup refuses pending migrations.

## Limits and degraded operation

| Resource/control                               | Implemented default                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_STREAM_ENABLED`                     | `false`; `.env.example`, Compose and Render explicitly retain this rollout gate                                                                    |
| `COMMUNITY_MAX_STREAMS`, `COMMUNITY_MAX_ROOMS` | 500 streams / 50 active rooms per web process; validated range 1–10,000 and 1–1,000; larger values have no capacity approval                       |
| Ordinary database pool / LISTEN                | Ten pooled runtime connections + one persistent runtime session; workers/operators budget separately                                               |
| Room reads                                     | Four concurrent; 80 reads/second with burst 20; 25 ms coalescing and room rotation                                                                 |
| Recovery                                       | Ten events/read, maximum 100 consecutive batches or 1,000 events then snapshot                                                                     |
| Snapshot size                                  | Ten visible messages; tested maximum JSON-escaped bodies/names fit the 64 KiB output limit                                                         |
| Per-client buffering                           | 64 KiB across Node writable queue and transport queue; respects write(false)/drain                                                                 |
| Stalled client                                 | Disconnect after 15 seconds without drain or immediately on byte pressure; no silently dropped changes                                             |
| Admission/reconnect                            | Primary process/room limits; per-IP burst 1,200 tokens, refill 50/sec, 60-sec expiry, at most 2,048 IP entries                                     |
| Heartbeat / repair                             | 15-sec no-ID heartbeat; 5-sec reconciliation for active rooms                                                                                      |
| Listener retry                                 | 0.5–30 sec exponential delay with jitter; reverify identity, commit LISTEN, wake all active rooms                                                  |
| Browser retry / freshness                      | 1–30 sec exponential delay with jitter; initial application/heartbeat deadline about 10–15 sec; 45-sec transport or stalled-application detection  |
| Degraded public reads                          | Poll durable updates every 2 sec, failure backoff up to 15 sec, at most 20 batches/pass; abort on stream reconnect/health and while backgrounded   |
| Media status reads                             | On `media` signals, about 2 sec after a known turn deadline, every 60 sec while live; polling 2 sec (speaker) / 6 sec (viewer) while not live      |
| A4 reads on the debate page                    | Shared activity on `activity` signals, else every 60 sec live / 15 sec not live; private workspace on own action, `round` signal, deadline, 30 sec |
| Graceful shutdown                              | Close streams first; cancel active delivery connections; bound listener close to 1.5 sec; release pool; existing process hard deadline 10 sec      |

The implemented ten-row limit is stricter than the pre-implementation maximum and prevents a legal
worst-case payload from repeatedly exceeding the byte limit. Events are encoded once per shared
room/cursor group and reused as immutable Buffers; each client has its own bounded queue.
The production image, Compose and Blueprint set `NODE_OPTIONS=--max-semi-space-size=4`, as do the
disposable web trial processes. This bounds Node's young-generation allocation policy for the
measured configuration. The first five-minute run exceeded the RSS growth budget with Node's
host-dependent default sizing; the explicit setting reduced measured memory in a repeat trial
without relaxing the latency or memory targets. Node documents the
[memory/throughput tradeoff](https://github.com/nodejs/node/blob/main/doc/api/cli.md#--max-semi-space-sizesize-in-mib).
Changing this setting requires new GC/latency measurements, including concurrent media/account
work, before a broader production release.
Inactive room resources disappear as soon as the last subscriber closes. Heartbeats neither hide
stalled application work nor advance recovery cursors. Slow clients reconnect from their applied
cursor and receive catch-up or a snapshot. HTTP/1 browser per-origin connection limits make multiple
tabs a risk; verify browser-to-edge HTTP/2 on the actual SSE route before enabling live audiences.

Browser fallback has explicit switching: before each stream attempt, any fallback fetch/timer is
cancelled; after a healthy application/heartbeat no fallback polling runs. On failure polling and
reconnect backoff begin; background/offline pages suspend public delivery. Own-state reads and manual
history pagination remain separate; media and A4 fallback polling follow the stream's health
(see [room signals](#media-and-a4-room-signals)). Allowlisted community/media and
bootstrap reads now use [delivery admission budgets](media-delivery-controls.md#shared-network-admission),
replacing the earlier 600/min shared-IP read restriction for those routes. Protected writes retain
their own limits. The isolated SSE harness raises the general API allowance for its trial; that
configuration does not establish hosted whole-app shared-network or authenticated-write capacity.

Do not point LISTEN at a transaction pooler (including port 6543, rejected when enabling this flag).
Use the actual direct/session path with runtime credentials, TLS and fixed
`pg_catalog,yaparena,pg_temp` search path. Provider hostname/custom-role suffix and pooling mode must
be verified rather than inferred from the port. See Supabase's
[connection-method documentation](https://supabase.com/docs/guides/database/connecting-to-postgres).
The new tables use explicit runtime DML grants, backend-only RLS and retention/room indexes;
the trigger is SECURITY INVOKER with no public EXECUTE grant. Runtime cannot own objects, bypass
RLS, assume owner roles or modify the migration ledger. No browser grants or Data API access are added.

## Retention and observability

Stream references retain seven days independently of chat and moderation evidence. A single-flight
minute job removes at most 1,000 expired references across at most ten sorted rooms, advancing each
room's `retained_after` floor in the same transaction. At most 100 empty orphan room counters are
cleaned afterwards using SKIP LOCKED. Recovery below the floor resets. The job uses the same bounded
statement/connection deadlines and retries on its next interval; downtime can leave a cleanup backlog.
Monitor oldest retained reference age and log size; a large backlog needs an authorized, bounded
operator cleanup using the same floor/lock invariant, not an unbounded DELETE. At sustained ten
mutations/sec seven days is about six million references, so hosted storage/IO capacity remains a
release measurement. Existing 365-day chat/evidence policies and open-case/appeal holds are unchanged;
chat/like cleanup now performs bounded public deletions which also allocate events.

Prometheus exports active `yaparena_community_streams`, `yaparena_community_rooms`, bounded-kind
`yaparena_community_delivery_total`, `yaparena_community_delivery_lag_seconds` and
`yaparena_database_pool_wait_seconds`, alongside existing process metrics. Kind labels include
listener connected/failure, snapshot, catchup, buffer pressure, admission refusal, read failure/limited,
invalid hint and retention failure; no room, account, cursor or IP labels are used. Delivery lag is
event occurrence to server output queue, not measured browser receipt or strictly commit latency.
The load trial reports client receipt latency separately. Stream lifetimes are excluded from ordinary
HTTP duration/count completion metrics. Listener logs use fixed sanitized messages; no URL, credential,
notification text or community body is logged. Ordinary pending-key query completion logs are suppressed.

Incident diagnosis should correlate pool wait, active counts, process RSS, listener failures, catch-up,
resets and buffer pressure. A rising room head with no catch-up after fifteen seconds indicates a
projection/pool/listener problem. Reconciliation should repair lost hints; repeated read failures close
streams and activate browser fallback. Repeated resets can indicate expired cursors, excessive lag,
profile projection resets or a deployment mismatch. Pressure on a few streams is expected slow-client
recovery; broad pressure requires capacity/proxy investigation. Preserve sanitized counts/timestamps,
never log bodies or replay references as evidence. Useful runtime-only aggregate SQL:

```sql
SELECT count(*) AS rooms, sum(cursor-retained_after) AS retained_span FROM community_rooms;
SELECT count(*) AS references, min(occurred_at) AS oldest_reference FROM community_room_events;
SELECT current_user, session_user, current_setting('search_path');
```

## Rollout, compatibility and rollback

Follow the existing isolation and release runbooks. Owner credentials belong only to the separate
operator migration process. First verify the target's applied ledger and runtime identity; then apply
the **new** additive migration before starting these assets/server. Applied migrations are not edited.
The room/log migration does not move schemas or repeat F04 provisioning. Initial legacy isolation
cutover requirements remain applicable if that migration is not yet present. ALTER TABLE/trigger
installation still takes locks, so measure migration duration in a disposable clone and select an
appropriate quiet window. Startup fails closed on an unsafe runtime identity or pending migrations.

Deploy the reviewed matching server/assets with `COMMUNITY_STREAM_ENABLED=false`, run HTTP/history
and private reconciliation checks, then enable in an authorized synthetic hosted trial. Reserve
connection capacity for `(web processes × 11) + worker pools + release/admin reserve` on the verified
session/direct route; the local two-process fanout trial does not size a hosted pooler. Render's actual
service `yaparena-staging-web` is **Free**, with automatic deployment off. The authorized
follow-up deployed SSE checkpoint `ab59ebb`, applied its additive migration and enabled the flag;
see the dated trial for actual evidence and subsequent combined release status. Treat this as staging, not an approved
live-event hosting plan. Subsequent [media delivery controls](media-delivery-controls.md) coordinate
clock advancement and provider repair in PostgreSQL. Process-local abuse counters and whole-app
hosted acceptance still prevent treating community fanout as approval to add web instances.

Rollback first disables the stream flag and restarts the web process; new clients switch to bounded
durable HTTP recovery. Retain the additive tables, triggers, keys and revisions, including the room
signal column and triggers, which earlier images ignore. The migration's down
refuses to destroy the log; use a forward fix. An earlier server with the prerequisite chat protocol
continues to have its writes captured by triggers but cannot serve `/updates` or new stream assets;
roll its assets back together and refresh clients. Before reverting to a server without keyed
submissions, pause chat and follow the prerequisite rollback warning in community operations.
Do not drop capture triggers, loosen runtime privileges or provide owner credentials as a workaround.

## Repeatable validation and hosted procedure

The local harness always creates a disposable SCRAM database with separate admin, owner and runtime
logins and synthetic accounts. It does not read `.env` or accept an external fixture URL. Default
mode uses PostgreSQL 18.4 Docker; `COMMUNITY_POSTGRES_MODE=host` uses an installed PostgreSQL 17/18
with a disposable cluster. Database isolation has its own `DATABASE_TEST_MODE=host` fallback. Both
clean up application processes and database resources even on failure. Physical/browser artifacts
and passwords remain outside Git. Commands used for this task:

```sh
npm run check
DATABASE_TEST_MODE=host npm run verify:database-isolation
COMMUNITY_POSTGRES_MODE=host npm run verify:community-delivery
```

`verify:community-delivery` builds and runs real concurrent transaction/rollback/NOTIFY tests, scoped
idempotency/conflict/allowance tests, current-visibility replay, authorized moderation/restoration,
manual matching and automatic media ending, retention gaps, snapshot/subscription barriers, killed
runtime listener recovery, default five-second missed-hint repair, independent Chromium sessions,
healthy-stream lost-HTTP/history races, accessibility/viewport/draft/pagination checks, and the load
harness. The load phase defaults to five minutes with 500 viewers, 50 rooms, authenticated ten writes/sec
(hot room two/sec), one additional subscriber in a second independent Node process, a 500-client
reconnect storm, actual SIGTERM/restart while committing a synthetic mutation, and ten real TCP
clients which stop reading. It asserts latency, recovery, memory, connection and cleanup budgets.
Set `COMMUNITY_SOAK_SECONDS=3600` for a longer release soak; CI uses a 30-second disposable smoke soak
in its integration path. A five-minute local run is not a long-duration hosted capacity approval.

Run hosted mutation/load/failure work in an authorized disposable staging environment, preferably
an isolated clone. If the authorized staging database contains existing trial data, take a backup,
record protected-row fingerprints and scope every selector/write/cleanup to unique synthetic
fixtures. The local orchestrator deliberately refuses hosted databases. Its separately enabled
browser harness permits the named staging origin only. Prepare synthetic published event/accounts
using the existing staging workflow, then:

1. Record reviewed commit/image, region, Node/PostgreSQL versions, provider plan, TLS/session mode,
   resource limits, replica/worker layout and approved capacity. Verify runtime identity on the actual
   listener and aggregate connection budgets without exposing URLs or passwords.
   Configure edge/access logs to omit query strings on private pending-key lookups, as the app's
   completion logger does; collect only sanitized timings/statuses for those requests.
2. Enable the flag on the clone, verify same-image migration compatibility, and run the read-only
   edge probe with an already-existing eligible synthetic UUID:

   ```sh
   BROWSER_BASE_URL=https://YOUR-STAGING-HOST COMMUNITY_EDGE_ROOM_ID=PUBLIC-SYNTHETIC-UUID \
     BROWSER_CHROME_PATH=/path/to/chrome node scripts/verify-community-edge.js
   ```

   This measures Chrome's actual CDP response protocol on readiness and SSE, first-frame timing,
   heartbeat receipt and anti-cache headers. Without a room it checks HTTP/2/readiness and reports
   stream-route availability only; it cannot establish SSE delivery. Test custom domains/CDNs as well
   as the provider URL. Use browser Network tools to prove one EventSource/page and no healthy fallback
   `/updates` polling. Proxy configuration alone is not evidence.

3. Use independent signed-in speakers/moderators plus anonymous desktop/phone viewers. Post, drop an
   HTTP confirmation, explicitly retry unchanged, load older history while removing content, disconnect
   a reader during moderation, restore by a different moderator, pause/resume, end via matching and
   automatic media clock, revoke topic publication, and verify drafts/anchors/status announcements.
   Exercise current Firefox/Safari, physical iOS Safari/Android Chrome, multiple tabs and accessibility
   tools. Verify own selections never appear in another viewer's fanout.
4. Reproduce the declared load with the same rate/account/session distribution and stream reader
   behavior as `verify-community-load.ts`, against the clone only. Record pool wait, lag histograms,
   RSS and throughput. Stop ten readers, reconnect 500 clients with application cursors, terminate the
   runtime LISTEN session through the authorized admin process, deliberately suppress wake-ups, restart
   and deploy the reviewed process while a sender writes. Verify reset after log expiry and release
   of zero-viewer rooms. Extend to the approved soak duration; do not raise limits to make it pass.
5. Archive sanitized measurements, client/proxy protocol/timings, commands, environment, versions,
   build identity and failures in a new trial record. Keep failed/partial criteria explicit. Approval
   of this transport does not close database-isolation, media, privacy, accessibility, financial or
   hosting-plan gates. See the accompanying delivery trial record for evidence actually performed.

Actual commands, failures, measurements, hosting observations and source hashes are recorded in the
[durable delivery trial](community-delivery-trial.md).

Room reads capture their subscriber cohort before choosing its minimum cursor. Subscribers
joining while that read is in flight are excluded from that projection and mark the room dirty
for another read using their own cursor. This prevents a reconnect with an older cursor from
skipping the first durable batch. Closed subscribers are skipped. Unit and real-PostgreSQL tests
hold a read after projection, add the older subscriber, and require all intervening messages.

## Authorized hosted browser procedure

`scripts/verify-community-browser.ts` defaults to loopback PostgreSQL. The explicitly enabled
`BROWSER_HOSTED_SYNTHETIC=1` mode is restricted to the existing HTTPS staging origin and a
certificate-validated port-5432 operator connection; it verifies the distinct owner identity.
Supply `DATABASE_FIXTURE_URL` only to that one-off trial process, with `sslmode=verify-full`
and a readable CA certificate path. Never add that URL to the Render web environment.
Set `BROWSER_BASE_URL=https://yaparena-staging-web.onrender.com`,
`COMMUNITY_DURABLE_TRIAL=1` and an ignored `BROWSER_ARTIFACT_DIR`, then run
`node scripts/verify-community-browser.ts`. It creates synthetic accounts/topic/event, tests
independent sessions, stream/HTTP races, moderation and lifecycle, and cleans its scoped rows.
Keep the trial log and postflight database counts. The operator must have the separate hosted
change authorization and backup required by the staging runbook before running it.

The hosted-capacity module `scripts/verify-community-hosted-capacity.js` accepts separate owner
fixture and runtime-observer connections from an authorized operator runner, rather than loading
web secrets itself. Its fixed stage/role guards exercise 500 HTTPS streams in 50 synthetic rooms,
ten committed SQL mutations/sec, reconnect and an optional provider restart. This measures hosted
fanout capacity; SQL fixture mutations do not establish hosted authenticated HTTP write throughput.
It reports actual restart duration independently of catch-up, enforces delivery/memory/session
budgets, keeps failed attempts visible, and deletes only its tagged fixture data. Preserve baseline
fingerprints and operator records, and combine it with the real HTTP browser journey.

The hosted-capacity runner also records process CPU over the measured steady-load interval,
maximum observed event-loop p99 and average pool wait. These are process observations, not
provider CPU entitlement/throttling evidence. A matched paid-plan comparison is required
before extrapolating the Free result. When configuring deployment, read every paginated
provider environment page before preserving/replacing variables; the staging canary has
more entries than Render's default 20-item page.
