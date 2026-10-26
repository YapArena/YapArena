# Decision 0012 — Live argument outline and turn-aligned trading windows

Status: founder decisions recorded 2026-10-25 (session "Yaparena debate argument summarization").
Built in four pull requests; this record grows with each. Works alongside Decision 0011
(live matchmaking and automatic start) and Decision 0013 (Yap Coins betting interface).

## Goal

While a debater speaks, viewers and debaters see a public "AI outline" of what that debater argues:
arguments with sub-points, refined every few seconds. Each speaking turn is one 60-second Yap
Coins (YC) trading window, and the outline is tied to its window so endorsement can be compared
per argument after settlement. Replays show the outline in sync with playback.

## Founder decisions (fixed)

1. **Windows.** One YC trading window per speaking turn. Turns are 60 s under the current rules,
   and the window length follows the turn. A pause does not move a window's cutoff.
2. **Transcription.** A LiveKit Cloud agent transcribes only the active speaker's own microphone.
   No diarization: the server already lets only the active side publish a microphone.
3. **Speech-to-text.** A provider switch comparing Deepgram Nova-3 through LiveKit Inference with
   ElevenLabs Scribe v2 Realtime (own key), with an optional shadow provider on the same audio.
4. **Languages.** French and English. Each debater chooses their language; a turn's outline is
   written in its speaker's language.
5. **Live loop.** Runs inside the agent: after each finished sentence, at most one Claude update
   every 3 s (configurable), plus a final update at turn end. Claude Haiku 5.5 live, Claude
   Sonnet 5.5 for a cleanup pass per window.
6. **Delivery.** Live outline edits and captions reach viewers over LiveKit, not per-viewer HTTP
   reads. The YapArena server is the authority: it validates, stores, links outlines to windows
   and freezes them at cutoff.
7. **Public.** The outline is labeled "AI outline", debaters can flag mistakes, slurs and insults
   never appear, debaters consent to transcription and the public outline, and transcripts are
   stored with word timings.
8. **Replays** show the outline version matching the playback time.
9. **Later, not now:** windows decided by what is said. Argument spans keep their timestamps so
   this can be tested offline.

## Coordination (hub session, 2026-10-25)

- Debater language and consent are an account-level setting (`GET/PUT /api/me/debater-settings`)
  with an exported server check. Matchmaking calls it at queue entry and challenge acceptance;
  this work does not edit `src/features/matching/`.
- Transcriber dispatch is one exported function, called with a single line where media starts and
  at readiness.
- Open rounds of a debate that becomes `cancelled` or `void_review` are voided automatically. The
  transcriber agent stops when a debate ends or is cancelled.
- No `event_rule_versions` row without the hub: turn length also drives matchmaking reservations
  and the betting interface.
- Matchmaking's `LIVE_DEBATE_CAPACITY` stays at or below the transcriber agents' concurrency.

## Pull request 1: turn-aligned windows

Behind `TURN_WINDOWS_ENABLED` (default `false`, requires `COIN_SANDBOX_ENABLED`). Set it on the
web and worker processes alike.

- **One window per live turn.** Each second the coin loop finds live debates whose running turn
  has no window and opens one in its own transaction: cutoff = that turn's `turn_deadline_at`,
  copied at creation and never changed. `coin_debate_rounds` gains `turn_number` and `turn_side`
  (migration `1792971645611_add-turn-trading-windows`). A unique index on (debate, turn) makes
  retries and overlapping ticks harmless. A window has no creator (`creator_id` is null); a manual
  round always has one.
- **Opening lag** is at most about one second. A turn with one second or less left gets no window.
  A turn the loop never saw running (paused within its first second) gets its window when it
  resumes, with the deadline as resumed.
- **Pauses.** A paused turn keeps its window's cutoff. Speech after the cutoff, when the turn
  resumes, falls outside any window (pull request 2 marks it so).
- **Early end.** Ending a debate early leaves its last window open until its own cutoff, at most one
  turn. Rounds stay immutable.
