# Prompt: implementation plan for the "last answer per account" endorsement rate

You are working in the YapArena repository. Before planning, follow `AGENTS.md`: read
`CONTRIBUTING.md`, check `git status`, `git branch -vv` and `git worktree list`, fetch `origin`
and compare `HEAD` with `origin/main`. This brief was checked against `origin/main` at
`c8fc7a8` (2026-11-12). If main has moved, re-check the file:line references below before relying
on them.

## Your task

Write a thorough **implementation plan** to replace the way YapArena currently calculates and
shows the endorsement rate with the method in the specification below. The plan must fit the
current code, schema, delivery paths and repository rules.

Do **not** judge whether the method is viable, statistically sound or a good product idea. The
founder has chosen it. Where the specification and the repository conflict, or where the
specification leaves a choice open, do not decide for the founder. List it as a decision with
the options, the repo facts behind each option, and a recommended default. Keep the plan going
on that default.

Produce the plan only. Write no code, migrations or doc changes and open no PR until the founder
approves the plan.

## The specification (founder's text, verbatim)

> # Topic endorsement rate: last answer per account
>
> ## What it measures
>
> For a topic, the share of accounts whose most recent answer is YES. Each account has
> exactly one voice. Bet size, price limit, number of turns answered and age of the answer
> are ignored. Older answers stay stored, are dropped from the figure, and are used only
> for the switching statistics.
>
> ## Precondition: one question per topic
>
> Every answer window asks "Do you agree?" with the topic's own question.
> YES = the topic's side A (`topics.side_a_label`); NO = side B (`side_b_label`).
>
> - Queue matches already use the topic title as the proposition
>   (`src/features/matching/matchmaking.ts:288`).
> - Direct challenges and the "Set the proposition" request form currently let the creator
>   type a free proposition, 10–240 characters
>   (`src/features/discovery/web.ts:504–506`, `src/features/matching/router.ts:140`).
>   Lock it to the topic title. Until then, exclude any debate whose proposition is not the
>   topic title.
>
> ## Data
>
> - `coin_debate_orders` (insert-only): `user_id`, `round_id`, `side` (YES/NO),
>   `created_at`. Ignore `quantity` and `limit_value`.
> - `coin_debate_rounds`: `debate_id`, `state`, `revealed_at`. `debates.topic_id`.
> - Only revealed rounds count. Exclude any bot or synthetic identity.
>   Debaters already cannot answer in their own debate (F14).
>
> ## Calculation, for a topic at time T
>
> 1. Take every order in rounds of the topic's debates revealed at or before T.
>    This includes replay answers in five-day debates, which reveal at the 120-hour close.
> 2. For each account, keep its answer with the latest `created_at`.
> 3. Rate = accounts whose kept answer is YES ÷ accounts with a kept answer.
> 4. The figure changes only when a round is revealed. A correction after reveal is
>    appended as a new record, and the figure is recomputed.
>
> Example:
>
> | Account               | Answers, oldest first   | Kept |
> | --------------------- | ----------------------- | ---- |
> | Alice                 | YES, YES                | YES  |
> | Bob                   | YES (April), NO (today) | NO   |
> | Chloé                 | NO                      | NO   |
> | Rate = 1/3 = 33% YES. |
>
> Label: "Of 3,491 accounts, 47% last answered YES ([side A label]). Not a vote, a price or a forecast."
> Always show alongside it: the number of accounts, the date of the last debate, and each
> debate's own result.
>
> ## Switching statistics (all answers, not only the last)
>
> For each account, list its revealed answers on the topic oldest first, by `created_at`.
> A switch is an answer on the other side from the account's previous answer.
>
> - Accounts with 2+ answers, and the share of them that switched at least once.
> - Switches per answer = switches ÷ consecutive answer pairs, split into
>   within one debate and between debates.
> - Of the switchers: stayed on the new side (first ≠ last) vs came back (first = last;
>   mostly misclicks or hesitation).
> - Direction: share of switches toward YES vs toward NO.
> - Per debate: share of accounts with 2+ answers in that debate that changed answer during it.
>
> ## Endorsement bar on the debate page
>
> ### Where
>
> Only on debate pages, along the bottom of the livestreamed video panel. It does not appear
> on topic pages or anywhere else.
>
> ### What it shows
>
> This debate's endorsement rate: each account's last revealed answer in this debate,
> through the latest revealed turn, using the same counting rule as the topic figure.
>
> ### The bar
>
> - A slim bar across the full width of the video panel.
> - The empty bar is 100%. It fills with white from the left up to the endorsement rate
>   (the YES / side A share). The unfilled rest is the NO / side B share.
> - After each turn is revealed, the figure is recomputed and the white fill moves to the
>   new rate.
> - Before the first reveal, the bar is shown with no white in it.
>
> ### Hover or tap
>
> Shows a small card with:
>
> - side A label and %, side B label and %;
> - account count;
> - change since the previous turn;
> - accounts on each side;
> - accounts that switched during this debate, and in which direction.
>
> Make the bar keyboard-focusable so the card can also open without a pointer, and expose
> the rate to screen readers (for example `role="meter"` with the current value).
>
> ### Hard constraints (repo rules)
>
> - Five-day debates, the default: no side data before the 120-hour close
>   (F11, F12, docs/financial-architecture-options.md section 4). During the live debate
>   the bar stays empty. It fills only once results are revealed at the close.
> - Per-round debates (founder-created, or a direct challenge with live opinions, PR #197):
>   each turn reveals at its cutoff, and the bar updates at each reveal.
>   Never use unrevealed orders.
> - docs/a4-mechanism.md: unrevealed A4 data never enters public bootstrap or caches, and
>   community SSE receives no A4 participation data. Compute the figure on the server from
>   revealed rounds only. Deliver it the way revealed turn results already reach the page
>   (frontend/a4-inline.ts → turn-results), not through community SSE.
> - Each turn window still settles on its own YES share. The bar is a separate figure and
>   changes no settlement.
>
> ## Decision still open
>
> - Founder decision record replacing F18, and updating F22 (the ideas market opens
>   around the topic figure), in docs/financial-architecture-options.md.

## What the repository does today (checked at `c8fc7a8`)

### There is no topic-level figure in code yet

- F18 (decaying, quantity-weighted "combined figure", 30-day half-life) is written in
  `docs/financial-architecture-options.md` (row F18 at :129, formula in section 4 at :177-183),
  but **nothing in `src/` or `frontend/` implements it**. F22 (:133) anchors the ideas market on
  that figure; the ideas market itself is not built.
- Every endorsement graph today plots **one value per round**: that round's settled YES share
  `v` = YES orders ÷ all orders, one order per account, refusals included
  (`src/features/a4/engine.ts:166-168`; `docs/a4-mechanism.md:44-47`).

### Surfaces that show an endorsement figure now

| Surface                                                               | Code                                                                                                                                                        | Data source                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topic page "Endorsement history" chart (labelled "Shared simulation") | `src/features/discovery/topic-history-web.ts`, `frontend/topic-chart.ts`, `frontend/homepage-chart.ts`, wired at `src/features/discovery/router.ts:441-469` | `publicBots.topics()` in `src/features/a4/public-bots.ts:340-353`: synthetic bot rounds (`a4_synthetic_rounds`) and opted-in A4 sessions (`a4_sessions`/`a4_rounds`/`a4_submissions`). **Not** `coin_debate_*` |
| Homepage idea cards and sparkline                                     | `src/features/discovery/homepage-model.ts:72-148`, `homepage-view.ts`                                                                                       | Same bot/A4 activity; already maps `yes: topic.sideALabel, no: topic.sideBLabel` (:147-148), display only                                                                                                      |
| Home list "Turn 6: 58% said yes"                                      | `src/features/discovery/home-list-model.ts:226-245` (`latestResult`)                                                                                        | `/windows` `pricing.share` of the latest revealed turn                                                                                                                                                         |
| Debate page "Results by turn" bars                                    | `frontend/turn-results.ts`, `frontend/turn-results-model.ts:28-98`                                                                                          | `/windows` `pricing.share` per settled, revealed turn                                                                                                                                                          |
| Debate page About card "Latest result" slim bar                       | `debate-web.ts:191`, `renderSentiment` in `frontend/a4-inline.ts:157-170`, CSS `public/arena.css:2827-2846`                                                 | Latest revealed round's share                                                                                                                                                                                  |
| Debate page bot-history line chart                                    | `frontend/arena-chart.ts`, fed by `/api/public/debates/:id/activity`                                                                                        | Bot/A4 data, shown until a turn reveals                                                                                                                                                                        |
| Outline correlation API (no frontend consumer)                        | `src/features/outline/repository.ts:618-707`                                                                                                                | **Quantity-weighted** share of settled windows, null below 5 commitments                                                                                                                                       |

Per-debate and per-turn results are "each debate's own result" in the spec's sense and stay.
The plan must say, surface by surface, what changes. The specification says the bar appears only
on debate pages, and that the topic figure is shown with its label, account count, last debate
date and each debate's result. It does not say on which page that topic figure appears, or
whether the topic page chart becomes a history of the new figure (one point per reveal, the
figure "at time T"). Treat that as a decision.

### Data model: what fits

- Real answers live in `coin_debate_orders` and `coin_debate_rounds`
  (`migrations/1792426006100_add-coin-debate-rounds.js`). Live debates use these tables when
  `COIN_SANDBOX_ENABLED` and `TURN_WINDOWS_ENABLED` are on (both on in production). The older
  `a4_*` tables are frozen for human play and are separate.
- `coin_debate_orders`: `round_id`, `user_id` (→ `account_subjects`), `side` YES/NO,
  `created_at DEFAULT clock_timestamp()` (database clock), `replay_position_ms` (set for replay
  answers). Insert-only by trigger (`coin_immutable`) and by grants (runtime has SELECT, INSERT).
- `PRIMARY KEY(round_id, user_id)`: **one answer per account per turn window**, and the first
  commitment is final (`already_answered`, `src/features/account-wallet/debate-sandbox.ts:1336-1344`).
  So a switch can only happen between turns or between debates, never within a turn.
- Replay answers are in the same table, only in five-day turn windows, and a user cannot join a
  window earlier than one already joined (migration `1792984636802_add-replay-joining.js:45-65`).
  Their `created_at` order therefore follows turn order within a debate.
- Bots never reach `coin_debate_orders`: `user_id` must be a real account and the only writer is
  the authenticated `submit` (`debate-sandbox.ts:1481`). Bots exist only in `a4_submissions`
  (`kind='bot'`) and `a4_synthetic_*`. There is no bot flag on accounts.
- F14 is already enforced in three places (database guard, `debate-sandbox.ts:1307-1322`, view
  eligibility).

### Data model: gaps and traps the plan must handle

1. **Void rounds also have `revealed_at`.** The schema CHECK requires `revealed_at` for both
   `settled` and `void` (`1792426006100:22-23`; void sets it at `debate-sandbox.ts:1070-1071`).
   "Revealed" must mean `state='settled' AND revealed_at <= T`, as `publicWindows` does
   (`debate-sandbox.ts:1972-1973`).
2. **Over-capacity orders count (founder, 2026-11-12).** Orders left out of a turn's pricing
   are listed in `result.overCapacity` (`debate-sandbox.ts:670-693`, :921) but stay in the
   table. They count in the topic figure and in the debate bar, so read the raw table, not the
   settlement snapshot. Settlement itself is unchanged.
3. **Rail.** Rounds carry `rail` ('simulation' or 'base-sepolia') and `publicWindows` filters
   by it (`r.rail=$2`). The figure must filter by the same rail.
4. **Publication and demo.** Public reads require `debates.publication_state='published'` and
   `topics.publication_state='published'`. `is_demo` exists on topics, debates and public
   profiles. Decide whether demo debates count. Also decide on suspended accounts
   (`users.account_status`) and retired accounts (an `account_subjects` row with no user).
5. **Ties on `created_at`.** Give a deterministic tie-break (for example turn number, then
   round id).
6. **Corrections after reveal do not exist.** Settled rounds cannot be updated (guard raises once
   `state<>'open'`), orders are immutable, and the only correction mechanism is account-level
   (`coin_sandbox_requests.kind='correction'`, `coin_sandbox_reports`). F16 promises "visible
   append-only correction note, recomputed combined figure". Spec step 4 needs a new insert-only
   table (or a deferred phase), and the plan must say which.
7. **Indexes.** `coin_debate_orders` has only its PK `(round_id,user_id)` and `request_id`
   unique. Rounds have `coin_debate_turn_window(debate_id,turn_number)`. A topic-wide query
   (topic → debates → rounds → orders, `DISTINCT ON (user_id) … ORDER BY created_at DESC`) and
   per-account switch sequences may need new indexes. Estimate cost and propose them in new
   migrations; never edit applied ones.
8. **Compute on read or store at reveal.** The figure changes only at a reveal. Settlement is
   chunked and the final chunk sets `revealed_at` (`debate-sandbox.ts:908-926`), run by the
   worker `tick()` every second. Compare (a) computing on read with a short shared read, and
   (b) appending an insert-only snapshot row per topic and per debate when a round settles
   (which also gives the "at time T" history and "change since previous turn" cheaply). In
   five-day debates every round of a debate reveals at the same 120-hour close, so the topic
   figure moves once per debate.

### Precondition: one question per topic

- Queue matches: `proposition = topic.title` (`src/features/matching/matchmaking.ts:286-288`).
- Direct challenges: free text, `text(value.proposition, 240, 10)` (`src/features/matching/router.ts:140`),
  stored in `match_requests.proposition` (`repository.ts:857`) and copied to the debate on
  acceptance (`repository.ts:630-632` → 292-300). Forms at `src/features/discovery/web.ts:504`
  ("Pick an opponent", with the `liveOpinions` switch) and :506 ("Set the proposition").
- Each round copies the debate's proposition at creation (`coin_debate_rounds.proposition`,
  `debate-sandbox.ts:960`, :1177). No code updates `debates.proposition`, but no trigger
  prevents it.
