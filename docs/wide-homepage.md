# Wide homepage

`/home` renders the native Express homepage modeled on the supplied
`yaparena-wide-homepage.html` product rooted at `#ya-market-v4`. Its scoped styles
retain the original typography, colors, full-width grids and responsive rules.
The export shell, iframe, host bridge and visualization runtime are not shipped.
`/live` retains its existing video discovery page; topic, debate, account and media
routes retain their existing contracts. The homepage moved from `/` to `/home`
when the [landing page](landing-page.md) took over `/`.

## Data and actions

The later [shared bot discovery](shared-bot-discovery.md) fills the same design
with explicitly labeled database-backed simulations and opted-in mixed/observer
aggregates. It also restores Live in the homepage header. The unavailable fields
below describe records without that source; sample figures never become unlabeled
real activity.

`homepage-model.ts` adapts up to 12 published topics and up to 100 associated
published debates. Topics without a published debate are omitted. Cards link to canonical topic/debate routes.
Live/replay eligibility, publication and moderation remain repository concerns;
the homepage grants no media access and loads no media SDK or recordings.
Counts describe debates present in that bounded feed, not a complete catalogue.
The separate `/live` feed retains its ranking and limit of nine playable debates.

Topic categories, ongoing topic markets, endorsement/price histories and individual
argument endorsements are not implemented as real markets or human-vote histories.
When shared simulation data is absent, their values remain `null` with stable em dashes
and an unavailable-history chart. Topic side labels provide unrated positions.
When present, the shared feed explicitly labels its simulated histories and independent
argument cohorts. A4's existing private per-debate settlement history is not relabeled
as a topic market or used to infer argument endorsement. Real records are never
replaced by example figures after a request fails; discovery failure returns 503
with the same usable shell and explicit unavailable state.

Real topic follows use the existing authenticated follow API and account flow.
`site.js` exposes a shared, idempotent initializer and cached reads for dynamically
rendered controls; both featured and expanded controls stay synchronized. Following
filters the loaded topics. Search and categories filter this view; without
JavaScript, the search form uses the existing topic search and cards remain links.
With no volume/shift data, sorting preserves stable order or uses the number of
playable debates shown. The header obtains actual Yap Coins balance/account state
through the existing browser controller. Failed/signed-out balances stay unknown.

The real Enter round link opens the existing debate interface and its access
rules. No economics, commitments, settlement, deposits or withdrawals are added.
The existing measurement consent controls and security policy remain in effect.

## Explicit reference dataset

For local visual acceptance, set `HOMEPAGE_REFERENCE_ENABLED=true` in the separate
runtime-only environment and open `/home?reference=1`. This is a deterministic copy
of the reference's six ideas, series, arguments and debate previews, clearly
marked Concept / Sample data. It does not write records, follows or orders;
position review is a local preview with no coins spent. It does not emit product
measurement events. Reference/demo follows stay separate from authenticated ones.

The flag defaults to false, rejects invalid values and is forbidden in production.
The route additionally checks the environment. Disabled reference requests return
404; a failed real request never enables it. No configuration change is required
for the actual `/home` homepage.

## Interaction and resource contract

- Trending panels move together with the original 620ms easing and direction.
  One elapsed-time clock drives the 6,500ms advance and active-dot fill. Hover,
  focus, visibility, intersection, touch inspection and participation attention
  pause it without discarding elapsed time. Manual selection resets progress.
  Rapid navigation cancels the previous transition; outgoing copies are inert,
  hidden from accessibility and stripped of IDs and label references.
- The argument stream loops upward in 32 seconds with hover/focus and explicit
  pause controls. Repeated content is inert and hidden from assistive technology.
- Both charts interpolate at the actual pointer coordinate. A frame batches only
  guide, marker, tooltip and readout updates; scrubbing makes no requests and does
  not rebuild the SVG or grid. Touch inspection and a labeled keyboard range
  control provide the same history, with Escape/exit restoring the latest value.
- An expanded idea occupies the full grid row immediately after its card's row.
  Sorting and resizing recalculate placement while preserving selection/focus.
  Filtering it away closes it. Trending changes never replace the expansion.
- Reduced motion disables automatic rotation/argument flow by default and removes
  animated transitions. Manual controls, links and all content remain usable.
  Page exit disposes animation frames, transitions, listeners and observers;
  back/forward restoration remounts the controller.

The separate homepage browser bundle has no additional frontend framework/runtime dependency. It is loaded only on
the homepage using the existing asset revision convention. Public HTML remains
server rendered and `Cache-Control: no-store`; CSP is unchanged.

The controller and chart bindings are authored in `frontend/homepage.ts` and
`frontend/homepage-chart.ts`; shared model/view/chart/clock TypeScript remains in
`src/features/discovery/`. Browser JavaScript is generated. Follow the
[frontend workflow](../CONTRIBUTING.md#frontend-development) for strict checks and new modules.

## Verification

Use Node 24 with the repository's normal build and quality commands. Functional
browser checks require local Chrome and run without the external reference export:

```sh
npm run build
node scripts/verify-homepage-browser.ts
node scripts/verify-hero-browser.ts
A4_QUALITY=true DATABASE_TEST_MODE=host node scripts/verify-database-isolation.ts
git diff --check
```

The last Node command provisions disposable loopback databases and runs the full
`npm run check` with the existing credential/regression suites enabled. Use the
documented Docker mode instead where host PostgreSQL is unavailable. Neither the
reference browser suite nor these commands need hosted credentials.

For the separate original-design comparison, supply the actual export explicitly:

```sh
HOMEPAGE_REFERENCE_PATH=/absolute/path/yaparena-wide-homepage.html \
  node scripts/verify-homepage-browser.ts --compare-reference
```

In comparison mode the browser verifier serves the original export unchanged, growing only its
outer iframe height to capture the complete product. It compares that rendering
with the native app under the existing CSP at 1440, 1920, 1024, 768, 390 and 320px,
captures additional slides/hover/expansion, and exercises timing, chart, filter,
follow, account and accessibility behavior. Synthetic integration responses are
confined to the local verifier. The original attachment is not committed.
See the [dated evidence and screenshots](evidence/homepage/2026-10-16.md).
