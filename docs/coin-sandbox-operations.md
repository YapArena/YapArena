# Isolated Yap Coins sandbox operations

Live funding and redemption remain disabled. The application sandbox initially
uses deterministic simulation. Its USDC labels are accounting fixtures with no
actual money or chain backing. A provider or chain sandbox is a separate form of
evidence; deterministic outcomes do not establish provider acceptance.

## Assets and backing

Purchased balances and earned profits use `USDC`, precision 6. Virtual grant
principal uses `YC_PROMO`, precision 4. At 100 YC per USDC their numerical atomic
valuations coincide, but the assets are different: virtual principal never funds
cash collateral, fees, purchased backing or withdrawals. Each grant keeps its
own principal, profit, current net result and permanent qualification peak.

Every earned grant profit must be financed from an independently funded
promotional treasury at credit time. A4 additionally reserves independent center
cash before admission; consuming virtual principal does not replenish it. The
approved live promotional budget of 50 USDC is **unfunded**, and this implementation
does not seed or allocate it. The explicit simulation seed command creates only
valueless fixture accounting entries.

External clearing buckets classify inflows/outflows by the **current liability
source**. They are not separate custody wallet balances. Purchased profits can
come from center collateral and are later withdrawn through purchased clearing;
promotional profits use promotional clearing. Receipt/event provenance preserves
the actual source, and aggregate custody cash must reconcile against aggregate
cash liabilities. Historical A4/YAP remains isolated and nonredeemable.

Sandbox debate results affect each grant's net profit and permanent qualification
peak in round-closing order, with round UUID as the fixed tie-breaker. Only the
worker settles, and a viewer's request never settles anybody's round. Its coin loop
runs one ordered batch a second, of at most 20 rounds and 200 orders, sized from the
measured cost per order to fit 250 ms and cut off at 250 ms whatever the database's
speed; while any live turn window is in its final 15 seconds, when most answers
arrive, at most 50 orders and 100 ms.
A larger round settles over several batches: each prices the whole round the same
way, from its complete and fixed set of orders, and settles the next orders by
account; the last one reveals the round and sends the results notice. A later round
waits until the earlier one is revealed. A round part-way through settlement
finishes settling even if its debate is cancelled, and can no longer be voided. The
batch locks every participating account and prepares all books, buckets and
cash/promotional ledger rows before posting any result. This prevents a later
account lock from deadlocking funding or payout reconciliation. An API caller must
have a current session at admission and again before commit, including an
idempotent or existing-round return; workers settle existing obligations without a
user session.

Each round's part of a batch settles in its own savepoint. A round whose settlement
throws is rolled back and set aside by the worker, which logs `coin round settlement failed; round
set aside` (error level, with `roundId`, `failures` and `retryInSeconds`) and keeps
settling the rest. It retries the round after 1 minute, then 2, 4 and so on up to an
hour; a restarted worker retries at once. Investigate the logged error, then fix it
or, if none of the round's orders has settled yet, refund it with `void-round`.

