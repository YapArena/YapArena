# Strict TypeScript for operational automation

Merged through PR #37, with readiness PR #39 integrated first and the Unicode/CI
follow-up in PR #38. Main `78d5087` passed all five required checks; see the
[completed integration evidence](evidence/ci-integration/2026-10-19.md#completed-integration--2026-10-19).
The migration's original parity evidence remains tied to its recorded source revision.

The production edge replay worker is authored in `edge/replay-worker.ts`. Wrangler
compiles that source using the existing bindings, route and compatibility date.
`tsconfig.edge.json` checks its consumed R2, cache and execution-context interfaces
with WebWorker libraries and no Node or browser DOM globals. No provider dependency
or production setting is added.

## Source inventory

`check-repository-files.ts` is checked in the database-tools project. It runs as
`npm run check:files` and enforces the [evidence file policy](../CONTRIBUTING.md#evidence-and-status-records).

New email-first automation is also strict TypeScript: `reset-test-accounts` and
`verify-auth-redis` are checked in the database-tools project. The explicit reset
is never imported by runtime or migrations. See [scope and limits](email-first-accounts.md).

The test identity entry (`test-identity.ts`, `test-identity-entry.ts`) is checked in the
database-tools project. It signs tests, browser verifiers and local development in through the
same post-callback function as the Auth0 callback, never ships in the image and refuses
`NODE_ENV=production`, Render, any provider setting and a non-loopback `APP_ORIGIN`
([Decision 0009](decisions/0009-auth0.md), point 10). `browser-sign-in.ts`,
`oidc-test-issuer.ts` and `verify-email-auth-browser.ts` are checked in browser automation:
the last drives Chrome through Auth0 sign-in, Google linking, sign-out and a cancelled sign-in
against the in-process issuer and does not establish hosted Auth0 acceptance.

`coin-sandbox-operator.ts` is also checked in the database-tools project. It is an
explicit owner-only, sandbox-only command, with no `.env` loading or HTTP listener.
Its optional fixed Base Sepolia signing/broadcast commands require the isolated
testnet rail and persist the nonce and exact transaction before submission.
Its inbox drain and reconciliation run separately from
runtime. See [the sandbox operating guide](coin-sandbox-operations.md) for command
schemas, secret variable names, physical rail isolation and release boundaries.

`verify-coin-testnet.ts` and `verify-coin-testnet-ledger.ts` are checked in the same
project. Their fixed Base Sepolia/Circle test-asset paths use private disposable
operator keys and distinguish standalone chain receipts from integrated
application-ledger acceptance. `verify-coin-sandbox-browser.ts`,
`verify-session-coordination-browser.ts` and `verify-media-cloud-revocation.ts` are checked
in browser automation. The first uses an isolated real application backend; the last requires
an explicitly authorized bounded hosted LiveKit trial. None substitutes for physical-device or screen-reader
acceptance. See the [completion matrix](email-first-completion.md) for current
commands, tested revisions and limits.

`verify-account-staging.ts` performs a read-only, strict-TLS catalog/account
preflight. It and `release-account-staging.ts` are still pinned to the retired embedded-wallet
release; see the [staging release notes](account-staging-release.md).
Build the reviewed server revision first; the CLI imports its compiled API.
It selects the sole eligible manual/uncertain mapping, then delegates exact
provider/digest inspection, atomic claim and full reset to the reviewed operator
API. An incomplete audited attempt stops for inspection instead of starting
another reset; do not switch to a new UUID to bypass that stop. It emits fixed stages
and HTTP error status only, never account identifiers or provider response bodies.
Its `--verify-transport` mode exercises the installed SDK's GET, POST freeze and
DELETE freeze through the same mode-specific allowlist with an injected offline sender, and
rejects incorrect methods, paths, bodies and content types. It makes no network
or database calls and needs no operator configuration.
`release-account-staging.ts` is a separate guarded owner command for
encrypted backup, isolated restore/migration rehearsal and exact reviewed
additive migrations. It requires independently stopped writers and passed
release gates; its environment assertions alone do not establish either.
Neither command resets accounts or enables live financial activity.
`release-account-render.ts` separately inspects or operates only the named
staging web and replay services, plus the `yaparena-staging-jobs` worker found by
exact name, type and workspace. Each mutation requires its matching
`ACCOUNT_STAGING_RENDER_ACTION`; deployment additionally requires the exact
current `ACCOUNT_STAGING_RENDER_COMMIT`. It emits only allowlisted metadata.
The operator must verify actual stopped writers, backup/rehearsal, release gates,
live deployment status and readiness separately.
The [account staging runbook](account-staging-release.md) gives the ordered
commands, backup/rehearsal requirements and postflight boundaries.

The live-outline transcriber agent ([Decision 0012](decisions/0012-live-argument-outline.md)) is
strict TypeScript in `src/features/transcription/agent/`, its own compiler project
`tsconfig.transcriber.json`. The server project excludes it, `npm run typecheck` checks it, and
`npm run build` emits it to `dist-transcriber/`. Its LiveKit packages are pinned development
dependencies in the root lockfile, so the web image never installs them; its image
(`deploy/transcriber/Dockerfile`) does. `stage-transcriber.ts`, checked in the database-tools
project, copies only the agent's build context for `lk agent deploy`. In the image's build stage,
`transcriber-runtime-modules.ts` (same project) copies only the packages the agent loads and
their dependency tree, so the web app's and the build tools' packages stay out of it.
`verify-outline-browser.ts`,
checked in browser automation and run by `npm run verify:browser`, drives the outline panel in
Chrome with synthetic LiveKit messages and an in-memory outline store.

These former JavaScript files retain their names with a `.ts` extension:

| Area                     | Sources under `scripts/`                                                                                                                                                                                    | Reason                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database and security    | `provision-database`, `migrate-database`, `inventory-database`, `verify-database-isolation`                                                                                                                 | Owner/runtime provisioning, migration execution, privilege inventory and fresh/upgrade isolation.     |
| Core browser release     | `verify-browser-release`, `verify-a4-browser`, `verify-arena-browser`, `verify-public-bots-browser`, `verify-homepage-browser`, `verify-hero-browser`                                                       | The existing PR #36 release coordinator and every browser verifier it invokes.                        |
| Community release        | `verify-community-local`, `verify-community-load`, `verify-community-delivery`, `verify-community`, `verify-community-browser`, `verify-chat-client`, `verify-media-operations`, `verify-media-clock-child` | Durable delivery, browser and independent media-clock checks invoked by the required integration job. |
| Replay release           | `verify-replay-pipeline`, `verify-media-packaging`, `package-replay`                                                                                                                                        | Disposable transaction/recovery checks and shared synthetic packaging CLI.                            |
| Integration smoke checks | `verify-discovery`, `verify-identity-social`, `verify-matching`, `verify-measurement`, `verify-measurement-browser`, `smoke-staging`                                                                        | Existing database, HTTP and browser verification commands in CI.                                      |
| Dependencies             | `test-http-request`, `seed-discovery`, `seed-public-bots`                                                                                                                                                   | Existing HTTP listener adapter and synthetic seed commands invoked by those verifiers.                |

The inventory contains 30 operational scripts, the edge worker and one shared fixture: 32 converted files.
Dated trial transcripts retain command names from their recorded revisions; use this guide
for current paths.

The shared `tests/helpers/replay-storage.ts` fixture is also checked because the
replay pipeline imports it. Existing tests retain JavaScript; only imports of renamed
helpers change. Applied migration names and contents remain JavaScript and unchanged.
`scripts/migration-exports.d.ts` describes only the immutable migration exports used
by provisioning/isolation; it is outside the migration directory and never executed.

Unrelated research, project initialization, diagnostic and hosted-only trial scripts,
shell backup/restore tools, tests, configuration JavaScript and application modules
are outside this language migration. The existing strict server/frontend sources
remain in place. A few server dependency-injection signatures describe the exact
methods consumed by existing fixtures; these changes erase entirely at runtime.

The remaining handwritten JavaScript scripts are intentionally outside the invoked
release/database dependency graph:

| Files under `scripts/`                                                                                                                                           | Why retained                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `a4-research.js`, `measure-local-journeys.js`, `report-playback.js`                                                                                              | Separate research and manual measurement/reporting tools.                                                                      |
| `check-media-storage.js`                                                                                                                                         | Optional startup/hosted storage diagnostic; not a provisioning, migration or required release-verifier dependency.             |
| `initialize-project.js`                                                                                                                                          | Reusable project initialization utility.                                                                                       |
| `verify-community-edge.js`, `verify-community-hosted-capacity.js`, `verify-replay-storage.js`, `verify-media-hosted-browser.js`, `verify-media-hosted-replay.js` | Separate manual edge/provider/storage/capacity trials, outside the release coordinators.                                       |
| `verify-session-controls-browser.js`                                                                                                                             | Separate manual account browser trial; required database authentication/security suites remain enforced by the existing tests. |

Applied `migrations/*.js`, `tests/*.test.js`, other test helpers and `eslint.config.js`
also remain in their existing languages; their conversion was not authorized by this
bounded migration. Served `public/**/*.js` remains ignored generated build output.

## Execution and checks

Use Node.js 24. Node runs the operational `.ts` sources directly using its built-in
type stripping. This requires no TypeScript runtime loader or new dependency. npm
command names, arguments, environment variables and supported operating modes remain
the same. For direct invocations use, for example:

```sh
node scripts/provision-database.ts
npm run migrate
npm run inventory:database
DATABASE_TEST_MODE=host npm run verify:browser
npm run verify:community-native-setup
COMMUNITY_POSTGRES_MODE=host npm run verify:community-delivery
REPLAY_POSTGRES_MODE=host npm run verify:replay-pipeline
npm run verify:media-packaging
```

Provisioning and migration still run in separate owner/admin processes. Web and worker
processes receive runtime credentials only. The release coordinators still create their
own disposable databases and synthetic fixtures; do not supply hosted databases or load
the combined operator `.env` into application processes.

`npm run typecheck:operations` first checks the server and emits ignored declarations
under `dist/`, then checks the explicit source inventories in
`tsconfig.database-tools.json`, `tsconfig.browser-automation.json`,
`tsconfig.community-tools.json`, `tsconfig.replay-tools.json` and `tsconfig.edge.json`.
Declarations let verifiers retain their existing imports of built `dist/*.js` while
using the actual shared server types. This command works before JavaScript is built.
It does not execute the verifiers. Node-only tools use Node libraries; browser
automation additionally uses DOM types for code evaluated inside browser pages.
The edge project is checked separately.

`npm run typecheck`, `npm run build` and the existing `npm run check` quality gate
include these compiler checks. Runtime type stripping is not a substitute for them.
Build output stays under `dist/` and `public/`; do not commit generated JavaScript or
declarations. Docker copies the two operational TypeScript entrypoints needed in its
production image. Compose, CI and maintained runbooks use their new source paths.
The required checks remain `quality / check`, `container`, `integration`, `monitoring`
and `deployment`; thresholds, assertions and separate verification gates are retained.

Types describe existing validation and fixture guarantees; they do not replace input
checks. Deliberately partial HTTP/component fixtures use exact shared method projections
at their invocation boundary, documenting routes whose omitted dependencies are never
used. Database rows, wire responses and subprocess results have specific projections.
Non-null assertions retain existing dereference behavior after known fixture setup;
they do not add runtime guards or repair unrelated failures.

The [migration evidence](evidence/operational-typescript/2026-10-18.md) records the
baseline, executable/behavior comparisons, checks and remaining evidence limits.

The [native PostgreSQL setup correction](evidence/native-postgres-utf8/2026-10-18.md)
supersedes the earlier migration's C-locale SQL_ASCII limitation. The focused setup
check runs native initdb under C with explicit UTF-8, performs real chat-column
roundtrip assertions and cleans up without starting browser/load phases. Follow
[community operations](community-operations.md) for the full gate and evidence limits.
