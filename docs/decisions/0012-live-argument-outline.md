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

## Later pull requests

2. Transcriber agent, provider switch with shadow mode, dispatch, room metadata, ingest endpoint,
   transcript storage, debater settings and live captions.
3. Live outline: loop module, Haiku integration, shared reducer, outline versions, freeze, LiveKit
   delivery, initial page state, outline panel.
4. Sonnet cleanup, correlation, chart integration, replay sync and timeline endpoint.
