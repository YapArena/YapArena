# Email-first accounts and platform currency

> **Superseded.** [Decision 0009](decisions/0009-auth0.md) replaced Privy with Auth0. Prompt 12
> deleted the Privy client, embedded wallet, passkeys, provider freeze/unfreeze jobs and their
> owner repairs, and its schema change drops their tables. This record describes the Privy-era
> design and its recorded revisions, not the current checkout; for current behavior see
> Decision 0009 and the [session revocation procedure](security/account-session-revocation.md).

Baseline: clean shared checkout at `fd60543`, equal to fetched `origin/main`
on 2026-10-19. Branch: `feat/email-first-accounts`; no unrelated edits present.
This record distinguishes implementation from acceptance; it is not paid-release approval.

Current staging web revision is `3096ca7`, verified LIVE on 2026-10-21 after
all five [exact-source CI checks](evidence/account-completion-baseline/passkey-signin-errors-20261021/ci-review.md)
passed. The [latest release](evidence/account-completion-baseline/passkey-signin-errors-20261021/README.md)
records seven hosted guest groups and 14 matching assets. The earlier
[guarded database release](evidence/account-completion-baseline/embedded-wallet-release/README.md)
records an encrypted 85-table/15-sequence backup, exact isolated restore/rehearsal,
two additive migrations and preservation of the three retained accounts plus the
manual signup. Staging has 45 applied / zero pending migrations. The replay worker
remains at `fd60543`; automatic deployment is off for both services. Earlier
[Privy-only](evidence/account-completion-baseline/privy-passkey-release/README.md) and
[9395242](evidence/account-completion-baseline/staging-release.md) releases remain preserved.
Only the deterministic coin sandbox is enabled. The founder now reports successful
Privy passkey setup, later returning passkey login and same-key use in the withdrawal
simulation. A separate read-only inspection confirms a ready user-owned embedded
wallet with no additional signer/policy. The [genuine acceptance record](evidence/account-completion-baseline/embedded-wallet-release/genuine-passkey-wallet-20261021/README.md)
preserves the initial failed login, later success and limits. Remaining genuine
recovery/Google/email-code journeys, device/screen-reader acceptance and live
financial approval remain separate requirements.

The latest passkey error correction distinguishes cancellation from provider,
network and configuration failures. Its installed-SDK suite passed 125 checks;
the combined application gate passed 858 tests and all core browser journeys.
The subsequent owner-only operator change `e8fcdff` accepts the verified Supabase
pooler login format while retaining SQL owner checks. Its local gate passed 859
tests without skips and 240 focused account/security/ledger cases on each fresh
and upgraded database. The [guarded simulation trial](evidence/account-completion-baseline/operator-pooler-20261021/README.md)
approved and completed the existing proof-matched withdrawal exactly once, with
an exact deterministic receipt, unchanged sources and no provider/chain calls.
This operator change requires no application redeployment or schema migration.

Current corrective work is tracked in the [completion log](email-first-completion.md).
The genuine returning-user trial exposed an uncertain provider-session reset
mislabelled as a sign-in-method change. Its reviewed repair is complete without
bypassing the old-token cutoff. The founder superseded the separate YapArena
passkey design: use only Privy enrollment in Account settings and one passkey
login option. The same credential's server-verifiable operation proof passed
798 quality tests, 198 fresh/upgrade PostgreSQL cases, 18 native passkey groups,
92 SDK scenarios and all five CI checks. Final review found an additional browser
account-switch race in ordinary provider-method settings; its correction and
regression are included in the current deployed source. Genuine provider acceptance retains
the separate scopes above.
Earlier separate-key descriptions and trials retain their recorded scope.

On 2026-10-21, the founder changed the wallet direction: automatically create
one user-controlled Privy EVM wallet, with default Privy recovery and no
YapArena signing authority. Remove new external-wallet linking from the product
while preserving retained wallet credentials. The
[wallet design](history/embedded-wallets.md) records supported provisioning,
recovery and cost boundaries. Creation must survive the post-login redirect
without blocking ordinary account access. Implementation is deployed and genuine
read-only user ownership/configuration acceptance passed; default recovery and
remaining provider/device scenarios are open. The five input routes and live
financial gates are unchanged. Earlier wallets-off observations remain dated
configuration facts. The founder selected continued payment-provider comparison
and identified their existing wallet as Tangem; neither selects custody/signing
or authorizes contacting a provider.

## Direction and phases

Email verification codes are primary. Google and passkeys are optional. Public
discovery/watching stay public; initial profiles are optional. Financial
eligibility is collected at the financial boundary, not ordinary signup.

