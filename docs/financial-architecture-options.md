# Financial architecture options

Decision brief for the founder and a specialist reviewer. Prepared 2026-10-24 from a founder
interview held 2026-10-23 and 2026-10-24, against `origin/main` at `6b076ce`. It resolves or
routes the open points in [PRD](product-prd.md#10-risks-dependencies-and-decision-log) D16 to D19
and lists the D20 questions. It is documentation only: it implements nothing, enables no live
funds, and states no legal or regulatory conclusion.

**Labels.** _Founder_ = decided by the founder in the interview. _Delegated_ = the founder asked
the author to decide (none in this interview). _Deferred_ = still open. _Specialist_ = sent to
qualified review. Earlier founder decisions are cited, not re-decided.

## 1. Starting point

Already decided before this brief and not reopened:

- YC is a YapArena-issued internal balance, **100 YC = 1 USDC**, six-decimal USDC atomic units;
  no ERC-20 ([financial decision sheet](email-first-accounts.md#financial-decision-sheet)).
- Withdrawals: USDC only, to a user-supplied external address, 5 USDC minimum gross debit with the
  network fee deducted from it, no daily cap, manual review (two Toronto business days); Canada
  first, every province disabled pending review
  ([approved decisions](email-first-completion.md#approved-decisions-do-not-ask-again)).
- Grants: 2,500 YC welcome and 500 YC Toronto-daily lots are spend-only; each lot's own profit
  becomes withdrawable once it reaches its target, financed by a separate 50 USDC promotional
  budget (approved, unfunded). New grant-funded exposure pauses when that budget cannot cover it.
- [Decision 0009](decisions/0009-auth0.md): Auth0 sign-in, **no embedded wallet**, sensitive
  operations confirmed by a fresh sign-in; real withdrawals add an email and in-app notice per
  request and per new address, and a 24-hour wait before a new address is usable (point 8).
- [Decision 0007](decisions/0007-a4-adjusted-ftm.md): A4 runs play rounds; the
  [mechanism](a4-mechanism.md) supersedes the PRD's paired issuance, money-share movement, curve
  and draw refunds for A4 only.

What the code does today (verified on `6b076ce`):

- **Ledger.** `coin_accounts`, `coin_journals`, `coin_postings` allow `environment` `sandbox` or
  `live`, asset USDC at precision 6, and account kinds available, reserved, pending, promotional,
  backing, fees, operating (`migrations/1792426001000_add-backed-coin-ledger.js:7-32`). Journals
  are append-only, balanced and sealed; `postCoinJournal` enforces idempotent balanced postings
  (`src/features/account-wallet/ledger.ts:94`).
- **Live is read-only.** The web role may write sandbox rows only
  (`migrations/1792426006000_add-isolated-coin-sandbox.js:182-189`); `GET /api/account-wallet`
  reads live balances and returns `withdrawalsEnabled: false` (`src/app.ts:414-426`).
  `requirePlayAsset` refuses real-fund adapters (`src/features/a4/funding.ts:44-46`).
- **Rails.** `coin_sandbox_controls` pins a database to `simulation` or `base-sepolia`
  (`migrations/1792426006000_add-isolated-coin-sandbox.js:28-32`); the web runtime uses
  simulation only. The Base Sepolia adapter fixes chain 84532 and Circle test USDC
  (`src/features/account-wallet/base-sepolia.ts:26-34`), funds go to one configured custody
  address, and `prepareTransfer` signs in-process with a caller-supplied test key
  (`base-sepolia.ts:239`, `:285`). The owner operator admits pre-signed payouts only
  (`src/features/account-wallet/sandbox-repository.ts:1333`).
- **Withdrawal flow.** Quote, fresh confirmation, reservation into review, owner approval,
  signed payout and reconciliation (`sandbox-repository.ts:985`, `:1017`;
  `src/features/account-wallet/external-operations.ts:117`). The 0009 point 8 notices and
  24-hour new-address wait are **not implemented**; there is no stored-destination table.
- **Sandbox debates run A4 on YC**, with YapArena's center as counterparty and a 0.01 USDC face
  (`src/features/account-wallet/debate-sandbox.ts:48-57`). Before settlement a participant sees
  terms, the seed commitment and their own order only (`debate-sandbox.ts:775-801`).
- **No order book or ideas-market code exists.** The homepage market card is a preview that
  submits nothing (`src/features/discovery/homepage-view.ts:87`).

## 2. Options

### (a) Custodial internal ledger, provider-held funds

- **Who holds funds:** a payment provider holds users' USDC in its custody balance and pays out
  through its API; YapArena keeps the ledger and reconciles against the provider.
- **Hidden tallies:** achievable. Positions never touch a chain; the only public records are
  deposits and payouts at the provider. PRD section 5's warning that public paired purchases
  reconstruct the split does not apply, because no purchase is public. Remaining channels are the
  application's own disclosures (section 4).
- **Code:** the ledger and the provider-shaped `ExternalOperationTerms` (`provider`, `network`,
  `quoteId`) fit. Needs a provider adapter, authenticated webhooks into live journals, and
  reconciliation against provider statements. **Blocker:** no shortlisted provider confirms
  custody and payouts for an individual operator
  ([provider comparison](provider-comparison-20261021.md#recommendation-and-shortlist)).

### (b) Positions on-chain in user wallets

- **Who holds funds:** each user, in their own external wallet; event and idea positions are
  tokens or contract balances.
- **Hidden tallies:** not met without a dedicated privacy design. Every purchase, side, amount
  and wallet link is public ([spec outline B2](product-specification-outlines.md#b2-leakage-analysis));
  a public record of paired purchases reconstructs the split, as PRD section 5 warns. Only
  confidential execution or commit-reveal research paths remain, none proven
  ([B3](product-specification-outlines.md#b3-candidate-designs-to-prototype-not-approved-architecture)).
- **Code:** no embedded wallet exists any more (Decision 0009 point 9); users would need to
  connect and sign with outside wallets, reopening wallet-first sign-in. Needs audited contracts,
  signing flows and chain indexing. The coin_* ledger would become a mirror; A4's center model
  would need on-chain collateral. Largest change of the three.

### (c) Hybrid: internal ledger, operator treasury, on-chain only at the edges — **chosen**

- **Who holds funds:** YapArena, in a treasury wallet it controls; the ledger records each
  user's claim. A provider may convert deposits later; withdrawals are sent by YapArena.
- **Hidden tallies:** same as (a): nothing about positions is on-chain. Treasury inflows and
  outflows are public but carry no side or round information.
- **Code:** closest to today. The Base Sepolia rail already models one custody address, an
  owner-only payout path and finalized-receipt reconciliation. Changes are listed in section 7.

| Criterion                   | (a) Provider custody    | (b) User wallets              | (c) Treasury hybrid      |
| --------------------------- | ----------------------- | ----------------------------- | ------------------------ |
| Holds funds                 | Provider                | Users                         | YapArena                 |
| Hidden tallies              | Feasible                | Needs unproven privacy design | Feasible                 |
| Fits email-first, no wallet | Yes                     | No                            | Yes                      |
| Existing code reused        | Ledger, operation terms | Little                        | Ledger, rail, payouts    |
| Main blocker                | Provider eligibility    | Contracts, privacy, wallet UX | Key security, specialist |

## 3. Decisions

| ID  | Decision                                                                                                                                                                                                                                             | Status   | Date       | PRD      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | -------- |
| F01 | Architecture (c): balances and positions live only in the internal ledger                                                                                                                                                                            | Founder  | 2026-10-23 | D16      |
| F02 | One YapArena treasury wallet holds the USDC; owed winnings are protected by a ledger reserve, not a second wallet, while no user deposits exist                                                                                                      | Founder  | 2026-10-23 | D16      |
| F03 | Every payout is signed on a hardware key (for example the founder's Tangem) after manual review; no live key on a server                                                                                                                             | Founder  | 2026-10-23 | D16      |
| F04 | Settlement asset USDC on **Base**                                                                                                                                                                                                                    | Founder  | 2026-10-23 | D16      |
| F05 | Balances are USDC claims; users carry depeg or issuer-freeze risk, disclosed in the terms                                                                                                                                                            | Founder  | 2026-10-23 | D16      |
| F06 | **Phase 1 accepts no user money.** Users play with free YC under the approved grant rules; only grant profits funded by the promotional budget are withdrawable. Purchases return in a later phase                                                   | Founder  | 2026-10-23 | D16      |
| F07 | Phone verification before a user's first withdrawal; one phone number per account's withdrawals; manual review stays                                                                                                                                 | Founder  | 2026-10-23 | D19      |
| F08 | A4 runs debate markets in phase 1                                                                                                                                                                                                                    | Founder  | 2026-10-24 | D17      |
| F09 | **No debate winner, permanently.** The curve parameter s is retired                                                                                                                                                                                  | Founder  | 2026-10-24 | D16      |
| F10 | One-minute A4 rounds during the live debate. Each minute is a replay timestamp: replay viewers join the round for the minute playing, never an earlier one; those orders settle at the close                                                         | Founder  | 2026-10-24 | D19      |
| F11 | Reveal mode per debate, chosen at creation and locked when the first round opens: five-day (default, mandatory for user-created debates) or per-round (founder-created debates only, live participation only)                                        | Founder  | 2026-10-24 | D17, D19 |
| F12 | Before reveal a participant sees their own order, the round's drawn price once one exists, and a participant count that includes replay joiners immediately; sides never                                                                             | Founder  | 2026-10-24 | D17      |
| F13 | The founder gives up routine viewing of hidden tallies: incident-only access, each access logged with reason. No personal founder orders in A4 rounds                                                                                                | Founder  | 2026-10-24 | D19      |
| F14 | Debaters may not endorse in their own debate nor trade its topic's idea market while it is hidden                                                                                                                                                    | Founder  | 2026-10-24 | D19      |
| F15 | Only unopened rounds can be voided (current A4 behaviour)                                                                                                                                                                                            | Founder  | 2026-10-24 | D19      |
| F16 | After reveal, mistakes get a visible append-only correction note, a recomputed combined figure and the approved original-source balance correction; idea trades in between stand                                                                     | Founder  | 2026-10-24 | D16, D19 |
| F17 | No fees in phase 1                                                                                                                                                                                                                                   | Founder  | 2026-10-24 | D16      |
| F18 | Topic figure: the share of accounts whose last revealed answer on the topic is YES, one answer per account, unweighted ([Decision 0015](decisions/0015-last-answer-endorsement.md); rules in section 4). Its history shows a point per revealed turn | Founder  | 2026-11-13 | D16      |
| F19 | The ideas market ships in phase 1 on YC: one YES/NO market per topic                                                                                                                                                                                 | Founder  | 2026-10-24 | D18      |
| F20 | Ideas units are backed and redeemable: anyone may lock 1 YC to create a YES+NO pair, and any pair redeems for 1 YC                                                                                                                                   | Founder  | 2026-10-24 | D18      |
| F21 | The founder provides early liquidity as a pair-backed market maker                                                                                                                                                                                   | Founder  | 2026-10-24 | D18      |
| F22 | A topic's market opens around its topic figure (F18, amended 2026-11-13); a topic without a revealed debate has no market yet                                                                                                                        | Founder  | 2026-10-24 | D16, D18 |
| F23 | Continuous limit-order book, price-time priority, partial fills; orders rest until cancelled; 0.001 YC price step, whole units, A4 rounding (pay rounds up, receive rounds down, dust to a visible system account)                                   | Founder  | 2026-10-24 | D16, D17 |
| F24 | A closed or duplicate topic pauses trading and cancels open orders; nothing is force-settled; pairs stay redeemable; duplicates are linked, not merged                                                                                               | Founder  | 2026-10-24 | D18      |
| F25 | Idea-market profit follows the same grant rules as debates and can become withdrawable                                                                                                                                                               | Founder  | 2026-10-24 | D18      |
| —   | Deposit provider, routes and conversion for the paid phase                                                                                                                                                                                           | Deferred | —          | D16      |
| —   | Fee rates for the paid phase                                                                                                                                                                                                                         | Deferred | —          | D16      |
| —   | Sponsor revenue split between debaters, until a sponsor contract exists                                                                                                                                                                              | Deferred | —          | D19      |

Consequences derived by the author (analysis, not founder decisions):

- **Five-day debates price at the close.** A4 draws a round's price from all locked orders
  ([mechanism](a4-mechanism.md#terms-and-arithmetic)). Because replay viewers join the same
  rounds until the 120-hour close, a five-day round can only lock and price then. Before reveal,
  five-day participants therefore see their own order and the count, not a price or execution.
- **Paid-to-free shifts the money flow.** With free YC, every withdrawable profit is a cost to the
  promotional budget, including idea-market gains (F25). The finite-treasury admission rule must
  also cover idea-market exposure, and payouts need wash-trading checks across linked accounts.
- **Zero participation.** An empty round has no offer and undefined settlement (A4); it adds
  nothing to the topic figure. F22 means such topics have no idea market until something is
  revealed.

## 4. Hidden tallies in the chosen design

Promise for phase 1: until a debate's reveal, YapArena discloses no side totals, settlement
shares, books or prices beyond F12, to anyone, including the founder outside a logged incident.
The PRD warning about public paired purchases does not arise: A4 has no public tape and the
ledger is internal. It is not yet a verified claim; the
[B4 evidence](product-specification-outlines.md#b4-prototype-evidence-required) is still required.

Residual channels the reviewer should assess:

| Channel                          | What leaks                                                           | Status                                         |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Immediate participant count      | Activity per minute; a known person's join can be noticed            | Accepted by founder (F12)                      |
| Drawn price in per-round debates | Range between side medians                                           | Inherent to A4; reveal follows within a minute |
| Replay viewers                   | Can watch the end before trading a minute; know more than live users | Inherent to F10; disclose to users             |
| Ideas market prices              | Traders' expectations of hidden debates                              | Public by design; no hidden data feeds it      |
| Founder incident access          | Direct knowledge                                                     | Logged and reasoned (F13)                      |
| Public speech, receipts shared   | Expectations                                                         | Outside any guarantee (PRD section 5)          |

Topic figure (F18, [Decision 0015](decisions/0015-last-answer-endorsement.md), replacing the
quantity-weighted, 30-day decaying share approved on 2026-10-24). For topic _t_, take every order
in a settled, revealed turn window of a published, non-demo debate whose question is the topic
title, counting a debate's turns only once every earlier turn is settled or void (a five-day
debate only once all of its windows are). Order each account's answers by order time, then reveal
time, turn and round, and keep its last one:

    figure(t) = accounts whose last answer is YES  /  accounts with an answer

Each account counts once; quantities, limits and results are not read. It is labelled "Not a
vote, a price or a forecast." Only revealed rounds count, so the figure cannot leak hidden data,
and it changes only at a reveal. A
[2024 follow-up](https://Www.Gwern.net/doc/statistics/prediction/2024-atanasov.pdf) found an
automated market maker (LMSR) outperformed continuous order books on low-activity questions; this
is noted for the founder's market-making rule, not decided.

## 5. Effect on earlier PRD decisions

The founder's answers depart from confirmed PRD rows. This brief changes only D16 to D20 in the
PRD; the rows below stay as written until the founder revises them.

| PRD row | Confirmed text (short)                         | Phase 1 per this brief                               |
| ------- | ---------------------------------------------- | ---------------------------------------------------- |
| D01     | Both markets ship with real-money crypto       | Both ship, on free YC with withdrawable grant profit |
| D02–D03 | Pooled money baseline; fee-free paid bootstrap | Last-answer share of accounts (F18); new topics wait |
| D04–D05 | Money-share winner; continuous curve           | No winner, permanently (F09)                         |
| D06–D07 | Paired event tokens; draw/void refunds         | A4 center counterparty; void unopened rounds only    |
| D08     | Founder liquidity counts as support            | No founder A4 orders; founder makes the ideas market |
| D11     | Founder access to hidden tallies               | Incident-only, logged                                |
| D13     | Winning-debater sponsor share                  | No winner; split deferred                            |

## 6. Questions for the specialist

Questions, not conclusions. Supply this brief, the [A4 mechanism](a4-mechanism.md), the
[grant rules](email-first-accounts.md#financial-decision-sheet) and the
[eligibility outline](product-specification-outlines.md#d-launch-eligibility-specification-outline).

1. **Custody.** YapArena (an individual, not incorporated) holds USDC owed to users in a
   self-controlled treasury wallet on Base. Is that custody of client assets under Québec and
   Canadian securities rules (AMF, CSA crypto-asset trading platform guidance)? What protection,
   segregation, insurance or registration would apply, and does the answer change when user
   deposits arrive?
2. **Money services and FINTRAC.** Do free-play payouts in USDC, later crypto deposits converted
   to USDC, or withdrawals to user-supplied addresses make YapArena a money services business or
   virtual-currency dealer? What triggers registration, record keeping, travel-rule and
   large-virtual-currency-transaction reporting, and at what thresholds?
3. **Classification of A4 rounds.** Users endorse YES/NO with a price limit against YapArena as
   counterparty and settle on the endorsement share. Are these derivatives, securities, betting
   or another regulated activity in Québec and Canada, with free coins and with paid coins?
4. **Classification of ideas units.** Pair-backed YES/NO units redeemable as a pair for 1 YC,
   traded on a continuous book with the founder as market maker: what are they, and does
   founder market-making need registration or conduct controls?
5. **Free-to-play prizes.** Free YC whose profit becomes withdrawable USDC: do Québec publicity
   contest rules (Régie des alcools, des courses et des jeux), skill-testing or no-purchase rules,
   or gaming law apply? Which disclosures and terms are required?
6. **Identity.** Is phone verification before the first withdrawal sufficient, or are age,
   residency, identity, sanctions or wallet screening required, and from which amount?
7. **Founder conduct.** With incident-only tally access and founder market-making, what
   disclosures, logs and trading restrictions are required?
8. **USDC risk.** Is it sufficient to disclose that balances are USDC claims and users bear depeg
   or freeze risk (F05)?
9. **Data.** Retention of withdrawal addresses, phone numbers and audit logs; cross-border
   processing by Auth0 and an SMS provider.

## 7. Engineering: blocked and safe to continue

Safe to continue now (no remaining decision needed; still sandbox or play only, real funds stay
disabled):

- A4 one-minute rounds, replay joining by video minute with no return to earlier rounds, reveal
  mode at creation and its lock, live-only per-round debates, immediate participant count, and
  the debater and founder exclusions (F10–F14). A4 and `debate-sandbox.ts` are the base.
- Visible correction records and topic-figure recomputation (F16, F18); topic history
  graphs with alternative windows.
- Ideas market in the sandbox on YC: pair mint/redeem, limit-order book, 0.001 tick, topic
  pause and linking, founder market-maker account, finite-treasury coverage of idea exposure,
  wash-trading signals (F19–F25). All new code; no order book exists.
- Live-withdrawal groundwork that does not move money: a Base mainnet adapter derived from
  `base-sepolia.ts` that exports unsigned transactions and imports hardware-signed ones (F03,
  F04); the 0009 point 8 notices and 24-hour new-address wait; phone verification (F07, needs an
  SMS provider choice and cost approval); incident-only tally access with audit logging (F13).
- The B4 hidden-tally evidence: data-flow inventory, access matrix, reconstruction attempts
  against the residual channels in section 4.

Blocked:

| Work                                                        | Blocked until                                           |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Enabling any `live` journal, payout or real-USDC withdrawal | Specialist answers 1, 2, 5, 6; funded treasury; E-gates |
| Funding the 50 USDC promotional budget for real payouts     | Specialist answers 1, 2, 5; founder action              |
| Deposit provider adapter, purchase flow, deposit routes     | Paid phase scheduled; provider deferred (section 3)     |
| Paid-phase fee schedule and fee accounting on real USDC     | Fee rates deferred                                      |
| Sponsor payouts to debaters                                 | Sponsor split deferred; a sponsor contract              |
| Claiming hidden-tally protection publicly                   | B4 evidence and reviewer acceptance                     |
| Real-money ideas market                                     | Specialist answer 4; E10                                |

Release gates in [spec outline E](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds)
still apply in full; E02, E06 and E13 need rewording for A4 and the no-winner decision, which is a
separate PRD revision for the founder.