**Locks and timeouts.** Settlement and voiding read a round's complete population
of orders. A submit holds its round's advisory lock shared for its whole
transaction; settling or voiding takes it exclusively first, so it waits for
in-flight submits and keeps new ones out until it commits. Reads (the signed-in
round view, results, the public window list) take no round, account or ledger lock.
Every submit still locks the shared treasury rows in turn, so submits to one window
run one after another inside the database. Request transactions set
`lock_timeout` 3 s and `statement_timeout` 5 s; the worker's set 5 s and 30 s. Both
are `SET LOCAL`, so they win over a pool-wide default. A timeout, a deadlock or a
full connection pool returns `503` with code `busy` ("Yap Coins are busy; try
again. Nothing was reserved."), never a 500.

The worker also warns `debate live past maximum duration` (with `debateId`,
`liveStartedAt` and `maximumSeconds`) once a minute for each debate still `live` 30
minutes past its rules' maximum duration (2 hours when unset): such a debate never
reveals and keeps every reservation in its windows. End it as operator.

## Launch mode: play money only

Founder decisions D1–D6 (2026-10-30) set how Yap Coins run at launch:

- **D2.** Phase-1 Yap Coins are play money. They never convert to real USDC; a paid phase would
  start on the separate `live` ledger. That is what makes the valueless treasury seed below safe.
- **D3.** Buying, withdrawing and their error reports stay off, and no page shows the
  `100 YC = 1 USDC` rate or withdrawal wording, until real withdrawals are approved (F06).
  `COIN_SANDBOX_TRANSFERS_ENABLED` (default `false`) turns the simulated purchase, withdrawal and
  deposit/payout error-report routes on for tests and a staging trial. While it is off those routes
  answer 404 and `GET /summary` reports `features.transfers: false`, so `/coins` hides the forms.
  The production web service (`PRODUCTION_SERVICE=true`) refuses to start with it on. Even when it
  is on, one simulated purchase is at most 1,000 USDC, so no balance approaches `numeric(36,0)`.
- **D4.** `/coins` shows Bots mode only while `A4_MODE` enables it.
- **D5.** With `TURN_WINDOWS_ENABLED=true`, turn windows are the only way to take a position:
  `POST /debates/:id/rounds` opens no manual round, and `/coins` hides the manual round form
  (`features.manualRounds: false`).

### Funding the center and promotional treasuries (D1)

Every contract reserves its face value, 1 YC (0.01 USDC-equivalent), from `center_available` into
`center_reserved`. A stake funded by grant coins also reserves the same again from
`promotional_available`. Both are operating accounts that start at zero on an empty database and can
never go negative. Until the operator seeds them, every answer is refused with
`503 answers_paused` ("answers are paused"); the caller's own shortfall is a separate
`409 insufficient_balance` with their available balance.

Settlement returns each reservation, minus what it paid out. The center's balance moves both ways;
the promotional treasury only drains, because it pays new profit on grant coins while lost grant
principal returns to `grant_issuer`. Five-day reveals hold their reservations for 120 hours.

Seed both on every new simulation database, before the first debate: production, staging, and any
fresh trial database. The seed is a valueless fixture (D2); it creates no real money.

1. Sign in once on the site with the operator's own account and pick its handle.
   `seed-simulation` records its journal against an existing account, and an empty database has
   none.
2. Find that account's ID as the owner:

   ```sql
   SELECT user_id FROM yaparena.public_profiles WHERE handle = '<operator-handle>';
   ```

3. Save two private inputs, each with its own new idempotency key (for example `uuidgen`), and run
   them with the owner environment. `amount` is atomic USDC-equivalent: `1000000000000` is
   1,000,000 USDC-equivalent, or 100,000,000 YC. `~/yaparena-private/seed-center.json`:

   ```json
   {
     "userId": "<operator-id>",
     "purpose": "center",
     "amount": "1000000000000",
     "idempotencyKey": "<new-uuid-1>"
   }
   ```

   `~/yaparena-private/seed-promotional.json` is the same with `"purpose": "promotional"` and a
   second new key. Then:

   ```sh
   node --env-file="$HOME/yaparena-private/owner.env" scripts/coin-sandbox-operator.ts seed-simulation < ~/yaparena-private/seed-center.json
   node --env-file="$HOME/yaparena-private/owner.env" scripts/coin-sandbox-operator.ts seed-simulation < ~/yaparena-private/seed-promotional.json
   ```

   Each prints
   `{"command":"seed-simulation","environment":"sandbox","rail":"simulation","status":"recorded","processed":0}`.
   Repeating an input with the same key changes nothing.

4. Check the balances as the owner. Both `_available` rows should read `1000000000000`:

   ```sql
   SELECT s.purpose, a.balance
   FROM yaparena.coin_sandbox_system_accounts s
   JOIN yaparena.coin_accounts a ON a.id = s.account_id
   WHERE s.purpose IN ('center_available','center_reserved','promotional_available','promotional_reserved')
   ORDER BY 1;
   ```

   On a database where no stake or grant has run yet the system accounts may not exist; the first
   seed creates them.

**Top-up.** When a treasury falls below `COIN_SANDBOX_TREASURY_ALERT_USDC` (default `200000`,
20% of the seed), run step 3 again for that purpose with a new idempotency key. Never change ledger
rules to let a system account go negative.

**Monitoring.** The worker checks both treasuries at start and once a minute, and logs the warning
`coin treasury low` with `account` (`center` or `promotional`), `availableUsdc` and
`thresholdUsdc` while either is below the threshold. The web service's `/metrics` exports
`yaparena_coin_treasury_available_usdc{account}` and `yaparena_coin_treasury_low{account}`
(1 while low), refreshed at most once a minute. Alert on either, as with the other uptime checks.

## Turn windows and automatic voiding

With `TURN_WINDOWS_ENABLED=true` (web and worker), each live speaking turn is one trading window
whose cutoff is the turn deadline, fixed at opening ([Decision 0012](decisions/0012-live-argument-outline.md)).
The coin loop opens it within about a second of the turn starting; asking for a round during a
live debate returns it instead of a five-minute round. Windows settle like any round.

Whenever the coin sandbox is enabled, the coin loop also voids every open round of a debate that
became `cancelled` or `void_review`, with reason `debate_unavailable`, and settlement skips such
rounds. The runtime may void only those; the database refuses any other runtime void, so
`void-round` below remains the owner's command for everything else.

## Reveal mode and debaters

Every debate round reveals in its debate's mode (Decision 0012, F11). **Five-day** is the default
and the only mode of a user-created debate: rounds take orders until their cutoff, stay locked,
and price and settle at the debate's 120-hour close, 120 elapsed hours after its live end. Until
then participants see their own order and the participant count, not a price or execution.
**Per-round** debates settle each round at its cutoff, as before. Record per-round only for a
founder-created debate, before its first round, with `set-reveal-mode`; the first round locks the
mode. Debaters cannot take a position in their own debate (F14).

From a five-day debate's live end until its 120-hour close, replay viewers may join a turn
window after its cutoff by giving the replay position they are watching (F10). The position must
fall inside the window's span in the recording, measured from the recording file's start that
LiveKit reports at completion (`recording_clocks`). A viewer who holds a position in a later
turn's window cannot join an earlier one.

## Results notice

When a round is revealed (settled) or voided, the settling transaction sends
`pg_notify('yaparena_results_v1', <user id>)` for each participant. PostgreSQL delivers it only if
the transaction commits, and once per user per transaction. The signed-in
`GET /api/coin-sandbox/results?since=<ISO time>` returns the viewer's own revealed or voided rounds
after that time, newest first, at most 50. Each has the debate, turn, speaking side, the viewer's
side and quantity, the state (with the void reason), the outcome (status, premium, fee, payout and
net in atomic units, as in the rounds view) and the reveal time. It is private (`no-store`) and
reads only the viewer's own rows. Under interface 10, the per-user stream (matchmaking's
`/api/me/stream`, once it lands) forwards the signal to the user's open pages, which then call
this read.

