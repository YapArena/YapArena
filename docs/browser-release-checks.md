# Core browser release checks

Run the maintained local gate from a clean, installed checkout with Node.js 24:

```sh
npm ci
npm run verify:browser
```

The command requires a running local Docker daemon, Chrome/Chromium and FFmpeg on
PATH. It builds the app, creates its own disposable PostgreSQL 18 cluster, provisions
separate owner/runtime identities, verifies fresh and legacy-upgrade isolation, and
runs the full runtime-backed `npm run check` with A4, wallet and session-revocation
database suites enabled. Browser checks then exercise real local account/A4/community
HTTP flows and the existing synthetic homepage/media components. No hosted target,
caller-supplied database URL, operator `.env`, provider account or recording is used.

For the supported native PostgreSQL 17/18 alternative, run as a non-root user with
`pg_config`, `initdb` and `pg_ctl` on PATH:

```sh
DATABASE_TEST_MODE=host npm run verify:browser
```

Set `BROWSER_CHROME_PATH` if the browser is not installed at a detected standard
location. Missing prerequisites, invalid options, failed assertions and subprocess
failures fail the gate; they do not become successful skips. The native harness
starts a new cluster on a random loopback port. It does not use an existing local
database. The launcher supplies a fixed locale and an allowlisted environment;
database/provider secrets and `NODE_OPTIONS` from the calling shell are not passed
to its verifiers. Application processes receive runtime credentials only.

## What is enforced

