# YAP Arena — Product Requirements Document

Version 1.0 · September 29, 2026 · Product direction and implementation handoff

**Status:** completed product specification with explicitly unresolved implementation decisions. This document describes planned behavior; it does not establish that features exist or authorize accepting real funds. It supersedes product draft v0.3 and incorporates the founder’s subsequent answers, including approval of collateral-backed event-token pairs and separately reserved refundable fees.

**How to read this document:** **Confirmed** records founder decisions. **Proposed** identifies a design or measurement choice awaiting acceptance. **Open decision** identifies an unspecified choice. **Requires specialist review** identifies a release dependency requiring qualified review. A derived mathematical result is identified as analysis, not attributed to the founder. No passage labeled “Recommendation” is retained.

The companion [specification outlines](product-specification-outlines.md) contain four separate specification outlines, worked accounting examples, evidence requirements, and primary sources. API, database, contract, infrastructure, and deployment designs belong in those subsequent technical specifications. Repository implementation must be inspected before claiming feature status. The [template PRD](template-prd.md) records the reusable backend foundation; this document governs YAP Arena product behavior when the two differ.

Current implementation is indexed in the [nonfinancial plan](nonfinancial-implementation-plan.md#current-implementation-and-evidence).
The dated requirements below remain authoritative product intent; they do not describe which
features have shipped. The later [measurement contract](measurement-operations.md#28-day-returning-participant-metric--definition-approved-gate-pending)
records approval of the nonfinancial returning-participant definition only; the 30% gate and
financial measurement remain unapproved.

**Later A4 decision (October 15, 2026):** [Decision 0007](decisions/0007-a4-adjusted-ftm.md)
selects A4 adjusted FTM for nonredeemable Yap Coins and labeled Bots mode. Its
[exact mechanism](a4-mechanism.md) supersedes the historical event money-share movement,
paired issuance/matching, clipped payout curve and special draw refunds for A4. The historical
rules below remain provenance, not the A4 implementation contract. A4 neither chooses a debate
winner nor implements the ongoing market or sponsor/creator payouts. Other product decisions
and real-fund release dependencies remain unchanged. See [current financial work](financial-implementation-plan.md).

**Later account and currency decisions (October 20, 2026):** the
[email-first account contract](email-first-accounts.md) and
[approved execution decisions](email-first-completion.md#decisions-received-during-this-execution)
govern current authentication and the separate internal YC sandbox. They supersede
the historical wallet-first preference, initial Canada/US targeting and withdrawal-fee
wording below for this flow: signup is email-first without wallet provisioning,
Canada is the initial target subject to eligibility review, and 100 YC = 1 USDC.
Withdrawals have a 5 USDC minimum gross debit, with the displayed network fee
deducted from that debit and no daily withdrawal cap. Completed purchases leave
through USDC withdrawals only. Purchased funds have no grant-profit target;
grant principal remains spend-only with independent, permanent qualification of
each grant's remaining profit. These decisions do not convert historical play
balances, change unrelated market economics or enable live funds. The broader
instrument and combined paid-release dependencies remain open.

## 1. Product vision and the user problem

**Make debate a continuing public competition where people can argue, financially support positions, and follow the history and market value of ideas.**

The initial problem hypothesis is that debate history is fragmented. Arguments and reactions disappear into feeds; audiences struggle to follow an idea across speakers and events; creators rarely share a lasting competitive record. YAP Arena connects live debates, replay, audience-funded outcomes, profiles, topic histories, and ongoing markets in one destination.

Two related demand hypotheses require separate validation: viewers want to pay to influence debate outcomes, and traders want continuing exposure to ideas. Interest in debate archives alone does not validate either financial behavior.

The intended business earns small fees on event participation and ongoing-market trades, plus sponsorship sold across debates. Winning debaters receive a share of sponsorship revenue attributed to their event. Audience settlement, creator rewards, and platform revenue are distinct flows.

YAP Arena should be useful to someone who simply arrives to browse or watch. Wallet connection is required for financial participation, not for watching. External creators and broadcasts distribute the product through links, QR codes, and overlays, while the platform retains discovery, histories, profiles, follows, and financial participation.

## 2. Target users and their main jobs

**Confirmed:** serve both established creators and ordinary users. The business operates from Québec and targets Canada and the United States; exact eligible provinces, territories, states, ages, and customer categories require specialist review.

| User             | Main job                                            | Successful experience                                                      |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Everyday debater | Find an opponent and defend a position              | Understands the format, participates, and builds a public record           |
| Creator          | Bring an audience and monetize winning performances | Runs a dependable debate and receives an explainable sponsor reward        |
| Viewer           | Discover and follow compelling debates              | Watches live or replay, engages, and returns to topics or people           |
| Paid participant | Financially support a side and receive settlement   | Understands influence, cost, lockup, possible loss, and payout             |
| Idea trader      | Hold or trade an idea position across debates       | Understands the instrument, available liquidity, and withdrawal process    |
| Moderator        | Enforce conduct and integrity rules                 | Can investigate, intervene, explain decisions, and handle appeals          |
| Sponsor          | Reach audiences across platform debates             | Receives contracted exposure and credible delivery reporting               |
| Founder/operator | Operate markets and programming                     | Can reconcile funds, investigate incidents, and showcase finalized debates |

These are roles, not mutually exclusive account types. One person may watch, debate, and trade. Rules governing debater self-participation and other related-party activity remain open; wallet count is never represented as verified human count.

## 3. What makes YAP Arena distinct

### Two connected markets

| Dimension     | Event market                                                                          | Ongoing ideas market                                                                               |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Purpose       | Determine an event winner through movement in audience money share                    | Let participants hold and trade continuing idea positions                                          |
| Participation | Purchase financial positions supporting either side                                   | Buy and sell the defined idea instrument                                                           |
| Exit          | Accepted positions cannot be resold or voluntarily withdrawn                          | Selling and withdrawal of available proceeds are supported                                         |
| Duration      | Includes live debate and five days after its actual end                               | Persists across multiple debates                                                                   |
| Price         | Polymarket-style order-book price discovery, adapted to locked positions              | Order-book price discovery through participant demand and supply                                   |
| Outcome       | Relative money-share movement selects the winner; a separate curve determines payouts | Debate records inform trading; results do not mechanically reset prices                            |
| Visibility    | Official tallies and results hidden until participation closes                        | Market information is visible under the instrument rules, without disclosing private event tallies |

**Confirmed:** paid participation influences the event outcome itself. This is not merely prediction of an independently judged winner. The result represents financially expressed support under the published rule; it does not establish objective truth or one-person-one-vote consensus.

The continuing record ties each debate to its topic, opposing positions, debaters, finalized outcome, and related market. The proposed competitive advantage is the accumulated community and history, not a claim that the software cannot be copied.

### Three quantities that must remain distinct

1. **Historical support baseline:** pooled eligible money allocated to each side across prior debates in the topic.
2. **Trading price:** what participants offer and accept in the order book.
3. **Event settlement value:** the per-token payment produced by the continuous curve or the draw/void refund exception.

Do not label any of these as interchangeable. In particular, a historical 60% support share does not guarantee a current executable price of 0.60. Opening liquidity may be quoted around that baseline; it must actually be funded and offered. Polymarket itself describes opening prices as emerging from orders, not preset odds. [P1]

## 4. Core user journeys

### Viewer discovers and participates

The viewer arrives directly, through a followed profile or topic, or through an external event link. The event page identifies the proposition, two sides, debaters, sponsor, live/replay status, applicable rules, and closing deadline. Watching requires no wallet.

For financial participation, the viewer connects a wallet, chooses a side, and reviews the actual quote or limit price, quantity, total principal, fee, maximum loss, lockup, and settlement rule. The interface distinguishes a displayed market price from an executable quote and identifies unfilled or partially filled orders. A wallet connection never authorizes a purchase by itself.

After acceptance, the user receives a durable private receipt and position history. Failed, pending, accepted, closed, settled, refunded, and disputed states must be understandable. Retrying cannot duplicate the purchase. The user can chat, react, engage with time-extension controls, follow the topic or speakers, and discover the next event.

### Replay viewer participates within five days

The replay and financial participation remain available for five days after the actual live end. Display the exact deadline and time zone. The proposed implementation is 120 elapsed hours, avoiding daylight-saving ambiguity; this operational interpretation awaits final rule approval.

Late participants use the same frozen baseline, curve parameter, fees, and event rules as earlier participants, but their entry prices may differ. Official totals, leader indicators, and results stay hidden until close. Chats, likes, and permitted engagement remain visible. Finality checks may delay publication after the cutoff, but never reopen participation implicitly.

### Debater creates or joins a match

A user creates or selects a topic, selects a side, and enters matchmaking or sends a direct challenge. Both paths are supported. Users create topics without needing a platform-wide ideological taxonomy. Related arguments may belong to the same topic; for example, nuclear energy’s cost and expansion can inform support for a nuclear-positive position.

Every event still requires a clear proposition and consistent side mapping to its topic. Accepting an opponent does not negotiate custom economic rules. Two debaters complete readiness checks and speak under platform-managed timers with bounded audience-driven extensions. There is no required host.

After live completion, replay participation runs for five days. Final settlement updates the debaters’ records and the topic’s history. The winner receives the published share of allocated sponsorship revenue, separately from audience payouts.

### Trader follows an idea

The idea page presents its definition, opposing position, related debates, historical support, finalized results, and trading information. Before purchase, the trader can read the instrument’s rights, supply rules, fees, exit conditions, and any redemption terms. A stock-market analogy grants no equity, dividend, or sponsorship entitlement.

The trader buys or sells through available orders and withdraws available proceeds. Selling, receiving proceeds, and withdrawing them are separate operations. The platform never promises a counterparty or an immediate exit at the displayed price.

### Moderator and operator resolve an incident

Users report conduct, suspected cheating, manipulation, or technical failures. Moderators review evidence, record reasons, notify affected parties, and support appeals. They may restrict chat, remove prohibited material, pause an event, or initiate void review under published rules. They do not replace the money-based winner with an assessment of argument quality.

Founder-only access to hidden event data is confirmed initially. Future administrators may receive security-related access. Ordinary moderation and sponsorship access does not imply tally access.

### Recap programming brings viewers back

The founder can showcase notable debates after their markets close and settlement is finalized, combining replay clips, commentary, final statistics, and upcoming events. Historical statistics are labeled accordingly. A recap never reopens a settled market.

## 5. Product principles and debate integrity rules

### Universal format

**Confirmed:** two debaters, no required host, equal initial speaking time, bounded engagement-driven extensions, and an overall maximum duration. Initial minutes, extension units, qualifying engagement, whether extensions cost money, and allocation between speakers remain open. Rules apply platform-wide and change prospectively; open events retain their rule version.

### Historical baseline and first-topic bootstrap

Let H_A and H_B be cumulative eligible principal allocated to the topic’s two sides in previous qualifying debates. At an event’s baseline snapshot:

\[
b_A=H_A/(H_A+H_B),\qquad b_B=1-b_A.
\]

This is pooled money weighting, not an average of debate percentages. For $60,000 for and $40,000 against, the baseline is 60%–40% regardless of how that money was distributed across events.

For any new topic with no usable history, paid participation before its first live debate establishes the baseline. This bootstrap participation is exempt from event transaction fees, creates financial positions, and is included in the first event’s final support and payouts. It is not a separate nonfinancial ballot. The exact snapshot instant and no-participation handling remain open; undefined support must never silently become 50%–50%.

**Proposed accounting convention:** support uses accepted acquisition principal excluding fees and unrelated deposits; ongoing-market trading volume does not enter event support. Exclude void events from future baseline accumulation, count each qualifying event once, and version corrections. These conventions must be approved in the economics specification because they affect results. Concurrent events use their own frozen snapshots; no event’s baseline changes mid-participation.

### Winner selection

Let M_A and M_B be eligible event principal at close, including applicable bootstrap participation and founder positions:

\[
c_A=M_A/(M_A+M_B),\quad c_B=1-c_A,
\quad \Delta_A=c_A-b_A,\quad \Delta_B=-\Delta_A.
\]

A wins if Δ_A > 0; B wins if Δ_A < 0; no movement is a draw. Both sides cannot gain relative share against the same baseline. A side can win while remaining below 50%. “X+1” means positive relative movement, not a mandatory one-percentage-point threshold. Compare exact accounting quantities rather than rounded display percentages; precision and rounding policy must be specified.

### Continuous audience payout

**Provenance:** recovered from an August 5 project discussion; subsequently confirmed by the founder as the intended production curve. The historical s = 0.20 is an example, not the approved production parameter.

\[
q=(\Delta_A-\Delta_B)/2=\Delta_A,
\qquad y_A=\operatorname{clip}\left(0.5+q/(2s),0,1\right),
\qquad y_B=1-y_A,\quad s>0.
\]

For n_A A-tokens, gross settlement is n_A U y_A, where U is one collateral unit. Profit subtracts actual acquisition principal and fees. The opposite side can receive a nonzero payout. Supporting the winning side does not guarantee profit.

**Confirmed funding:** each event-token pair, one token per side, is backed by U. Participants provide the capital; the founder may manually provide early liquidity, with no founder-imposed maximum. Founder financial support counts in audience support; its stated purpose is liquidity rather than profit. No automated founder-funding mandate or substitute voting rule is introduced.

**Derived solvency condition:** with N fully backed pairs, aggregate curve liability is NU(y_A+y_B)=NU. Equal issuance and full backing must hold for all outstanding claims, including founder inventory. Unfunded promises of future liquidity do not count as collateral. Polymarket’s complete-set issuance is the external reference for paired backing. [P2]

**Confirmed draw/void exception:** refund actual committed principal plus platform event transaction fees. Do not apply the curve’s 0.5/0.5 value to a draw. Event fees remain separately reserved until settlement so these refunds can be honored. Blockchain network-cost reimbursement remains open. Sponsor revenue and ongoing-market balances cannot silently fund event obligations.

### Hidden tallies and public engagement

Until close, withhold official event side totals, relative movement, leader indicators, and results from the public, debaters, sponsors, and ordinary staff. Users see their own receipts; the founder is the initial authorized exception. Event orders, fills, token balances, quote responses, notifications, and analytics must be included in the disclosure analysis.

**Important limit:** public histories can make a historical baseline reconstructable; public speech and voluntary receipt sharing can inform expectations. The product must not promise that nobody can infer support or predict the winner. Protecting unreleased platform data is different from hiding public history. Public-chain visibility also requires an actual privacy design, not merely hiding a screen counter. [P3]

**Open decision:** the executable event-price and order-book disclosure model. A public record of all paired event purchases could reconstruct the money split. No claim of hidden tallies is accepted until the companion prototype requirements are met.

### Expression and integrity

Favor free expression and controversial viewpoints while enforcing published rules on threats, harassment, cheating, and technical integrity. “Twitter style” expresses a preference, not automatic adoption of another service’s policies. Apply conduct rules consistently across viewpoints; do not award wins for ideological correctness.

## 6. Major capabilities and their priority

Both markets ship together in the first release. The following capabilities are required for that release; presentation polish may vary, but financial correctness and disclosure cannot be deferred.

| Priority | Capability                                              | Acceptance outcome                                                          |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| P0       | Direct discovery, profiles, follows, topic pages        | Users can browse without a wallet and follow persistent histories           |
| P0       | Matchmaking and direct challenges                       | Both routes create a correctly mapped two-person event                      |
| P0       | Live debate, timers, bounded extensions, replay         | The hostless format operates and establishes an authoritative end time      |
| P0       | Wallet access and financial receipts                    | Users explicitly authorize and can inspect each financial action            |
| P0       | Event order entry and paired backing                    | Accepted positions are funded, locked, correctly counted, and reconciled    |
| P0       | Five-day close and hidden event data                    | Late participation works; unauthorized surfaces reveal no prohibited totals |
| P0       | Results, curve settlement, refunds                      | Winner, payouts, draw, and void follow separate documented rules            |
| P0       | Continuing ideas market                                 | Users can buy, sell, view history, and withdraw available proceeds          |
| P0       | Chat, likes, reports, appeals, incident operation       | Engagement and conduct controls work without a required host                |
| P0       | Sponsor coverage and winner rewards                     | Contracted exposure, allocation, and creator payments are traceable         |
| P0       | Basic external distribution                             | Links and shareable event information bring users to the platform           |
| P1       | Recap production tools and richer overlays              | Improve distribution without blocking the two-market core                   |
| P1       | Borrow the microphone                                   | A viewer question backed with YC reaches a debater live; YC is reconciled   |
| Later    | Seasons, complex ratings, advanced trading, native apps | Separate prioritization; none is implied by the core rules                  |

The ongoing instrument’s supply, legal rights, redemption or closure treatment, and liquidity arrangements remain open despite confirmed order-book pricing. An order book determines transaction prices; it does not define what is owned. It must not be replaced by monthly performance contracts or administrative repricing.

## 7. First release scope, later releases, and explicit exclusions

**Confirmed release decision:** launch the dedicated platform with both real-money crypto markets together. Simulations, development environments, and user research are preparation, not a replacement commercial launch or an unapproved staged rollout.

**Proposed delivery surface:** responsive web supporting desktop and mobile browsers, with one settlement asset and one network as already accepted. Native apps and additional assets/networks are later candidates. Asset, network, custody model, initial languages, and exact operational limits remain open.

Launch requires: frozen market and refund rules; selected curve parameter; complete ongoing-instrument definition; demonstrated accounting and privacy; security review; withdrawal and recovery drills; workable moderation and dispute policies; contracted platform-wide sponsor coverage; and qualified eligibility review for each permitted jurisdiction. Both markets must pass their gates before the combined paid release.

Sponsors pay for exposure across all debates. This is the confirmed commercial model, not evidence that a contract already exists. Event attribution, winning-debater share, payout timing, overlapping campaigns, and draw/void creator compensation remain open. Small event/trading fees are confirmed; actual rates remain open. No withdrawal fee is approved.

Explicit exclusions: judge-selected winners; required hosts; per-match negotiated rules; event-position resale or voluntary withdrawal; public interim outcomes; one-person-one-vote substitution; winner-takes-all pooled-stake substitution; mechanically forced ongoing prices; guaranteed trading profit or liquidity; and podcast/discussion-market expansion. Sponsorship entitlements belong to debaters under their reward rules, not automatically to audience token holders.

## 8. Trust, safety, accessibility, privacy, and reliability

This section preserves the founder’s acceptance of the previous PRD’s safeguards, with later founder clarifications taking precedence.

**Wallets and control.** Wallet-first access is intended; mandatory email or product-imposed KYC is not the desired initial experience. This is not legal approval to omit identity checks. Use understandable signing prompts, never request seed phrases, visibly switch accounts, distinguish login from spending, and disclose custody and recovery expectations. Uncommitted funds and settled proceeds are withdrawable under published rules; accepted event positions remain locked until settlement or refund.

**Privacy and authority.** Minimize personal data and explain wallet traceability. Founder-only tally access is initially permitted; future security administrator access needs a defined scope and audit trail. Sponsors have no privileged access. Record sensitive access and market interventions. Related-party participation, debater self-voting, and permitted trading with privileged information require explicit policies; no automatic prohibition or permission is inferred from a missing rule.

**Accessibility.** Support keyboard navigation, screen-reader labels, sufficient contrast, captions or transcripts, reduced motion, and usable mobile controls. Never communicate sides or outcomes by color alone. WCAG 2.2 AA is a proposed verification target, not a claim of existing conformance. [P4]

**Reliability.** Pending, delayed, failed, suspended, disputed, refunded, and completed actions must be legible. Retries cannot duplicate votes, tokens, fees, or payouts. Stale clients cannot extend deadlines. Publish rules for no-shows, interrupted video, missing replay, appeal, and corrections. Preserve receipts and visible correction history; never quietly rewrite settled history. An outage must not convert protected collateral into operating revenue.

**Eligibility.** Obtain qualified advice for the exact structure and jurisdictions before accepting funds. AMF and CSA materials identify structure-dependent crypto-platform requirements; CFTC, FINTRAC, and FinCEN materials identify other relevant review domains. They do not classify or approve YAP Arena. [P5–P9] The companion eligibility outline defines the required written decisions.

## 9. Measurable success criteria and evaluation

**Proposed primary product metric:** 28-day returning participant rate: the proportion of a new engaged-user cohort that returns on a separate day within 28 days to a different debate or topic experience. Define an engaged visit as at least ten minutes of watch time, a completed financial action, or participation as a debater. These thresholds and the proposed 30% initial return hypothesis require founder acceptance. Use accounts or consented first-party identifiers and disclose measurement limitations; do not equate wallets with humans.

Segment the primary metric by watching only, event participation, ongoing trading, live/replay, creator/everyday-user source, and founder-affiliated versus independent activity. It must not conceal weak demand for either market.

| Hypothesis and proposed initial target                                                                                                       | Test and supporting measures                                                                                                     | Decision triggered by evidence                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Persistent history matters: at least 12 of 20 interviewees describe a recent tracking problem                                                | Recruit creators, ordinary debaters, viewers, and crypto/noncrypto users; ask about actual past behavior before showing features | If weak, revise the problem statement and discovery experience                                       |
| Rules are understood: at least 90% correctly explain influence, lockup, payout, and refund examples                                          | Moderated prototype tasks; include a winning-side loss and a draw                                                                | If weak, redesign explanation and repeat comprehension testing before funds                          |
| Paid influence is wanted: at least 30% of qualified prototype participants choose it after costs and risk are clear                          | Compare watching/history, paid influence, and idea trading in counterbalanced tasks; record rejection reasons                    | If weak, bring positioning or mechanics back to the founder; do not silently remove the event market |
| Idea trading has independent demand: at least 25% of participants offered a second session voluntarily return to manage a simulated position | Two-session prototype, stated instrument rights, realistic spreads, and no guaranteed rewards                                    | If weak, revisit the instrument and value proposition before release                                 |
| Both markets function without founder activity dominating usage                                                                              | Measure founder-excluded fills, depth, concentration, unfilled demand, and return behavior                                       | If weak, revise liquidity/distribution plans and repeat the exercise                                 |

All numerical research targets are **proposals**, not approved launch thresholds or forecasts. Small samples provide directional evidence, not population proof. Simulated purchases do not prove willingness to risk real money. Observe real behavior only after the legal and financial gates are satisfied.

Supporting operating measures: time to match; acceptance and no-show rates; completed debates; replay watch and participation share; order fill rate, spread and slippage by size; payout/refund accuracy; withdrawal completion; disputes and appeals; sponsor exposure and renewal; and net contribution after delivery costs, debater rewards, fees, and liquidity losses. Exclude wash activity and report concentration. Gross volume alone is not success.

## 10. Risks, dependencies, and decision log

| ID  | Status                     | Decision or dependency                                                                                                                    |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Confirmed                  | Two connected markets; both ship together with real-money crypto                                                                          |
| D02 | Confirmed                  | Historical baseline pools money across prior topic debates                                                                                |
| D03 | Confirmed                  | Fee-free first-topic paid bootstrap; included in first event final support                                                                |
| D04 | Confirmed                  | Winner follows relative money-share movement; changes are complementary                                                                   |
| D05 | Confirmed                  | Recovered continuous curve is production intent; s = 0.20 remains illustrative                                                            |
| D06 | Confirmed                  | One token per side per collateral-backed event pair                                                                                       |
| D07 | Confirmed                  | Draw/void refund principal and event fees; fees reserved separately until settlement                                                      |
| D08 | Confirmed                  | Participants fund positions; manual founder liquidity counts as support; no preset founder maximum                                        |
| D09 | Confirmed                  | Event positions locked; ongoing positions tradable; available proceeds withdrawable                                                       |
| D10 | Confirmed                  | Polymarket-style order-book pricing; no result-driven ongoing repricing formula                                                           |
| D11 | Confirmed                  | Five-day post-live participation; founder access exception to hidden event tallies                                                        |
| D12 | Confirmed                  | Two debaters; hostless; matchmaking and direct challenges; universal bounded-time rules                                                   |
| D13 | Confirmed                  | Platform-wide sponsors, winning-debater sponsor share, small participation/trading fees                                                   |
| D14 | Confirmed                  | Québec operating base; Canada and US intended markets; wallet-first preference                                                            |
| D15 | Proposed                   | Principal-only support accounting, void exclusion, 120-hour duration interpretation, responsive web, metrics and WCAG verification target |
| D16 | Partly confirmed           | Phase 1: internal ledger, Base USDC treasury, no fees, no winner (s retired); paid fees open; [brief](financial-architecture-options.md)  |
| D17 | Confirmed (phase 1)        | A4 one-minute rounds; per-debate reveal mode; own order + count shown; tally proof pending; [brief](financial-architecture-options.md)    |
| D18 | Confirmed (phase 1)        | One YC market per topic; YES+NO pair redeems for 1 YC; founder market maker; limit book; [brief](financial-architecture-options.md)       |
| D19 | Partly confirmed           | Replay joins live minutes; debater/founder limits; void unopened rounds; sponsor split open; [brief](financial-architecture-options.md)   |
| D20 | Requires specialist review | Eligibility, authorizations, identity checks, financial security, privacy; questions in [brief](financial-architecture-options.md)        |
| D21 | Confirmed (YC only)        | Borrow the microphone: viewers pledge YC to questions, a camp's #1 fires; [Decision 0018](decisions/0018-borrow-the-mic.md)               |

Principal risks are concentrated influence, baseline gaming, strategic last-minute purchases, thin liquidity, fabricated debates, cross-market information advantage, disclosure through event trades, sponsor dependence, and accounting or operational failure. Paid influence is intentional; controls must distinguish permitted influence from prohibited conduct rather than quietly replace the mechanism.

The draw refund exception creates a discontinuity relative to near-zero curve settlement. Historical aggregate support is a money-weighted record, not a representative poll or a causal measure of persuasion. Founder knowledge plus founder participation creates an information asymmetry to disclose and review without rewriting the approved manual-liquidity decision. Shipping both markets increases the shared release dependencies; the selected response is to complete both, not silently stage them.

**Codex handoff:** preserve confirmed rules; inspect repository instructions and implementation; turn open decisions into tracked issues, not hidden defaults. Build reversible prototypes and simulations while specifications are settled. Keep real-fund activation blocked until the evidence checklist passes. Never claim hidden-tally protection, legal approval, production readiness, or deployed features merely because this PRD is complete.

### Primary-source references

Sources consulted September 29, 2026. Founder decisions come from this project conversation; external sources support only the specifically attributed claims.

- **P1:** Polymarket, [How Are Prices Calculated?](https://help.polymarket.com/en/articles/13364488-how-are-prices-calculated).
- **P2:** Polymarket, [Manage Positions](https://docs.polymarket.com/trading/positions/manage).
- **P3:** Ethereum, [Privacy](https://ethereum.org/privacy/).
- **P4:** W3C, [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/).
- **P5:** AMF, [Éclairage sur la législation](https://lautorite.qc.ca/professionnels/fintech-technologie-financiere/entreprises-ayant-un-projet-novateur/indications-sur-la-legislation).
- **P6:** CSA, [Regulation of Crypto Assets](https://www.securities-administrators.ca/investor-tools/crypto-assets/regulation-of-crypto-assets/).
- **P7:** CFTC, [Designated Contract Markets](https://www.cftc.gov/IndustryOversight/TradingOrganizations/DCMs/index.htm).
- **P8:** FINTRAC, [Money services businesses](https://fintrac-canafe.canada.ca/msb-esm/msb-eng).
- **P9:** FinCEN, [FIN-2019-G001: Business models involving convertible virtual currencies](https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-certain-business-models).
