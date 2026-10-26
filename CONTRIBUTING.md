# Contributing

These instructions assume that you already cloned the repository, changed into its root directory,
and installed the tools listed in the [README](README.md#requirements). Cloning initializes Git; do not
run `git init` inside the clone. YapArena product changes belong in this repository.

For product behavior, follow the [YAP Arena product PRD](docs/product-prd.md) and its
[specification outlines](docs/product-specification-outlines.md). The
[template PRD](docs/template-prd.md) documents the reusable service foundation, not the current
product's financial rules or release scope. Keep confirmed decisions intact, identify proposals
and open decisions explicitly, and resolve financial behavior in reviewed specifications before
implementing it. Do not treat a passing backend quality gate as permission to accept real funds.

## Development workflow

1. Inspect the checkout before choosing a branch:

   ```sh
   git status --short
   git branch -vv
   git worktree list
   git fetch origin
   git rev-list --left-right --count HEAD...origin/main
   ```

   Report any mismatch with fetched main. If the checkout contains unrelated edits or an older
   feature branch, preserve it and create a separate worktree:

   ```sh
   git worktree add -b short-description-of-change /tmp/yaparena-change origin/main
   cd /tmp/yaparena-change
   ```

   Choose an unused branch and directory. Do not stash, reset, or overwrite someone else's work
   as a setup step. For a clean checkout where `main` is available, the ordinary alternative is:

   ```sh
   git switch main
   git pull --ff-only
   git switch -c short-description-of-change
   ```

   `git pull --ff-only` updates reviewed history without creating an accidental merge commit.
   Use a short branch name describing one change and the
   [current implementation and evidence](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence)
   to distinguish completed packages from remaining acceptance work.

2. Install locked dependencies:

   ```sh
   npm ci
   ```

   This creates a clean `node_modules/` directory from the exact versions in `package-lock.json`. It
   does not install a CI service or modify the lockfile. Run `npm install PACKAGE_NAME` only when the
   change intentionally adds or updates a dependency, and review both `package.json` and
   `package-lock.json` afterward.

3. Make server/shared changes in strict TypeScript under `src/` and handwritten frontend changes under `frontend/`, following the frontend workflow below. Add or update tests for changed behavior. Tests belong under `tests/`; database
   structure changes also require a new migration rather than an edit to migration history.

4. Run the fast local checks:

   ```sh
   npm run check:fast
   ```

   This checks lint rules, formatting, the [tracked-file policy](#evidence-and-status-records) and
   types, then runs every unit test. It takes about 30 seconds on a recent laptop. It does not
   start PostgreSQL or enforce coverage thresholds, so the PostgreSQL suites skip. Also run the
   tests for the code you changed that `check:fast` skips, such as a PostgreSQL suite through the
   [auth regression gate](docs/operations.md#auth-regression-gate) or a focused verifier.

   CI is the full gate. Every pull request runs the database-backed quality gate with coverage,
   the container builds and scans, and every integration check. Run the full local gate only to
   debug a CI failure, for migration work, or when a prompt asks for it:
   `A4_QUALITY=true npm run verify:database-isolation` (Docker, or `DATABASE_TEST_MODE=host` with
   PostgreSQL 17/18 tools on PATH) runs `npm run check` with disposable A4, wallet and revocation
   identities, and `npm run verify:browser` adds the core browser journeys. A plain `npm run check`
   without those identities omits PostgreSQL coverage and can fail the unchanged coverage
   threshold. See [local verification](docs/operations.md#local-verification) and, for containers
   and Compose, the [operations runbook](docs/operations.md).

5. Review and commit only the intended files:

   ```sh
   git status
   git diff
   git add PATHS-TO-CHANGED-FILES
   git commit -m "Describe the change"
   git push --set-upstream origin short-description-of-change
   ```

   Replace `PATHS-TO-CHANGED-FILES` with the actual files; it is not a literal path. The first push
   connects the local branch to the branch on GitHub. Then open a pull request, complete the
   repository's pull-request template, and watch CI:

   ```sh
   gh pr checks PR-NUMBER --watch
   ```

   Fix any failure and push again. A new push cancels the pull request's older CI run.

6. Merge through the merge queue once checks and review pass, and only when you are authorized
   to merge: click **Merge when ready** on the pull request, or run `gh pr merge PR-NUMBER`.
   The queue tests the pull request merged onto the latest main, together with any pull requests
   queued ahead of it, and merges only if every required check passes. The branch does not need
   to be up to date with main, so do not merge main into it just to rerun CI. If the queue
   removes the pull request after a failure, fix it, push, and add it again.

Focused branches make review and rollback smaller. Locked installs keep developer results aligned
with CI. The fast local checks catch most mistakes before a push, and CI runs the database,
migration, container and browser checks that unit tests cannot exercise.

Keep platform behavior under `src/platform` and product behavior under `src/features`. Database
changes require an additive migration; never rewrite a migration that may have been applied.

This boundary keeps reusable infrastructure independent from product domains. Additive migrations
preserve a trustworthy history across developer, staging, and production databases.

Do not commit `.env`, credentials, production data, generated coverage, or registry tokens. Report
security problems using [SECURITY.md](SECURITY.md), not a public issue.

Dependency install scripts are reviewed and pinned in the `allowScripts` policy in `package.json`.
Review the package, exact version, published provenance, and required lifecycle behavior before
changing that policy. Supported npm versions report or enforce unreviewed scripts during install.

See the [glossary](docs/glossary.md) for terms such as branch, pull request, migration, image, and CI.

## Frontend development

All new or substantially modified handwritten frontend code must use strict TypeScript,
including UI controllers, charts, media clients, account controls, browser utilities and service
workers. Author modules in `frontend/`, keep styles/static assets in `public/`, and preserve existing
browser-safe shared implementations in `src/features/`. Never edit or commit generated JavaScript.

- `npm run typecheck:frontend` enforces the authored-source inventory and checks
  `tsconfig.frontend.json` (strict browser DOM types, no server globals),
  `tsconfig.service-worker.json` (strict WebWorker types without DOM/server globals), and
  `tsconfig.frontend-build.json` (the isolated Node build tool). `npm run typecheck` and the normal
  `npm run check` CI gate include it.
- `npm run build:frontend` emits every executable `frontend/**/*.ts` module to the corresponding
  `public/**/*.js` path and builds the four bundles `media.bundle.js`, `replay.bundle.js`,
  `hero-live.bundle.js` and `homepage.bundle.js`. Bundle entries emit only their bundle, and
  type-only modules produce no asset. `media.bundle.js` and `hero-live.bundle.js` are ES modules
  that share code such as `livekit-client` through content-hashed `public/chunks/` files, which
  the server caches as immutable without a `?v=` revision. Run the type check before this focused
  build; `npm run build` runs both and also compiles the server.
- `npm run dev` generates assets before starting the API, then watches frontend and shared discovery
  sources. Sign-in is a full-page redirect through Auth0
  ([Decision 0009](docs/decisions/0009-auth0.md)): the header and `/account` link to
  `/api/auth/login`, and no page loads a provider script. With no `AUTH0_*` settings, sign in
  locally through the test identity entry instead: `npm run build`, then
  `npm run start:test-identity` serves the application with `/api/test-identity`.
  `npm run watch:frontend` watches assets independently. Runtime configuration remains in
  `.env.runtime`; build processes do not load the operator `.env`.

To add a module, create `frontend/name.ts` (or a subdirectory), use `.js` specifiers for browser
imports, and reference `/assets/name.js` from existing server markup when needed. Entry modules that
need dependencies bundled use the explicit bundle entries in `scripts/build-frontend.ts`.
`frontend/sw.ts` stays at `/sw.js` with its existing registration/scope. Put worker-only code in the
worker project and update its include/exclude boundaries if another worker is separately requested.
The inventory check rejects handwritten JavaScript in `frontend/` and tracked JavaScript/TypeScript
in `public/`; generated JavaScript is ignored by Git, lint and formatting and excluded from Docker
build input. Browser output is always regenerated in the image build.

Build server and browser markup with `html` from `src/platform/html.ts`. It escapes every
interpolated value unless the value is already `SafeHtml`; wrap a trusted fragment with `raw()`
and say at the call site why it is safe. Write a boolean attribute value as `${String(flag)}`.
Lint rejects local escape helpers and `innerHTML` built from interpolated template literals. A module
served under its own `/assets/name.js` URL that imports shared `src/` code belongs in
`inPlaceBundles` in `scripts/build-frontend.ts`.

Use meaningful types for DOM elements, events, state and API payloads; do not add `any`,
`@ts-ignore`, `@ts-nocheck` or broad assertions to silence errors. Narrow assertions may express
existing markup, server-contract or platform guarantees. Do not add new validation/guards as part
of typing an existing module. Document suspected existing bugs separately.

For language migrations, the current application is the source of truth. Preserve appearance,
DOM/CSS/selectors, responsive behavior, animations/transitions, chart geometry, loading/errors,
keyboard/focus/scrolling, timing/polling/request ordering/retries/reconnection, playback and state
transitions. Preserve requests/payloads, cookies/storage keys, asset URLs and service-worker
semantics. Keep modules and algorithms, capture the baseline, and compare screenshots and
interactions using identical fixtures and viewports. Investigate differences instead of updating
expected outputs. Separately requested product changes may alter behavior within their scope.
Report local versus hosted/device evidence and skipped checks in the PR.

## Core browser release verification

`npm run verify:browser` prepares disposable PostgreSQL owner/runtime identities, builds
the app, runs the full database-backed quality gate, and verifies account/A4, debate
workspace, shared-data discovery, homepage and Live/replay preview workflows. CI runs the
browser part on every pull request in the `integration: core browser and database isolation`
job, in parallel with `quality / check`, which runs the quality gate. Run it locally to debug
a CI failure or when a prompt asks for it.
See [prerequisites, native PostgreSQL mode, deterministic fixtures and evidence
limits](docs/browser-release-checks.md). Missing prerequisites and assertions fail the
gate; real hosted/device media acceptance remains separate.

## Operational TypeScript

Author the production edge worker and maintained critical release/database automation in
strict TypeScript. Follow the [operational source inventory and execution guide](docs/operational-typescript.md).
`npm run typecheck:operations` checks all converted files explicitly, with separate Node,
browser-automation and edge projects; the ordinary `typecheck`, `build` and `check` commands
include this gate. Server declarations emitted under ignored `dist/` provide types for the
verifiers' existing built-server imports. Use Node 24 for direct `node scripts/name.ts` commands.
Keep runtime validation, fixture assertions, SQL, ordering, diagnostics and evidence boundaries
intact. Do not rewrite applied JavaScript migrations or convert unrelated scripts incidentally.

## Evidence and status records

Evidence belongs in the pull request description and CI artifacts. Paste test output, timings and
screenshots into the PR; the integration core browser job uploads browser results as the
`core-browser-evidence` artifact. Do not commit screenshots, videos, raw logs or evidence folders.
A short Markdown record in `docs/` is allowed only for a decision, or for a hosted or manual result
that CI cannot reproduce. Update the
[status table](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence) in
place instead of adding status prose; older status text lives under `docs/history/`.

`npm run check:files` runs inside `npm run check` and fails when a tracked file is:

- an image, video or `.raw` file under `docs/` (for example `.png`, `.jpg`, `.svg`, `.mp4`, `.webm`);
- larger than 1 MiB, unless it is under `public/` (served assets); or
- generated build output: anything under `dist/`, `dist-transcriber/` or `coverage/`, or any
  JavaScript file under `public/` (served bundles, built from `frontend/`).

Files that predate the policy are listed in `scripts/repository-files-baseline.txt`. Do not add
entries; remove one when its file is deleted. Existing evidence on main stays in place.

## Documentation changes

Verify claims against the reviewed branch's source, scripts, migrations, workflows and saved trial
evidence. Follow the [evidence policy](#evidence-and-status-records) for new records. Update the
authoritative runbook and implementation status together when behavior changes.
Preserve dated reports and decisions; add a current-state note or superseding link when a finding,
handoff, command or acceptance status is obsolete. Keep implemented, locally tested, hosted-tested
and planned behavior distinct. Check relative links, anchors, referenced paths and formatting, and
run `npm run check:fast` before opening a documentation PR. When every changed file is Markdown
or under `docs/`, CI takes a fast path: `quality / check` runs only the format check, the
tracked-file policy and the repository-file tests, and `container` and the integration jobs are
skipped. The five required CI checks are `quality / check`, `container`, `integration`,
`monitoring` and `deployment` (active ruleset rechecked 2026-10-23); all five report on the fast
path and in the merge queue too. The `deployment` job validates configuration; it does not
deploy the app. Recheck GitHub rules if they change.

When using a separate worktree, report its branch and PR and the state of the original checkout.
Reconcile Markdown only where local edits can be preserved, and identify conflicts explicitly.
Never leave a dirty old checkout appearing to represent current main. Merge only within the user's
authorized scope; opening a PR does not authorize merging it when approval has been reserved.