| Phase | Scope                                                 | Current boundary                                                                                                                                                  |
| ----- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Privy, onboarding, stable accounts, sessions/settings | Operation-bound security keys, recovery/linking and session controls implemented; genuine hosted returning/recovery/device acceptance outstanding                 |
| B     | Shared Redis controls and justified caches            | Local multi-client/outage checks passed; staging protected request passed its Redis control                                                                       |
| C     | Redeemable YC, sandbox funding/redemption             | Persistent simulated workflows and YES/NO source accounting implemented; actual Base Sepolia funding/payout reconciled through isolated app ledger; live disabled |
| D     | Authorized reset and final acceptance                 | Selected IDs 1–4 deleted after backup/rehearsal; three retained accounts and the founder's new manual signup preserved                                            |

These phases preserve the combined [pre-funds gates](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds).
Unresolved financial decisions do not block independent authentication work.

## Financial decision sheet

Latest founder decisions supersede earlier CAD/bank/PayPal instructions.

| Term                       | Confirmed decision / unresolved detail                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meaning / representation   | YapArena-issued platform currency held as internal account balances; no ERC-20 or confidential-chain requirement                                                                                                                                                                                            |
| Value                      | **100 YC = 1 USDC**; six-decimal USDC atomic integers, 10,000 atomic units per YC                                                                                                                                                                                                                           |
| Region                     | Canada initially, subject to activity-specific provincial/provider age, identity and retention review. Every live province remains disabled; no universal 18-year threshold is assumed.                                                                                                                     |
| Purchases                  | Supported crypto only for now, quoted conversion into USDC before crediting YC; cards deferred by founder while this is a personal project                                                                                                                                                                  |
| Requested deposit networks | Ethereum, Base, Solana, BNB Smart Chain and Bitcoin; routes/input assets still require provider verification                                                                                                                                                                                                |
| Withdrawal                 | External crypto wallet, **USDC only**; no bank/PayPal payout                                                                                                                                                                                                                                                |
| Bitcoin / BNB              | Input-conversion routes; never assume native USDC support on those networks                                                                                                                                                                                                                                 |
| Welcome                    | 2,500 YC, grant principal permanently spend-only                                                                                                                                                                                                                                                            |
| Daily                      | 500 YC once per Toronto calendar day; each grant requires fresh net profit earned using that grant                                                                                                                                                                                                          |
| Qualification              | Welcome lot needs 2,500 YC net profit; each daily lot needs its own 500 YC. Receipt is not profit, does not raise the welcome target, and cannot reuse prior profit                                                                                                                                         |
| Example                    | Welcome 2,500 + qualifying profit 2,500 = 5,000 balance; only 2,500 profit withdrawable                                                                                                                                                                                                                     |
| Promotional backing        | Initial 50 USDC treasury budget approved, still unfunded/unallocated. Sandbox reserves maximum new promotional exposure before admission, separately from purchased backing; never cap already-earned backed profit afterward.                                                                              |
| Spending / losses          | Oldest grant first, then purchased coins; mixed-source profit/loss allocated proportionally. Once a grant qualifies, it stays qualified after subsequent losses                                                                                                                                             |
| Purchased value            | No grant-profit qualification requirement for purchased coins; standard operation authorization and applicable provider/eligibility checks still apply                                                                                                                                                      |
| Limits / timing            | Founder update: 5 USDC minimum gross debit, **no daily withdrawal cap**. Displayed network fee comes out of the debit: request 5, fee 0.10, receive 4.90. Manual review target: two Toronto business days excluding Canadian federal holidays; network confirmation is additional.                          |
| Transfers / corrections    | No user-to-user transfers initially. Founder update: completed purchases use USDC withdrawals only; no original-route unused-purchase refunds. Incorrect/failed deposits require support/reconciliation/corrections. Uncertain payout reserves release only after reconciliation proves no payout.          |
| Error reports and costs    | Accept reports whenever submitted; review transaction evidence and append auditable corrections. Operator-caused shortfalls/costs use separate operator funds. Quote recovery costs and obtain consent first; ordinary trading losses remain final. Compensation restores only the original balance source. |
| Settlement order           | Grant qualification follows round closing time, then round UUID for an equal-time tie. Later API request arrival cannot reorder profit before an earlier loss.                                                                                                                                              |
| Operator status            | Personal project for now; no company registration or provider eligibility assumed                                                                                                                                                                                                                           |
| Custody / reserves         | Recommend provider-held user backing separated from fees/operations, with YapArena ledger reconciliation; provider support, custody, signers and reserve caps need approval                                                                                                                                 |
| A4                         | Existing `YAP` is **nonredeemable play money**, including starter/refill/bot grants; economics preserved. Redeemable use requires reviewed terms and all gates                                                                                                                                              |