- Schema limits differ: `topics.title varchar(140)`, `debates.proposition varchar(240)`,
  router minimum 10 characters.
- Exclusion rule: count a debate only when its proposition equals its topic's title. No code
  edits a topic's title today: the only `UPDATE topics` statements change `category`
  (`src/features/matching/topic-category.ts:49`) and `publication_state`
  (`src/features/matching/repository.ts:700`). A direct comparison with `topics.title` is
  therefore enough. If title editing is ever added, it must not silently drop a topic's history.
- Locking means changing both forms, router validation, `match_requests` handling and the
  matching repository. Say whether a database constraint should enforce it, and how existing
  debates and open match requests with a different proposition are treated.

### Polarity: side A is always YES (founder, 2026-11-12)

The founder decided that side A is always the YES answer to the topic's question, and side B
always NO. The plan must make this hold everywhere:

- There is no column mapping YES to side A today. YES endorses the proposition
  (`docs/a4-mechanism.md:72-73`).
- Decision 0013 says "side A is not the yes side" (speakers are named by side label and never
  coloured by answer; `docs/decisions/0013-yap-coins-always-on-and-debate-staking.md:46-48`).
  The new decision record amends that line.
- Topic creation asks for a "Question", then free "Side A" and "Side B" labels, with nothing
  saying side A is the yes side (form in `src/features/discovery/web.ts:353`, validation
  `src/features/matching/router.ts:50-90`: labels 2-80 characters and different). Plan the
  form copy (and any validation) so side A is entered as the YES answer.
