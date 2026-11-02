# Wide homepage

`/home` renders the native Express homepage rooted at `#ya-market-v4`. It began as a copy of
the supplied `yaparena-wide-homepage.html` product; since the site redesign (PR 3 of 5, see
[site design](site-design.md#home)) it uses the site kit, header and footer like every other
page. The homepage moved from `/` to `/home` when the [landing page](landing-page.md) took over
`/`. `/live` is the video discovery page described under [Live](site-design.md#live).

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
When shared simulation data is absent, their values remain `null`: the idea shows "No rounds
yet" and an empty chart frame. Topic side labels provide unrated positions.
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

- The trending card shows one idea: its pixel mark, For and Against with their share, up to
  three arguments, the chart, and a footer with the volume, the debaters and Explore debate. It
  never turns by itself. Dots and previous / next (named after the neighbouring ideas) move the
  panels together with the original 620ms easing and direction; rapid navigation cancels the
  previous transition, and outgoing copies are inert, hidden from accessibility and stripped of
  IDs and label references. Every slide keeps the same height.
- Both charts draw one white line left to right the first time each is seen (once per idea,
  metric and range), ending on a square pixel that pulses. They interpolate at the actual
  pointer coordinate; a frame batches only the clip, marker, label and readout updates, and
  scrubbing makes no requests and does not rebuild the SVG or grid. Touch inspection and a
  labelled keyboard range control give the same history; Escape or leaving restores the latest
  value. On the trending card, scrubbing shows that moment's For and Against.
- An expanded idea occupies the full grid row immediately after its card's row. Sorting and
  resizing recalculate placement while preserving selection/focus. Filtering it away closes it.
  Trending changes never replace the expansion. Sample ideas, which have no page, open their
  panel from Explore debate and the rail.
- New activity waits while someone points at or focuses the trending card or inspects a chart.
- Reduced motion removes the slide, draw-in and pulse animations. Manual controls, links and all
  content remain usable. Page exit disposes animation frames, transitions, listeners and
  observers; back/forward restoration remounts the controller.

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

The redesign departs from the supplied export on purpose, so the earlier geometry comparison
with it (`--compare-reference`) is retired.
See the [dated evidence and screenshots](evidence/homepage/2026-10-16.md).