- **Manual creation during a live debate** (`POST /api/coin-sandbox/debates/:id/rounds`) returns
  the current turn's window, opening it if the loop has not yet, and never a five-minute round.
  Between windows it answers 409. Outside live debates nothing changes: a manual five-minute round
  opens as before. Manual rounds keep their own one-open-per-debate rule, so one opened before
  the debate went live does not hold back its windows.
- **Settlement, terms, seeds, ledger and rails are unchanged.** A window settles like any round
  after its cutoff.
- **Automatic voiding.** Each second the coin loop voids every open round, window or manual, of a
  `cancelled` or `void_review` debate, with reason `debate_unavailable`, restoring exact sources
  (F15: only unopened rounds can be voided). Settlement skips those rounds. The database lets the
  runtime role void only such rounds with that reason; every other void is still the owner's
  `void-round` command. This runs whenever the coin sandbox is enabled, independent of the flag.
- **Room signal `window`** (docs/community-delivery.md): committed when a YC round or window opens,
  settles or is voided. It carries no content.
- **Public window list**, `GET /api/public/debates/:id/windows` (only with the flag):
  `{ debateId, eventStatus, serverNow, windows: [{ id, turnNumber, side, opensAt, closesAt,
state, voidReason }] }`, the latest 100 windows in turn order. No orders, counts, prices or
  seeds. The signed-in view (`GET /api/coin-sandbox/debates/:id/rounds`) adds `kind`
  (`turn`/`manual`), `turnNumber`, `side` and `voidReason` to each round.

## Pull request 1b: the founder's round rules

Migration `1792984532958_add-turn-window-rules`. It applies to every Yap Coins debate round,
windows and manual rounds, with or without `TURN_WINDOWS_ENABLED`. Until it is deployed, keep the
flag off wherever user-created debates exist.

- **Reveal mode (F11).** Each debate is `five_day` or `per_round`, and each round copies its
  debate's mode when it is created.
  - Five-day is the default and the only mode a user-created debate can have. A five-day round
    takes orders until its cutoff and then stays open but locked. It prices and settles at the
    debate's 120-hour close (`live_ended_at` plus 120 elapsed hours, once the debate is `ended`,
    `replay` or `finalized`). Before that nobody sees a price, execution or seed.
  - Per-round reveal is recorded only by the owner, for a founder-created debate, with the
    `set-reveal-mode` command and a reason (`coin_debate_reveal_modes`, append-only). The debate's
    first round locks the mode; the database refuses a later record and ignores any mode the
    inserting code supplies.
  - A cancelled or under-review debate's locked rounds are voided as before (F15: only unrevealed
    rounds).
  - Rounds created before this migration keep revealing at their cutoff.
- **Manual rounds.** A locked five-day manual round no longer blocks the next one: asking for a
  round returns the manual round still taking orders, or opens one. The one-open-manual-round index
  now covers per-round rounds only; the coin transition lock serializes the rest.
- **Participant count (F12).** The signed-in rounds view gives each round's `participants`, the
  number of accounts that committed, at once. It never gives side totals. The drawn price appears
  with the result, at the reveal.
- **Debaters (F14).** Neither debater can take a position in their own debate: the server answers
  403 and the database refuses the order. The signed-in view gives each round
  `eligibility: { canTakePosition, reason }`, where `reason` is `debater`, `committed`,
  `debate_unavailable`, `closed`, `paused` (financial activity paused for correction review), `full`
  or `null`.
- **Both views** give `revealMode` and `revealAt` for each round or window. `revealAt` is the
  cutoff for a per-round round, the 120-hour close once a five-day debate has ended, the actual
  reveal once revealed, and `null` before a five-day debate ends. The public window list also gives
  the debate's own `revealMode` and `revealAt`. It still has no counts.

## Pull request 1c: replay joining

Migration `1792984636802_add-replay-joining` (F10).

- **Recording clock.** When a recording completes, LiveKit reports the file's start. The webhook
  and the missed-webhook reconciliation store it once per debate in `recording_clocks`, before
  marking the recording ready, so a retried completion still records it.
