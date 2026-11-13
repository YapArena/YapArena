# Decision 0015 — Last-answer endorsement rate

Status: approved by the founder, 2026-11-13 (implementation plan and decisions D1–D14), building
on answers given 2026-11-12. Planned; nothing below is built yet. Replaces F18 and amends F22 in
the [financial brief](../financial-architecture-options.md#3-decisions), and amends the polarity
line of [Decision 0013](0013-yap-coins-always-on-and-debate-staking.md). Works within the A4 turn
windows of [Decision 0012](0012-live-argument-outline.md) and the hidden-tally rules (F11, F12).

## The figure

A topic's figure is the share of accounts whose **last** revealed answer on the topic is Yes. Each
account counts once, whatever it staked; quantities, limits and results are never read. It
replaces F18's quantity-weighted, 30-day decaying share. The same rule gives each debate its own
figure through its latest counted turn. It is shown as "Not a vote, a price or a forecast."

Counting rules, used by the topic figure, its history, the debate bar and the switching
statistics:

1. **Counted debate:** the debate and its topic are published, the debate is not a demo, and its
   question (`debates.proposition`) equals the topic title.
2. **Counted round:** a turn window (`turn_number` set) of a counted debate, on the configured
   rail, `settled`, with `revealed_at` passed. Void rounds and the older manual five-minute
   rounds are excluded.
3. **Closed turns:** a per-round debate counts turns 1…N only once every turn up to N is settled
   or void. A five-day debate counts only once all of its windows are settled or void, so it is
   revealed all at once.
4. **Counted answer:** every order of a counted round, over-capacity orders included. Bots never
   place these orders, and debaters cannot answer in their own debate (F14); their answers in
   other debates of the topic count.
5. **Answer order:** `created_at`, then the round's `revealed_at`, `turn_number` and round id,
   all ascending. An account's **kept answer** is its last one; the rate is kept Yes answers over
   all kept answers.
6. **Switch:** an answer on the other side from the same account's previous answer, "within a
   debate" when both are in the same debate, "between debates" otherwise. An account has one
   answer per round, so it cannot switch within a turn.

The figure changes only at a reveal, when it is recomputed (spec step 4); nothing moves it in
between.

## Founder decisions

- **Side A answers yes** (2026-11-12). YES already means "agrees with the proposition"
  ([A4 mechanism](../a4-mechanism.md#lifecycle-clocks-and-visibility)); the topic forms now say
  which side that is. Stored side labels are never swapped, because speaker A argued side A's
  label in every past debate.
- **Question lock** (2026-11-13). New challenges always use the topic title as their question.
  Challenges sent before the lock keep their typed question until accepted or expired (at most
  7 days); a debate whose question is not the topic title is not counted and gets no video bar,
  and keeps its per-turn results. No database trigger enforces the lock: the equality filter in
  every figure query is the guarantee.
- **D1 — Home list** "Turn 6: 58% said yes" stays: it is the debate's own per-turn result. The
  legacy home idea feed is not shown and goes with first-run PR 7.
- **D2 — About card "Latest result" bar:** removed. Results by turn shows the latest turn and the
  video bar shows the debate figure.
- **D3 — Bot history line chart** on the debate page stays (labelled practice data). On the topic
  page the shared simulation chart is replaced by the figure's history.
- **D4 — Topics whose side A does not read as yes.** An owner script lists published topics with
  both labels and their debate and answer counts, and flags likely mismatches. The founder records
  each review in an insert-only `topic_answer_reviews` table (owner insert only, latest row wins).
  A topic marked "side A is not yes" shows the figure as plain Yes/No without a side label;
  unreviewed topics follow side A = yes.
- **D6 — Exclusions.** Demo debates are excluded from the topic figure, as in discovery lists; a
  demo debate page still shows its own bar. Suspended and retired accounts still count: their
  answers were valid when given, and removing them would move the figure without a reveal. A
  debate hidden after its points were recorded keeps those points; the next point is computed
  without it.
- **D7 — Manual (non-turn) rounds** are excluded.
- **D8 — Hybrid storage.** The topic figure, its history and the topic switching statistics are
  stored as insert-only points by a separate worker step after each reveal. The debate bar is
  computed on read.
- **D9 — Debate figure delivery:** an `endorsement` block (counts only) in the existing
  `GET /api/public/debates/:id/windows` payload, read in the same snapshot as the turn bars and
  still `no-store`. Never on community SSE.
- **D10 — Switching statistics:** a short "How answers changed" block under the topic figure.
- **D11 — History ranges:** All (default), 1D, 1W and 1M, each counted back from the latest point.
- **D13 — No flag.** Each pull request goes live when it deploys, staging first. The recorder
  ships before any UI, so the history is already filled when the pages show it.
- **D14 — "Last debate" date** on the topic page is the live end date of the debate that produced
  the latest point.
- Also decided 2026-11-12: the debate bar sits on the video's bottom edge, and the topic figure
  and its history go on the topic page. D5 and D12 were dropped.

## Design

- **Model:** `src/features/endorsement/` folds eligible answers into the rate and the switching
  statistics in one pure, browser-safe function. All exclusions live in SQL, so the PostgreSQL
  suites test them; a `DISTINCT ON` query cross-checks the fold.
- **Recorder:** runs each second beside the coin tick, in its own transactions, never inside
  settlement. Per topic it takes an advisory lock, then appends one `endorsement_points` row per
  newly counted round, in turn order: a five-day debate's rounds in one transaction, a per-round
  debate's only after its earlier turns are settled or void. Points are insert-only (updates and
  deletes refused); point order is insertion order, so history is never rewritten. Its first run
  fills the history of existing rounds.
- **Debate page:** a 6 px bar on the video's bottom edge (white Yes share on a dark track, a 12 px
  hit area that shrinks to 6 px over the native replay controls) with a card on hover, focus or
  tap: both shares and counts, the change since the previous counted turn and how many accounts
  changed answer. It stays empty before the first reveal and, for five-day debates, until the
  close. Layout in [the debate page design](../debate-page-design.md#stage).
- **Topic page:** "Where viewers ended up": the figure, its last debate and the number of debates
  counted, each counted debate's final share, "How answers changed" and the history chart (one
  point per revealed turn, placed by order rather than time). Layout in
  [the site design](../site-design.md#topic-history).
- **Schema:** new migrations only: `endorsement_points` (before the recorder deploys), an optional
  covering index on `coin_debate_orders(round_id)` if staging plans need it, and
  `topic_answer_reviews` (before the topic page deploys). Settlement code, its tables and its
  triggers do not change.

## Hidden tallies

Every query requires a settled, revealed round. The database already refuses to settle a five-day
window before its 120-hour close, and the closed-turn rule keeps five-day debates all-or-nothing.
Nothing reads open rounds, sandbox requests or private rounds, and nothing reaches community SSE,
bootstrap templates or the service worker cache. Only counts are published, never account ids. A
small count can expose one account's last answer, the same exposure as a revealed turn's share,
which the founder accepted for every revealed window (Decision 0013).

## Delivery

| Pull request | Ships                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| 0            | This record and the doc updates                                                           |
| 1            | Question lock and side A = yes copy; the polarity audit script and `topic_answer_reviews` |
| 2            | Model, `endorsement_points` and the recorder; no UI                                       |
| 3            | Debate bar in `/windows` and on the video; the About result bar removed (D2)              |
| 4            | Topic figure, per-debate results, switching block and history chart                       |
| 5            | The ignored `proposition` key removed from challenge and request posts                    |

Pull requests 1 and 2 can run in parallel, then 3 and 4. Migrate each environment before
deploying the version that needs a new table.