- Audit existing topics, where `side_a_label` may not read as the YES answer to the title. Say
  how mismatched topics are found and fixed, or excluded, without silently changing records.
- The stake panel's question ("Do you agree?" with green Yes / red No) and the speakers' side
  labels must stay consistent with this mapping on the debate page.

### Delivery to the debate page

- The spec says "frontend/a4-inline.ts → turn-results". In fact `frontend/stake-panel.ts`
  `loadWindows()` (:233-251) reads `GET /api/public/debates/:id/windows` for signed-in and
  signed-out viewers and passes **only `value.windows`** to `shareStakeWindows`
  (`frontend/stake-windows.ts`, events typed in `frontend/window-chart-model.ts:27-45`).
  `a4-inline.ts` subscribes via `onStakeWindows` (:286-291) and renders the turn bars.
- Refresh: the `window` room signal (a timing-only hint from the `capture_room_signal` trigger,
  no payload) spread over 0-3 s, a 1 s window-boundary check, a 15 s/60 s poll while visible,
  and `visibilitychange`.
- Server: `publicWindows` in `debate-sandbox.ts:1953-1986`, route
  `src/features/account-wallet/window-router.ts:20` (`Cache-Control: no-store`, shared read).
  Pricing is returned only for `state='settled' AND revealed_at<=now`. The public payload has
  no participant or account counts today.