- **Window spans.** A turn window's span in the recording is its `[opensAt, closesAt]` minus the
  file's start, in whole milliseconds and never below zero. Both views give each turn window
  `recording: { startSeconds, endSeconds }`, or `null` before the recording is timed.
- **Joining from the replay.** From a five-day debate's live end until its 120-hour close, a
  viewer can join a turn window after its cutoff. `POST /api/coin-sandbox/rounds/:id/submit`
  takes `replayPositionSeconds`, the position they are watching, which must lie inside that
  window's span. A viewer who already holds a position in a later turn's window of the debate
  cannot join an earlier one: replay viewers never return to earlier rounds. The order guard
  enforces both, and the order records its position (`replay_position_ms`).
- Per-round debates, manual rounds and live debates take live positions only.
- The signed-in view's `eligibility` gains `via` (`live` or `replay` when the viewer can take a
  position) and the reason `later_window`. Replay joiners count in `participants`, and their
  orders settle with the window at the close.
- The server cannot see what the viewer is watching. The position is the client's claim, checked
  against the window's span and the viewer's later positions. Replay viewers can watch the end
  before trading a window (accepted, F10).

## Pull request 2: transcription and captions

Behind `LIVE_OUTLINE_ENABLED` (default `false`; needs LiveKit media and a
`TRANSCRIPTION_INGEST_SECRET` of at least 32 bytes). Migration `1792975000000_add-live-transcription`.

- **Debater settings** (`debater_settings`, `GET/PUT /api/me/debater-settings`): language (`fr`/`en`)
  and consent to transcription and the public AI outline, stored with the consent wording's version
  (`DEBATER_CONSENT_VERSION`). A new wording asks again. `checkDebaterSettings` and
  `assertDebaterSettings` (409, code `debater_settings_required`) in
  `src/features/transcription/debater-settings.ts` are the check matchmaking calls at queue entry
  and challenge acceptance. The form is a "Debating" card in the account's Profile tab, shown only
  when the flag is on.
- **Dispatch.** The agent joins only when dispatched explicitly (`agentName`). The jobs loop
  dispatches each ready or live, non-demo debate with a consenting debater once, so the agent is
  warm before the first word; the operator start route calls the same exported function with one
  line. A database claim per debate prevents a second agent (LiveKit dispatch is not idempotent).
  Failures retry with backoff, five times at most.
- **Turn hint.** The media permission reconciliation (every turn change, pause, resume and end, and
  its five-second repair) writes `{v, debateStatus, mediaState, turnNumber, activeSide,
turnDeadlineAt}` to room metadata, after permissions and best effort. The agent treats it as a
  hint; ingest re-validates. Speaker languages and consent come from the server's session state
  (`POST /api/internal/transcription/debates/:id/session`) rather than participant metadata, so
  speaker tokens are unchanged.
- **Agent** (`src/features/transcription/agent/`, its own compiler project
  `tsconfig.transcriber.json`, image `deploy/transcriber/Dockerfile`). Hidden; subscribes only to the
  active side's microphone; one speech-to-text channel per provider for the active speaker; opens the
  next speaker's channel 1.5 s before the deadline; flushes finals at turn end and on pause.
  `TRANSCRIPTION_PROVIDER=deepgram|elevenlabs`, optional `TRANSCRIPTION_SHADOW_PROVIDER`. Each final
  segment records provider, role, word timings, latency (speech end to final) and audio length. It
  stops when the debate ends or is cancelled, and gives up on a debate that has not started within
  15 minutes.
- **Captions.** Interim (at most four a second) and final text on LiveKit's `lk.transcription` text
  stream, one stream per update with the speaker as sender. Browsers show one line under the video,
  toggleable; the choice is remembered per browser.
- **Ingest** (`POST /api/internal/transcription/debates/:id/updates`): HMAC-SHA256 over
  `timestamp.body`, at most 30 s of skew, 32 KB, ten updates per debate in a burst then five a second.
  One transaction: the debate is live and the turn current (or the turn that ended in the last 15 s,
  for its final flush), segment sides match the turn, the speaker consented. Each segment maps to
  its turn's window by spoken end time; speech after the cutoff has no window. Agent clock drift
  beyond one second is corrected. Idempotent by (debate, job, sequence).
