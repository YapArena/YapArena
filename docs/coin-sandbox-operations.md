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
peak in round-closing order, with round UUID as the fixed tie-breaker. Opening a
successor round and maintenance advancement use the same ordered batch (20
rounds by default). A target outside that bounded batch stays open until earlier
obligations are processed; an API caller cannot move its later gain ahead of an
earlier loss. The batch locks every participating account and prepares all books,
buckets and cash/promotional ledger rows before posting any result. This prevents
a later account lock from deadlocking funding or payout reconciliation. An API
caller must have a current session at admission and again before commit, including
an idempotent or existing-round return; workers can settle existing obligations
without a user session.

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