## Rail and credential separation

`coin_sandbox_controls` pins the physical database to `simulation` or
`base-sepolia`. The default is simulation. Rail changes require an explicit owner
process **before any initialization or history**; after that use a fresh isolated
database. Shared/exclusive transaction locks prevent a race with first writes.
Never configure a testnet payout adapter against a database containing simulated
USDC. The named staging web application uses simulation only.

The runtime role can append sandbox requests, journals and authenticated webhook
inbox records. It cannot approve requests or acknowledge inbox work. Manual review
and reconciliation use a separate owner process whose `current_user` is exactly
`yaparena_owner`. Owner credentials must never be placed in the web or worker
process. No tool here loads `.env` automatically.

Build before running the strict TypeScript operator:

```sh
npm run build
node scripts/coin-sandbox-operator.ts review < /path/to/private-command.json
```

Supply only these environment variable names through the operator's private
environment: `COIN_SANDBOX_OWNER_DATABASE_URL`, `COIN_SANDBOX_RAIL`, and, for the
isolated Base Sepolia rail, `COIN_SANDBOX_CUSTODY_ADDRESS`. Webhook HTTP runtime
configuration uses `COIN_SANDBOX_WEBHOOK_SECRET` separately. No owner connection
is accepted by the webhook router.

For Supabase's shared pooler, the configured custom-role login includes its
project suffix. The command accepts that documented owner-login form only on
Supabase's indexed AWS pooler hosts; direct/local owner logins still work.
PostgreSQL must independently report both `current_user` and `session_user` as
the exact dedicated owner before an operator action. The suffix does not grant
ownership. Keep verified TLS and the reviewed CA in the private operator
configuration; never put the owner connection in the web or worker environment.
See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

