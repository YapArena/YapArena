# Live and replay debate workspace

The later [shared bot discovery](shared-bot-discovery.md) adds a clearly labeled
shared simulation history, including signed-out viewing, and a History source
control for authenticated private results. Independent synthetic arguments appear
below the graph. Publication consent is available beside the round controls;
personal receipts and balances remain private.

The [homepage preview](homepage-preview.md) can open this workspace on click or
continuous mouse hover. Its automatic muted preview is separate from the full
watching controls and does not change speaker capture or settlement behavior.

The October 15 visual reference selects a navy interface, blue-gray panel borders,
green YES/red NO accents, and a shared header with Live, Explore, Create, debate
search, a Yap Coins balance menu and account avatar. The same workspace renders
live, upcoming, ended and replay events. Existing discovery/account/matching pages
use the shared header and palette; `/coins` retains advanced experiment controls.

Desktop has three columns: broadcast/replay and community, settlement chart with
its price/median inspector and commitment history, and compact participation/info
plus settled sentiment. The participation card retains the old round column's
width and ends at the main graph's lower boundary; its content can scroll when
expanded setup or text needs more room. Narrow screens stack
these panels without removing controls. Video enlargement changes CSS on the
existing surface: it preserves media nodes, tracks, playback and chat. Hover,
keyboard focus and touch expose the control; Restore or Escape returns its exact
original bounds. Keyboard focus stays inside the enlarged video until restored.