- **Storage.** `transcript_segments` is append-only. Retention is in `docs/data-ownership.md`.

### Capacity per LiveKit plan

A live debate uses one agent session, one LiveKit Inference speech-to-text connection when Deepgram
is the primary (two for about 1.5 s at each turn change), and one recording. Limits read on
2026-10-25 from livekit.com/pricing:

| Plan  | Agent sessions | Inference STT connections | Recordings (egress) | Live debates at most |
| ----- | -------------- | ------------------------- | ------------------- | -------------------- |
| Build | 5              | 5                         | 2                   | 2                    |
| Ship  | 20             | 20                        | 100                 | 10                   |
| Scale | 50 (up to 600) | 50                        | 500                 | 25                   |

Keep matchmaking's `LIVE_DEBATE_CAPACITY` at or below min(agent sessions, half the Inference
connections, recordings). ElevenLabs as primary or shadow is limited by its own plan's realtime
concurrency, also halved for the turn overlap (Free 6, Starter 9, Creator 15, Pro 30).
Approximate costs per live debate hour: agent session $0.60 beyond included minutes, Nova-3
monolingual $0.29, ElevenLabs Scribe v2 Realtime $0.39; a shadow provider adds its own cost.

## Pull request 3: the live AI outline

Also behind `LIVE_OUTLINE_ENABLED`; the agent writes outlines only when it has an
`ANTHROPIC_API_KEY`. Migration `1792984708611_add-live-outline`.

- **Shared reducer** (`src/features/outline/reducer.ts`, browser-safe). A turn's outline has at most
  4 arguments (label ≤ 80 characters) of at most 6 points (≤ 120), each with its time span in the
  turn. Canonical edits: `add_argument`, `update_argument`, `add_point`, `update_point`,
  `remove_point`, `link_rebuttal`. IDs are window-scoped (`t3a1`, `t3a1p2`) and never reused.
  The server resolves the model's proposal (temporary keys, no timings) into canonical edits with
  `resolveEdits`; the server, agent and browsers all apply them with `applyEdits`.
- **Live loop** (`src/features/transcription/agent/outline-loop.ts`, host-independent). Each final
  sentence triggers a call when none is in flight and at least `OUTLINE_MIN_INTERVAL_MS` (default 3000) passed since the last started; otherwise one call is scheduled. Text accumulates; there is
  never a backlog of calls; a skipped call's text is kept for the next. A turn's end flushes once.