- Natural fits to compare: add a revealed-only debate endorsement block to `/windows` and extend
  the bus type, or a new public endpoint refreshed on the same signal. Either way it must be
  null/empty before the first reveal, never use open rounds, and never go through community SSE
  (`src/features/community/delivery.ts:83-101` carries only topic names). The founder decided that
  every revealed window shows its results, whatever its size; note that the correlation API uses
  a minimum of 5, and keep the new figure consistent with the founder's rule unless told otherwise.
- Topic figure: `/topics/:slug` is server-rendered (`router.ts:441-469`). It reads activity with
  a fallback when the read fails. The new figure should follow the same optional,
  failure-tolerant pattern.

### The bar on the video panel

- Placement is decided (founder, 2026-11-12): a slim bar overlaid on the video itself, along
  its very bottom edge, full width. It is not a strip under the video.
- Panel: `.arena-video-surface[data-arena-video]` inside `.arena-video-slot`
  (`src/features/discovery/debate-web.ts:150-158`). It is `position:relative; overflow:hidden`
  (`public/arena.css:1128`), so an absolutely positioned child stays inside the rounded panel
  and does not change the 960 px+ `--stage-rest` height calculation (`arena.css:3265-3276`).
- Things that also sit near the bottom edge. They are stacking details for the plan to solve,
  not reasons to move the bar:
  - replay `<video controls>`, whose native controls draw along the bottom (:155);
  - `.arena-frame-tag` at bottom-left of each half, shown on hover (`arena.css:1219`, :1253);
  - from 1200 px, chat overlaid bottom-right (`arena.css:3321-3343`, z-index 4, shadow 3);
  - `.arena-chat-toggle` and `.arena-video-expand` (z-index 6);
  - expanded mode `.is-expanded` (`position:fixed; z-index:1000`).