Paid-product direction is money-backed YC with explicit spend-only promotions.
Historical play, sandbox simulation and live liabilities stay separate. Old grants
never acquire cash value. No live funding, redemption or financial promotion is
enabled; the approved 50 USDC budget has not been funded or allocated.

The ledger enforces balanced postings, exact projections, sealed committed
journals, exact reversals and environment/asset consistency. Runtime writes are
restricted to the isolated sandbox; live financial history is not writable by
the web role. Immutable grant lots and profit events support independent targets
and permanent qualification. The existing header/menu projections remain
separate from explicitly labelled simulation balances; Escape restores focus.

Persistent sandbox workflows now cover confirmed funding, exact source-aware
grants/spending/results, transactional withdrawal reservations, manual owner
review, operation-bound authorization, authenticated notification handling and
external reconciliation. Actual Base Sepolia test USDC was credited and paid
through a separate isolated application ledger after canonical/finalized receipt
verification. Conversion quotes in the public sandbox remain deterministic
simulations. [Recorded evidence](evidence/coin-testnet/ledger/README.md) identifies
the exact scope; it is not multichain/provider or live-money acceptance. Error
report/review and source-restoring compensation are implemented under the
approved policy above. The [integrated local browser/quality gate](evidence/account-completion-baseline/final-integrated-release-gate/README.md)
passed 739 tests at its recorded revision. The [completion matrix](email-first-completion.md)
tracks actual CI, hosted and external gates separately.

## Provider verification and limitations

Official documentation checked 2026-10-19; locked versions:
`@privy-io/node` 0.36.0, `@privy-io/react-auth` 3.50.0, Redis client 6.3.0.

