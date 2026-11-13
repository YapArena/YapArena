# Shared bot discovery

> **Current state (2026-11-13, [Decision 0015](decisions/0015-last-answer-endorsement.md), D3):**
> topic pages no longer show this history; they show the last-answer figure
> ([topic history](site-design.md#topic-history)). The shared history shows on debate pages only,
> and `publicBots.topics()` now feeds only the unused `GET /api/public/homepage`. The browser
> trial checks the debate page after each settlement and that the topic page carries no
> simulation chart.

> **Earlier state (2026-11-06, first-run plan PR 6):** the home no longer shows these charts; it
> is a list of debates. Each topic's history shows on its topic page
> ([topic history](site-design.md#topic-history)) from `publicBots.topics()`, as served when the
> page loads, without polling. The debate page is unchanged. The browser trial
> (`scripts/verify-public-bots-browser.ts`) now checks the topic page after each settlement,
> where the homepage, expansion and inspection-hold checks below used to run.

The homepage and debate workspace use one database-backed, explicitly labeled
simulation feed. A visible **Live** link in the homepage header opens the existing
`/live` video page. Its media preview controller and layout remain intact.

The public homepage omits the introductory heading block, keeping the existing
gutters and grids directly below the ticker. Tiles, trending titles and expanded
titles use the associated debate question rather than a topic's working label.
The explicitly gated reference preview retains the original supplied heading.

The public idea ticker scrolls continuously from right to left at approximately
24 pixels per second, without separators. It includes all homepage ideas and
pauses on hover/focus, outside view or in hidden tabs. Keyboard focus reveals the
selected entry; visual repeats are hidden from assistive technology but remain
clickable. Live updates preserve its progress and defer during interaction.
Reduced motion presents one horizontally scrollable copy with no animation.

Hover pauses the argument stream. Wheel/trackpad scrolling moves through it in
either direction without scrolling the page, and leaving resumes the same
32-second loop from the inspected position. The stream also accepts arrow,
Page Up/Down and Home/End keys while focused. Explicit pause and reduced-motion
preferences continue to apply.

## Sources

- Seeded examples use the existing heterogeneous `generateBots` preset, 500 bots,
  A4 epsilon 0.05, no fee, and exact A4 pricing/execution. Each published debate
  receives 36 hourly simulated history points, six relevant supporting/counterarguments,
  and independent argument endorsement cohorts. Simulated times, seeds, pricing,
  aggregate premiums/counts and argument results persist in PostgreSQL. This seed
  never issues credits or modifies accounts, wallets, submissions, private runs
  or financial journals.
- An account can publish its settled aggregate mixed (Bots + you) and observer
  (Bots-only) results. Eligible past and future rounds are read directly from A4's
  stored settlements. No copied settlement state, extra worker or financial
  transition is added.

This is simulation activity, not an ongoing idea market, actual viewers or a
human-only popularity score. Quotes are labeled shared YES offers rather than
fills. The Live page retains its existing human-volume ranking. Real balances,
follows, media availability and canonical routes retain their existing contracts.

Each argument uses an independent heterogeneous cohort of 500 bots. Counterargument
endorsement is independent too; these rates need not sum to 100%. Seeded argument
results are stored. For later shared A4 rounds, argument results are reproducibly
derived from the finally revealed round seed and database-backed definitions,
with a bounded 100-entry memo for unchanged reads. They are simulated argument
endorsements, not votes made by the human participant.

## Consent and privacy

`a4_public_publishers` records explicit account consent. Authenticated
`GET/POST /api/a4/publication` reads/changes only the current account's choice under
the existing session lock, revocation, origin and rate-limit controls. Changes
are audited. The choice is visible in the debate and full Bots controls. Withdrawal
excludes that account's results from subsequent public queries without deleting
private history.

Both debate and topic must still be published. A4 rounds must be finally settled,
and both session and round reveal times must have passed. Pending, priced,
delayed-unrevealed, hidden and nonconsenting runs are excluded. Human-only rounds
remain outside this simulation feed. Public responses omit creators, seeds,
individual orders/limits, receipts, payouts and balances. The original private
human/sandbox timeline retains its isolation rules.

The three new tables are RLS-enabled in private schema `yaparena`, owned by
`yaparena_owner`. Runtime can read them and insert/delete publication consent;
only the separate owner process can seed/edit history or definitions. PUBLIC and
Supabase browser roles have no access. No public-schema objects, security-definer
functions, provider APIs or additional runtime credentials are introduced.

## Views and refresh

`GET /api/public/homepage` returns the homepage adapter and a stable revision;
unchanged revision requests return 204. Up to 12 topics with published debates and
100 associated published debates are considered. Orphaned topics do not stand in
for deleted debates. Upcoming/replay links do not invent media readiness.

`GET /api/public/debates/:id/activity` returns a shared timeline for a published
debate. Views retain the latest 100 eligible points with absolute sequence numbers
and `hasMore`. Topic charts merge related debates chronologically; debate charts
contain only that debate. Public reads are `no-store` and recheck visibility and
consent on every request.

The visible homepage polls every five seconds; the debate page re-reads shared activity on
room signals, otherwise every 60 seconds with a live room stream or 15 without one.
Homepage updates preserve trending and
expanded selections, filters and ranges, and defer replacement during inspection.
Both chart sizes use stored values, timestamps and piecewise interpolation. The
debate workspace defaults to shared history when available, including while signed
out. History source switches to authenticated private history. Its YES/NO plot,
offer/median inspector and argument panel use the same feed. Participation and
receipts stay private. Hidden tabs skip polls; page exit cancels new pollers.

## Staging seed and release

Inventory/back up the actual staging target and run the additive migration with
the owner identity in a separate operator process before deploying the reviewed
source. Follow the [staging runbook](render-staging.md#deploy-the-web-service).
Keep the owner URL out of web/worker configuration. After building:

```sh
PUBLIC_BOTS_STAGE_ORIGIN=https://yaparena-staging-web.onrender.com \
PUBLIC_BOTS_SEED_ACK=synthetic-only \
PUBLIC_BOTS_PUBLISH_HANDLE=CONSENTED_PUBLIC_HANDLE \
node scripts/seed-public-bots.ts
```

That process's `DATABASE_URL` must authenticate as owner. The origin must be the
existing staging origin or loopback; first bind the operator connection to that
target. Omit the optional handle without explicit account consent. Stable seed
keys make reruns idempotent. Existing examples/definitions and hidden records are
preserved. Writes are batched per debate; computations happen outside transactions.

The recorded [PR #34 staging release](https://github.com/Boufe/YapArena/pull/34)
authorized the `boufe` account's past/future mixed and observer aggregates only.
That historical operator authorization is not permission to opt in another creator;
the account API supports each signed-in creator's own explicit consent. The PR handoff records the
exact source, deployment and seed counts. Rollback deploys the previous compatible homepage
code; retain additive tables and A4 history.

## Verification

```sh
npm run build
DATABASE_TEST_MODE=host npm run verify:browser
git diff --check
```

Node tests cover deterministic cohorts, independent arguments, charts, adapters,
revisions and unavailable states. Disposable PostgreSQL tests cover consent,
mixed/observer inclusion, hidden/future/private exclusions and seed-write denial.
Fresh/upgrade isolation includes the new tables.

The local browser trial uses a fresh synthetic creator, separate from the workspace
account and its still-running 60-second fixture. It settles two existing-format mixed
histories before publication, retaining the 36 seeded plus two mixed initial-history
assertions. It runs the seed twice, then uses the actual A4 worker to
settle observer/mixed rounds while homepage, expansion and debate stay open. It
checks automatic updates, pending privacy, scope switching, signed-out viewing,
consent withdrawal, mobile, axe, CSP assets and Live navigation. A controlled
observer case holds chart inspection while a real response contains a new settlement;
the chart must retain the old round until interaction ends, then refresh without reloading.
See [the current fixture/readiness contract](browser-release-checks.md#ci-and-diagnostics) and the
[local evidence](evidence/shared-bots/2026-10-16.md). Hosted functional and physical
device acceptance remains the user's manual test.