**Layout since 2026-10-25 (founder-approved; supersedes the column order above):**
chat sits in the left column. The centre column is the widest: any status banner above
the video, then the 16:9 video, the debate line and topic tags, then the outline and
the chart. The right column holds the participation (later betting) panel, then debate
info; the panel keeps its natural height instead of ending at the graph's boundary. The
debate question appears in the video's top-left corner, and the broadcast state with the
watch count in its top-right corner, left of the expand button, while the pointer is over
the video or focus is inside it. On touch screens a tap on the video shows them until the
next tap elsewhere (the browser's hover emulation). They never take clicks, the question
stays the page's `h1` for screen readers, and reduced motion removes the fade. From 1190 px down, chat moves below the video and panel. On phones the
order is: banner, video, panel, chat, debate line, outline and chart, then the rest of the
right column. The layout is in [`debate-web.ts`](../src/features/discovery/debate-web.ts)
and the grid rules in `public/arena.css`.

**Betting panel (Decision 0013):** the right column starts with the Yap Coins panel
(`frontend/stake-panel.ts`, pure logic in `frontend/stake-model.ts`). It reads the anonymous
turn-window list and, when signed in, the coin-sandbox summary and rounds view; it re-reads them
on the `window` room signal (spread over up to 3 s) and every 15 s without the room stream. It
joins the current window with `POST /api/coin-sandbox/debates/:id/rounds`, submits with an
idempotency key, and on a five-day replay submits to the playing turn's window with the position
from the replay player's `yap:playback` event. After a stake it dispatches `yap:coins-changed`
for the header balance. The Bots sandbox moved behind a "Bots sandbox" tab next to Info.

## Data and interaction

- Header search submits to the existing published-debate search. Navigation opens
  actual discovery/matching/account routes. The balance menu uses authenticated
  runtime data, and the debate balance is explicitly scoped to its current run.
- `GET /api/a4/debates/:id/timeline?scope=human|sandbox` returns at most 100
  settled, revealed rounds in settlement order. It rechecks account/session validity
  and debate/topic publication. Human rounds and the creator's own mixed bot runs
  are separate; observer runs and another creator's sandboxes never enter this feed.
- `GET /api/a4/debates/:id/workspace?runId=...` combines the authorized run,
  scoped balance, run list and timeline into one account-bound polling response.
  One request per five-second refresh preserves the ordinary API request budget;
  unrelated debate IDs and observer runs are rejected. Account/session rechecks
  remain inside the repository transactions. No existing rate limit is increased.
- Every chart point is the exact unweighted YES share for one final round; NO is
  its complement. Empty rounds break the line and have no invented percentage.
  Hover/touch/focus inspects the nearest round. The existing green/red numeric
  badges show that round's YES/NO rates, while its offer/medians appear on the
  scale immediately below the X axis inside the same graph panel. The inspected
  argument replaces the debate proposition in the heading beneath “What fraction
  of participants endorse”; leaving the graph restores the proposition. No argument
  badge sits below the axis and no floating text card covers the plot. Inspection
  never switches the commitment target; clicking or Enter selects the round's run
  and its own receipts. Arrow keys, Home/End and the price inspector's round picker
  provide keyboard navigation. Hovering does not issue backend requests.
  Visible tabs refresh every five seconds, including after the selected run completes.
  A reconnect catches up from durable PostgreSQL state. No speculative values,
  pending counts, provisional payouts, hidden books or secret seeds enter the feed.
- The price scale is the first element after the X-axis canvas; its heading,
  navigation and compact summaries follow it. The graph badges and scale share
  one inspection state. They show the latest settled round by default and restore
  it on pointer leave/focus exit, including after a historical commitment target
  was selected. A background refresh preserves an ongoing hover, and a new
  settlement updates both default displays together. Empty latest rounds show
  unavailable rates rather than substituting an older round or a fictitious share.
  Persistent price/median markers glide horizontally to the inspected round's
  values; the heading slides and fades between arguments. Rapid scrubbing retargets
  these transitions without queuing them, and heading space is reserved to keep the
  graph stationary. Reduced-motion preferences make both changes immediate.
- The inspector below the graph replaces the old horizontal round strip. It shows
  the settled median NO floor and YES ceiling, offered YES price and complementary
  NO price, final YES share and the signed-in user's own YES-scale limit. Missing
  sides and nonpositive median intervals are labeled explicitly; fallback offers
  may lie outside the reported medians. It inspects settled chart history; the
  current commitment form and countdown continue to represent their active run.
  Pending medians/final rates remain sealed.
  Prices on this scale use hundredths of one Yap Coin, denoted `¢`, with no cash value.
- A horizontal countdown inside the chart section derives its remaining fraction
  from the round's actual opening/cutoff timestamps. It updates every second,
  clamps at zero and changes color for the final ten seconds. Its accessible
  progress value includes remaining seconds; reduced-motion preferences disable
  the draining transition. Hovering history does not alter the current countdown.
- New round setup accepts an optional, single-line argument label (1–80 characters).
  The server validates and snapshots it in the existing immutable run configuration;
  all periods in a multi-period advanced run share that label. Historical runs
  without labels say “Argument not labeled.” This metadata does not change A4
  pricing, quantity, endorsement or settlement calculations and needs no migration.
- Volume is executed premium for the displayed settled window, in Yap Coins.
  Counts are labeled human/bot **commitments**, not people or adoption. Sentiment
  explicitly names its settled round; it is not an assertion about truth, a price,
  a rolling five-minute sample or an official debate winner.
- Position buttons, quantity shortcuts and the purchase ceiling use the existing
  server-side review/commit API. NO ceiling conversion, fee allowance, full
  reservation, idempotent retry, first-binding submission and delayed finality are
  unchanged. Open commitments cannot be cancelled. History shows actual receipts.
- Initial signed-in setup marks the participation panel `aria-busy="true"` and
  disables its form controls until publication/run/workspace initialization releases
  the action guard. Controls then regain their prior disabled states and the panel
  reports `aria-busy="false"`, including after initialization errors. Visibility alone
  is not a readiness signal. See [the maintained startup regression](browser-release-checks.md#ci-and-diagnostics).
- Existing live/replay controls, signed replay access, captions, operator controls,
  moderated chat, delivery/recovery, likes, sharing and reports remain connected.
  Replay chat follows the existing read-only policy. Synthetic demo listings label
  their unavailable community rather than pretending to contain a real audience.
- Playback presence uses a bounded, ephemeral in-process roster (5,000 connections,
  65-second expiry) behind the existing publication/origin/body/admission gates.
  Only visible, playing video tabs heartbeat. Pause/exit/expiry remove connections.
  It counts active playback connections on the existing single instance, not unique
  people; it does not write measurement events or bypass measurement consent.
  Shared cross-instance audience measurement is outside this implementation.

## Turn windows

With [Decision 0012](decisions/0012-live-argument-outline.md) turn windows enabled, each live
speaking turn is one Yap Coins trading window cut off at the turn deadline. The coin loop opens it
and signals `window` to the room; `GET /api/public/debates/<id>/windows` lists the windows' timing
for every viewer. This workspace's YAP round controls are unchanged; the YC round bar and ticket
on this page belong to the betting interface work (Decision 0013).

With the live outline enabled, a captions line sits under the video once the page joins the
LiveKit room. It shows the active speaker's latest words from the transcriber agent, at a fixed
height so nothing below moves, and a Captions button turns it off for this browser.
Below the video, an "AI outline" panel shows the active turn's arguments and points in the
speaker's language, earlier turns underneath, and the debater's own flags. It has a fixed height
and scrolls inside itself; live changes arrive over LiveKit and are highlighted briefly. After
each turn a cleanup replaces that turn's entry with its final outline. On a replay the panel
follows the video: it shows the outline as it was at the playing position, with earlier turns'
final outlines.

## Verification and operation

No database migration, new dependency, provider configuration or paid mode is needed.
Use the same owner-provisioned/runtime-only database configuration as A4. Existing
disabled/Yap Coins/Bots switches keep their meanings. A code rollback leaves
append-only A4 history intact; existing obligations keep their settlement recovery.

Run the disposable quality/browser gates with:

```sh
DATABASE_TEST_MODE=host npm run verify:browser
```

This builds and runs fresh/upgrade database checks and the full quality/browser gates.
Omit the mode variable to use disposable Docker PostgreSQL instead. `verify-arena-browser.ts` extends that disposable browser
trial with real settlements, a real published-profile chat message, search, tab
selection, mobile checks, axe and uninterrupted synthetic replay playback during
enlargement. It refuses a hosted target. Synthetic browser playback establishes
component behavior, not LiveKit transport, R2 delivery quality or physical-device
acceptance. See the [dated evidence](evidence/debate-workspace/acceptance-2026-10-15.md).
