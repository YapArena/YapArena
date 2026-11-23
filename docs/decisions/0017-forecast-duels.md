# Decision 0017 — Forecast duels for debate windows

Status: founder decisions, 2026-11-23. Pull request 1 is built: the settlement engine and its
tests. Nothing calls the engine yet, so every window still settles under A4
([Decision 0007](0007-a4-adjusted-ftm.md), [exact rules](../a4-mechanism.md)). When the switch
ships, this record supersedes Decision 0007 for the turn windows of
[Decision 0012](0012-live-argument-outline.md) and amends F10 and F11 of the
[financial brief](../financial-architecture-options.md#3-decisions) for them. Bots mode and every
round opened under `a4-v1` keep A4.

## Founder decisions

1. **Forecast duels become the mechanism of live debate windows.** A window is a closed set of
   sealed tickets, one per account, final once placed, settled when it closes.
2. **No side bet.** A ticket's Yes or No is recorded and counted in the displayed share, and
   carries no money in any window. The whole stake rides on the read. The proposal's opening-window
   side bet is dropped, so every window settles under the same rule.
3. **A window settles only with 10 viewers present.** A viewer who was connected at any point in
   the window counts, so leaving cannot cancel a window. Otherwise every stake is returned.
4. **Replay viewers cannot place tickets for now.** The founder will design a separate form of
   betting for replays. Results are shown at each window's close.
5. **Today's 60-second turn windows first.** Windows cut by what is said stay later work
   (Decision 0012, point 9).
6. **The ticket of [Decision 0016](0016-phone-full-screen-watch.md) is not reopened:** Yes and No,
   the size chips and the read slider stay as approved.

Assumed by this record until the founder says otherwise:

- A viewer is a signed-in account connected to the live debate; the two debaters and signed-out
  viewers do not count. The count is stored with the window when it locks.
- A floor of 5 tickets applies as well (`minTickets`), because duels among very few tickets carry
  little information. The rule itself needs 3.
- Read leverage 12.5; rounding dust goes to a visible system account; a returned window publishes
  no share.

## The rule (`fd-v1`)

Implemented in `src/features/duels/engine.ts` as one pure function, `settleWindow`, of a window's
locked tickets, its terms and the face value. It uses no seed, price or draw, and the platform
takes no position.

- **Ticket.** A side (YES or NO), a read on the YES scale (the stored `limit_value`, a decimal from
  0 to 1 with at most six places) and a size of 1 to 100 contracts. The stake is size × face and is
  the most the ticket can lose. The read is the ticket's forecast of the share of the **other**
  tickets that say YES.
- **Small room.** With fewer tickets than `minTickets`, every stake is returned and no duel runs.
- **Duels.** Every pair of tickets duels once. With n tickets, K of them YES, sides a (1 for YES),
  reads f and stakes w summing to W, the pair (i, j) is scored on the YES share among the other
  n − 2 tickets:

      s = (K − a_i − a_j) / (n − 2)
      gap = clip((f_j − s)² − (f_i − s)², −1/λ, 1/λ)        λ = 12.5, so the cap is 0.08
      result_i = λ · w_i · Σ_j (w_j / W) · gap_ij

  The closer read wins the duel; equally close reads tie and move nothing.

- **Payout.** stake + result, rounded down to an atomic unit. The remainder, fewer atomic units
  than there are tickets, is dust.
- **Displayed summary.** The YES share K / n, the median read, and whether the share came out
  above, at or below that median (`verdict`: YES, EVEN or NO). The verdict moves no coins and is
  never a winner (F09).

Properties, each covered by `tests/duels-engine.test.js`:

- Results sum to exactly zero before rounding.
- No ticket loses its whole stake or doubles it: each result is smaller than the stake.
- A ticket's own side never changes its own result, because every share it is scored on leaves it
  out. Its side does enter the share other pairs are scored on.
- The result does not depend on ticket order.

Worked example, six tickets and 100 YC staked; the share is 66.7% and the median read 63%:

| Ticket | Side | Read | Size | Duels won | Net (YC) |
| ------ | ---- | ---- | ---- | --------- | -------- |
| A      | YES  | 60%  | 10   | 3 of 5    | +3.1325  |
| B      | YES  | 70%  | 20   | 3 of 5    | +5.0150  |
| C      | YES  | 55%  | 10   | 4 of 5    | +2.5075  |
| D      | NO   | 66%  | 10   | 3 of 5    | +4.3375  |
| E      | NO   | 50%  | 40   | 0 of 5    | −16.2500 |
| F      | YES  | 75%  | 10   | 2 of 5    | +1.2575  |

`tests/fd-v1-vectors.json` holds 33 rooms settled by an independent exact implementation that the
founder supplied with the engine. Its 18 reads-only rooms are unchanged; its 15 opening-window
rooms were settled again by that same reference without the side bet.

## Known limits

- **The side is unpaid.** Misreporting it gains nothing and costs nothing, so the displayed share
  and the last-answer figure ([Decision 0015](0015-last-answer-endorsement.md)) rest on answers
  with no money behind them.
- **Coordinated accounts.** One account's side moves the share other pairs are scored on, so two
  accounts acting together gain from the rest of a small room. No settlement rule here detects it.
- **Zero-sum.** The average ticket earns nothing; better forecasters win from worse ones.
- **Not tested on people.** The evidence is simulation with bots.

## Delivery

| Pull request | Ships                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| 1            | This record, the engine and its tests. Nothing calls the engine                          |
| Later        | A stored count of viewers present per window                                             |
| Later        | Ledger postings for a zero-sum window, and settlement that follows each round's own rule |
| Later        | Results at each close for live debates, and no replay tickets on duel windows            |
| Later        | The wording and result display, within Decision 0016's ticket                            |
| Later        | New live windows open under `fd-v1`                                                      |

Still open: how the last-answer figure treats a returned window, and how a window cut short by a
departing debater is refunded.
