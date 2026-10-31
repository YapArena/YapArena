# Low cost staging

The staging stack uses one Render web service, a separately configured replay encoder, Supabase
Postgres, LiveKit Cloud, and Cloudflare R2.
Since the [worker cut-over](#move-background-jobs-to-the-worker), a paid Render worker runs every
background job: clocks, revocation, wallet provisioning and cleanup. Supabase only hosts
PostgreSQL; the application continues to own accounts, sessions, and authorization. LiveKit carries
the live video and records it to a private R2 bucket. The browser reads verified adaptive replays
through the authenticated private edge; eligible recordings without a ready adaptive package retain
the signed-MP4 fallback. Playback starts on the viewer's click.

Latest saved web release: [PR #34](https://github.com/Boufe/YapArena/pull/34) records
`fc241e1` live on October 17 at 01:47:54 UTC, with read-only HTTP postflight at 01:48:24 UTC
and no worker change. The [hosted replay report](replay-starter-trial-2026-10-07.md) separately
records the existing paid `0.5c-512mb` encoder, October 8 all-eligible rollout and matching
web/worker builds at `b11a11b` on October 15. Those historical checks supersede no-encoder/
deleted-canary notes; they do not establish today's live versions or a matching build pair.
The October 19 documentation audit did not inspect live providers or deploy current main.
The October 22 [worker cut-over](#move-background-jobs-to-the-worker) put `8a80e44` live on the new
jobs worker at 17:41:59 UTC and on web, with `RUN_BACKGROUND_JOBS=false`, at 17:48:45 UTC.

`render.yaml` defines **one Free Render web service**, with `RUN_BACKGROUND_JOBS=false`, and the
paid `yaparena-staging-jobs` background worker that runs the jobs instead
([cut-over](#move-background-jobs-to-the-worker)). It does not create a Render database or the replay
encoder. Its start commands only start runtime processes; migrations run in a separate
operator process. Render Free has no pre-deploy command, so `render.yaml` disables automatic
deployment and the operator completes migrations before manually deploying the same reviewed
commit. A second migration URL in the web service environment would expose that privilege to a
compromised app and is prohibited. Keep each service to one instance. Review current provider
allowances and billing settings before use.

`render.yaml` builds the web service from the Dockerfile. CI also publishes the scanned web and
encoder images for every `main` commit; [deploy the CI-published images](#deploy-the-ci-published-images)
switches both services to those images, pinned by digest. After that switch, `render.yaml` only
describes a source-built service.

To roll out the matchmaking, Yap Coins turn window and live outline release (Decisions 0011 to
0013), follow the step-by-step [staging rollout](staging-rollout.md).

Production is a separate stack at `https://yaparena.com`, described by
[`render.production.yaml`](../render.production.yaml) and built with the
[production rollout](production-rollout.md). It shares no service, project, tenant, bucket or secret
with staging, and syncing one Blueprint never changes the other environment. Staging stays on Render
Free and out of search engines: a service without `PRODUCTION_SERVICE=true` sends
`X-Robots-Tag: noindex` on every response, and its `/robots.txt` disallows all crawling. Every release
runs on staging before production ([releasing](production-rollout.md#releasing-from-now-on)).

This is a small trial environment. Render Free sleeps after 15 minutes without inbound traffic and
can take about a minute to wake. An open debate page still sends the app requests at least once a
minute, but an instance restart can still interrupt the turn clock. The background jobs run in the paid jobs
worker, which does not sleep; moved back to web, they stop while web sleeps. Supabase Free can
pause after a week of low activity. Do not use this environment for promised live events or real user data.

## Create the database

1. Create a Supabase Free project in a region close to Render's Ohio region.
2. Disable Supabase's **Data API** for the project in the Data API integration settings. This app
   uses its own Express API and direct PostgreSQL queries; its tables are not designed for public
   access through Supabase REST or GraphQL.
3. Follow the [database isolation runbook](security/database-isolation.md) to inventory the project
   and provision distinct `yaparena_owner` and `yaparena_runtime` identities in an administrative
   operator process. Keep that process and its secrets outside Render web/worker environments.
4. In the project's **Connect** dialog, construct a **Session pooler** PostgreSQL URL (port 5432)
   for each custom login. Verify the custom-role username/project suffix supported by the actual
   pooler using a real connection; do not assume the default `postgres` URL authenticates the new role.
   This supports the app's persistent `pg` pool on an IPv4 network. Do not use the transaction
   pooler URL (port 6543) for this deployment. Replace the password placeholder without its square
   brackets, URL-encode reserved password characters, and use certificate-verified TLS with
   `sslmode=verify-full` and the provider CA configured through the approved secret/file mechanism. Keep
   the URL and password out of Git and chat.

## Deploy the web service

The historical Work Package 6 trial record does not establish the currently deployed branch,
credentials or API settings. Verify those in the provider dashboards and keep the
[measurement release sequence](measurement-operations.md#release-and-rollback-sequence) and
[operating trial record](operating-readiness-trial.md) as separate evidence.

1. Obtain the separate hosted-change/deployment authorization. Select a reviewed `main` commit
   whose CI run passed every job (including database isolation checks) and copy its web and
   encoder digests from that run's summary ([CI-published images](#deploy-the-ci-published-images)).
   For a source-built service, validate `render.yaml` with `render blueprints validate render.yaml`.
   Inventory and back up the target first. For an upgrade, stop traffic/background jobs while
   provisioning moves the existing public schema objects.
2. In a secured operator container or release runner, run `scripts/provision-database.ts` as the
   administrator using a provisioning-only secret environment. Next run the **same reviewed web
   image** with the owner URL as `DATABASE_URL`, in a separate one-off process:

   ```sh
   docker run --rm --env-file /secure/yaparena-migration.env \
     ghcr.io/yaparena/yaparena@sha256:WEB_DIGEST \
     node scripts/migrate-database.ts
   ```

   The protected file contains only the migration process's `DATABASE_URL`. Do not mount it in the
   web service or put it in a shared Render environment group. A nonzero result stops the release.
   For a source-built trial image, build the reviewed checkout and record its image ID/commit before
   using it for this step; confirm the web build uses that exact commit as well.

3. In Render, set the web service's image URL to that web digest, or create/update the Free web
   Blueprint for that reviewed commit if the service still builds from source. Confirm automatic
   deployments are off in the **actual service**, including existing services whose settings may
   differ from the file. Set `DATABASE_URL` to the **runtime** Session pooler URL. The Blueprint
   generates `METRICS_TOKEN`; metrics collectors and hosted verifiers send it as a bearer token,
   and `/metrics` returns 404 without it. For the landing headline font, add the secret file
   `landing-headline-font.b64` that `LANDING_FONT_FILE` points to
   ([landing page font](landing-page.md#deploying-the-headline-font)). Remove all
   migration/admin secrets and combined operator files from web/worker environments. Replacing the
   URL does not rotate the old shared owner password; handle old credentials/deployment copies under
   separately authorized credential rotation.
4. Manually deploy only after the owner migration job succeeds. Startup verifies the runtime
   database identity and applied migration list before serving traffic. Confirm `/ready`, sign-in,
   account roles, matching, notifications, moderation and measurement with synthetic staging data.
   Keep public HTTP checks separate from the hosted API-isolation checklist.
5. Record Dashboard Data API/exposed-schema facts and real anonymous/authenticated access probes
   in an authorized disposable clone as specified by the [F04 checklist](security/database-isolation.md#hosted-operator-checklist--required-to-close-f04).
   Keep F04 **UNVERIFIED** until these hosted checks are complete.

The first deploy has no media configuration and says so on debate pages. Seeded demo debates use
the older `preview-1` rules and cannot be used for a real media trial.

## Enable live video and replay

Public community streaming is a separate rollout gate. `COMMUNITY_STREAM_ENABLED=false` remains in
the Blueprint; enabling it requires an authorized hosted trial following the
[delivery guide](community-delivery.md#rollout-compatibility-and-rollback). Reserve one persistent
runtime LISTEN session per web process in addition to its ordinary ten-connection pool, verify its
actual direct/session-pooler identity, and measure Chrome's HTTP/2 protocol and timely frames on the
real SSE route with `scripts/verify-community-edge.js`. A file's port/settings do not establish these
facts. [Delivery controls](media-delivery-controls.md) now coordinate media clocks and shared-network
read admission, but process-local abuse limits and unverified whole-app scaling still require one instance.
The Free hosting plan does not become an approved live-event plan by enabling SSE.

1. Create a LiveKit Cloud Build project. Copy its HTTPS API URL, WSS browser URL, API key, and API
   secret. Create a private Cloudflare R2 **Standard** bucket and a bucket-scoped S3 key that can
   write, read, and HEAD replay objects. Keep all keys in the provider dashboards and Render.
2. Configure R2 CORS for browser GET requests from the exact Render HTTPS origin. Set LiveKit's
   webhook URL to `https://<staging-host>/api/media/webhook`; the app verifies webhook signatures.
3. Add **all** variables below to the Render web service together. Partial media configuration
   prevents the app from starting. Save and redeploy after all values are present.

| Variable                                        | Source                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`                                   | LiveKit Cloud HTTPS API URL                                                                                   |
| `LIVEKIT_PUBLIC_URL`                            | LiveKit Cloud WSS browser URL                                                                                 |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`         | LiveKit project credentials                                                                                   |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_PUBLIC_ENDPOINT` | R2 HTTPS S3 endpoint (same value for both)                                                                    |
| `MEDIA_S3_REGION`                               | `auto` for R2 S3; do not enter the bucket location hint such as ENAM. The app forces `auto` for R2 endpoints. |
| `MEDIA_S3_BUCKET`                               | Private R2 bucket name                                                                                        |
| `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`    | R2 bucket-scoped S3 credentials                                                                               |

The current media provider sends the same S3 key to LiveKit Egress and uses it for playback. A
single bucket-scoped key therefore needs write and read permissions. Split those permissions and
rotate staging credentials before a public launch. A new event under `prototype-media-1` is needed
for a live media trial. Use two test speakers on separate networks and verify join, turn changes,
pause/resume, recording completion, replay playback, captions, and reconnects.

If LiveKit Egress reports `CreateMultipartUpload` with HTTP 401, verify that
`MEDIA_S3_ACCESS_KEY` and `MEDIA_S3_SECRET_KEY` are the S3 credentials from an active R2 API token
with **Object Read & Write** access to `MEDIA_S3_BUCKET`. Confirm the S3 endpoint belongs to the
same Cloudflare account. Replace both Render secrets together and redeploy before starting a new
trial. [Cloudflare identifies 401 as missing or invalid credentials](https://developers.cloudflare.com/r2/api/error-codes/).

## Enable turn trading windows

[Decision 0012](decisions/0012-live-argument-outline.md) makes each live speaking turn one Yap Coins
trading window. Apply its migrations as the owner first, then deploy. Turn windows stay off until
`TURN_WINDOWS_ENABLED=true` is set on **both** web and the jobs worker (it requires
`COIN_SANDBOX_ENABLED=true`). Automatic voiding of a cancelled or under-review debate's open rounds,
five-day reveal and the refusal of debaters' own positions apply whenever the coin sandbox is
enabled. To check, start a debate with two test speakers and read
`GET /api/public/debates/<id>/windows`: a window with `turnNumber` 1 should appear within about a
second, cut off at the turn deadline, and a new one at each turn change. A user-created debate's
windows show `revealMode` `five_day`: they stay open but locked after their cutoff and settle 120
hours after the debate ends.

| Variable               | Default | Purpose                                                    |
| ---------------------- | ------- | ---------------------------------------------------------- |
| `TURN_WINDOWS_ENABLED` | `false` | One Yap Coins trading window per live turn; web and worker |

Yap Coins run in launch mode on staging as in production
([coin sandbox operations](coin-sandbox-operations.md#launch-mode-play-money-only)): no simulated
purchases or withdrawals, and turn windows as the only way to take a position. Seed the center and
promotional treasuries once per database before the first debate
([procedure](coin-sandbox-operations.md#funding-the-center-and-promotional-treasuries-d1)); until
then every answer is refused as paused. Set `COIN_SANDBOX_TRANSFERS_ENABLED=true` on the web
service only for a deliberate trial of the simulated money flows.

| Variable                           | Default  | Purpose                                                                      |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `COIN_SANDBOX_TRANSFERS_ENABLED`   | `false`  | Simulated purchases, withdrawals and error reports; web; never on production |
| `COIN_SANDBOX_TREASURY_ALERT_USDC` | `200000` | Worker warning and `/metrics` flag below this treasury balance               |

## Enable live transcription and captions

[Decision 0012](decisions/0012-live-argument-outline.md) adds a LiveKit Cloud transcriber agent.
It needs live video configured first, and the owner must apply the transcription migration
before deploying. Its secrets live in LiveKit Cloud and Render; never in the repository.

1. Generate a random ingest secret of at least 32 bytes (for example `openssl rand -hex 32`) and
   keep it in the password manager.
2. Stage the agent's build context outside the repository and create the agent once, in the
   region nearest the web service and the debaters: `us-east` for Render's Ohio region (the region
   cannot change later):

   ```sh
   node scripts/stage-transcriber.ts ../yaparena-transcriber-deploy
   cd ../yaparena-transcriber-deploy
   lk agent create --region us-east .
   ```

   `lk agent create` writes `livekit.toml` there; restaging keeps it. Later releases run
   `node scripts/stage-transcriber.ts ../yaparena-transcriber-deploy` and then
   `lk agent deploy ../yaparena-transcriber-deploy`.

3. Set the agent's secrets with `lk agent update-secrets` (each update restarts it). LiveKit injects
   `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; do not set them.

   | Agent secret                    | Value                                                                |
   | ------------------------------- | -------------------------------------------------------------------- |
   | `YAPARENA_INGEST_URL`           | The staging HTTPS origin, for example `https://<staging-host>`       |
   | `TRANSCRIPTION_INGEST_SECRET`   | The secret from step 1                                               |
   | `TRANSCRIPTION_PROVIDER`        | `deepgram` (LiveKit Inference) or `elevenlabs`                       |
   | `TRANSCRIPTION_SHADOW_PROVIDER` | Optional, the other provider, for the comparison trial               |
   | `ELEVEN_API_KEY`                | Only when either provider is `elevenlabs`                            |
   | `TRANSCRIBER_AGENT_NAME`        | Optional; defaults to `yaparena-transcriber`                         |
   | `CAPTION_UPDATES_PER_SECOND`    | Optional; interim captions per second, 1–10, default 4               |
   | `ANTHROPIC_API_KEY`             | Enables the AI outline (Claude Haiku 5.5); without it, captions only |
   | `OUTLINE_MIN_INTERVAL_MS`       | Optional; at least this long between outline calls, default 3000     |

4. On **both** web and the jobs worker, set `LIVE_OUTLINE_ENABLED=true`, the same
   `TRANSCRIPTION_INGEST_SECRET`, and `TRANSCRIBER_AGENT_NAME` if you changed it. Deploy.
5. Check with two test debaters who chose a language and agreed on their account's Profile tab. When
   the debate becomes ready, the agent joins within about a second (`lk agent logs`:
   `transcriber joined`). Captions appear under the video, and
   `SELECT count(*) FROM yaparena.transcript_segments WHERE debate_id=...` grows during each turn.
   With `ANTHROPIC_API_KEY` set, the "AI outline" panel fills within a few seconds of each
   sentence, and `lk agent logs` shows `live outline call` lines whose `cacheReadTokens` is above
   zero after the first call of a turn. A few seconds after each turn, a `window cleanup call` line
   (Claude Sonnet 5.5) appears and the turn's entry under "Earlier turns" changes to its final
   outline; `SELECT final_source FROM yaparena.outline_windows WHERE debate_id=...` shows `cleanup`,
   or `frozen` when no cleanup arrived within a minute.
   The agent leaves when the debate ends.

Never run the agent locally with `start` against the staging project and the production agent name:
it would compete for real debates. Use `lk agent dev` or a different `TRANSCRIBER_AGENT_NAME`.
Capacity per LiveKit plan is in the decision record; keep matchmaking's `LIVE_DEBATE_CAPACITY`
within it.

## Move background jobs to the worker

While `RUN_BACKGROUND_JOBS` is true (the default), the web process runs the one-second A4/coin
debate, media clock/recording-stop and speaker-revocation jobs and the hourly cleanup.
`node dist/worker.js` builds the same jobs from the
same factory (`src/services.ts`) and always runs them, whatever `RUN_BACKGROUND_JOBS` says. It
serves no HTTP and starts no community stream. The worker is paid compute and needs the separate
hosted-change/deployment authorization. Staging completed these steps on 2026-10-22; they apply to
a new environment or a repeat after rollback.

`scripts/release-account-render.ts` finds the jobs worker by exact name, type and workspace.
It suspends and resumes it with web and the replay encoder, requires the same runtime database
URL, and deploys the release SHA to it after web. Its `deploy` mode accepts
`RUN_BACKGROUND_JOBS=false` on web only while the jobs worker is running.

1. Create the worker from the `yaparena-staging-jobs` Blueprint entry (Starter or larger) and deploy
   the same reviewed commit as web, after its migrations. Give it the runtime `DATABASE_URL` and DB
   TLS settings used by web, never an owner/migration URL, plus web's `A4_MODE`/`A4_*`,
   `COIN_SANDBOX_ENABLED`, `TURN_WINDOWS_ENABLED`, `LIVE_OUTLINE_ENABLED`, `TRANSCRIPTION_INGEST_SECRET` and all `LIVEKIT_*`/`MEDIA_*` media and replay variables. Never give it
   `AUTH0_*`: Auth0 settings belong to web only, and the worker reads no `REDIS_*`. Keep
   `LOG_LEVEL` at `info` or more verbose, and keep web's `RUN_BACKGROUND_JOBS=true` until step 3.
   A new environment created from `render.yaml` starts web with `false`: set it to `true` first,
   or no process runs the media jobs until the worker has their settings.
2. Confirm the worker ticks. Its Render logs show `background worker started` with `media`
   matching web, then one `background job ran` line per job: `a4-recovery` within a second,
   `media-clock` and `speaker-revocation` with media, and `cleanup` after the first hour. Repeating errors block the cut-over, for example
   `A4 recovery tick failed`, `media clock failed`, `recording stop queue failed`,
   `speaker access revocation failed` or `... cleanup failed`. Render's metrics for the worker
   should show steady CPU/memory and no restarts. The worker has no `/metrics` endpoint, so its
   Prometheus counters (`yaparena_auth_journey_total`, `yaparena_media_control_total`) are not
   scraped.
3. Set `RUN_BACKGROUND_JOBS=false` on the web service in the dashboard, matching `render.yaml`.
4. Redeploy web if saving the variable did not start a deploy. Its `server started` log shows
   `backgroundJobs: false` and no `background job ran` lines follow; `/ready` returns 200. Check
   the worker log for new errors.

Rollback: set web `RUN_BACKGROUND_JOBS` back to `true` and redeploy web. Both processes then run
the jobs, as during steps 1–3; suspend the worker afterwards to return to a single process.
`render.yaml` declares `false`, so change the file too or keep Blueprint sync off while rolled back.

Both processes may run every job at once. PostgreSQL coordinates them: row locks and leases for
A4, recording stops and speaker revocation, advisory locks for the coin-debate and media clocks,
and idempotent cleanup deletes. A second process can wait on an account lock or skip an A4 session
for 30 seconds after a lock timeout; it does not repeat the settlement or clock step. One caveat
remains:

- **Media permission repair.** Each process repairs speaker permissions under a per-room advisory
  try-lock and gives up after about 12 attempts (1.2–2.4 seconds). When LiveKit is slower than
  that, the other process fails closed and pauses a running debate ("Speaker permissions
  unavailable"). One process used to deduplicate this work in memory. The risk stays after the
  cut-over because web API and webhook routes still reconcile permissions while the worker repairs
  rooms. Avoid live events during the cut-over and resume an affected debate as operator.

## Later scale-up

The Free setup is for functional trials. For reliable scheduled events, first upgrade the Render
web service so it stays awake. Database-backed clock ownership and canonical permission repair
now coordinate clock work across processes, but reliable compute and hosted recovery still need
validation. Move to a paid database with restore-tested backups before accepting real users. Add
alert delivery, load and media trials, and a shared rate limiter before scaling web instances.
Keep production in separate provider projects and credentials, as the
[production rollout](production-rollout.md) does. See
[decision 0004](decisions/0004-live-debate-replay.md) for open production media decisions.

## Deploy the automatic replay encoder

This is a separate service; the existing Free blueprint does not provision it. Creating a
Render background worker incurs paid compute. Select resources only after measuring representative
recordings; the local six-second test does not approve the smallest tier for two-hour/4K inputs.
An encoder already exists in the saved staging evidence; inspect that service before creating
another. The steps below describe fresh provisioning or a reviewed reconfiguration, not pending
per-recording operations or evidence that the Blueprint creates a worker.

1. Back up and apply `1791385198189_automatic-replay-packaging.js` through the isolated migration
   operator, then run the runtime database identity/isolation checks. Deploy the reviewed web
   commit with packaging disabled first. Keep the additive migration on rollback.
2. Create a background worker from the encoder image published by the same CI run as the web
   image (`ghcr.io/yaparena/yaparena-encoder@sha256:ENCODER_DIGEST`) and set Docker Command to
   `node dist/replay-worker.js`. That image already contains FFmpeg and ffprobe. A worker built
   from source instead needs `MEDIA_WORKER_TOOLS=true`, which Render maps to a Docker build
   argument; web images keep the default `false`. Never reference secrets in build arguments.
3. Give the worker only runtime database credentials, strict DB TLS/search-path settings,
   LiveKit credentials and private bucket credentials. Match `MEDIA_REPLAY_EDGE_URL`,
   `MEDIA_REPLAY_SIGNING_SECRET` and canary `MEDIA_REPLAY_EDGE_ROOMS` with the web service.
   No owner/migration/admin URL or Cloudflare deployment token belongs in either service.
4. Enable `MEDIA_REPLAY_PACKAGING_ENABLED=true` on worker and web for the synthetic canary.
   Start with `MEDIA_REPLAY_CONCURRENCY=1` and the bounded defaults in `.env.example`.
   The worker checks tools/codecs and runtime identity before claiming jobs.
5. Complete a synthetic recording and observe automatic verification, durable claim, conversion,
   immutable upload, validation and ended-to-replay publication. Kill/restart the encoder during
   a second job; confirm automatic lease recovery, no duplicate publication and cleanup of
   abandoned attempts. Test topic/event removal, renewal, seeking and optional/no-caption paths.
6. Record exact commits/images, worker plan, CPU/RSS/disk/queue age, conversion time and failures.
   Evaluate the remaining capacity gates before approving a production envelope; alert on exhausted
   jobs. Scope changes require explicit deployment review. The recorded October 8 staging rollout
   already removed the room allowlist on both services; it did not establish full-duration capacity.

After deployment, new eligible recordings are converted and published automatically. Initial
service configuration and incident response remain deployment operations, not a per-recording
approval step. Existing eligible MP4 replay remains the fallback until a verified package is ready.
See [replay automation](replay-automation.md) and [delivery controls](media-delivery-controls.md)
for queue invariants, limits, rollback and the unverified hosting/physical-device acceptance gates.

## Deploy the CI-published images

After `quality / check` and `container` pass on a push to `main`, CI publishes two `linux/amd64`
images; Render runs only that platform. Tagged `vX.Y.Z` releases still publish multi-platform web
images separately.

| Image                               | Contents                                  | Render service                          |
| ----------------------------------- | ----------------------------------------- | --------------------------------------- |
| `ghcr.io/yaparena/yaparena`         | Production web image                      | Web service, jobs worker, migration job |
| `ghcr.io/yaparena/yaparena-encoder` | Same build with `MEDIA_WORKER_TOOLS=true` | Replay encoder worker                   |

The `publish` jobs push each image by digest without a tag, scan that pushed digest with the
`container` job's Trivy settings, and only then tag it `sha-<full commit SHA>`. A failed scan
leaves no tag, and an existing tag is never moved. The CI run summary lists each
`image@sha256:...`; both images carry SBOM and provenance attestations. `publish` does not wait
for `integration`, so deploy only a commit whose whole CI run passed.

### Registry access

GHCR makes a new package private, even for a public repository: a linked package inherits the
repository's access permissions but not its visibility. After the first `main` publication,
choose one option for both packages:

- **Public (recommended).** On GitHub, open each package from the repository's **Packages** list,
  then **Package settings → Danger Zone → Change visibility → Public**. Render then pulls without
  credentials. The images contain only what the public Dockerfile builds from the public
  repository; build arguments are non-secret and `.dockerignore` excludes `.env` files. A public
  package cannot be made private again.
- **Private.** Create a personal access token (classic) with only `read:packages`. In Render's
  workspace settings under **Registry Credentials**, add a GitHub credential with your GitHub
  username and that token, then select it on both services. The token can read every package your
  account can read, so store and rotate it like other deployment secrets.

If a package with either name existed before this workflow, grant this repository write access
under the package's **Manage Actions access**, or the first publication fails.

### Switch the existing services

Render can change an existing service's source to a prebuilt image in place: **Settings → Build →
Source → Edit**, then choose an existing image
([Render changelog, 2026-04-30](https://render.com/changelog/change-your-services-backing-repo-or-image-in-the-render-dashboard)).
The service keeps its ID, `onrender.com` hostname, plan, health check and environment variables.
Its type cannot change, so the web service stays a web service and the encoder a background
worker. This has not yet been tried on these services.

1. On Render's **Blueprints** page, check whether this repository's `render.yaml` manages the web
   service. If it does, disconnect that Blueprint (its services remain) or turn off its automatic
   sync before switching. `render.yaml` still declares `runtime: docker`, and a Blueprint cannot
   change an existing service's runtime, so a later sync would conflict.
2. Migrate with the chosen web digest as in step 2 of [deploy the web service](#deploy-the-web-service).
3. Switch the web service to `ghcr.io/yaparena/yaparena@sha256:WEB_DIGEST`, selecting the registry
   credential if the package is private. Keep Docker Command `/bin/sh /app/scripts/start-staging.sh`,
   health check path `/ready` and every environment variable. Render deploys the image after the
   change; confirm `/ready` and the smoke checks.
4. Switch the `yaparena-staging-jobs` worker to the same web digest and keep Docker
   Command `node dist/worker.js`. Confirm its `background worker started` log line.
5. Switch the encoder to `ghcr.io/yaparena/yaparena-encoder@sha256:ENCODER_DIGEST` from the same CI
   run and keep Docker Command `node dist/replay-worker.js`. `MEDIA_WORKER_TOOLS` only affected
   source builds and can be removed. Confirm the worker passes its tool, codec and runtime
   identity checks before it claims jobs.
6. If Render does not offer an image source for an existing service, create new image-backed
   services of the same type and plan instead. Copy every environment variable and set the Docker
   Command. A new web service gets a new hostname, so `APP_ORIGIN`, the LiveKit webhook URL and
   the R2 CORS origin must follow it. Delete the old services only after the new ones pass.

### Deploy a later commit

1. Copy the web and encoder digests from a `main` commit whose CI run passed every job.
2. Migrate with the web digest as in step 2 of [deploy the web service](#deploy-the-web-service).
3. Change each service's image URL to its new digest and save. Use digests from one CI run so web,
   the jobs worker (web digest) and the encoder match. Confirm `/ready`, the jobs worker's startup
   log and the encoder startup checks.

Prefer the digest. The `sha-<full commit SHA>` tag is an acceptable pin because the workflow never
moves it, but anyone with write access to the package could. A deploy hook with an `imgURL`
parameter deploys an image without changing the saved image URL, so a later manual deploy returns
to the saved one; change the URL in settings instead. To roll back, set the previous digest.
Render's rollback also needs that image in the registry, so keep published package versions.
Migrations are additive and are not rolled back.
