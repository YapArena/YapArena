# Media delivery controls and automatic replay integration

The 2026-10-07 implementation removes shared-network media polling and clock
coordination code gaps. Automatic replay is described in [replay automation](replay-automation.md).
These are implementation changes, with the local evidence below. They are not
approval for financial activity or evidence of hosted media capacity.

Current evidence note — 2026-10-15: the [hosted replay report](replay-starter-trial-2026-10-07.md)
supersedes the pre-deployment status below. An existing paid encoder converted and automatically
published real LiveKit recordings, recovered after graceful cancellation/replacement, and processed
the eligible staging catalog. Matching web/worker builds were last saved at `b11a11b` on October 15.
This does not establish abrupt host loss/OOM, maximum-duration/4K capacity, physical-device,
acoustic or sustained 510-participant acceptance. Local results below retain their original scope.

## Provisional operating envelope

The existing provisional media target remains 500 viewers across five simultaneous
debates, ten speakers and five recordings. Browser/device acceptance remains the
current and previous supported Safari, Chrome and Firefox versions, including the
physical devices listed in the media trial plan. The available iPhone 15 Pro can
establish its own device results; it cannot establish iPhone SE 2 or Pixel 4a results.
No new production limit or transcoding latency objective has been approved.

Media clock status uses HTTP. The one public community SSE connection per event page
carries reference-only `media` [room signals](community-delivery.md#media-and-a4-room-signals):
the page re-reads status on a signal, about two seconds after a known turn deadline, and
every 60 seconds while that stream is live; without it, speakers poll every two seconds and
viewers every six. Viewer polling stops in background, all polling stops offline, and a single
chain resumes on foreground/network/cache return. Community polling remains confined
to degraded community delivery.

## Shared-network admission

Allowlisted public pages/assets, public discovery/media/community reads and necessary
authenticated bootstrap reads use a separate delivery budget. Read classification
does not authorize an event or reveal personal state: the existing routes still
validate publication/topic eligibility and authentication. SSE admission stays separate.
Authentication mutations, speaker tokens, lifecycle/moderation/chat/like writes and
other protected writes retain their existing origin, authorization and rate controls.

The `yap_media_guard` cookie is a necessary abuse-control lease, independent of
product measurement consent. It contains an opaque random value, expiration and
HMAC signature; it conveys no account or authorization privilege. It is HttpOnly,
SameSite Strict, Secure in production and expires after 15 minutes. The signing
context is domain-separated from the existing runtime media secret. No guard value
or IP is stored in PostgreSQL, public payloads, telemetry, metric labels or logs.
Server counters contain hashed network keys and opaque lease/room keys in bounded
process memory. Cookie deletion is rate-limited by separate issuance budgets.

| Scope, fixed one-minute window          |  Reads | Viewer grants | Playback reports |
| --------------------------------------- | -----: | ------------: | ---------------: |
| One lease and event room                |     90 |             8 |               30 |
| Entire browser lease                    |    450 |            40 |              150 |
| Shared network (IPv6 prefix normalized) | 45,000 |         3,000 |           15,000 |
| Process                                 | 60,000 |         6,000 |           30,000 |

Issuance is capped at 2,000 leases/network/minute and 6,000/process/minute.
There are at most 6,000 browser/room counter buckets, 2,000 network buckets and
128 concurrent delivery responses. Expired buckets are reclaimed lazily; overflow
scans occur at most once/second/map. Finish/close releases response capacity once.
Pressure returns 503 with Retry-After 1; rate exhaustion returns 429 with Retry-After 60.
Clients recover by fresh reads/reconnect backoff; no mutation allowance is consumed.
These ceilings are abuse/memory limits, not a promise of 6,000 concurrent viewers.
Counters remain process-local: this does not establish whole-app multi-instance abuse
protection or remove the need to review authentication/write shared-IP policies.

## Clock and provider ordering

The database supplies clock time while locked; Node wall-clock skew does not decide
a turn or end. Due rooms are ordered by deadline and UUID. A transaction-scoped,
nonblocking PostgreSQL advisory lock permits one clock advance job at a time across
processes. Each room's existing debate-before-media row locks and deadline recheck
prevent a repeated due scan from advancing twice. The ownership transaction contains
no provider calls, no viewer connection and no durable uncommitted public payload.
Room changes still commit through their existing atomic community lifecycle triggers.

All production API, webhook and clock speaker-permission calls use canonical
reconciliation, rather than the caller's captured side. A separate per-room advisory
lock serializes provider calls; current eligible database state is read before and
after the call, with bounded revision/generation retries. No business writer acquires
this lock, so it cannot invert business row lock order. Transaction locks release on
commit, rollback, connection loss and process death; broken borrowed connections are
discarded. The pool uses runtime credentials and startup identity verification.

RoomService requests time out after two seconds, Egress requests after five seconds.
Matching permissions are skipped, and null/invalid speaker metadata never grants a
microphone on pause/end. Transient permission failure pauses a running debate rather
than treating a failed side assignment as successful. There are at most 16 room
permission tasks. Timers use monotonic process time for reconciliation scheduling.

Every five seconds the process repairs up to eight active/paused rooms and separately
four recently ended rooms, using independent round-robin cursors. Thus recent endings
cannot starve active rooms. Within five active rooms, inspection occurs each interval;
with more than eight active/paused rooms, the inspection bound is
`ceil(room_count / 8) * 5 seconds`, plus pool/provider latency. Recently ended rooms
remain eligible for ten minutes. These scans repair missed work after restart.

Provider mutations cannot commit atomically with PostgreSQL and LiveKit has no
application-revision fencing API in this implementation. A provider request already
in flight when its database connection is lost can complete later. Canonical retries
and periodic repair converge after service recovery; this is not strict remote
linearizability or a guarantee of instantaneous revocation during a provider outage.
Whole-app multi-instance readiness remains a separate release gate.

Processing recordings are checked in bounded batches every 30 seconds, independently
of signed webhook receipt. A UUID keyset cursor rotates through five recordings per
batch; one failed or unfinished recording cannot starve later inputs. With `N` pending
inputs, inspection takes at most `(ceil(N / 5) + 1) * 30 seconds`, plus bounded provider
and pool latency. Recovery requires the matching completed Egress result,
expected filename, nonzero exact object length and current ended media state.
Partial/aborted recordings never become verified replay sources. Persistent external
failure remains observable; no automation can create a missing/corrupt recording.

Shutdown marks maintenance stopping, prevents additional recording-stop work, drains
the coordinator and SSE resources, then closes HTTP and database pools. Every service
entry point has a ten-second hard shutdown deadline. Encoder requests/children abort
and durable leases recover abrupt termination.

## Dedicated encoder deployment

The web process never encodes. The separate `node dist/replay-worker.js` entry point
verifies the runtime database identity and migration ledger, uses its own pool of two
connections with 1,500 ms acquisition/query timeouts, and starts the durable queue.
Use only normal runtime DB, LiveKit and bucket credentials plus the replay edge/signing
configuration. Never add database owner credentials or Cloudflare deployment tokens.

Enable `MEDIA_REPLAY_PACKAGING_ENABLED=true` on the web and encoder after migration
and private-edge validation. `MEDIA_REPLAY_EDGE_ROOMS` restricts both encoder jobs and
web adaptive access during a canary; omitting it enables the eligible catalog.
`MEDIA_REPLAY_CONCURRENCY=1` is the provisional default (hard maximum two).
Job/input/output limits are documented in `.env.example` and replay automation.

CI publishes the encoder image (`ghcr.io/yaparena/yaparena-encoder`) with FFmpeg and
ffprobe for every `main` commit; see [the CI-published images](render-staging.md#deploy-the-ci-published-images).
A worker built from source by Render's Docker runtime instead needs
`MEDIA_WORKER_TOOLS=true`, which Render maps to the Docker build argument that installs
them; the web image default omits them. Either way, set Docker Command to
`node dist/replay-worker.js`. A self-managed Node 24 host can install FFmpeg instead.
The application does not require a local Docker daemon. CI verifies both image variants.
See [Render Docker configuration](https://render.com/docs/docker).

On Render, a separate continuously running encoder requires paid background-worker
compute. Adding that service is distinct from upgrading the existing web service or
workspace. The separately configured staging worker is recorded in the hosted report; the Blueprint
still provisions only the web service. The six-second local
sample is insufficient to approve the cheapest worker for maximum-duration/4K inputs;
validate CPU, memory, disk, queue wait and encoding time on the intended compute first.
The current Free web restart limitation and hosted soak requirements remain recorded
in the community delivery evidence. See [Render compute plans](https://render.com/docs/compute-plans).

For the full 500-viewer/five-debate trial, confirm LiveKit participant and five concurrent
Egress limits and Workers request quota before starting it. No plan upgrade is needed
to implement or locally verify this code. No hosted 510-participant capacity claim is made.

## Performed local evidence

Commands run in the isolated integration checkout, Node 24.19.0/macOS, PostgreSQL
17.10, FFmpeg 9.0.2; no production data and no Docker daemon:

```sh
npm run check
DATABASE_TEST_MODE=host npm run verify:database-isolation
REPLAY_POSTGRES_MODE=host npm run verify:replay-pipeline
COMMUNITY_POSTGRES_MODE=host COMMUNITY_SOAK_SECONDS=30 npm run verify:community-delivery
```

The integrated isolation verifier passed fresh/upgrade inventories (38 private tables),
browser-role denial, runtime-only journeys and 19 membership guard cases.
The replay trial passed real concurrent enqueue/claim, canary filtering, current-input
and ETag binding, fenced completion, rollback of publication/history/community cursor,
removal/visibility races, exhausted-attempt retention, restrictive deletion and cleanup.
Actual six-second no-caption conversion produced three qualities/13 files/3,060,005 bytes
in 1.823 seconds while parallel validation was running; sampled encoder RSS was 101 MiB,
trial Node peak 113.42 MiB. A real DB-heartbeat stall drained in 1,515.55 ms against eight
seconds. Storage in this trial was an explicitly synthetic in-memory adapter.

Final repeat on implementation commit `fae50da641255afda0971e69e69c157a2d8a36a2`
passed: conversion 0.745 seconds/98.13 MiB sampled encoder RSS, 13 files/3,058,877 bytes,
96.23 MiB trial Node peak, stalled-heartbeat shutdown 1,515.15 ms. The quality gate
passed 377 tests with 94.85% lines, 92.18% branches and 94.46% functions. All five
[CI jobs](https://github.com/Boufe/YapArena/actions/runs/37652828898) passed, including
both production image variants/scans and PostgreSQL 18.4 integration checks.

The actual Express app trial admitted 500 anonymous leases on one IP across five rooms:
5,301 HTTP requests including event pages, CSS, auth bootstrap, chat/personal-like reads,
real synthetic-key JWT generation and repeat media polling. Public delivery had zero
admission refusals; 300 unauthorized protected writes returned 401 and the 301st returned
the expected 429. Combined bootstrap/token and polling samples had p95 21 ms. Runtime
pool connections peaked at ten. Two independent processes proved lock exclusion and
SIGKILL recovery (26.6 ms), and forced backend loss discarded its connection. Concurrent
due clocks with Node time one hour behind advanced each room only once.

The final repeat on that implementation commit passed 5,301 requests at p95 27.03 ms,
zero public-delivery refusals, preserved protected-write refusal and 26.77 ms process-lock
recovery. Six real PostgreSQL processing recordings established that failed/unfinished
inputs on the first five-item page did not prevent the sixth from becoming verified.

The same disposable trial retained the existing multi-context community browser journeys
and 30-second 500-stream/50-room soak: 300 HTTP writes, 3,000 delivery samples, p95 213 ms,
reconnect 446 ms, restart 890 ms, peak process RSS 131.41 MiB, final zero streams and slow
client recovery. Those are local community measurements; they are not LiveKit media load.
The earlier hosted Free restart result (28.74 seconds) has not been superseded by a
matched paid trial. Raw sanitized logs remain in ignored local trial artifacts; rerun
the commands for evidence against an exact reviewed commit/hosted image.

The final 30-second community repeat passed 500 streams/50 rooms, 300 writes/3,000 samples,
p95 264 ms, reconnect 587 ms, restart 889 ms, peak RSS 129.89 MiB/growth 57.67 MiB,
460 slow-client stress mutations, ten buffer-pressure outcomes and zero final streams.
Desktop/mobile-emulation chat delivery was 998/1,000 ms, reconnect catch-up 81 ms and
moderation removal 473 ms. Mobile emulation is not physical-device acceptance.

After upload recovery commit `a1e67f603089ec7eea793df9a193672fa6cde286`, the full local
quality gate passed 385 tests (94.88% lines/92.25% branches/94.40% functions). The real
PostgreSQL replay repeat passed again, including 0.669 s conversion/97.8 MiB sampled
encoder RSS and 1,523.21 ms shutdown during a DB-heartbeat stall. Actual R2/private-edge
verification at 17:11 UTC passed conditional-write protection, pinned download mismatch,
marker-last validation and 240p/480p/720p delivery without captions. Three SDK streaming
failures recovered; all 15 synthetic objects were removed with zero remaining. Encoding
took 584 ms and upload/HEAD validation 6,054 ms. Earlier TLS/parser failures remain recorded.

The [hosted worker trial](replay-starter-trial-2026-10-07.md) supplies short-recording evidence for
actual R2 automatic publication, graceful worker replacement and removal/renewal. Still measure
abrupt host loss/OOM, full-duration encoding, a longer hosted soak,
browser/acoustic/physical-device behavior and the declared media load. Existing privacy,
financial and production replay-domain gates remain open. The implementation itself merged in PR #27.

## Diagnosis and rollback

For an explicit staging-only storage trial, build first and run:

```sh
node --env-file=.env.runtime scripts/verify-replay-storage.js
```

This requires `MEDIA_S3_ENDPOINT`, region/bucket/access/secret settings and
`MEDIA_REPLAY_EDGE_URL`/`MEDIA_REPLAY_SIGNING_SECRET`. It creates a fresh UUID-scoped
synthetic source and package, checks real conditional writes, pinned download, immutable
metadata/length, ready-marker ordering and no-caption delivery through all three edge
renditions, then deletes only those owned objects. It does not change application DB
state, deploy anything or establish browser/hosted-worker capacity. On cleanup failure,
the private temporary directory retains exact owned keys in `cleanup.json` for recovery;
never delete unrelated prefixes. Do not publish credentials or issued playback URLs.

`yaparena_media_control_total` uses bounded clock/permission/admission outcome labels;
pool wait and existing delivery metrics remain separate. Encoder logs contain bounded
event/failure codes, attempts and aggregate bytes/files, with no source URLs or credentials.
Inspect durable queue state and leases through an authorized private DB connection;
do not expose queue records through public fanout. Five exhausted attempts mark an input
failed and preserve its budget; alert on failed inputs instead of auto-publishing damage.

If encoding fails, inspect missing tools, resource ceilings, provider object completion,
lease/DB timeouts and input validation. If access fails, check the current DB-ready pointer,
edge canary scope, marker presence and signing configuration. If a speaker's permission
lags, check database pool wait, provider request failures and repair page population.

Roll back by stopping the encoder, disabling `MEDIA_REPLAY_PACKAGING_ENABLED` and
reverting to reviewed web code/configuration. Retain the additive migration and durable
cleanup tombstones; never undo it or restore stale ready pointers. Existing signed MP4
access remains available where eligible. Remove obsolete package objects through fenced
cleanup, after eligibility is revoked. Keep financial state and live-end timestamps intact.