The operator accepts one JSON object on stdin, at most 32 KiB. It prints a bounded
command/status summary, with no addresses, amounts, account identifiers, signing
bytes, connection strings or provider error objects. Keep operator input private.

| Command             | JSON fields                                                                                                                                  | Effect                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`            | `requestId`, `decision` (`approve` / `reject`), `idempotencyKey`                                                                             | Approve a gross reservation into pending cash, or reject an unsubmitted request and restore its exact sources.                                                                                                             |
| `simulate`          | `requestId`, `status`; optional `transactionId`                                                                                              | Explicit valueless simulation outcome. Never available on testnet.                                                                                                                                                         |
| `confirm-funding`   | `requestId`, `transactionId`, `sender`                                                                                                       | Base Sepolia only: verify the exact finalized incoming test-USDC transfer before cash issuance.                                                                                                                            |
| `confirm-treasury`  | `operatorUserId`, `purpose`, `amount`, `idempotencyKey`, `transactionId`, `sender`                                                           | Base Sepolia only: allocate an exact finalized incoming test-USDC transfer to a separate promotional, center or correction bucket; never reuse a purchased or payout receipt.                                              |
| `reconcile`         | `requestId`; incoming funding also needs `transactionId`, `sender`                                                                           | Read the pinned external chain and update a single operation. Caller status is never evidence for testnet.                                                                                                                 |
| `reconcile-pending` | optional `limit` (1–100, default 20)                                                                                                         | One bounded pass over approved/pending/uncertain testnet payouts that have a persisted signed identity. Schedule the explicit command in a separate owner process if desired.                                              |
| `drain-inbox`       | optional `limit` (1–100, default 20)                                                                                                         | One bounded pass over authenticated, unacknowledged notifications, then append owner-only outcomes.                                                                                                                        |
| `seed-simulation`   | `userId`, `purpose` (`promotional` / `center` / `correction`), `amount`, `idempotencyKey`                                                    | Simulation fixtures only. Does not create actual treasury funds or credit a user's balance.                                                                                                                                |
| `correct`           | `requestId`, `reportId`, `reviewId`, `reason` (`incorrect_funding` / `operator_error`), `idempotencyKey`                                     | Require an evidence-reviewed erroneous credit for this exact original funding, then append its exact reversal or hold it for reconciliation.                                                                               |
| `retry-correction`  | `correctionId`, `reportId`, `reviewId`, `idempotencyKey`                                                                                     | Require the same reviewed original funding and retry after reconciliation restores its original sources.                                                                                                                   |
| `review-report`     | `reportId`, `outcome`, private `note`, `evidenceDigest`, `idempotencyKey`; optional safe `publicNote`, approved `amount` or recovery `quote` | Append owner evidence and a separately publishable outcome. An operator compensation review needs an exact atomic USDC amount. A recovery quote needs `amount`, pinned `network`, ISO `expiresAt`, and safe `description`. |
| `compensate-report` | `reportId`, `reviewId`, atomic USDC `amount`, `idempotencyKey`                                                                               | Restore only evidence-reviewed original cash sources from separately funded correction cash. No new coin category, qualification progress or cash grant principal is created.                                              |
| `set-reveal-mode`   | `debateId`, `mode` (`per_round` / `five_day`), `reason`                                                                                      | Founder-created debates only, before their first round: record the reveal mode. Repeating the same mode is a no-op; any other change is refused.                                                                           |
| `void-round`        | `roundId`, `reason` (`debate_unavailable` / `operator_cancelled`)                                                                            | Owner-only refund of an open sandbox round, restoring exact sources and unused backing without earning profit.                                                                                                             |

Completed purchases support USDC withdrawals only. Corrections are auditable
operator repairs; they do not promise original-route unused-purchase refunds or
refunds of trading losses. Withdrawal minimum is 5 USDC **gross debit**. The
displayed network fee is deducted from gross, so gross 5.00 and fee 0.10 pays 4.90.
There is no daily withdrawal cap. Gross, fee, net, rail, network, asset,
destination and quote identity are bound to the fresh, one-use operation proof.

### Manual review calendar

The approved review target is two business days in `America/Toronto`: weekdays
excluding Canadian federal holidays. Network confirmation time is additional.
The owner process must check the request receipt time, current Toronto calendar
and the [Government of Canada general-holiday reference](https://www.canada.ca/en/services/jobs/workplace/federal-labour-standards/vacations-holidays.html#h2.2)
when scheduling review, and record any observed substitute holiday in the private
operator review record. This is a manual service target. The application does
not implement a holiday calendar, computed review deadline or automatic payout
approval. Missing the target never releases a reserve, retries a payment or
changes a customer's financial eligibility; reconcile the original operation.

Yap Coins are always on ([Decision 0013](decisions/0013-yap-coins-always-on-and-debate-staking.md),
amending [Decision 0009](decisions/0009-auth0.md)): an account's first own sandbox
request records an automatic opening in `coin_sandbox_openings` (no operation), and
the browser then claims the welcome grant. Openings confirmed by a fresh sign-in
before that decision keep their operation. The owner's operator paths never open
an account: owner funding and new payout authority require that opening. Each withdrawal
and each recovery consent is confirmed by its own fresh sign-in, bound to the exact
terms (see [the confirmation contract](security/account-session-revocation.md#confirmation-by-fresh-sign-in)).
Retained passwords, wallets and passkeys no longer approve anything, and there is no
separate lost-credential recovery: whoever controls the account's email or Google
sign-in can confirm. The application does not impose an account-wide hold on its own;
an operator suspends the account when a sign-in method is reported compromised.

## Error reports, reviewed corrections and original-source restoration

An authenticated account can report an owned deposit or payout request without
a filing deadline. Reports do not debit, hold, pause or restore money. They remain
available during a financial correction hold. Descriptions and private evidence
notes are limited to 2,000 characters and never enter logs or metric labels.
Account/request-scoped idempotency preserves an exact submission. Stored reports
and all review/consent/correction events are append-only.

Owner review outcomes are `evidence_required`, `no_error`, `erroneous_credit`,
`operator_shortfall`, `operator_cost` or `recovery_quote`. Review requires a private
note and evidence digest; only an explicitly supplied safe `publicNote` and
public outcome/quote fields appear in customer projections. A report alone never
authorizes a reversal. Configured `correct` and `retry-correction` commands require
a review for the same account and exact original funding request, classified as
an erroneous credit. Validation and its immutable review reference share the
financial transaction. Low-level repository correction methods remain trusted
owner-only internals for isolated fixtures and are not an unreviewed web API.

YapArena-caused missing internal balances can be restored only from funded
`correction_available` USDC, with owner evidence identifying the missing amount.
The balance journal, original-source book credit and report receipt commit
together. The source IDs and categories stay intact; grant principal stays
spend-only and current/peak qualifying profit never increases. Partial restored
amounts use original debit weights with largest-remainder allocation, stable
source-order ties and remaining per-source caps. Cumulative restoration is checked
across every report for that original request, preventing duplicate compensation
under a new report ID. An unfunded operator reserve cannot credit a customer.

For a completed deposit, restore only missing original purchase principal, capped
at the original confirmed credit. Reconcile any outstanding reservations of that
principal first. For a completed payout, use only its persisted original cash
source reservation, capped at the original gross debit and its source slices.
An uncertain or pending payout cannot use compensation to release its original
reserve. Ordinary spending and trading losses do not establish an operator error.
Completed purchases retain the USDC-withdrawal policy; reports introduce no
original-route purchase refund product.

A recovery quote states exact USDC cost, rail/network, expiry and a safe
description. Consent requires a confirmation by fresh sign-in with purpose
`recovery.cost.consent`, bound to the account, session/generation, report, original
request, exact quote identity/digest/terms and expiry. It consumes once, and a
superseded or expired quote fails closed. A recorded consent authorizes **no
charge and no external recovery execution**; no later action may treat it as a
general financial approval. A lost-response retry can read the existing report;
the consumed confirmation itself remains invalid for reuse.

The sandbox implements restoration of provably missing **internal sources**.
Provider-specific recovery/network expenses outside an original application debit
still need the selected provider route and evidence, and remain live-disabled.
This scope is not a waiver of YapArena's approved responsibility for its own
errors or those expenses. Simulated reserve seeds are valueless test fixtures;
Base Sepolia correction reserves require their own verified incoming receipt.

## Authenticated notification inbox

Mount `createSandboxWebhookRouter` before the application's JSON parser. The
factory receives only the runtime pool, pinned rail and a dedicated secret with
at least 32 bytes. HTTP delivery uses JSON with `requestId`, `status`,
`transactionId` (string or null), and optional EVM `sender`. Unknown financial
claims such as `amount`, `accountId` and `finalNoTransfer` are rejected.

Send headers `X-Yap-Timestamp` (Unix seconds), `X-Yap-Delivery` (unique bounded
identifier), and `X-Yap-Signature` (lowercase hexadecimal HMAC-SHA256). The HMAC
input is the exact concatenation of timestamp, `.`, delivery identifier, `.`, and
raw request bytes. Verification is constant-time, delivery age is limited to
five minutes, content encoding is not accepted, and the raw body is limited to
32 KiB. This is YapArena's own notification protocol, not a claim that any
financial provider has accepted a webhook integration.

An identical delivery returns 202 with `duplicate: true`. Reusing its delivery
identity with different authenticated bytes returns 409. Inbox records and
operator outcomes are append-only. The webhook never changes a cash balance,
settles a payout or releases a reserve. A failed webhook alone cannot establish
that no payment happened.

The separate owner command drains the inbox and reconciles actual testnet
operations using fixed Circle test USDC on Base Sepolia. Simulation outcomes are
explicitly labelled and physically isolated. Duplicate owner execution is safe
through financial-event idempotency. A crash after a financial commit but before
acknowledgement can retry the same inbox item without double payment. Transient
database failures leave inbox work unacknowledged. A processed pending observation
needs a later notification or `reconcile-pending` pass; no indefinite busy retry
loop runs in the web process.

## Testnet signing and uncertain outcomes

This operator reconciles but never signs or broadcasts. A separately authorized
sandbox signer may prepare a candidate nonce privately, then call
`reserveSignedPayout` with the approved request and exact signed transfer. The
repository validates recovered sender, chain, token, destination, net amount,
operation ID and hash, then atomically reserves request/hash/sender/nonce. Commit
that reservation **before any broadcast**. A reservation loser must never send
its candidate bytes. Retries use the original persisted signed identity.

Testnet payout reconciliation refuses requests without that immutable identity.
A receipt must match the original nonce and transfer terms and be canonical and
finalized. Missing transactions, RPC failures, unfinalized receipts and conflicting
evidence retain reserves. Only a finalized original reverted transfer proves no
transfer for release; a provider status named `failed` or a different failed
transaction does not. Failed/uncertain source reservations restore purchased
principal/profits and qualified backed grant profits exactly once only after this
proof. The operation never changes historical qualification.

Keep physical-device, automated browser, actual testnet and simulation results
separate in acceptance evidence. An owner approval or a passing unit test does
not enable live liabilities or satisfy jurisdiction/provider release gates.