- **Claude Haiku 5.5** (`claude.ts`). Thinking off, effort low, a strict JSON schema, `max_tokens`
  800, no retries, a 4 s abort; a refusal or a late answer is skipped (Claude Haiku 5.5 has no
  server-side refusal fallback). The cached prefix is the stable instructions, with French and
  English examples (over the model's 512-token cache minimum), then the proposition and
  debate-wide argument map; the current outline, new text and about 20 s of context follow
  uncached. Each call logs latency and cache read and write tokens.
- **Ingest.** A transcript update may carry a proposal (`baseVersion`, `span`, `edits`, `model`).
  The ingest transaction resolves it under the debate's outline head lock: a stale base answers
  with the latest version and outline so the agent resynchronizes; edits that cannot apply, text
  with French or English slurs or insults (`moderation.ts`), and an outline over 8 KB are
  dropped. An accepted proposal becomes the next live version (`outline_versions`, contiguous per
  debate). Its segments are stored either way.
- **Delivery.** The agent publishes each accepted version as `{v, type: "edits", debateId, version,
turnNumber, side, language, edits}` on the reliable LiveKit topic `yap.outline.v1`. Browsers
  apply version N+1 and repair any gap with one `GET /api/public/debates/:id/outline?after=N`
  (at most 50 versions, else a snapshot; ETag). A page that has not joined the video opens a
  data-only LiveKit connection through the viewer-token endpoint after 3 s; only when that fails
  does it re-read on the `outline` room signal, spread over 3 s. The debate page embeds the current
  outline, so loading it needs no request.
- **Freeze.** Each second the jobs loop records, for every window past its cutoff, the latest live
  version created before it (`outline_windows.frozen_*`): what traders saw. Versions after the
  cutoff are marked outside the window. Pull request 4 adds the final outline.
- **Flags.** `POST /api/debates/:id/outline/flags` lets the debater who spoke a turn flag one of its
  items as a mistake; the panel shows the flag publicly. Freezing and flagging send the `outline`
  room signal.
- **Panel** (`frontend/live-outline.ts`, `outline-panel.ts`, `outline-state.ts`, loaded with the
  captions as one lazy chunk). Labeled "AI outline", in the speaker's language, side shown by name
  and side label. Keyed DOM updates touch only changed text, once per animation frame and never
  while the tab is hidden; a brief highlight on change (none under reduced motion); a fixed-height
  body that scrolls inside itself; screen readers hear new arguments only, at most every 10 s.

## Pull request 4: cleanup, replay sync and correlation

No migration; it uses PR3's `outline_windows.final_*` columns and PR1c's `recording_clocks`. Still
behind `LIVE_OUTLINE_ENABLED` and the agent's `ANTHROPIC_API_KEY`.

- **Window cleanup (Claude Sonnet 5.5).** After a turn's last live call, the agent sends the whole
  turn's transcript (at most its last 8,000 characters), the live outline and the debate's earlier
  arguments to `claude-sonnet-5-5`. Adaptive thinking at low effort (the model rejects disabled
  thinking), a strict JSON schema, a 20 s timeout and one retry, prompt caching of the stable
  instructions. A policy decline is retried server-side on the default fallback
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); a refusal that remains is skipped.
  The rewrite reuses live argument IDs, and links each argument to an earlier one it rebuts
  (either side) or continues (same side).
- **Final outline.** `POST /api/internal/transcription/debates/:id/cleanup` (signed like ingest)
  accepts one cleanup per window, until 60 s after the window froze (`not_frozen` makes the agent
  retry every 3 s, eight times). The server resolves it (`src/features/outline/cleanup.ts`): live
  IDs, spans and unchanged points are kept; new items are numbered above every live one; links
  must name earlier arguments; slurs drop their item; 8 KB at most. It becomes the window's final
  outline (`final_source='cleanup'`), and the agent publishes `{v, type: "final", debateId, turn}` on
  `yap.outline.v1`, which pages apply to that earlier turn. A window with no cleanup 60 s after its
  freeze keeps its frozen outline as final (`final_source='frozen'`, jobs loop). Finalizing sends the
  `outline` room signal, and the snapshot's ETag now includes the number of final windows.
- **Replay timeline.** `GET /api/public/debates/:id/outline/timeline`: every live version with its
  edits and its time in the recording (`at`, from the recording clock), and each turn's final
  outline. Once the debate ended and every window is final it is immutable and cached for a day.
  A replay page reads it once and, on the player's `yap:playback` event (`{debateId,
positionSeconds, playing}`, dispatched by the replay player), shows the outline as it was: a
  binary search for the last version shown by then, replayed forward incrementally; earlier turns
  show their final outline. No request during playback.
- **Correlation.** `GET /api/public/debates/:id/outline/correlation`, from revealed (settled)
  windows with a final outline only, never unrevealed data. Per window: the quantity-weighted YES
  share and its change from the previous reported window. Per argument: its thread (the first
  argument of its `continues` chain), and the share of the window's commitments made while it was on
  screen (live orders after it first appeared; replay orders at a later position). Nothing is
  reported for a window with fewer than five commitments.
- **Chart.** `windowArgumentLabel` in `frontend/arena-chart.ts` turns a window's final argument labels
  into the heading slot's text, replacing the manual argument label for turn windows. Today's chart
  shows A4 rounds, not turn windows; the betting panel's chart (B) passes it each settled window's
  final labels from the timeline.