- Current stack: frames 2 < chat shadow 3 < chat 4 < overlays 5 < toggle/expand 6.
- The replay timeline `.arena-timeline` sits **under** the video, outside the surface
  (debate-web.ts:159; Decision 0013, amendment 2026-11-02). Say how the bar and the timeline
  relate on replays.
- PR #188 regression: the empty `.media-videos` once covered "Play replay" / "Join as viewer".
  `scripts/verify-replay-timeline-browser.ts` step 13 checks with `elementFromPoint` at
  390×844, 768×1024 and 1440×900. The bar must not take those clicks.
- Patterns to reuse:
  - the existing slim bar `.arena-sentiment-bar` with `--yes-share` and `data-empty`;
  - turn-results hover/focus captions and roving tabindex (`frontend/turn-results.ts:88-94`, :182-233);
  - the floating `#ya-chart-tooltip` with edge flipping (`frontend/homepage-chart.ts`);
  - `(hover:none)` handling (`arena.css:1458`).

  No `role="meter"` exists yet. Specify the attributes (`aria-valuenow`, min, max,
  `aria-valuetext`) and how tap opens and closes the card on touch.

- The About card's "Latest result" bar shows the latest round's share. Decide whether it stays
  as the per-turn result or is removed so the page doesn't show two different "yes" bars.