| Verifier                        | Scope                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-database-isolation.ts`  | Fresh/upgrade permissions, runtime identities, migrations, the retired YAP play freeze on upgrade, backend journeys, A4 PostgreSQL cases and the full local quality gate.                                                                                                               |
| `verify-a4-browser.ts`          | Actual browser registration, inline commitment without replacing media/chat, advanced review, keyboard focus, receipt reload, controls, sealed data, exact deterministic execution/nonexecution, balances and reservation release, observer isolation, logout and cross-account denial. |
| `verify-arena-browser.ts`       | Existing runtime-backed workspace, live chat, settlement chart, round/price inspection, animation, enlargement, responsive layout and accessibility checks. Called by the A4 verifier.                                                                                                  |
| `verify-public-bots-browser.ts` | Owner seed idempotency, real worker settlement, public homepage/expanded/debate refresh, consent, synthetic labels and private/unrevealed/hidden exclusions. Called by the A4 verifier.                                                                                                 |
| `verify-homepage-browser.ts`    | Six responsive widths, carousel/argument/ticker controls, pointer/touch/keyboard charts, reduced motion, follows/auth states, canonical navigation, no-JS fallback, unavailable data, CSP and axe checks. Controlled component repositories/auth responses.                             |
| `verify-hero-browser.ts`        | Real synthetic WebM playback, one-preview handoff, looping, hover/click/mobile navigation, reduced motion, Save-Data and authorization-denial behavior.                                                                                                                                 |
| `verify-matchmaking-browser.ts` | Two accounts through the live queue (opposite sides, both accept in 30 seconds, both open the room), the automatic no-show and a "now" challenge accepted from its dialog. Run from the isolation harness on the fresh database, without LiveKit.                                       |

The existing community, replay pipeline, packaging, backup/restore, container,
monitoring and deployment-configuration gates remain separate and unchanged.
These browser checks do not establish hosted LiveKit, acoustic quality, physical
devices, sustained audience capacity or financial-release acceptance.

## Deterministic A4 cases

Only the disposable database owner installs a temporary fixture trigger. It supplies
known session seeds on INSERT for synthetic mixed/reference runs before bots and
human commitments exist. Normal application code derives and commits round seeds,
accepts submissions, advances transitions, and posts/settles the actual ledger.
No production source, randomness, authorization, migration or API seed input changes.
The trigger/function are removed during verifier cleanup, and the cluster is removed
by the enclosing harness on both successful and failed assertions.

Both cases keep the default 5% exploration setting and 500 reference bots. Expected
values are fixed fixtures rather than recalculated with the implementation under test:

| Session seed          | Branch / outcome                                       | Human premium | Human payout | Final available balance |
| --------------------- | ------------------------------------------------------ | ------------- | ------------ | ----------------------- |
| `browser-release-0`   | Targeted / executed and settled                        | 7.707870 YAP  | 9.001996 YAP | 1001.294126 YAP         |
| `browser-release-120` | Exploratory / accepted with no accepting opposite side | 0 YAP         | 0 YAP        | 1000 YAP                |

Each case commits ten contracts, checks the ten-coin reservation, final release,
exact offer, receipt and persisted reload. Both are independently created twice by
default, using fresh synthetic accounts and closing completed pages so polling does
not consume another case's real per-account A4 rate budget.
`A4_BROWSER_REPETITIONS=1` through `5` controls repetitions for focused
diagnostics; this repeats deterministic scenarios, never retries a failed assertion.
An assertion failure stops the command immediately.

## CI and diagnostics

The integrated fixes are on main through PRs #37–39. Main `78d5087` passed all five
required checks in [run 39262775602](https://github.com/Boufe/YapArena/actions/runs/39262775602);
this does not reclassify earlier failed runs or establish hosted/device capacity.
The integration community job also runs the `npm run verify:community-native-setup` check
under C locale using actual native PostgreSQL, separately from this browser coordinator's
Docker gate.

The A4 inline regression holds the initial workspace request against the real
disposable runtime. While it is pending, the visible participation panel reports
`aria-busy="true"` and its form controls are disabled. Initialization restores each
control's prior disabled state only after the busy guard is released; the verifier
waits for the visible panel's `aria-busy="false"` before one normal creation click.
It checks one creation request, one stored run, one open round and the visible
commitment form, then continues every existing browser scenario. The held request
is released and its route removed in `finally`, including on assertion failure.
The existing integration job runs this regression as part of the full browser gate;
no sleep, retry, forced click or timeout increase is involved. See the
[readiness fix evidence](evidence/a4-readiness/2026-10-19.md).

The shared-data verifier registers its own synthetic account rather than copying
the workspace account's cookies. The workspace intentionally leaves its normal
60-second “Pilot studies” run in flight; publishing that same creator would let
an unrelated later settlement replace this verifier's expected latest round.
The verifier checks distinct creator IDs, that the workspace creator stays private,
and that the initial public history contains 36 seeded rounds plus the same two
completed mixed histories created for this separate actor through the real worker. It
leaves the workspace run and all existing timing/settlement assertions intact.

The shared-data verifier brings each page to the foreground before waiting for its
live chart refresh, and asserts that it is visible. Homepage polling pauses in
hidden tabs; applying a received update also waits until hover, focus and chart
inspection end. Before observing the homepage, the verifier clicks its existing
search input normally and moves the pointer outside the interactive regions,
then asserts that inspection/hover/focus have ended. It does not reload the page.
A maintained observer-round case deliberately focuses the chart's range control
and hovers the carousel, observes a real homepage response containing the settled
round, and proves the chart retains its old round until interaction ends. Both
homepage charts and the debate must then display the exact new round. Existing
settlement, consent, privacy and refresh assertions and their 20-second timeouts
remain unchanged. Failures retain the homepage screenshot and interaction state
alongside the existing debate evidence. See the
[CI correction evidence](evidence/ci-integration/2026-10-19.md#post-merge-browser-correction).

The `integration: core browser and database isolation` job runs this gate on pull
requests, merge groups and main, and the required `integration` gate job requires it.
It uses `npm run verify:browser -- --integration-only` in parallel with
`quality / check`. That mode skips what `quality / check` already runs: the full
quality gate, the account-security suites and the treasury scenarios. It keeps the
fresh/upgrade isolation databases, the A4 PostgreSQL suite on both, the A4 browser
journeys, homepage and Live/replay checks. This option requires `CI=true` and is not
the documented local command. The five required job names remain `quality / check`,
`container`, `integration`, `monitoring` and `deployment`.

The launcher prints its synthetic artifact directory at startup. Set
`BROWSER_ARTIFACT_DIR` to choose one explicitly. `result.json` reports the executed
stages and overall exit status; component JSON and screenshots record browser checks.
An A4 failure retains its current synthetic screenshot and completed outcomes.
CI retains only the selected synthetic JSON/screenshots for seven days; it does not
upload database inventories, quality logs, environment files, traces or cookie jars.

The homepage's original external HTML export is not a prerequisite for functional
release checks. The separate original-design comparison remains available explicitly:

```sh
HOMEPAGE_REFERENCE_PATH=/path/to/original-export.html \
  node scripts/verify-homepage-browser.ts --compare-reference
```

That command requires the actual export and fails if it is unavailable or invalid.
The normal gate reports the export comparison as not requested, runs every maintained
functional check with checked-in fixtures, and captures responsive screenshots.
