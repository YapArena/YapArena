# Decision 0018 — Borrow the microphone

Status: founder decisions, 2026-11-17 to 2026-11-20, tested in a simulator on 2026-11-20. Pull
requests 1, 2a and 2b are built (see [How it is built](#how-it-is-built)); no debate offers the mic
yet.

A viewer can put one question and one follow-up to a debater during a live debate, by voice or by
text. Viewers compete for that right by pledging Yap Coins (YC) to questions; YC spent on a
question goes to the debaters. The rule IDs below (L, F, E, X, N, D, S) are the founder's spec's
and the tests'.

## Founder decisions

**The list (L).** On for every debate (L1). It opens when both debaters have completed three rounds
(L2) and never closes (L3). Any viewer can submit one question of up to 200 characters to a debater
of their choice, with a wager of at least 1 YC (L5, L16, L21); any viewer can pledge at least 1 YC
to any open question, optionally with a paid comment of up to 200 characters shown under it (L6,
L19). Totals are public (L7). Each camp — the side opposite a question's target — ranks its open
questions by total, ties to the earlier (L8, L9). A list gives one mic per camp (L10). A pledge or
wager can be withdrawn at any time until its camp's mic fires; withdrawing the wager removes the
question and refunds its pledges (L11, L20). Debaters cannot submit or pledge (L17), and replay
viewers take no part (L18).

**Firing (F).** Only a camp's current #1 can fire, whenever its author chooses, including in the
middle of a turn (F1, F2). The fired question's total is spent and every other question of the camp
is refunded (L13, L14). Spent YC goes to the two seated debaters in equal halves (L15). One mic is
live at a time; a mic fired while another is live is queued and cannot be cancelled (F11, F13). A
"Yapper incoming" animation covers the stage when a mic starts, naming the asker, the debater asked
and, when the mic cut a turn, whom it cut and the time lost (F15). There is no deadline to fire, no
forfeit and no offer down the ranking: if the #1 does not fire, anyone can outbid them.

**The exchange (E).** Four one-minute turns: question, answer, follow-up, answer (E1, E4). The
asker speaks live or types; typed text is shown and read by a synthetic voice, not moderated, and
the platform can mute a live asker (E2, E9). The asker need not ask the backed text (E7). Whoever
was speaking when a mic fired loses the rest of that turn, and no answer is stretched (E5, E6). A
cut turn's window is refunded in full (E10). Asker turns have windows like debater turns and belong
to the asker's camp (E11). Afterwards the debater who was not the target speaks a full turn (E8).

**Keep the asker on (X).** Viewers, the asker included, can fund an extension of one more question
and answer (X1, X4, X6). Funding opens with the asker's first turn and closes when their last turn
ends, or as soon as the price — the question's total when it fired — is reached (X1, X2). Unfunded
pledges are refunded (X7). Extensions repeat without a cap, with no per-camp time budget (X8, X9).

**Extra lists (N), the end (D) and seats (S).** After both standard mics, a majority of the viewers
present can open a new list through a standing button; it follows the same rules (N1 to N4). A
debate has no fixed length (D1). It ends when more than half of the viewers present have their
standing end button on, when both debaters agree, or when a seat stays empty for 90 seconds (D2,
D3, S11). Viewers present are signed-in viewers connected at that moment (D4). Viewers cannot end
it before three rounds and both standard mics, a camp with no questions counting as done (D5, D6).
Unfired questions are refunded at the end (D7). The first viewer to claim an empty seat, declaring
the side, becomes a debater with no veto by the other (S1 to S3, S7). From that moment they cannot
trade, submit or pledge in the debate, and keep what they hold (S4, S5). Both seats can change
hands (S10).

**Paying the debaters (founder, 2026-11-23).** Debaters receive everything as cash-backed YC
(sandbox `USDC`). A pledger's YC can be grant coins (`YC_PROMO`) or cash-backed; when their pledge is
spent, its cash-backed part goes to the debaters and its grant part is burned to the grant issuer,
the center treasury paying the debaters the same amount in cash-backed YC, as A4 pays winners.
Phase-1 YC still never convert to real USDC.

## Assumed by this record until the founder says otherwise

The simulator runs these the same way.

- L22, L23: a camp that has fired takes no more questions in that list; a viewer whose question
  fired or was withdrawn may submit another.
- F12, F14, F16: a queued mic starts after the resume turn of the mic before it; the animation
  lasts about 2.7 seconds and pauses the debate clock.
- X3, X10, X11, X12: the price is the full total; each extension's funding opens and closes with its
  question; reaching the price pays the debaters at once; pledges above the price are cut and
  extension pledges cannot be withdrawn.
- N5, N6: a later list's vote counts once the current list is done and no mic is live or queued; it
  opens at the end of that round and refunds anything left open in the previous list.
- D8, D9: an empty camp counts as done only after its list's first round has ended; ending the
  debate also refunds open funding and the cut turn's window, while a queued mic stays paid.
- S6, S8, S12, S13, S14: questions to a departed debater go to the replacement; a claimant's open
  question is refunded; a leaving debater's turn ends and its window is refunded while the debate
  waits; YC paid during an empty seat waits for its next occupant; someone who held a seat never
  trades in that debate again.
- Amounts are whole YC (10,000 atoms each), so halves are exact.
- Until D1 ships, mic turns (the four exchange turns and the resume turn) do not count toward the
  rules' maximum length, so a mic never ends a debate mid-exchange; a mic stays live through its
  resume turn, so a mic fired then queues.

## Open

- The outbid-and-fire race: with no close, the #1 can fire the instant they lead.
- An asker who speaks for neither camp.
- Where the list, the Fire button, the asker and the animation sit on the phone full screen. Decision
  0016 fixes that screen, so the mic's interface needs the founder's approval there.
- D1 amends D12 of the [PRD](../product-prd.md#10-risks-dependencies-and-decision-log) ("universal
  bounded-time rules") once it ships; LiveKit offers no spend limit, so an operating ceiling on
  length stays in configuration.

## How it is built

The [build plan](https://claude.ai/artifact/X3UWh8J7nEAmGSRhGFPjkj) ships in phases, each behind
`MIC_ENABLED` (off by default) and copied into a debate's rules snapshot when it starts.

1. The pure rules (PR 1).
2. The list, pledges as `coin_*` ledger holds (reserve, release, payout), firing under a row lock so
   an outbid and a fire cannot both win, the exchange in the turn engine with its own turn numbers,
   and on-screen text questions. PR 2a is built: the list on PostgreSQL, holds, refunds and the
   payment to the debaters on the ledger, and the routes; nothing opens a list until the turn
   engine does in PR 2b. PR 2b is built: debates that start with the switch on open the list when
   round 3 ends, a fired mic cuts the running turn (its window refunded after the cut commits, the
   worker retrying both), each exchange turn and the resume turn get their own turn number and
   window, and the asker can end their turn early or put their text on screen.
3. The asker's live voice, then the synthetic voice.
4. Keep the asker on and extensions.
5. Votes, extra lists and the end of the fixed length.
6. Seat replacement.

Shared with [Decision 0017](0017-forecast-duels.md): the count of viewers present
(`src/features/presence/`) and the void of a cut turn's window (`voidTurnWindow`, reason `turn_cut`)
come from the forecast duels work; the mic consumes them.