### Switching statistics

- Per-debate stats (switchers and direction) are needed for the bar's card. Topic-level stats
  have no stated location; propose one (the topic page next to the figure is the obvious
  candidate) as a decision.
- "Within one debate" means between turns of the same debate (never within a turn, because of
  the PK). "Between debates" means consecutive answers in different debates of the topic.
- All of it is computed from revealed, settled rounds only, with the same exclusions as the figure.

### Docs and rules the plan must cover

- New decision record in `docs/decisions/` (next number after 0014) replacing F18 and updating
  F22 in `docs/financial-architecture-options.md` (table rows and the section 4 formula). Also
  amend the Decision 0013 polarity line, and update `docs/site-design.md` (topic page), the
  debate page design doc, and the status table in `docs/nonfinancial-implementation-plan.md`
  (update it in place).
- Frontend: strict TypeScript under `frontend/`, no `any`, no suppression, no committed
  `public/*.js`. Put pure model logic in a browser-safe module with unit tests, like
  `turn-results-model.ts`.
- Tests:
  - unit tests for the counting rule and switch statistics (including the spec's
    Alice/Bob/Chloé example, ties, void rounds, over-capacity, replay answers and five-day
    before/after the close);
  - PostgreSQL suites (`tests/coin-sandbox-postgres.test.js`, `tests/coin-turn-windows.test.js`);
  - page snapshots (`tests/page-snapshots.test.js`; any markup change in the video surface
    changes them);
  - browser verifiers (`npm run verify:browser`, the PR #188 click check).

  Coverage stays at or above 90%.

- Migrations: new files only, with expand-then-contract ordering. List the "migrate before
  deploy" steps for staging and production.
- Say whether the change ships behind a config flag, and what happens to the bot/simulation
  topic chart (it is labelled synthetic and comes from different tables).

## What the plan must contain

1. **Baseline**: branch, `origin/main` commit, and anything that changed since `c8fc7a8`.
2. **Decisions for the founder**: each conflict or open choice above, with options, repo facts
   and a recommended default. Over-capacity answers, side A = YES and the bar's placement are
   already decided; do not reopen them. At least: which surfaces change; the topic page chart;
   how existing topics are brought in line with side A = YES; proposition lock (existing debates, database
   enforcement); corrections table now or later; demo, suspended and retired accounts; compute-on-read vs snapshots; delivery path; the About card bar; where topic
   switching statistics appear.
3. **Server design**: SQL for the topic figure at time T, the debate figure through turn N, and
   the switching statistics. Give types in `src/features/...`, the module and repository
   function, the route and payload shape, caching, and revealed-only guarantees.
4. **Schema**: new migrations (indexes, optional snapshot and correction tables, proposition
   lock), grants for `yaparena_runtime`, insert-only triggers, and rollout order.
5. **Frontend design**: markup in `debate-web.ts`, CSS in `public/arena.css` (z-index, bottom
   edge conflicts, breakpoints, expanded mode, `hover:none`), a new strict TS module and its bus
   wiring, accessibility, and the card's content and copy.
6. **Topic page**: what replaces or joins the "Endorsement history" section, the label text,
   the account count, the last debate date and each debate's result.
7. **Proposition lock**: form, router, repository and validation changes, and copy.
8. **Tests and verification**: per layer, and which evidence goes in the PR description.
9. **PR breakdown**: small, ordered PRs with what each one ships and depends on, including the
   docs/decision PR.
10. **Risks to repository rules**: anything that could leak unrevealed data, break F11/F12/F14,
    change settlement, or regress the PR #188 stage buttons.

Write the plan as a Markdown document for the founder. Give file:line references for every
claim about current code, and keep it concise.