- [Custom UI](https://docs.privy.io/authentication/user-authentication/whitelabel): supported React hooks in a focused island within existing server-rendered TypeScript, loaded on the account page or on demand by the shared header popup. Hosted anonymous loading observations are recorded below; population and end-to-end signup latency remain unverified.
- [Core JS](https://docs.privy.io/recipes/core-js): provider requests consultation for low-level integration; use the supported React workflow.
- [Tokens](https://docs.privy.io/authentication/user-authentication/access-tokens): supported signature, issuer, audience and expiry verification. Browser email/account/wallet ownership claims are never authoritative.
- [Freeze/unfreeze](https://docs.privy.io/user-management/users/managing-users/freezing-users): freeze revokes refresh sessions; unfreeze does not restore them. Issued JWTs still need the local fence below. Selected-app behavior requires a hosted trial.
- [MFA](https://docs.privy.io/authentication/user-authentication/mfa/overview): embedded-wallet key operations, with caching scope; not arbitrary backend-operation proof.
- [Cookies](https://docs.privy.io/recipes/react/cookies): production Privy HttpOnly cookies require domain/DNS/provider setup. Development uses provider browser token storage; YapArena authorizes only its own HttpOnly cookie.
- [Login settings](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods): Google defaults support development; production branding needs own OAuth credentials. Email sender/branding entitlement still needs verification.
- [CAPTCHA](https://docs.privy.io/authentication/user-authentication/captcha): direct OTP requests depend on Privy controls; custom UI includes its CAPTCHA component. Match the selected provider to CSP.
- [Crypto deposits](https://docs.privy.io/wallets/funding/crypto-deposits/overview): routes differ from supported assets; dedicated addresses require wallets and app-paid source-chain gas sponsorship. No sponsorship credits purchased.
- [Pricing](https://www.privy.io/pricing): free below 500 MAU; automatic upgrades need monitoring. Free/low-cost preference; no paid upgrade approved.
- [Deletion](https://docs.privy.io/user-management/users/managing-users/deleting-users): deletion changes future DID and disassociates wallets. Never delete keys/assets for a fresh-looking signup.
- [Webhooks](https://docs.privy.io/api-reference/webhooks/overview): development testing is free; the current documentation requires Enterprise for production webhooks. No paid upgrade approved. Current state: [Decision 0008](decisions/0008-auth-simplification.md) step 9 replaced the per-request Privy inspection with an asynchronous re-check at most every 15 minutes per active account. Requests never wait on Privy; deleted, frozen or guest Privy users lose their sessions and method changes are recorded with a notice. See the [revocation procedure](security/account-session-revocation.md).

The selected dashboard reports a development-app limit of 150 users. This is
distinct from the advertised free production MAU allowance. Sender/branding
entitlement and production business approval remain unverified.

The screenshot is CRSHMARKET. [Blink](https://www.blink.cash/apps) lists that
integration; this identifies its passkey deposit option, not a card processor.
Card/crypto business approval, Canadian/provincial support, commercial terms and
Bitcoin/BNB conversion routes remain unverified. Privy login/wallet support alone
does not establish payout eligibility. The earlier `d6e2d35` release had wallet
creation off. The founder-approved durable EVM provisioning is now deployed and
read-only user-only ownership acceptance passed. Default recovery and a
custody/export execution remain unverified.

Provider review concerns support for YapArena's actual activity and flow of
funds; it is not a blanket assertion that wallet transfers require incorporation.
The founder confirmed this is a personal project. [MoonPay's partner KYB
requirements](https://support.moonpay.com/en/articles/694369-business-verification-kyb-for-partners-documents-and-what-to-expect)
require registration documents and may require additional evidence for regulated
activities. This does not establish every provider's requirements or select
MoonPay. Live financial workflows also remain disabled because their engineering
and repository release gates are unfinished.

## Ownership, sessions and recovery

PostgreSQL owns stable bigint IDs, unique provider-DID mappings, account status,
auth generations, consumed provider sessions and application sessions.
Provisioning is transactional, DID-locked and idempotent. Matching legacy
unverified email text never merges accounts. Retained accounts need existing
credentials and deliberate dual-ownership reconciliation. That flow now requires
proof of the retained account and the verified provider identity; an identity
already owned by another account fails for manual review. Privy mode retires new
password registration. Final combined and hosted acceptance is tracked separately
in the [completion matrix](email-first-completion.md).

The selected app initially had email on, Google/passkeys/CAPTCHA off, no allowed
origins, and email auto-merging on. On 2026-10-19, automatic merging was disabled
under **App settings → Basics → Advanced → Account merging**, Turnstile CAPTCHA
was enabled, and the staging HTTPS origin was added. A supported SDK settings
read independently confirmed all three changes. During completion work, the
founder signed into the dashboard and the free development-app Google/passkey
login options were enabled; public staging configuration independently confirms
both. Dashboard wallet creation-on-login remains off; the new durable server
provisioning job is a separate, not-yet-released implementation. The server
requires auto-merging off and rechecks before
exchange; only enabled optional methods appear. No cached positive ownership
decision bypasses this check.

The verified credential identifiers are hashed as an enrollment snapshot. Since
[Decision 0008](decisions/0008-auth-simplification.md) step 9, an exchange with
changed methods records them with an audit event and an in-app notice instead of
requiring ownership reconciliation.
Email changes and method linking/removal now use retained operation-specific proof
before provider interaction and exact verified credential-delta reconciliation
afterward. Provider-side ownership rules still apply. New passkeys are enrolled
through Privy in Account settings. The same credential approves a server-issued
WebAuthn challenge for sensitive operations. First-key setup requires a valid
account session, no prior strong method and no financial history; existing
password/wallet accounts approve setup with that retained method. The application
accepts only credential material read directly from Privy and a fresh native
assertion, never a browser claim that MFA succeeded.

An interrupted first setup can restart after fresh login to the same provider
identity, only while there is no financial or accepted strong-method history.
The recorded original key must match exactly. If its details never reached
YapArena, the founder approved verifying the single current added Privy key.
Restart issues a new short-lived, one-use challenge, preserves provider-reset and
session-generation fences, and requires native user verification. Email alone
cannot finish setup.

The earlier independent-key implementation supports replacement of a lost sole
email or Google login when a retained legacy YapArena security passkey exists.
Those records and their authorization boundary remain supported; new enrollment
does not create independent YapArena keys. A new Privy passkey instead signs into
the same Privy identity, from which retained-proof settings can change email or
Google methods. The legacy recovery below is a replacement of the local
provider binding, not recovery or modification of the original Privy user.
This is retained backend compatibility, not a second visible passkey sign-in
choice in the current UI. The protocol first opens the existing account with
the retained independent key, verifies a new
email through Privy's normal code flow, reviews the replacement and approves an
exact one-use security-key challenge. An already-bound replacement identity
requires review; it never triggers an automatic account merge.
For a lost Google login, the founder approved using that same inbox as the new
email-code login. Privy must verify inbox access, and the retained YapArena
passkey must independently approve the replacement; a matching address alone
never establishes account ownership.

The replacement preserves the internal account, profile, balances and security
keys. The old provider identity becomes a permanent retired mapping, every old
application session and outstanding operation loses authority, and one successor
session is issued after the atomic commit. A delayed provider-control job for
the retired identity must not freeze, unfreeze or alter the replacement identity.
The [completion matrix](email-first-completion.md) tracks implementation and
acceptance of this newly approved flow separately.
Recovery requires working origin storage to coordinate the provider replacement
across tabs and refreshes. If storage is unavailable, the UI blocks recovery and
explains the problem before requesting an email code. A failed recovery cannot
silently become ordinary signup.

Each Privy `sid` can issue at most one YapArena session. Token refresh/replay
cannot recreate an expired/revoked app session. Exchange requires exact Origin,
rejects switching an active account, and publishes a cookie only after commit.
Production `__Host-session` is Secure, HttpOnly, host-only, SameSite Strict.
Safe return retains the initiating local path, query and fragment. Account-page
OAuth query strings are omitted from HTTP logs.
The approved return behavior brings the user back to the initiating action for
confirmation. Same-page authentication preserves the existing document and
draft inputs; a redirect keeps only a bounded, expiring public action locator
and safe local URL. Signing in never submits the initiating stake, payment,
follow or account mutation. Provider callback parameters are removed from the
returned URL.

**Current state — 2026-10-22 founder decision:** Sign out works as in other apps
and ends only this device's session. `POST /api/auth/logout` deletes that one
session row (audited `sessions.logout_one`); it does not advance the account
generation or queue a Privy freeze/unfreeze. The browser ends its own Privy
session with Privy `logout()`. Sign out all sessions and Sign out other sessions,
with `POST /api/auth/logout-all` and `/logout-other-sessions`, were removed. The
account page's Active sessions list was removed on 2026-10-24 (founder); its API
remains. This
is implemented and locally tested on branch `fix/single-device-logout`, not
hosted-tested; see [Decision 0008](decisions/0008-auth-simplification.md) point 4.
The next two paragraphs record the earlier decision and the `92f11b4` correction.
Their provider-reset description still applies to the remaining generation
changes: security incidents, key triggers, wallet removal, password change and
suspension.

Normal **Sign out** now revokes all YapArena sessions by founder decision.
Explicit owned-session and logout-others controls retain their targeted semantics.
Generation changes enqueue durable provider-revocation work in the transaction.
The local fence commits before external calls. After a confirmed provider freeze,
the worker unfreezes active accounts and advances the mapping with an issuance
bound strictly after the freeze. This bound works only after old refresh sessions
were revoked; `iat` alone is not fresh authentication. The normal worker durably
records mutation intent before its one external call. Only positively acknowledged
freeze/unfreeze responses enter resumable GET-only confirmation phases: ten-second
checks, at most eight reads or 120 seconds per phase. Read-only propagation checks
release the pool connection and account lock. The bounded mutation window holds
account ordering (one five-second RPC for freeze; an exact-state GET plus unfreeze
may use two such RPCs, under the cumulative twenty-second attempt deadline).
An intent without a durable acknowledgement, an expired budget, unknown outcome,
or independently pre-frozen account remains fenced for operator review; mutations
are never automatically repeated. Legacy jobs retain conservative handling and
the existing reviewed owner retry remains one-shot. Monitor reads return temporary
unavailability during owned pending phases; genuine credential changes still revoke
access. Both authentication queues run on the web service whenever Privy is configured,
independently of the general background-job setting, with database leases across
replicas. Provider incident handling requires a single writer
because the provider has no conditional ownership API for freeze/unfreeze.
Resume after suspension still requires reviewed reconciliation.

Current state, 2026-10-22: the logout overlap handling below and its owner-only
rearm (`prepareAcknowledgedLogoutReset`/`resumeAcknowledgedLogoutReset`) were
removed on `fix/single-device-logout`, because only sign-out-all/others
generations could reach them. An older job overlapping a newer generation again
stops for manual review (`inherited_manual`).

The first-key/logout overlap correction is committed in `92f11b4`. An older
positively acknowledged reset may drain only through the exact successful
authenticated-logout generation chain; a later logout then performs its own
reset. Older completion cannot adopt a stale generation, lower a token cutoff
or wake wallet work. Unknown/crashed mutations and changed authority remain
manual. A separate owner-only, fingerprint-bound review can rearm the exact
stopped acknowledged/inherited pair once without making any provider mutation.
Its fresh/upgrade PostgreSQL gate passed 248 cases on each path, including
runtime-role denial, adversarial review evidence, concurrent replay, in-flight
intent competition and audit rollback. This is local acceptance; the new
disposable account has not yet been repaired or genuinely retested.

Sensitive backend changes retain operation-bound password/SIWE proof and reuse
the same Privy passkey for an application-issued, server-verified WebAuthn
challenge. New enrollment and the single passkey login option belong to Privy;
previous independent application keys remain usable as retained credentials.
New external-wallet linking and unknown-wallet signup are disabled when email-first
authentication is configured. Retained-wallet sign-in and proof-protected removal
remain available. Expiring single-use proof binds account,
session/generation, operation, nonce, expiry and exact financial terms where
applicable. The sandbox withdrawal reserves funds and consumes that proof in one
transaction. Browser MFA flags and token refresh are insufficient.
Weaker email recovery cannot replace stronger wallet authorization.
If every retained passkey, trusted wallet and password is lost, ordinary email
access may continue, while actions requiring strong proof remain unavailable.
Physical loss is not automatically detectable and does not create an automatic
account-wide hold. Email cannot reset an accepted stronger method; a complete
provider-approved recovery service remains pending.

Already-open media connections, outstanding grants and in-flight feature writes
retain their documented [revocation boundary](security/account-session-revocation.md#external-and-in-flight-boundaries).
The Privy outbox does not revoke LiveKit/media grants. A separate tracked-speaker
queue now handles session expiry/revocation and suspension with durable retries;
Cloud token rejection and legacy-grant rollout require separate hosted acceptance.

## Redis, configuration and measurements

Redis stores shared abuse counters only. Atomic Lua increments/install TTLs
together. Namespaced HMAC IP-subnet/operation keys contain no raw identity or
bearer credential. Direct OTP requests go to Privy; application auth POST
mutations use Redis, with logout and session reads available during outages.
With Redis configured, the general API, A4 and coin-sandbox limiters count in
the same store and fail open on a store error (logged, `fail_open` outcome); the
auth and wallet-sign-in limiters fail closed (503). Without Redis they stay
process-local. Verified account-scoped
wallet-operation creation uses a separate 30-per-15-minute budget; auth POSTs
share a 120-per-15-minute IP-subnet budget. Logout, session listing and
per-device revocation remain usable during Redis outages. These are initial
staging limits, not financial fraud controls.

Connect/command bounds are one second; offline queue and automatic reconnect are
disabled, with five-second retry backoff. Protected mutations fail closed (503);
throttles return 429/Retry-After. Security state uses a separate `noeviction`
instance. No ordinary cache or positive authorization cache was introduced.
PostgreSQL remains authoritative for every authenticated session lookup.

A free Render Key Value instance, `yaparena-staging-security`, was created in
Ohio. The verified staging-service Connect panel lists outbound ranges
`74.220.50.0/24` and `74.220.58.0/24`; only those ranges were allowed on the
authenticated external TLS endpoint. No public allow-all rule was added. Hosted
connectivity was verified after rollout by a protected staging auth request,
which passed the shared Redis control and returned the expected 410 for retired
password signup. This establishes one hosted connection, not multi-instance
load/outage acceptance. Free instances lose counters on restart;
this is not durable financial-security acceptance. Production config requires TLS.

Prometheus measures aggregate auth events/timing and Redis latency/errors/throttles.
Journey bodies reject credentials, email and extra fields. Recovery event names
are a vocabulary, not evidence of a completed recovery flow.

Runtime secret names: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
`REDIS_SECURITY_URL`, `REDIS_NAMESPACE`, `REDIS_KEY_SECRET` (32+ random chars).
`PRIVY_VERIFICATION_KEY` is optional: the SDK fetches public keys.
`PRIVY_CLIENT_ID` is optional unless a separate client is configured. Only App ID
and optional Client ID reach the browser. Keep owner/admin processes separate;
never load a combined operator env file into web/worker processes.

## Authorized staging reset

Confirmed site: **https://yaparena-staging-web.onrender.com**, Render service
`srv-datv1kjncjis73a500cg`, Supabase project `ypteqfmjietdqjzyvgtk`, database
`postgres` via the verified TLS pooler. User initially confirmed disposable
accounts, then explicitly narrowed deletion to **IDs 1, 2, 3 and 4 only** after
reviewing the account list. Preserve IDs **72, 73 and 134**. The earlier
empty-environment requirement is superseded by that selection.
Initial counts: users 7, sessions 4, linked wallets 1, owned profiles 3, play runs
15, immutable play journals 101, media records 13. All rounds inspected were
settled; no ready/live debate or redeemable asset found. These are pre-reset counts.

Explicit command: `npm run reset:test-accounts -- --dry-run --user-ids=1,2,3,4`,
then the same selection with `--prepare`, `--rehearse`, `--execute`. The restore
proof must match the exact selection. Unselected users, sessions, linked sign-in
identities and owned profiles are checked unchanged in the deletion transaction.
Every invocation requires either an explicit ID selection or `--all-users`;
omitting the scope fails before database access.
Never invoked at startup or by migrations. Requires
exact host/database/project/origin, owner credentials, drained writers, encrypted
private backup, restored table/sequence fingerprints and deletion rehearsal.
Pre-migration backups can be captured/restored first; execution additionally
requires a fresh post-migration backup and successful deletion rehearsal. Canonical
fingerprints use explicit `C` ordering, so source and restore database collations
cannot cause false mismatches. Rehearsal writes only to the guarded disposable
copy; it does not lock the hosted tables. Snapshot export holds source table
write locks. Destructive execution takes **ACCESS EXCLUSIVE** locks on all
application/migration tables, fencing concurrent reads/writes for the transaction,
with a five-second lock timeout. A second local connection must demonstrate a
blocked signup insert during rehearsal before execution is permitted. Operators
must still stop every web/worker writer and callback; the hosted run verified
both Render services suspended before execution. Managed warm idle pool backends
are not treated as active application writers. Refuses live coin
records/non-play assets, unsettled rounds and active events. Historical subject
IDs retain immutable history without login credentials; public content and media
are preserved where integrity permits. No TRUNCATE, disabled constraints,
Redis FLUSH or key/asset deletion.

Required operator variables: `RESET_DATABASE_URL`, `RESET_EXPECTED_HOST`,
`RESET_EXPECTED_DATABASE`, `RESET_EXPECTED_PROJECT`, `RESET_ENVIRONMENT=staging`,
`RESET_ORIGIN`, `RESET_BACKUP_DIRECTORY`, `RESET_BACKUP_KEY`,
`RESET_WRITERS_STOPPED=true`; rehearsal also needs guarded loopback
`RESET_RESTORE_DATABASE_URL`. Keep values, backups and raw reports outside Git.

The [sanitized preflight report](evidence/email-first/reset-preflight.json)
records a real encrypted staging snapshot with verified table/sequence restore
fingerprints. The new migrations and deletion were rehearsed on a second local
restore: zero users/sessions/wallets, with 15 play runs, 101 journals and 13 media
records preserved; deletion was rolled back. Both hosted services resumed after
the snapshot. The four new account/coin/history/grant migrations were then
applied by a separate owner process on 2026-10-19. At that point seven users,
four sessions and one linked wallet remained; no provider identity or money
journal existed. Provider signup was paused in `auth_controls` for the rollout.
Both services resumed.
The web service has the five new runtime variables above, with its existing
restricted database identity preserved. Feature revision `f8c26a9` was deployed
explicitly to staging with signup paused, without changing main, automatic
deployment or the replay worker revision. Its five required CI checks passed in
[run 39327344593](https://github.com/Boufe/YapArena/actions/runs/39327344593).
Hosted `/ready`, `/account` and provider configuration passed; anonymous session
inspection returned 401 and protected password registration returned 410.

The [selected reset report](evidence/email-first/reset-selected.json) records the
committed deletion at 2026-10-19 21:47:26 UTC: four selected users and three
sessions removed; three users, one session and one linked wallet remain. Their
account/credential rows were checked unchanged. Three public profiles were
detached; 15 play runs, 101 play journals, 13 media records and permanent subject
IDs remain. The fresh encrypted post-migration backup restored with identical
table/sequence fingerprints; exact deletion and concurrent-writer blocking were
rehearsed first. No provider identity, wallet key/asset or live financial record
was deleted. Redis was not flushed. Both services resumed; readiness is 200 and
ordinary signup is enabled.

Deleted IDs have no account/session/wallet/challenge rows, so their old app
session lookups cannot authorize. An actual pre-reset browser-cookie replay was
not captured. No Privy users existed before deletion. The founder then completed
a genuine hosted email signup. [Read-only verification](evidence/email-first/hosted-signup.json)
confirmed one verified provider identity, exactly one new stable account, one
active app session and one consumed provider-session exchange. The four deleted
IDs remain absent. There are now four accounts: the three retained accounts and
the founder's new manual signup, which must be preserved. Automation created no
acceptance identities. No live coin journal or promotional grant was issued.
Provider-session revocation/recovery and stale-token replay remain acceptance gates.

## Account visual refresh

The founder separately requested a redesign of authentication, account settings
and the Yap Coins popup. The refresh keeps the shared navigation and navy/mint
theme, adds a focused email/code panel and organizes profile, security, linked
wallets and activity into a responsive dashboard. The withdrawal amount has a
prominent numeric display, with available/reserved/pending/promotional balances,
independent grant targets and permanent-qualification indicators. The preview
continues to state that purchases and withdrawals are unavailable.

The existing profile, legacy login, wallet-authorization and session controllers
remain in use. Strict TypeScript/TSX owns the changed browser behavior; the new
server markup is isolated in `src/features/discovery/account-web.ts`. No wallet,
provider identity or financial state is created by this visual change. The Privy
email island disables unused external-wallet discovery using the locked SDK's
typed connector settings and an explicitly empty wallet list; disabling connectors
alone still caused directory requests during hosted verification. The separate
native-wallet controller is retained. CSP is
not broadened to accommodate unnecessary WalletConnect explorer requests.

[Matched screenshots and browser results](evidence/account-refresh/README.md)
separate synthetic authenticated views from real anonymous staging observations.
The local fixture verifies profile creation/publication and permanent handles,
session sign-out controls, exact return paths, keyboard/code behavior and
menu/dialog focus restoration. Automated WCAG AA-tag checks cover the email
form, signed-in area and wallet dialog. Manual screen-reader and physical-device
acceptance, complete WCAG 2.2 AA conformance and provider recovery remain unverified.

The [explicit staging deployment](evidence/account-refresh/hosted-deployment.json)
of `a1dcf40` became live at 2026-10-19 22:39:36 UTC. Readiness, account, public
discovery and Live pages returned 200; anonymous session inspection returned 401.
Main, automatic deployment and the replay worker were unchanged. Real anonymous
desktop/mobile [browser observations](evidence/account-refresh/hosted-anonymous.json)
found no page errors, overflow or top-level CSP violations. The email form became
ready in 2.275 and 2.296 seconds in these workstation runs; the provider bundle
transferred about 1.72 MB compressed. CAPTCHA frames loaded, but this check did
not submit email or validate CAPTCHA. At that recorded revision, optional
Google/passkey buttons shown in local fixtures were disabled in the selected app.
They have since been enabled as documented above.

[Read-only account postflight](evidence/account-refresh/hosted-accounts.json)
confirmed the three retained accounts and the founder's one manual account,
one active manual-account session, and no live money journals or grants. The
cumulative provider-session exchange count is now two; this did not create an
additional account and is not a captured returning-user or revocation trial.
No additional reset was performed for the UI rollout.

## Shared navigation and popup

The [shared-header change](evidence/shared-header/README.md) uses Live's navigation
on all ordinary pages. Visitors see Log in / Sign up; a verified YapArena session
reveals the YC balance, Deposit and account menu. Existing account and protected
action links open the same custom email popup. It preserves safe initiating URLs,
keyboard/focus behavior and browser Back, and clears submitted fields on dismissal.
Successful same-page authentication preserves the document and draft inputs,
refreshes protected controllers, and returns focus/action context for confirmation.
A redirect returns to the exact safe initiating URL; it does not submit the action.
The account page reuses its existing authentication root; other pages download
the provider bundle only when authentication is opened.

Header session authority stays on the server. Outage/retry, cross-tab logout and
late balance responses are covered locally; legacy A4 balance events cannot set
the financial header. CSP now supports the lazy popup site-wide while retaining
configured media origins. OAuth credential parameters are excluded from return
paths and HTTP request logs. The Deposit button explained that funding was not yet
available; on 2026-10-24 it was removed until funding opens, and visitors now see one
Sign in button that opens the account page. No provider identity, wallet, money journal or financial adapter is
created by this UI change. Responsive container queries support 200% header
reflow; a desktop/mobile comparison verifies shared geometry and typography
without the debate stylesheet. That earlier UI revision `f942dc6` was deployed and
verified anonymously on staging. It is superseded by the `9395242` release above;
real popup signup, optional-method and financial acceptance remain distinct
from anonymous observations.

## Earlier foundation evidence

The refreshed complete local gate passed **524 tests, no skips**, with 93.92%
lines, 92.75% branches and 95.30% functions; fresh/upgrade database isolation and
the core browser release gate passed. Real local Redis checks passed with two
clients, 100 concurrent atomic increments, TTL expiration and bounded outage
failure. The production Docker image built successfully after an authorized
Colima restart recovered a full-disk I/O error. Local databases/containers recovered;
no image/volume/cache pruning was performed.

Locked-install audit reports 10 moderate, zero high/critical findings in the
Privy wallet dependency tree. A forced SDK downgrade is not an accepted fix.
The approximately 5.6 MB minified provider bundle loads on the account page or
on demand from the shared login/signup popup. The
hosted compressed transfer and initial readiness observations above do not
establish a population latency budget, isolated decode cost or end-to-end
signup completion performance.

[Screenshots and recorded UI checks](evidence/email-first/README.md) use local
SSR fixtures at identical 1440x1000 and 390x844 viewports. The installed SDK runs
with live public metadata (CAPTCHA disabled in the fixture response only), intercepted OTP endpoints, optional-method fixture
flags and synthetic money balances. These checks include exact return paths,
keyboard/focus, code errors, refresh, independent grant bars, modal/menu closing,
no overflow and automated WCAG tags under the account CSP. Synthetic checks do
not prove email delivery, hosted signup, recovery, screen-reader usability,
physical-device passkeys or complete WCAG 2.2 AA conformance. Genuine hosted
signup and the selected reset have separate evidence above. Financial workflows,
recovery and full provider-session acceptance remain open. The founder narrowed
the reset scope; an empty environment is no longer the requested final state.
