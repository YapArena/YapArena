# YapArena

YapArena is a live debate platform in development. It currently provides a Node.js 24,
strict TypeScript, Express, and PostgreSQL service with authentication, migrations, tests,
monitoring, container releases, public discovery, wallet sign-in, profiles, follows, topics,
nonfinancial debate matching, community chat/likes/moderation, consented measurement, and live
media with an optional automatic adaptive replay pipeline. Synthetic hosted trials cover recording,
replay conversion/publication and selected browser recovery paths; production and physical-device
acceptance remain open. The messages API remains an example feature. A4 play-money rounds, persistent Yap Coins and labeled Bots mode are described in the
[financial operations guide](docs/financial-operations.md). Real-money markets, creator
incentives and sponsor workflows remain unimplemented.

## A4 play-money rounds

Set up the owner/runtime database boundary, apply the new migrations, then follow
[local play activation](docs/financial-operations.md#local-activation-and-exercise).
Ordinary Yap Coins play (human runs and the account-wide balance) is retired and its ledger
frozen read-only under [decision 0010](docs/decisions/0010-single-ledger.md); past runs and
balances stay readable. Bots mode continues: open `/coins` or the participation panel on a
published debate to start a labeled bot run. Its play funding is recorded, nonredeemable
issuance, and it defaults to 500 synthetic participants.
See [A4 rules](docs/a4-mechanism.md), [decision 0007](docs/decisions/0007-a4-adjusted-ftm.md)
and the [financial implementation plan](docs/financial-implementation-plan.md).
Default activation is disabled; no hosted migration or deployment follows from this change.

## Product direction and document authority

The [YAP Arena product PRD](docs/product-prd.md) defines the planned product. Its
[specification outlines and release evidence](docs/product-specification-outlines.md) identify
the financial, privacy, instrument, and eligibility decisions that still require approved
specifications and proof. When product guidance differs from the older
[service template PRD](docs/template-prd.md), follow the product PRD for YapArena behavior.

The planned first paid release includes two real-money crypto markets together: a debate-event
market and a continuing ideas market. People sign in with Auth0, using an email code or Google
([Decision 0009](docs/decisions/0009-auth0.md)); signing in never authorizes financial activity.
The PRD does not authorize accepting funds. Prototypes and simulations may precede launch, while
real-fund activation depends on the companion document's evidence checklist and qualified
jurisdiction-specific review.

The companion document is an outline, not an approved technical design. The next product work is
to settle the PRD's proposed and open decisions, then produce reviewable specifications for event
economics, hidden-tally protection, the ongoing instrument, and launch eligibility. Use the
worked examples and evidence requirements in those outlines to test each design. Both markets
must pass the combined release gate before the first paid launch.

The [nonfinancial implementation plan](docs/nonfinancial-implementation-plan.md) orders the
discovery, debate, replay, community, moderation, and operating work that can proceed while
financial specifications are resolved.
Its [current implementation and evidence](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence)
is the status index for future agents. Fetch and compare the checkout with `origin/main` before
treating an old branch or dated handoff as the current implementation; see [CONTRIBUTING.md](CONTRIBUTING.md).
The [public discovery decision](docs/decisions/0001-public-discovery.md) records the initial
HTML/API architecture and its release checks.
The [identity and social decision](docs/decisions/0002-identity-and-social.md) records account
ownership, wallet recovery limits, audit retention, and export/deletion behavior.
The [topic and event decision](docs/decisions/0003-topics-matching-events.md) records the
preview's challenge, scheduling, no-show, audit, and lifecycle rules.
The [live media decision](docs/decisions/0004-live-debate-replay.md) records prototype timings,
recording gates, incident behavior, and the validation still needed before a production media choice.
The [Auth0 decision](docs/decisions/0009-auth0.md) replaces Privy with Auth0 email-code and Google
sign-in, links the two only after a verified email code, and confirms sensitive operations by a
fresh sign-in.
The [low cost staging runbook](docs/render-staging.md) describes the Render app, Supabase database,
deployment procedure and LiveKit/R2 media integration steps. The
[hosted replay trial](docs/replay-starter-trial-2026-10-07.md) records the existing separate encoder,
the all-eligible staging rollout and the October 15 encoder verification. The
[shared discovery release](https://github.com/Boufe/YapArena/pull/34) records the later
October 17 web deployment; neither record establishes the services' live state today.

To work on YapArena, follow [Local development](#local-development). The original
[service template guide](docs/getting-started.md) records the older reuse workflow and its current
initializer/database-identity limitation; it is not a verified setup path for a renamed service.

Cloning a repository already creates its local Git metadata and configures the GitHub repository as
the `origin` remote. Do not run `git init` after `git clone`.

See the [operations runbook](docs/operations.md) for health diagnosis, migrations, backup, restore,
and rollback procedures. The [glossary](docs/glossary.md) explains recurring Git, npm, Docker,
database, CI, and release terms.

## Requirements

- Git
- Node.js 24
- npm
- Docker with Compose

Git downloads the repository and records source changes. Node.js runs the application and development
tools, npm installs JavaScript packages, and Docker provides PostgreSQL and a production-like runtime.
Node 24 is required so local and CI behavior match.

Confirm the tools are available before running the setup commands:

```sh
git --version
node --version
npm --version
docker --version
docker compose version
```

`node --version` must report a version beginning with `v24`. The other commands should print versions
without errors, and the Docker application or daemon must be running before any `docker compose`
command can start a service.

## Local development

Run these commands from the repository root: the directory containing `package.json`,
`package-lock.json`, and `compose.yaml`. If this is a newly generated project, run its initializer
first because the initializer updates `.env.example` with the new project and database names.

Create local configuration:

```sh
cp .env.example .env
```

This copies the committed example settings into a new `.env` file used only on this computer. It
contains development ports, a local-only database password, and the database connection URL. Docker Compose reads it automatically. `npm run dev` instead reads `.env.runtime`, described below. The
file is excluded by `.gitignore`; do not commit it or put production secrets in it. If `.env` already
exists, inspect it instead of overwriting custom local values.

Install the locked dependencies:

```sh
npm ci
```

Here, `ci` means **clean install**; it does not download or run the GitHub CI workflow. The command
downloads the exact package versions and integrity-checked files recorded in `package-lock.json` into
the generated `node_modules/` directory. It fails if `package.json` and the lockfile disagree, which
prevents this computer and automated CI from silently choosing different dependency versions. Unlike
`npm install`, it does not update the lockfile and it replaces an existing `node_modules/` directory
with a clean installation.

Start PostgreSQL and apply pending migrations:

```sh
docker compose up --detach --wait db
docker compose --profile release run --rm --build provision
docker compose --profile release run --rm migrate
```

- `docker compose up --detach --wait db` downloads the PostgreSQL image if needed, creates the local
  database container, leaves it running in the background, and waits until its health check passes.
  Its data remains in a Docker volume between restarts.
- `provision` creates/adopts separate owner and runtime identities in a one-off administrative
  container. `migrate` applies pending migrations in a different container using only the owner login. A migration is a
  versioned code change that creates or alters database tables. `--rm` removes only the temporary
  migration container after it exits; it does not remove the database or its stored data.

Start the API with automatic reload:

Create a separate ignored `.env.runtime` file with only the runtime `DATABASE_URL` and application
settings from `.env.example`; omit all operator passwords, fixture and migration URLs. For an
unchanged local setup, the minimum contents are:

```dotenv
DATABASE_URL=postgresql://yaparena_runtime:local-runtime-only@127.0.0.1:5433/yaparena
APP_ORIGIN=http://localhost:3000
```

Adjust the URL to match your local runtime password, database and published PostgreSQL port. Then run:

```sh
npm run dev
```

`npm run dev` generates browser assets, watches frontend/shared sources, starts the TypeScript API
directly with Node.js, loads `.env.runtime`, and automatically restarts the API when its sources
change. `npm run build` checks strict operational and frontend types, compiles production server JavaScript into
the ignored `dist/` directory, and generates all browser modules and the four
bundles (`media`, `replay`, `hero-live` and `homepage`).
PostgreSQL must still be running in Docker. Open <http://localhost:3000/ready> to confirm the
API can reach the database. Press `Ctrl-C` to stop the API; the database container keeps running until
you run `docker compose down`.

### Frontend sources and checks

Handwritten frontend code lives in `frontend/**/*.ts`, including browser utilities and
`frontend/sw.ts`; new or substantially modified frontend code must use strict TypeScript.
Browser-safe shared TypeScript remains in `src/features/`. `public/` contains static assets and
ignored generated JavaScript, never authored JavaScript. Existing `/assets/*.js` URLs and `/sw.js`
are preserved.

Run `npm run typecheck:frontend` for the strict browser, service-worker and build-tool checks plus
source-policy enforcement. It is included in `npm run typecheck`, `npm run check` and CI.
`npm run build:frontend` regenerates assets; `npm run watch:frontend` watches them independently.
See [the frontend workflow](CONTRIBUTING.md#frontend-development) for adding modules, bundle entries
and worker boundaries. A language migration preserves the existing UI and behavior exactly;
separately requested product changes remain possible.

### Public discovery preview

Open <http://localhost:3000/> for the public home page, or visit `/debates` and `/topics`.
Anonymous visitors can search and browse published debates, topics, and speaker profiles.
The read-only JSON API lives under `/api/public`. It supports bounded `q`, `status`, `topic`,
`profile`, `limit`, and `offset` query parameters as applicable. Debate pages show only public
event fields; they never infer a winner or expose a hidden tally.

The [wide homepage](docs/wide-homepage.md) connects published topics, playable
debates, follows and the existing Yap Coins header to the supplied visual design.
Unavailable topic-market figures stay explicitly unknown. For local reference
comparisons only, enable `HOMEPAGE_REFERENCE_ENABLED=true` in the runtime-only
environment and visit `/home?reference=1`; this labeled sample mode is disabled by
default and forbidden in production.

[Shared bot discovery](docs/shared-bot-discovery.md) additionally supports stored,
clearly labeled heterogeneous simulations and opted-in settled mixed/observer
aggregates. Homepage and debate charts update together; Live remains accessible
from the header. Public simulations never spend account balances.

The database starts with no public records. To add fictional, clearly marked examples in local
development after migrating, run:

```sh
docker compose --profile release run --rm \
  --volume "$PWD/scripts:/app/scripts:ro" \
  migrate node scripts/seed-discovery.ts
```

The seed is idempotent and refuses `NODE_ENV=production`. It creates sample topics, speakers,
and listings only. A demo replay listing has no video. The one-off `migrate` service supplies the owner
identity for fixture writes; the read-only script mount supplies the seed, which is not included
in the production image. The running app keeps runtime credentials. The host script
`npm run seed:discovery` reads `DATABASE_URL` from `.env`, whose default runtime login lacks the
fixture writes. Use it only in a separate local operator process with an explicitly supplied owner
URL and the configured private search path. Refresh the pages after seeding. The old messages migration
and API remain for existing clients.
After a first successful visit, the public shell caches a short offline explanation. It does
not cache debate records; reconnect to see current content.

### Identity and social preview

Sign in with "Continue with Google" or "Continue with email" in the header or on
<http://localhost:3000/account>. Both go through Auth0 ([Decision 0009](docs/decisions/0009-auth0.md));
a Google sign-in for an address that already has an account links only after a verified email
code. Locally without Auth0 settings, run `npm run start:test-identity` and sign in at
<http://localhost:3000/api/test-identity>. Sign out ends only this device's session. The account
page's Active sessions list can sign out any one session you do not recognize.
See the [revocation contract](docs/security/account-session-revocation.md) for incident response
and deployment requirements.
Creating a profile starts a private draft; choose Public and save to publish it. Public people
and topic pages have follow controls. The account page shows your sign-in methods, follows,
recent identity activity and account notifications. Sensitive operations, such as a sandbox
withdrawal, are confirmed by signing in again; the confirmation expires after five minutes and
never authorizes anything beyond that one operation.

`APP_ORIGIN` must exactly match the browser origin, including the port, for the Auth0 callback
and cookie-authenticated writes. Review the
[identity decision](docs/decisions/0002-identity-and-social.md) before collecting user data:
automated export and deletion are not yet available.

### Topics and debate matching preview

Open <http://localhost:3000/match> after signing in and publishing a profile. Create a topic
draft, review its side mapping, and publish it. You can then issue a direct challenge or open a
queue request. A second speaker accepts or joins on the opposite side. The match page shows
requests, scheduled events, readiness, and account notifications. Speakers complete a camera and
microphone check on the public event page before readiness. An operator can record reschedules,
cancellations, and no-shows through the matching API, and control live, pause, end, and replay through
the media API or the event page. The [event decision](docs/decisions/0003-topics-matching-events.md)
states the preview policies.

Every created event stores an immutable snapshot of its platform rules version. No event in
this preview accepts funds, computes a paid cutoff, or publishes a winner. Historical demo replay
listings have no recording. New events use prototype media timings until product rules are approved.

### Local live debate and replay prototype

The optional media stack uses LiveKit, an Egress recording worker, Redis, and S3-compatible local
storage. Start it with `docker compose -f compose.yaml -f compose.media.yaml` and apply migrations
before starting the app; see the [media decision](docs/decisions/0004-live-debate-replay.md) for the
exact commands, controls, and validation limits. Local keys in the Compose override are development
only. A recording must be complete and verified in object storage before replay is eligible.
When enabled, the [automatic replay pipeline](docs/replay-automation.md) creates and validates
240p/480p/720p HLS, retries failed work and publishes eligible replay without a person approving
each recording. Optional reviewed captions accompany the package; absent captions never block
publication. Extensions remain disabled.

The [playback runbook](docs/media-playback-operations.md) describes connection preparation,
bounded recovery, HLS packaging, private authenticated edge delivery, telemetry and rollback.
The [proposed acceptance scope](docs/media-playback-requirements.md) and
[local trial record](docs/media-playback-trial.md) distinguish implementation checks from
physical-device and deployed performance evidence. Run `npm run verify:media-packaging`
with FFmpeg installed to verify the synthetic adaptive recording ladder.

The separate encoder starts with `npm run start:replay-worker` after building, applying the
additive migration, configuring the private replay edge and enabling
`MEDIA_REPLAY_PACKAGING_ENABLED=true`. Runtime credentials alone belong in its environment.
For native disposable PostgreSQL checks, run `REPLAY_POSTGRES_MODE=host npm run verify:replay-pipeline`;
the default verifier uses disposable Docker PostgreSQL. See
[delivery controls](docs/media-delivery-controls.md) for shared-IP budgets, clock ownership,
local evidence and hosted gates. On Render the encoder needs separate paid worker compute;
it never runs inside the web request process.

Run the quality gate:

```sh
npm run check
```

This runs lint rules, verifies formatting, the [tracked-file policy](CONTRIBUTING.md#evidence-and-status-records)
and strict types, and executes the test suite with its coverage thresholds.
CI runs this gate with database identities on every pull request. Before pushing, run the faster
`npm run check:fast`, which skips PostgreSQL suites and coverage thresholds.
CI means **continuous integration**: GitHub automatically runs checks on pushed changes.

The full check needs disposable A4, wallet and revocation database identities. To create them
and execute every database suite without managing URLs yourself, use:

```sh
A4_QUALITY=true npm run verify:database-isolation
# Alternative with PostgreSQL 17/18 tools on PATH:
DATABASE_TEST_MODE=host A4_QUALITY=true npm run verify:database-isolation
```

Each command provisions and removes its own databases, then runs `npm run check` with the
required identities. Without them, PostgreSQL suites skip and coverage can fail. For browser
changes, `npm run verify:browser` includes this full quality gate and the maintained browser
journeys; see [browser prerequisites and evidence limits](docs/browser-release-checks.md).

## Runtime configuration

Copy `.env.example` for safe local defaults. Production values belong in a secret manager or a
protected environment file, never in Git.

An environment variable is a named setting read when a process starts. Changing `.env` does not edit
source code, and a running process or container must be restarted before it sees a changed value.

| Setting                              | Local default                      | Meaning                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | `development`                      | Selects development or production security and error behavior.                                                                                                                                                              |
| `HOST` / `PORT`                      | `0.0.0.0` / `3000`                 | Select the network interface and port used by `npm run dev`; normally keep the local defaults.                                                                                                                              |
| `HOST_PORT`                          | `3000`                             | Selects the host port used to reach the API when it runs through Docker Compose.                                                                                                                                            |
| `LOG_LEVEL`                          | `debug`                            | Controls how much structured log detail the application emits.                                                                                                                                                              |
| `APP_ORIGIN`                         | `http://localhost:3000`            | Identifies the browser origin allowed to make cookie-authenticated write requests.                                                                                                                                          |
| `TRUST_PROXY`                        | `false`                            | Trusts no reverse proxy locally; production must use the exact trusted proxy-hop count.                                                                                                                                     |
| `REQUEST_BODY_LIMIT`                 | `10kb`                             | Rejects JSON request bodies larger than this amount.                                                                                                                                                                        |
| `API_RATE_LIMIT`                     | `300`                              | Limits general API requests from one client during each rate-limit window.                                                                                                                                                  |
| `AUTH_RATE_LIMIT`                    | `10`                               | Applies a stricter limit to sign-in starts, callbacks and confirmations during the same window.                                                                                                                             |
| `RATE_LIMIT_WINDOW_MS`               | `900000` (15 minutes)              | Defines the time window, in milliseconds, for both request limits.                                                                                                                                                          |
| `SESSION_DURATION_MS`                | `604800000` (7 days)               | Defines how long a signed-in server-side session remains valid.                                                                                                                                                             |
| `METRICS_TOKEN`                      | unset                              | Bearer token required by `/metrics` (32+ characters); production returns 404 for `/metrics` while it is unset.                                                                                                              |
| `AUTH0_ISSUER_BASE_URL`              | unset                              | Auth0 tenant or custom domain (`https://…`). Web service only; production refuses to start without the three Auth0 settings.                                                                                                |
| `AUTH0_CLIENT_ID` / `..._SECRET`     | unset                              | The Regular Web Application's credentials. Locally, leave all Auth0 settings unset and use `npm run start:test-identity`.                                                                                                   |
| `PRODUCTION_SERVICE`                 | unset                              | `true` only on the production web service: it refuses an `*.auth0.com` issuer and is the only service search engines may index. Every other deployment sends `X-Robots-Tag: noindex` and a `robots.txt` that disallows all. |
| `REDIS_SECURITY_URL` / `...`         | unset                              | Optional shared Redis abuse controls (`REDIS_SECURITY_URL`, `REDIS_NAMESPACE`, `REDIS_KEY_SECRET`); production requires TLS.                                                                                                |
| `POSTGRES_DB` / `POSTGRES_USER`      | project-specific                   | Name the local PostgreSQL database and its bootstrap administrator, separate from runtime.                                                                                                                                  |
| `POSTGRES_PASSWORD`                  | `local-development-only`           | Authenticates the local PostgreSQL user; never reuse this example password outside local development.                                                                                                                       |
| `POSTGRES_PORT`                      | `5433`                             | Exposes PostgreSQL on this host port while PostgreSQL continues to use port `5432` in its container.                                                                                                                        |
| `DATABASE_URL`                       | project-specific PostgreSQL URL    | Gives Node.js a complete database connection string; it must use the dedicated `yaparena_runtime` login, never the owner/admin identity.                                                                                    |
| `PROMETHEUS_PORT` / `GRAFANA_PORT`   | `9090` / `3001`                    | Expose the optional local monitoring interfaces on these host ports.                                                                                                                                                        |
| `GRAFANA_ADMIN_USER` / `...PASSWORD` | `admin` / `local-development-only` | Provide local Grafana sign-in credentials; replace them in every nonlocal environment.                                                                                                                                      |

See `.env.example` for local ports and monitoring settings, and the
[operations runbook](docs/operations.md#release-and-deploy-an-image) for production values.
Production runs at `https://yaparena.com` from [`render.production.yaml`](render.production.yaml), a
Blueprint separate from staging's [`render.yaml`](render.yaml); the
[production rollout](docs/production-rollout.md) lists every production variable and where its value
comes from. `APP_ORIGIN` is exactly `https://yaparena.com` there, with no `www`.

## Logging

Logs are JSON and include an `X-Request-Id` for correlation. Supply that header when tracing a
request across services; otherwise the API generates a UUID. Authorization and cookie headers are
redacted, including outgoing Set-Cookie and named error fields. See the
[logging incident procedure](docs/operations.md#credential-logging-follow-up-f01) for the limits
and outstanding historical-log review. Set `LOG_LEVEL` in `.env.runtime` for host development or
`.env` for Compose to control verbosity.

```sh
docker compose logs --follow app
```

Streams application-container logs continuously for debugging; press `Ctrl-C` to stop following the
logs without stopping the container. If the API is running through `npm run dev` instead, its logs
already appear in that terminal.

## API

Check liveness and readiness:

```sh
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

- `/health` checks whether the API process is alive.
- `/ready` checks whether the API and PostgreSQL are ready.

Inspect Prometheus metrics:

```sh
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics
```

The endpoint exposes Node.js process metrics and bounded HTTP request count and
duration metrics. When `METRICS_TOKEN` is set, requests must send it as a bearer
token. In production the endpoint returns 404 until the token is configured;
other environments without a token leave it open for local use. The local Compose
stack uses the fixed development token from `monitoring/prometheus.yml`. In a
deployed environment, also expose `/metrics` only to the monitoring network or
collector rather than the public internet.

### Local monitoring stack

Start the application with Prometheus and Grafana:

```sh
docker compose --profile monitoring up --detach --build --wait
```

- Prometheus: <http://localhost:9090>
- Prometheus alerts: <http://localhost:9090/alerts>
- Grafana: <http://localhost:3001>
- Dashboard: **YapArena / YapArena overview**

Grafana uses `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` from `.env`.
The example development credentials are `admin` / `local-development-only` and
must not be reused outside local development. Prometheus retains seven days of
metrics in a named volume; Grafana stores its local state in a separate named
volume.

Prometheus evaluates version-controlled alerts for API availability, HTTP 5xx
rate, and p95 request latency. The local stack has no Alertmanager, so it shows
alert state but does not send notifications.

Stop the stack while preserving its data:

```sh
docker compose --profile monitoring down
```

Sign in through the local test identity entry and save the session cookie. Start it with
`npm run build` then `npm run start:test-identity` (it refuses production and any Auth0
setting; real sign-in goes through Auth0 in a browser):

```sh
curl -X POST http://localhost:3000/api/test-identity/sign-in \
  -H "Content-Type: application/json" \
  -c /tmp/yaparena.cookies \
  -d '{"email":"user@example.com"}'
```

`curl` is a command-line HTTP client. `-X POST` selects the HTTP method, `-H` declares a JSON request,
`-d` supplies the JSON body, and `-c` saves the returned session cookie to a temporary file. The
example cookie path is under `/tmp`, so it is local and disposable; it is not a production session
store.

Create and persist a message as the authenticated user:

```sh
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -b /tmp/yaparena.cookies \
  -d '{"name":"Example User"}'
```

`-b` reads the saved cookie, authenticating this request as the signed-in user. The JSON body creates
and persists one example message owned by that user.

List messages with bounded pagination:

```sh
curl -b /tmp/yaparena.cookies \
  "http://localhost:3000/api/messages?limit=20&offset=0"
```

This sends an authenticated `GET` request. `limit=20` asks for at most 20 records and `offset=0` starts
at the first record. The response contains only the authenticated user's messages.

## Docker

After provisioning and migrating as described above, build and start the local production-like service:

```sh
docker compose up --build
```

Builds images and starts the production-like stack in the foreground, where the combined logs remain
visible. Press `Ctrl-C` to stop those containers. Add `--detach` if you want the stack to remain in the
background and return control to the terminal.

Tagged releases publish multi-architecture images to `ghcr.io/OWNER/REPOSITORY`. Each push to
`main` also publishes `linux/amd64` web and encoder images tagged `sha-<full commit SHA>`.
See [the operations runbook](docs/operations.md#release-and-deploy-an-image) for
the immutable-digest release and deployment procedure.

The template automates continuous delivery of a verified container artifact, but not deployment to a
particular cloud. Each product adds provider-specific continuous deployment because credentials,
approval gates, migration orchestration, health checks, and rollback mechanisms differ by runtime.

Check status and follow application logs:

```sh
docker compose ps
docker compose logs --follow app
```

- `docker compose ps` shows container state and health.
- `docker compose logs --follow app` streams application logs.

Stop containers while preserving database data:

```sh
docker compose down
```

Stops containers without deleting database volumes.

Change the HTTP host port when necessary:

```sh
HOST_PORT=8080 APP_ORIGIN=http://localhost:8080 docker compose up
```

Starts the stack with port `8080` exposed on the host and keeps browser-origin validation aligned with
the new URL. Put these values in `.env` if the change should apply to future Compose commands instead
of this one command only.

## Image security

Build and scan the production image for actionable high and critical vulnerabilities:

```sh
docker build --pull --target production --tag yaparena:local .
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed yaparena:local
```

- `docker build --pull ...` refreshes base-image metadata, builds the Dockerfile's production stage,
  and gives the result the local name `yaparena:local`.
- `trivy image ...` requires the separately installed Trivy scanner. It reports high and critical
  vulnerabilities for which a fix is available; it does not modify the image.

The production stage removes npm, Yarn, and Corepack after installing dependencies. Development and
test stages retain those tools.

Database provisioning, privilege inventory, backend RLS policies, fresh/upgrade verification and
hosted isolation gates are documented in the [F04 database runbook](docs/security/database-isolation.md).
Run `npm run verify:database-isolation` separately from `npm run check` with Docker available.

Durable public chat, likes and chat writability use a feature-gated SSE connection per event page.
The [community delivery guide](docs/community-delivery.md) defines the public protocol, runtime
LISTEN requirements, limits, retention and rollout. `COMMUNITY_STREAM_ENABLED=false` remains the
default; new pages use bounded durable HTTP recovery until it is enabled. Run
`npm run verify:community-delivery` for disposable PostgreSQL, independent browser sessions,
two-process fanout, restart/slow-client trials and a five-minute 500-viewer soak. An installed
PostgreSQL 17/18 can run the local fallback using `COMMUNITY_POSTGRES_MODE=host`; isolation uses
`DATABASE_TEST_MODE=host`. These checks are local capacity evidence, not hosted release approval.

All three native community, isolation and replay launchers initialize UTF-8 explicitly.
`npm run verify:community-native-setup` is the focused C-locale Unicode smoke used in CI;
it checks the actual migrated chat column without running the full browser/load workload.

Critical database/release automation and the edge replay worker use strict TypeScript.
See the [source inventory and execution guide](docs/operational-typescript.md);
`npm run typecheck:operations` is included in the ordinary quality and build gates.
