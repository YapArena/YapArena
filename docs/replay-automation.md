# Automatic adaptive replay packaging

This checkpoint replaces the manual packaging/publication prerequisite for eligible
recordings when automatic packaging is enabled in the dedicated encoder worker.
Caption review remains optional: an absent reviewed WebVTT file never blocks conversion
or replay publication. Existing approved captions accompany a package; a subsequent
approved caption change creates a new immutable package. This change adds no transcription
service and makes no claim about automatic caption generation or caption quality.
Worker startup verifies ffprobe, libx264/AAC encoding and HLS muxing before claiming a job;
missing tools/codecs fail startup, preserving durable attempt budgets.

Current evidence note — 2026-10-15: implementation merged in
[PR #27](https://github.com/Boufe/YapArena/pull/27). The
[hosted replay report](replay-starter-trial-2026-10-07.md) records the separate paid encoder,
successful no-caption provider conversion/publication, graceful worker replacement/retry,
removal/renewal/expiry and the October 8 all-eligible staging rollout. October 15 evidence verifies
the automatic-publication interface and matching builds. The local checkpoint results below are
historical evidence, not a statement that deployment is still pending.

The earlier operator workflow in [decision 0004](decisions/0004-live-debate-replay.md)
describes the prototype. This subsequent decision authorizes automatic **ended → replay**
publication after a verified adaptive package. It changes neither live-end timestamps,
financial participation closure, finalization, outcomes, nor approval for financial activity.
Only published, non-demo events under a published topic, with ended media and a verified
nonempty recording for the expected Egress key, qualify. Hidden/draft/cancelled/live events
remain ineligible; no encoder result overrides an operator visibility change.

The page describes automatic preparation while an eligible recording is converted and
hides the operator's Publish replay action for that path. Publication follows verified
package completion, so a ready source recording can still need conversion time. Services
with automatic packaging disabled and rooms outside its scope retain the manual fallback.
Publication makes Play replay available; viewers must click it to start playback.

## Delivery choice

Continue recording the verified room-composite MP4, then transcode offline to 240p,
480p and 720p HLS with aligned two-second H.264/AAC segments. LiveKit documents simultaneous
file and segmented outputs, but its [Egress API](https://docs.livekit.io/reference/other/egress/api/)
allows one segmented output and one encoding configuration per request. Therefore a single
documented direct HLS Egress request does not produce this three-quality adaptive ladder.
Several differently encoded concurrent Egress jobs would introduce additional live
recording resources and failure coordination. Offline MP4 conversion reuses the existing
verified source and keeps that work outside the live path. This is an engineering inference
from the documented API; it does not claim LiveKit can never deliver adaptive HLS.
See [LiveKit output options](https://docs.livekit.io/transport/media/ingress-egress/egress/outputs/)
and [FFmpeg HLS muxing](https://ffmpeg.org/ffmpeg-formats.html#hls-2).

The web service never starts FFmpeg. A separate worker requires Node 24, FFmpeg/ffprobe
with libx264/AAC, its own `yaparena_encoder` PostgreSQL login (never the runtime one; see
[the database isolation runbook](security/database-isolation.md)), private bucket credentials, and an
available authenticated replay edge/signing configuration. It requires no database-owner
credential or Cloudflare deployment token. Worker provisioning is separate from the web Blueprint;
the hosted report records the existing service. Main process/configuration/CI wiring is merged.

## Queue and publication invariants

Migration `1791385198189_automatic-replay-packaging.js` creates private RLS-protected
`media_replay_jobs` and `media_replay_attempts`. Runtime privileges are explicit; public
and browser roles receive none. Input bindings are immutable to runtime UPDATE.
Jobs bind a room, verified source key and SHA-256 digest of the current optional reviewed
caption text (absent text uses the digest of an empty string). A pinned source ETag is
required, and download uses `If-Match`. SHA-256 records the downloaded source bytes too.

Bounded periodic reconciliation discovers eligible inputs, repairs expired leases and
invalidates obsolete work. Claims use database time and
[FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html), without
holding a transaction during download, conversion or upload. One current input has one
durable job; each of its at most five attempts has a fresh UUID token and package prefix.
Backoff has jitter and is capped at 60 seconds. Process loss returns the job after lease
expiry; no stale token can renew or publish it. An exhausted input remains failed, so
retention cannot silently reset its attempt budget. A new source, approved caption change,
or newer authorized republication may produce a new input/job.
The optional room allowlist applies to enqueue, claim and all readiness/publication
operations: `undefined` permits all eligible rooms, while an explicit empty list permits
none. It is validated and copied, so a single-room canary never publishes unrelated events.

Domain removal/visibility/source/caption changes invalidate jobs in the same transaction
via private triggers, including event deletion. Cleanup tombstones deliberately survive
parent deletion. Final completion acquires **topic → debate → media → community room →
job → attempt** locks. Domain writers acquire domain/community locks before queue locks;
ordinary queue claims acquire only queue locks. Multi-row invalidation takes jobs in UUID
order. Completion rechecks source/caption bindings, visibility, current lease and writing
attempt while locked. It atomically sets the ready pointer and, only for an ended event,
sets replay status and records actor-less `automatic_replay` history. The existing
community lifecycle trigger writes its public cursor/event in that same transaction.
Rollback publishes none of those changes. Repeated completion creates no duplicate history.

Upload paths are allowlisted and attempt-specific. Generated files are validated for
nonempty regular files, checksums, aligned finite segment durations and complete VOD
playlists. Upload uses `If-None-Match: *`, followed by size/checksum-metadata verification
of every object. `ready.json` is written **last**, after a renewed lease/eligibility check.
The marker contains source/caption/manifest digests and aggregate file/byte counts, with
`reviewedCaptions: false` permitted. A marker alone never authorizes access: the application
requires a current database-ready pointer and current public authorization. A lost lease
or removal between marker write and completion leaves only an unreferenced prefix.

## Resource limits and shutdown

Library defaults are one job per encoder (hard maximum two), five-second polling,
60-second leases, 15-second heartbeats and a 30-minute whole-job deadline. A job accepts
at most 2 GiB of source, 7,200 seconds of media, 3840×2160 video and eight source audio
channels. It emits at most 4 GiB and 11,000 files; individual transport-stream segments
are limited to 4 MB. Fixed output bitrates/duration and a free-space preflight bound the
encoding budget. A 500 ms disk monitor aborts conversion on byte/file/segment limits,
and each rendition is rechecked before starting the next. Use a worker volume with an enforced disk budget and enough headroom
for simultaneous input/output; admission is per worker process, not a global host quota.
Validate full-duration/4K resource use before increasing concurrency.

Source downloads stream to a private temporary directory, never buffer the recording in
RAM. FFmpeg uses two encoder/decoder threads and one filter thread, no shell/stdin, bounded
stdout, a local-file input protocol allowlist and disabled external MP4 data references.
See [FFmpeg protocol restrictions](https://ffmpeg.org/ffmpeg-protocols.html). Source probing,
audio/video requirements, fixed output encoding and duration limits precede publication.

Shutdown aborts storage requests and encoder work, waits for child close (SIGTERM then
SIGKILL after two seconds), drains heartbeats and removes owned temporary files before
releasing upload protection. Configure the dedicated runtime pool with bounded acquisition
and query timeouts; the integration uses short timeouts to fit its eight-second graceful
encoder deadline and ten-second hard process deadline. Abrupt termination is recovered by
durable leases and cleanup, not an assumption that a shutdown handler always runs.

An abandoned attempt remains protected until its claim's whole-job deadline plus two
minutes, unless the worker has drained all I/O and explicitly releases protection. This
prevents deleting an old prefix while a paused writer may still be uploading. Cleanup
claims have their own fenced leases and bounded batches: at most 11,001 objects from that
exact attempt prefix, with no deletion of source MP4s, legacy manual packages or other
rooms. Partial deletion retries. Cancelled jobs are pruned after 30 days only once every
attempt has been cleaned. Ready and exhausted failed inputs remain retained while current.
Restrictive DELETE policies refuse removal of current ready/failed jobs or uncleaned
attempts. Event/source retention must invalidate database eligibility before object deletion.

Fresh grants are refused as soon as the database input/visibility becomes ineligible.
Existing issued credentials retain their configured maximum access window; this queue
does not shorten a five-minute HLS capability or a one-hour legacy MP4 URL. Package cleanup
can remove abandoned or obsolete objects earlier, so recovery always requests fresh access.

## Repeatable evidence

Run with Node 24 from the repository root:

```sh
npm ci
npm run check
npm run verify:media-packaging
npm run verify:replay-pipeline
# Optional native local cluster instead of disposable Docker PostgreSQL:
REPLAY_POSTGRES_MODE=host npm run verify:replay-pipeline
```

The pipeline trial defaults to disposable Docker PostgreSQL 18.4. Native host mode
requires PostgreSQL 17/18 tools (`initdb`, `pg_ctl`); both modes require FFmpeg on PATH.
It refuses other Node/PostgreSQL major versions, creates a disposable localhost
cluster and random synthetic identities, runs actual migrations as owner, verifies the
separate runtime identity, then performs all queue/application work as runtime. It reads
no `.env`, accepts no hosted database URL and writes no provider or external bucket state.
The object adapter is synthetic in-memory storage, explicitly not proof of S3/R2 behavior.

On 2026-10-07, macOS/local Node 24.19.0, PostgreSQL 17.10 and FFmpeg 9.0.2:

| Performed check                                                           | Result                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Concurrent enqueue/claim and source ETag binding                          | Passed with real PostgreSQL                                    |
| Injected publication rollback including community cursor/history          | Passed                                                         |
| Atomic automatic publication and repeated/uncertain completion            | Passed                                                         |
| Removal racing completion, stale lease, caption invalidation              | Passed                                                         |
| Event deletion tombstones, retry exhaustion and topic revocation          | Passed                                                         |
| Runtime-only RLS/grants and immutable bindings, bounded retention         | Passed                                                         |
| Actual automatic no-caption six-second 720p conversion/upload/publication | Passed; 13 files, 3,060,757 bytes                              |
| Conversion worker elapsed / sampled peak encoder RSS                      | 0.702 s / 97.34 MiB (two threads)                              |
| Trial Node process peak RSS                                               | 105.48 MiB, including synthetic object adapter                 |
| Separate captioned encoding trial                                         | Three decoded qualities; 14 files; aligned two-second segments |

Follow-up checks passed a real database-stall shutdown in 1,524.80 ms against an
eight-second deadline, a stuck encoder SIGKILL/close in 2,028 ms, restrictive deletion
policies, source-key replacement and room-scoped canary isolation.
Terminating the runtime publication backend during a controlled media-row lock wait also
passed: the worker handled the connection error, released the broken client, rolled back
publication and left no ready pointer. Integrated isolation verification additionally
passed all 38 private tables and 19 membership-guard cases.

The local Docker trial could not start because its existing daemon reported a containerd
temporary-directory I/O error; its trial container was removed. Native PostgreSQL 17
verification passed. Docker 18.4 execution is a runnable CI path requiring independent
evidence; no shared Docker VM restart or unrelated-container cleanup was attempted.

The RSS sample interval is 30 ms and may miss a brief peak. Six-second timings/memory
are not capacity predictions for full recordings or provider-hosted workers. Unit tests
also cover bounded child execution, private-file cleanup, partial/corrupt/immutable upload,
marker ordering, missing/oversized sources, revoked leases and graceful cancellation.
Record the exact integration commit, deployed image, limits and platform during hosted
validation; these local results belong to the isolated packaging checkpoint.

## Rollout, rollback and diagnosis

Immutable object transfers also have bounded recovery: at most three attempts per object,
fresh/closed file streams, 150/300 ms backoff with 25% jitter and the enclosing job's abort
deadline. A lost PUT acknowledgement is accepted only after HEAD verifies exact length,
SHA metadata and a unique nonce from that same upload invocation. A confirmed PUT with a
failed HEAD retries verification alone. Initial duplicate 412, foreign/mismatched proof and
authorization failures fail closed; recovery never overwrites an existing object. The ready
marker uses the same checks after the lease check and all media objects. This closes the
non-retryable SDK streaming failure observed in the actual staging R2 trial.

The repeatable actual-storage procedure is `node --env-file=.env.runtime
scripts/verify-replay-storage.js` after building; see [delivery controls](media-delivery-controls.md)
for its explicit synthetic scope, environment and exact-prefix cleanup. The successful
2026-10-07 17:11 UTC trial on application commit `a1e67f6` recovered three SDK streaming
failures, converted a six-second no-caption source in 584 ms, and uploaded/HEAD-verified
13 files/3,063,201 bytes in 6,054 ms. Real conditional writes, pinned-source mismatch,
ready-marker ordering, unsigned 403 and all three edge renditions passed. All 15 owned
R2 objects were deleted and zero remained. Two earlier TLS failures and one trial-parser
failure are retained as failed attempts. This is local encoding with actual staging R2/edge,
not hosted-worker publication, browser playback, cache-hit or capacity evidence.

Apply the additive migration before starting the integrated encoder. Leave packaging
disabled until the image, runtime identity, private bucket permissions, edge signature
checks and source completion reconciliation are available. Then use synthetic eligible
recordings to verify automatic readiness/publication, missing-caption behavior, optional
caption replacement, removal, source retention, provider webhook loss, crash/restart,
storage partial failure and cleanup on the actual deployed route. Inspect queue ages,
failure codes, active/expired leases and attempt cleanup backlog with runtime access.
Logs use fixed event names and bounded codes; they exclude source keys, private caption
text, object URLs, raw encoder stderr and credentials.

Pause/stop the encoder for rollback. Keep both tables/triggers and pending cleanup work;
the migration intentionally refuses a destructive down migration. The API can continue
to use eligible already-published packages, with the current authorization gate. Existing
MP4 fallback is degraded delivery and does not meet the adaptive acceptance requirement.
Never rewrite a ready prefix, delete queue tables while object cleanup is pending, or
restore a removed recording solely because a stale worker completed.

Actual storage conditional-write and edge access/expiry checks are recorded in the local-storage
and hosted reports. Observed cache-hit provenance remains unverified. Release still requires
full-duration worker soak, abrupt-loss/OOM and provider-reconciliation failure trials, and the
[playback envelope](media-playback-requirements.md), including provisional physical
iPhone SE (2nd generation)/Pixel 4a, browser cohorts, controlled recovery, capture-to-playback
delay and sustained media load. No current local check closes those gates or changes billing.
