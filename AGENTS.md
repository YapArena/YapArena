# Repository Guidelines

## Establish the Checkout and Current State

Before planning work, read `CONTRIBUTING.md`, inspect `git status --short`, `git branch -vv`
and `git worktree list`, then fetch `origin` and compare `HEAD` with `origin/main`.
An old branch with uncommitted work can lack features already merged on main. Preserve those
edits and create a separate worktree from `origin/main` when needed; do not reset or switch a
dirty shared checkout to make it current. Report the baseline and any mismatch explicitly.
On an older branch, this file and `CONTRIBUTING.md` can describe an outdated workflow; read the
current versions with `git show origin/main:AGENTS.md` and `git show origin/main:CONTRIBUTING.md`.

Use the [implementation status](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence)
for completed work and remaining gates, and the [product PRD](docs/product-prd.md) for requirements.
Dated trials and integration handoffs describe their recorded revisions, not the current checkout.
Follow their current-state notes and linked operating guides before reimplementing old findings.

## Project Structure & Module Organization

The Node.js 24 service uses strict TypeScript in `src/`. Keep reusable infrastructure in `src/platform/` and product code in `src/features/` (for example, `src/features/media/`). Handwritten browser modules and utilities live in `frontend/` as strict TypeScript; `frontend/sw.ts` uses separate service-worker types. Existing browser-safe shared TypeScript remains under `src/features/`. Styles and static assets live in `public/`; every JavaScript file in `public/` is ignored build output served at its existing URL. Place Node tests in `tests/` with names such as `media-router.test.js`. Add database changes as new files in `migrations/`; never edit an applied migration. Product decisions and operating instructions live in `docs/`.

## Build, Test, and Development Commands

- `npm ci` installs the locked dependencies from `package-lock.json`.
- `docker compose up --detach --wait db` starts local PostgreSQL.
- `npm run dev` builds and watches frontend assets and runs the API with reload, loading a separate runtime-only `.env.runtime` file.
- `npm run build` checks operational and frontend sources, compiles server TypeScript, and generates all browser JavaScript and the five bundles (`media`, `replay`, `hero-live`, `homepage` and `recording`).
- `npm run typecheck:operations` checks the edge worker and critical database/release automation in separate strict compiler projects; see [the source inventory](docs/operational-typescript.md).
- `npm run typecheck:frontend` checks the source inventory, strict browser types, isolated service-worker types, and the frontend build tool. `npm run typecheck` includes this gate.
- `npm run check:fast` runs lint, format, the tracked-file policy (`npm run check:files`), type checks and the unit tests, without PostgreSQL or coverage thresholds (about 30 seconds). Run it before pushing.
- `npm run check` runs the same checks with coverage thresholds. Its PostgreSQL suites need the disposable identities described under Testing Guidelines.

See `README.md` for the migration and media container commands.
Provision and migrate in separate owner/admin processes before starting runtime. Never load the
combined operator `.env` into the web or worker process. The dedicated replay encoder starts with
`npm run start:replay-worker` after building and configuring automatic packaging; the general
maintenance worker does not encode recordings.

## Coding Style & Naming Conventions

Use two-space indentation and the existing Prettier defaults. ESLint checks JavaScript and TypeScript; run `npm run lint` and `npm run format:check` after edits. Use `camelCase` for variables and functions, `PascalCase` for types, and descriptive lowercase file names. Keep API authorization and state transitions on the server.

## Frontend preservation and TypeScript policy

The preservation rules below apply to language migrations. Refactors and fixes requested by a
prompt may change internals, but list every user-visible change in the PR.

All new or substantially modified handwritten frontend code must use strict TypeScript, including browser utilities and service workers. Add modules under `frontend/` following [the frontend workflow](CONTRIBUTING.md#frontend-development); never author or commit served JavaScript. The normal CI quality gate enforces this source policy and strict checking. Do not introduce `any`, type-check suppression directives, or broad assertions to bypass errors; type existing API data and runtime guarantees faithfully.

A language migration must preserve the existing appearance and behavior exactly: markup, CSS, responsive layouts, animation/timing, focus, scrolling, charts, playback, network ordering/retries, API payloads, storage keys, asset URLs and service-worker behavior. Keep module structure and algorithms, and preserve existing TypeScript rather than duplicating it. Record suspected existing bugs separately; do not add runtime guards or fixes to make typing easier. Separately requested product changes may change behavior within their authorized scope. Capture a baseline and compare identical fixtures/viewports before claiming migration parity.

## Testing Guidelines

Use Node's built-in test runner and `node:assert`; put tests in `tests/*.test.js`. Add tests for behavior changes and failures, especially media state transitions. `npm run test:coverage` enforces at least 90% line, branch, and function coverage. Browser, device, LiveKit Cloud, and replay quality checks require a documented staging trial; unit tests alone do not establish them.
The A4, wallet and revocation PostgreSQL suites require explicit disposable-database URLs;
CI supplies them. Missing identities skip database coverage and can make the coverage gate fail.
Use [the disposable quality command](docs/operations.md#local-verification) for a complete local check,
or [the auth regression gate](docs/operations.md#auth-regression-gate) for focused auth work.
Database isolation, durable community delivery and replay pipeline verifiers are separate checks
from `npm run check`. Record skips and distinguish local, hosted and physical-device evidence.

Default loop: run `npm run check:fast` plus the tests for the code you changed that it skips
(for example a PostgreSQL suite or a focused verifier), push, watch CI with
`gh pr checks <number> --watch`, and fix failures. CI is the full gate; it runs the
database-backed quality gate, container scans and every integration check. Run the full local
gate (`A4_QUALITY=true npm run verify:database-isolation`, `npm run verify:browser`) only to debug
a CI failure, for migration work, or when a prompt asks for it.

Main uses a merge queue. When a prompt authorizes merging, add the PR to the queue with
`gh pr merge <number>`; the queue reruns CI on the PR merged onto the latest main. Do not merge
or rebase main into a branch just to rerun CI. CI caches are described in
[the operations runbook](docs/operations.md#ci-caches).

## Evidence and Status Records

Put evidence (test output, timings, screenshots) in the PR description or CI artifacts; the
integration core browser job already uploads `core-browser-evidence`. Do not commit screenshots, videos, raw
logs or evidence folders. Add a short Markdown record in `docs/` only for a decision, or for a
hosted or manual result that CI cannot reproduce. Update the
[status table](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence) in place
instead of writing status prose, and keep reports short. `npm run check:files` enforces the file
rules; see [the evidence policy](CONTRIBUTING.md#evidence-and-status-records).

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects such as `Validate media prototype failure handling`. Keep commits focused. Pull requests should explain the change, link the relevant issue or decision, list checks run, and put screenshots for UI changes or staging evidence for media changes in the PR description, not in commits. Follow `CONTRIBUTING.md` and the repository pull request template.

## Security & Configuration

Start from `.env.example`; never commit `.env`, credentials, tokens, private recordings, or production data. Report security issues through `SECURITY.md`. Do not treat prototype media or passing tests as approval to enable financial activity.
