# Email-first completion contract and decision log

> **Superseded.** [Decision 0009](decisions/0009-auth0.md) replaced Privy with Auth0. Prompt 12
> deleted the Privy client, embedded wallet, passkeys, provider freeze/unfreeze jobs and their
> owner repairs, and its schema change drops their tables. This record describes the Privy-era
> design and its recorded revisions, not the current checkout; for current behavior see
> Decision 0009 and the [session revocation procedure](security/account-session-revocation.md).

**Execution resumed at the founder's explicit request.** The
[2026-10-21 pause checkpoint](email-first-resume.md) preserves the prior state.
Source `3096ca7` passed all five exact-source CI checks and is verified LIVE.
The owner-only follow-up `e8fcdff` passed its local 859-test gate and all five
exact-tree CI checks. The email-send guidance correction `7e5c0a3` passed its
145-check SDK and combined 859-test local gates. The reset overlap correction
`92f11b4` passed 248 focused PostgreSQL cases on each fresh/upgrade path and
independent security review. Local Valkey8.1.10 passed all ten operational groups
in `0e226c9`. Application819421d now includes those auth/UI changes and is verified LIVE; the Valkey verifier remains operational evidence. Overall task remains incomplete.

**Current state — 2026-10-22 founder decision:** Sign out ends only this
device's session and calls no Privy reset; Sign out all sessions and Sign out
other sessions were removed. With them went the `92f11b4` logout overlap
handling and its owner-only rearm, so the pending "exact reviewed owner rearm"
below can no longer run. The per-device Active sessions list was later removed
from the account page (founder, 2026-10-24); its API remains. This is
implemented and locally tested on branch `fix/single-device-logout`, not
hosted-tested; see the [account contract](email-first-accounts.md#ownership-sessions-and-recovery).
The dated entries below are kept as recorded.

Earlier integrated attempts **failed** before the corrected run passed. A sandbox permission
failure stopped the first database start; the permitted rerun then failed an
existing short-session accounting barrier fixture. Its deterministic replacement
first exposed a fixture ID-type mistake and a separate real owner exact-replay
race between the initial history check and snapshot. Both were corrected in `cf4249a`; its 249-case fresh/upgrade gate and the later
870-test combined core-browser gate passed. The earlier 248-case PASS remains
dated evidence. The corrected deployment is now LIVE; no owner repair has run.

**Latest verified local candidate:** application source `819421d` passed the full
870-test quality gate with zero skips and 93.79/91.28/95.12% line/branch/function
coverage, 249 account/security/ledger cases plus17 A4 and five treasury cases on
each fresh/upgrade path, and all four core-browser stages. The unchanged
application assets also passed184 installed-SDK checks plus a separate overlapping
32-check focus/report/accessibility follow-up; these are not216 unique checks.
All nine new confirmation-card axe reports have zero violations. The latter
verifier-only assertion change is committed locally as `7bb6e7f`. Exact-source
[CI39705118511](evidence/account-completion-baseline/ci-819421d-20261022/README.md) passed all five checks for the exact819421d tree, with870 tests and actual remote coverage93.80/91.28/95.12. Render deployment `dep-dbcmpbbncjis73cvs9pg` is verified LIVE at819421d with the worker unchanged. Guest acceptance passed seven groups with14 matching assets and readiness200. The GET-only old-instance containment check stopped before its snapshot on a worker configuration-shape mismatch; no owner repair is executed. Genuine returning login remains incomplete.

Execution baseline: `feat/email-first-accounts` at `03ecffb`, clean on inspection,
15 commits ahead / zero behind fetched `origin/main` (`fd60543`). PR #42 is the
existing draft; all five required checks passed for that baseline. Preserve its
implementation, retained accounts and genuine manual signup. Recorded staging
revision `f942dc6` was the pre-release baseline. The named web service is verified LIVE at
`3096ca7`, with seven hosted guest groups and 14 matching assets, preserving the
prior guarded 45-migration database release; the worker remains LIVE at unchanged `fd60543` and automatic deploy is off. The guarded releases and actual evidence are recorded below. No live financial
activation, external costs, fund movement or additional account reset authorized.

**Genuine acceptance continuation (2026-10-21):** the founder reports successful
Privy passkey setup, same-key use in the withdrawal simulation and later returning
passkey login. The first returning attempt failed and its cause is unknown. A
separate read-only check on deployed `eba1dc5` confirms a ready, user-owned wallet
with no additional signer/policy; the local current/latest reset phase is complete
with matching generations. The [actual reports and limits](evidence/account-completion-baseline/embedded-wallet-release/genuine-passkey-wallet-20261021/README.md)
are distinct from synthetic fixtures, default wallet recovery, an identified
physical-device trial or a live financial payout. Remaining email-code/Google/
recovery/device/provider/financial gates keep the overall task incomplete. The
founder selected continued payment-provider comparison and identified their
existing wallet as Tangem; custody/signing is unselected. The founder explicitly chose to keep the NOWPayments inquiry unsent; no contact is authorized.
The [current provider comparison](provider-comparison-20261021.md) records
NOWPayments, CoinGate and BitPay route/cost/custody restrictions from official
sources. No candidate is an approved full fit; this is research rather than
provider-sandbox or live acceptance.

**Latest execution (2026-10-21):** the passkey failure classifier is deployed at
`3096ca7`. Its controlled before/after fixtures, 125 installed-SDK checks, combined
858-test/database/core-browser gate, all five exact-tree CI checks and actual
LIVE/guest postflight are recorded in the
[passkey correction evidence](evidence/account-completion-baseline/passkey-signin-errors-20261021/README.md).
The existing withdrawal was then approved and completed through the maintained
owner operator at `e8fcdff`, after independent review and a new 859-test gate.
The [actual simulation result](evidence/account-completion-baseline/operator-pooler-20261021/README.md)
confirms one approval, one exact receipt, unchanged identity and grant sources,
balanced postings and zero provider/chain requests. This closes that specific
hosted deterministic review/settlement trial, not provider or live acceptance.
No hosted grant issuance is inferred. All five owner-source CI jobs passed in
[run 39695525275](evidence/account-completion-baseline/operator-pooler-20261021/ci-review.md),
with measured CI coverage 95.31/91.21/95.35, distinct from local
95.32/91.23/95.35.

**Genuine disposable signup (2026-10-22 UTC):** the first human-driven attempt in
an automation-launched browser failed immediately before code verification.
The original observer omitted CAPTCHA traffic and did not establish a cause.
After native controls opened a normal Chrome Incognito window, the founder
reported successful signup. The [genuine journey record](evidence/account-completion-baseline/genuine-email-signup-20261022/README.md)
keeps the two environments and evidence limitations distinct. Its recipient and
all credentials stay private. Read-only server attribution subsequently passed. The founder then reported
ambiguous passkey confirmation and failed returning passkey/email login. The
00:19:44 snapshot records an accepted key and locally ready wallet, but two
manual reset jobs and mismatched generations. The prior job/provider state is
under investigation; this journey remains failed/incomplete. The separately reviewed send-code correction is now locally committed as
`7e5c0a3`, with 145 installed-SDK checks and the full859/core-browser gate passed.
It is not the functional reset repair. The later GET-only inspection confirms
provider frozen state with unchanged matching key/credentials and a matching
acknowledged-freeze window. The founder confirmed no separate dashboard block.
Normal-engine overlap handling and visible setup/wallet feedback are now being
corrected. The normal engine fix and exact owner-only rearm API are committed in
`92f11b4`; the real first-key/logout regression and adversarial owner evidence
passed 248 cases on each fresh/upgrade path, with independent review of the
frozen source and actual logs. Integrated attempts failed as recorded above; corrected release acceptance and the exact disposable-account
owner repair remain pending. No
CAPTCHA bypass, key replacement or provider configuration change follows.

**Current state — 2026-10-22, passkey confirmation:** the setup panel no longer appears above the
page. It sits under **Add a passkey** with three labelled steps (create, confirm for YapArena, ready),
one **Confirm passkey** action and plain-language prompts; a same-account refresh no longer hides the
account area. This is on branch `feat/account-setup-ux` and has local installed-SDK browser checks only;
hosted and physical-device passkey acceptance remain open.

**Earlier corrective work (2026-10-20):** genuine returning-user acceptance was
incomplete at that recorded revision. Its initial blocker was an uncertain provider-session reset with
unchanged server-verified sign-in methods. The browser incorrectly presented
every exchange `403` as a credential change, producing an empty retained-method
selector. Backend error classification is committed in `180a004`; matching
browser regression is committed in `c094f44` (78 fixture groups, zero page
errors). The first guarded retry's freeze was confirmed by a later read and the
actual organization Activity log. A single reviewed unfreeze returned success;
its immediate confirmation check stopped safely. A subsequent read confirmed an
explicit null freeze timestamp and unchanged credentials. Owner-only
database finalization subsequently completed after 185/185 tests on both fresh
and upgraded databases. The independent hosted read-only postflight confirms
matching generations, preserved old-token cutoff and a complete reset job.
[Exact repair evidence](evidence/account-completion-baseline/provider-reset-repair/README.md)
does not substitute for a genuine returning-login trial. No second unfreeze
was attempted.
No account, credential history or revocation fence has been deleted or bypassed.
The resumed checkout was `c094f44`, 99 commits ahead and none behind fetched
`origin/main`. The earlier Privy-only release served `d6e2d35`,112 commits ahead
and none behind freshly fetched main. Its hosted guest result remains separate
from genuine signed-in acceptance.

The founder's latest instruction is **use the Privy passkey only**. This
supersedes the separate YapArena passkey enrollment/sign-in choice. Enrollment
belongs in Account settings, with one passkey sign-in option. Reusing the same
Privy credential for application operation proofs is implemented locally. The
combined corrective gate passed 798 tests without skips, 198 focused PostgreSQL
cases on each fresh and upgraded database, 17 A4 cases and five treasury cases
on each path, plus the core browser journeys. See the
[integrated corrective evidence](evidence/account-completion-baseline/privy-passkey-integrated/README.md).
The rebuilt native passkey and coin browser gates passed 18 and 22 groups on
the final `14bc559` assets; cookie ordering passed 14 issuer paths. The
92-scenario SDK suite also passed with no browser or requirement failures.
All five exact-tree CI checks passed, and guarded staging deployment plus seven
guest browser groups passed at `d6e2d35`. See the
[corrective release](evidence/account-completion-baseline/privy-passkey-release/README.md)
and [CI evidence](evidence/account-completion-baseline/privy-passkey-ci/README.md).
The final review then found a browser account-switch race in ordinary provider
settings: delayed approvals/callbacks must not continue under another account.
That follow-up correction and its 99-scenario SDK regression passed locally and
are committed in `f422dfd` and included in the now-deployed `eba1dc5` release. A refreshed
provider token remains insufficient. Earlier local
separate-key recovery/financial results are historical evidence for that
architecture, not acceptance of the replacement. Existing credential records
must be preserved.

This is a working requirement matrix. **Open** is incomplete, even when an
earlier foundation exists. Agent reports require independent integration checks.
Owners: lead = integration/financial implementation; auth = account security;
provider = provider/eligibility research; Redis = shared-abuse acceptance;
review = independent reviewer assigned after integration.

**Earlier credential-wait verification (2026-10-21):** that correction passed
858 tests with zero skips and 239 focused PostgreSQL cases on each fresh and
upgraded database, plus all core browser gates. A separate new native passkey
run passed 18 groups. See the exact working-tree hashes and scope in the
[new correction evidence](evidence/account-completion-baseline/wallet-verification-pause/README.md).
The separately dated installed-SDK 111, coin 22 and HTTP cookie-coordination
seven-group/14-issuer results retain their own source boundaries. These are
synthetic provider/browser fixtures with real application/database behavior
where stated. No new genuine provider result is inferred from them.
The separate read-only provider verifier passed 20 offline protection checks.
See [combined evidence](evidence/account-completion-baseline/wallet-phase-integrated/README.md),
[SDK evidence](evidence/account-completion-baseline/embedded-wallet-browser/README.md),
[native passkeys](evidence/account-completion-baseline/security-passkey-browser/privy-only/README.md),
[coins](evidence/account-completion-baseline/coin-sandbox-browser/README.md)
and [cookie coordination](evidence/account-completion-baseline/wallet-phase-cookie-browser/README.md).
All five exact-tree CI checks passed for `eba1dc5` in run 39678375965. Guarded migration/LIVE/readiness and seven hosted guest groups also passed; genuine provider acceptance remains open and is not inferred from CI or guest checks.

On 2026-10-21, the founder **superseded embedded-wallets-off and new external
wallet linking**: automatically create one user-controlled Privy EVM wallet per
account, use default Privy recovery and give YapArena no delegated signing
authority. Remove new external-wallet linking from the product; preserve
retained wallet ownership records and security methods. Signup/access must remain
available if wallet creation fails. This does not change internal YC, the five
requested input routes or the live-money gates. Implementation and the dedicated
synthetic browser checks pass locally and the implementation is deployed. Actual
read-only wallet ownership acceptance subsequently passed; default recovery and
remaining genuine provider/device scenarios remain open.

The earlier genuine hosted passkey trial saved one Privy passkey with an exported COSE
public key that passes the parser, but local activation had not captured it at that time. The later successful setup/login report above supersedes that state without rewriting the earlier evidence. The
subsequent recorded event was logout-all, followed by a provider freeze.
An independently reproduced two-session pending-setup monitor bug was corrected;
it is not established as the cause of this genuine failure.
A reviewed first-setup reset-only repair completed on 2026-10-21 after independent
review and 206 fresh/upgrade PostgreSQL cases. One provider unfreeze was followed
by GET-only finalization after propagation; the accepted snapshot and old-token
fences are preserved, and no application key or session was created. See the
[actual repair evidence](evidence/account-completion-baseline/first-passkey-reset-repair/README.md).
Only fresh provider login plus native key verification may activate the key.
The independently reproduced two-session monitor fix is committed in `5b15294`.
The normal-worker phase engine distinguishes acknowledged read-only confirmation
from uncertain mutation outcomes and passed the combined local gate. The
coordinated worktree started verification at `030b60e`, 116 ahead / zero behind
fetched main. Tested wallet/phase and operator sources are now in focused commits
through `8dad4dd`; they are now included in the exact `eba1dc5` staging release. Final isolated
quality passed again after the operator/harness updates. All five exact-tree CI
checks passed at `eba1dc5`; guarded release evidence now establishes exact LIVE revision, readiness and guest acceptance.

Release was paused before any service or database mutation after the lead found
that human-delayed credential acceptance could exhaust wallet creation retries.
The correction parks authorization waits without automatic provider polling and
rearms only the accepted same identity after verified login/retry or synchronized
reset. It passed the new combined and native gates above. The earlier `a9706cc`
CI run passed four checks but failed the retained-wallet browser near its final
mobile refresh assertions; its original error line was not preserved. A separate
deterministic refresh barrier reproduced the invalid immediate visibility assertion;
the corrected verifier passed four focused groups and four groups in successful
exact-tree CI run 39678375965. Guarded release passed; genuine user trials remain required.

**Independent CI and configuration review (2026-10-21):** all five required jobs
passed in [run 39678375965](https://github.com/Boufe/YapArena/actions/runs/39678375965).
All five checkout logs name merge `4f7f28a1`; its parents and tree prove the tested
content equals pushed `eba1dc5`, rather than relying on run `head_sha`. CI quality
passed 858/858 with zero skips and 95.32/91.23/95.35 coverage; 239 account/security, 17 A4
and 5 treasury cases passed on both fresh and upgrade paths. The retained child
reported `status: passed`, four groups. Actual browser/artifact details and
runner-local limits are in the [CI audit](evidence/account-completion-baseline/wallet-phase-ci/eba1dc5/README.md).
The lead's separate six-GET [Render configuration inspection](evidence/account-completion-baseline/embedded-wallet-release/runtime-credential-separation/acceptance.json)
confirmed expected runtime credentials and no configured owner/admin markers for
both named services, including direct secret files; it made no database writes
or provider mutations. Neither result alone establishes that the new source is deployed.
The independent 52-row review found no new application-source gap. Recorded
CI and staging postflight passed; genuine provider, physical-device and
legal/custody/routes/backing gates remain incomplete.

**Guarded database release (2026-10-21):** both named writers were suspended.
The separate owner prepared an encrypted application-schema backup and an exact
85-table/15-sequence isolated restore, rehearsed both additive migrations, then
applied them to staging. Runtime nonidle peer sessions were zero before both
prepare and apply. The guarded pre/post security fingerprints were unchanged.
The [read-only database postflight](evidence/account-completion-baseline/embedded-wallet-release/staging-database-postflight.json)
confirms 45 applied/zero pending, all four accounts/three retained, selected reset
accounts absent, zero live journals/grants and matching provider generations.
The browser/runtime role boundary remains intact. These are application-schema
backup/rehearsal checks, not a full provider/global-role disaster recovery claim.
Both writers resumed. At 22:08:54UTC, Render confirmed web deployment
`dep-dbcjbacs728c73f7m02g` LIVE at exact `eba1dc5` and the replay worker LIVE at
unchanged `fd60543`, with automatic deploy off for both. At 22:09:27UTC, seven
hosted guest groups passed with 14 exact authentication/header/security asset
matches, PostgreSQL-backed readiness 200 and retired-register 410 Redis behavior,
without account/provider mutation. The anonymous wallet endpoint separately
returned 401 with private/no-store/no-cookie behavior and no wallet-state leak.
These results do not establish genuine authentication, wallet creation/recovery
or physical-device acceptance.

**Earlier provider inspection was pending (2026-10-21):** at 22:09:31UTC the
fixed-target GET-only verifier reported `PENDING: credential_verification_required`
for the deployed revision. The job was `retry_wait`: an accepted credential
snapshot was present and generation matched, while the current provider digest
did not match it. Two database snapshots and repeated provider reads agreed;
the inspection made six provider GETs/four Render GETs and zero mutations.
SDK automatic-wallet flags remain off; the durable server job implements the
approved automatic provisioning trigger. User-only wallet ownership, no
additional signer/policy, successful creation and default recovery are **not
established** by this pending result. Native user
testing was still in progress at that snapshot. The [later genuine continuation](evidence/account-completion-baseline/embedded-wallet-release/genuine-passkey-wallet-20261021/README.md) records the subsequent user report,22:38 ownershipPASS and22:59 exact sandbox authorization match. See the
[sanitized provider report](evidence/account-completion-baseline/embedded-wallet-release/provider-wallet/acceptance-pending.json).

**Scoped privacy and deliverables review (2026-10-21):** the actual
[count-only repository scan](evidence/account-completion-baseline/embedded-wallet-release/repository-privacy.json)
passed 897 tracked/new-document text files against five current privately loaded
secrets, with zero matches. It made two GETs and no database connection or
mutation; 763 binary files/pixels and unknown/historical obfuscations are outside
that scanner. Current empty-form hosted screenshots and recorded artifacts were
reviewed separately. Supabase advisors access remained denied; no clean advisor
result is claimed. The scan output and later fixed-text completion/PR metadata
are explicitly added after that scan.
Focused source commits and the reviewed documentation/screenshots/archives are
published in PR #42, including archive `1bec989` and its description refreshed
at 22:24:50 UTC. That publication recorded runtime CI and staging at exact `eba1dc5`;
future PR-header check results are reported only when observed, without an
invented future success or a self-referential runtime commit/CI cycle. The
independent whole-contract source/release review and final two-document
reconciliation passed the second reviewer's actual read-only audit of all 52 rows.
That reviewer validated 321 references, 59 catalog entries, 49 local links and
eight source/compiled hashes, with no unsupported acceptance claim or new blocker.
The overall task remains incomplete for the genuine/human and external gates.

## Shared engineering contracts

- PostgreSQL owns stable account IDs, session digest/generation, revocation and
  financial history. Sensitive commits lock account, recheck session, then lock
  operation and relevant financial rows in stable order.
- Fresh proof must bind account, session generation/digest, operation UUID,
  nonce, expiry and immutable terms; consume in the mutation transaction.
  Provider access-token refresh/issuance time and frontend MFA flags do not qualify.
- Existing wallet proof remains purpose-specific SIWE and retained-credential
  approval. No implicit email matching or provider/browser ownership claim.
- Financial identifiers: historical `YAP` stays separate; new accounting uses
  `USDC`, precision 6 for cash and `YC_PROMO`, precision 4 for spend-only
  promotional principal, with atomic integer strings and `sandbox` / `live` environments.
  One YC = 10,000 USDC atomic units. No floating-point authoritative amounts.
- Status vocabulary: pending, completed, failed, uncertain; uncertain payment
  retains its reserve until external reconciliation establishes no payment.
  Idempotency is scoped by environment, owner, operation and immutable terms.
- Logs/metrics contain bounded outcomes and timings, no credentials, signatures,
  raw email/IP, webhook bodies or private financial data. HMAC identifiers only
  where a privacy-reviewed operational purpose requires them.

## Requirement matrix

| ID  | Requirement / acceptance criteria                                                                                              | Owner         | Dependencies                                    | Status / evidence                                                                                                                                                                                                                                                                                  | Remaining blocker                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Establish checkout, fetch, PR and deployed revision; preserve existing work                                                    | lead          | access                                          | Exact3096 CI5/5 and LIVE web/unchanged fd worker verified; latest guest7/assets14 passed. Prior guarded45/0 migration preserved account/security fingerprints. Operator e8 changes no runtime/schema.                                                                                              | Satisfied for recorded staging release; genuine/provider acceptance tracked separately                                                                         |
| R02 | Read governing PRD, plans, security, operations and recorded evidence                                                          | all           | repository                                      | Governing PRD/plans, A4, financial/security/Redis/operations guides read                                                                                                                                                                                                                           | Keep later changes consistent with governing sources                                                                                                           |
| R03 | Maintain checklist, decision log, coordinated contracts and ownership                                                          | lead          | none                                            | Current 52-row checklist, decision log, ownership/contracts and actual CI/release evidence audited                                                                                                                                                                                                 | Satisfied current maintenance; continue on new facts without treating future duty as a missing implementation                                                  |
| R04 | Preserve public discovery/watch, theme/header and signed-in controls                                                           | lead          | UI baseline                                     | Theme/header preserved; installed-SDK125 actor/privacy suite and exact3096 hosted guest desktop/mobile7 groups/assets14 passed; earlier matching screenshots retained.                                                                                                                             | Genuine hosted signed-in/theme/account-switch journey                                                                                                          |
| R05 | Genuine Privy primary email-code signup and returning login                                                                    | auth          | Privy app/domain                                | Original manual account signup and later passkey return succeeded. New disposable email signup succeeded, then passkey/email return failed with verified provider freeze; correction awaits release/repair/retest.                                                                                 | Genuine returning email and recovered disposable journey remain incomplete.                                                                                    |
| R06 | Code lifecycle, paste/autofill, resend, cancellation, errors, delayed delivery                                                 | lead          | Privy capabilities                              | Provider-owned code lifecycle; installed-SDK125 covers code/resend/cancel/network plus bounded passkey failure classifications, zero page/requirement errors.                                                                                                                                      | Genuine delivery, delayed/expired/used codes and OS autofill                                                                                                   |
| R07 | Refresh/back/multi-tab/network/initialization and duplicate-submit handling                                                    | lead          | browser                                         | Final SDK111 and native cookie coordination passed: seven groups across 14 issuers, with initialization, refresh, cancellation, delayed response and cross-tab ownership fencing                                                                                                                   | Genuine hosted interrupted and cross-tab provider ceremony                                                                                                     |
| R08 | Optional Google and passkey enrollment/returning authentication                                                                | auth/lead     | provider settings and proof                     | Free development Google/passkey enabled; founder reports successful passkey setup and later returning passkey login; initial failed attempt preserved                                                                                                                                              | Genuine hosted Google linking/login and remaining device/recovery trials                                                                                       |
| R09 | Minimal onboarding and exact safe local return/action                                                                          | lead          | browser                                         | Bounded return-to-page/action context, confirmation before mutations and local browser regressions implemented.                                                                                                                                                                                    | Genuine initiating-page/action return journey                                                                                                                  |
| R10 | Stable transactional identity provisioning, races and callback replay                                                          | auth          | PostgreSQL                                      | Stable transactional DID mapping and session fences, plus durable wallet enqueue, passed 858 tests and 239 account/security/ledger cases on each fresh/upgrade path                                                                                                                                | Genuine hosted callback/account journey; source/schema deployed                                                                                                |
| R11 | Recovery/email changes/method linking/removal                                                                                  | auth          | supported fresh proof, policy                   | Same Privy key, restricted restart and retained ownership flows implemented; embedded-asset recovery exclusion rechecked under the final account lock; 239 cases passed on each fresh/upgrade path                                                                                                 | Genuine hosted flow; recovery after losing every strong method awaits provider approval                                                                        |
| R12 | Retained legacy dual-ownership reconciliation, no email-only merge                                                             | auth          | fresh proofs                                    | Explicit dual-ownership reconciliation implemented; cross-account/no-merge negative PostgreSQL cases passed                                                                                                                                                                                        | Genuine hosted retained-account linking trial                                                                                                                  |
| R13 | Linked-wallet management preserves retained and final-method protections                                                       | auth          | existing F02                                    | New external linking disabled in UI and both backend paths in Privy mode; unknown-wallet signup denied; retained login, removal and final-method guards passed PostgreSQL and strict browser gates                                                                                                 | Genuine hosted and physical wallet ceremony                                                                                                                    |
| R14 | Cookie/domain/sender/branding/provider limits/pricing verified                                                                 | auth/provider | official docs/settings                          | Free DEV 150-user cap/current hosted config verified. Official custom OTP sender/template and production webhooks require Enterprise and remain unused; basic name/logo guide states no plan restriction. Capability follow-up records public pricing/cookie/OAuth limits                          | Numeric selected-production user-GET quota and actual production domain/DNS/OAuth/provider-cookie configuration                                                |
| R15 | Automatic user-controlled EVM wallet; signup independent of provisioning                                                       | wallet/lead   | provider settings                               | Durable automatic user-owned EVM wallet deployed without app signer; read-only actual provider ownership/no extra signer-policy PASS; founder reports assigned wallet                                                                                                                              | Default wallet recovery and remaining genuine provisioning/device scenarios                                                                                    |
| R16 | Expiring replay-resistant operation proofs bound to exact sensitive terms                                                      | auth/lead     | supported authenticators                        | Five-minute term-bound one-use proofs; genuine same-key proof/audit/exact terms/two-posting reservation matched read-only, then guarded owner review/receipt completed without changing authorization terms.                                                                                       | Satisfied for recorded genuine proof and local negative suite; device/live gates separate                                                                      |
| R17 | Logout current/others/all, suspension, credential revocation and stale-token fence                                             | auth          | PostgreSQL/provider                             | Superseded 2026-10-22: Sign out ends this device only; sign-out all/others, 92f11b4 overlap handling and owner rearm removed (local, `fix/single-device-logout`). Dated: disposable return failed, provider frozen, two manual overlap jobs; 92f11b4+cf4249a passed 249/path and combined870.      | Hosted single-device sign-out and genuine returning/revocation acceptance pending; the owner rearm no longer exists                                            |
| R18 | Provider-side credential changes invalidate existing application cookies                                                       | auth          | supported affordable mechanism                  | Superseded by [Decision 0008](decisions/0008-auth-simplification.md) step 9: requests make no Privy call; an asynchronous 15-minute re-check ends sessions of deleted, frozen or guest Privy users and records method changes with a notice; step-up checks the approving key live                 | Production rate allowance and genuine hosted credential-change trial                                                                                           |
| R19 | Open connections, in-flight operations and media grant revocation boundaries                                                   | auth/lead     | media provider                                  | Actual HTTP logout/PG outbox disconnected Cloud speaker; refreshed tokens rejected/public viewer preserved; legacy drain and zero-room/assigned-speaker inventory confirmed                                                                                                                        | Genuine hosted user logout and physical media remain separate                                                                                                  |
| R20 | Preserve approved financial terms exactly                                                                                      | lead          | founder prompt                                  | Approved rules preserved by independent source/copy review, unchanged financial 22-group scope and combined suites. Exact deployed customer assets match; no stale cap/fee/refund/purchased-qualification term                                                                                     | Rule-preservation requirement satisfied within recorded scope; live financial R21-R36 gates separate                                                           |
| R21 | Custody/signing/provider routes including all five requested networks                                                          | provider      | actual activity approval                        | Current official NOWPayments/Circle research; all five route candidates tracked                                                                                                                                                                                                                    | Written actual-activity approval, custody/signing and route selection                                                                                          |
| R22 | Quotes/expiry/conversion/fees/settlement/finality/reorg handling                                                               | provider/lead | chosen routes                                   | Simulation quotes plus finalized canonical Base Sepolia receipts; actual app-ledger funding/payout reconciled                                                                                                                                                                                      | Approved live provider multichain quotes, routes, fees and finality                                                                                            |
| R23 | Canadian age/province/identity/retention eligibility                                                                           | provider      | qualified/provider review                       | Founder confirms no review; every live province remains disabled                                                                                                                                                                                                                                   | Written activity/province/age/identity/retention review and provider acceptance                                                                                |
| R24 | Approved solvent finite promotional allocation and reserve caps                                                                | lead/provider | founder decision                                | Separate worst-case pre-admission reserve and concurrent solvency checks passed combined gate                                                                                                                                                                                                      | Real 50 USDC remains unfunded/unallocated; live provider approval                                                                                              |
| R25 | Payout timing, refund/correction/dispute rules and instrument integration                                                      | lead/provider | founder decisions                               | YES/NO integration; two-business-day review and no-cutoff error/correction rules approved                                                                                                                                                                                                          | Provider-specific recovery execution and live operational acceptance                                                                                           |
| R26 | Confirmed funding, conversion quotes and exactly-once funded issuance                                                          | lead          | external contract                               | Confirmed simulation issuance passed local gates; actual finalized 6 test-USDC app-ledger funding reconciled                                                                                                                                                                                       | Live five-network provider acceptance                                                                                                                          |
| R27 | Exactly-once welcome/daily Toronto-day grants and grant lots                                                                   | lead          | claim timing decision                           | Exactly-once welcome/explicit Toronto-day claims passed concurrency/native gates; implementation deployed to staging                                                                                                                                                                               | Actual hosted snapshot0welcome/0daily/0grant events; real grant backing unfunded/unallocated                                                                   |
| R28 | Source spending, proportional profit/loss, fees/rounding and permanent qualification                                           | lead          | examples approved                               | Exact source engine, actual-cost A4, profit-first grant loss and sticky qualification passed combined suites and review                                                                                                                                                                            | None for local sandbox; live instrument release gates separate                                                                                                 |
| R29 | Promotional backing and available/reserved/pending/promo/withdrawable projections                                              | lead          | R24/R28                                         | Source-aware balance/reserve/qualification projections implemented; actual genuine-account book/funding/proof/reservation inspected; later maintained simulation review/settlement passed.                                                                                                         | Remaining genuine projection/grant journeys and live promotional backing/eligibility                                                                           |
| R30 | Withdrawal request, specific proof, manual review and transactional reservation                                                | lead/auth     | R16/R25                                         | Exact genuine proof/reservation plus actual maintained owner review and completed deterministic receipt passed at runtime3096/operator e8. One approval/one outcome, unchanged terms/sources, zero external calls.                                                                                 | Selected-provider payout/reconciliation/finality and live operating acceptance                                                                                 |
| R31 | Scoped idempotency and pending/completed/failed/uncertain external outcomes                                                    | lead          | provider contract                               | Scoped external states and persisted signing identity passed combined gate; actual original payout reconciled                                                                                                                                                                                      | Selected live provider external idempotency unverified                                                                                                         |
| R32 | Receipts, refunds, corrections and append-only auditable reversals                                                             | lead          | approved policy                                 | Append-only reports, consent, funded original-source correction and reversals passed PG/native browser and independent review                                                                                                                                                                      | Provider-specific error recovery execution and live operating acceptance                                                                                       |
| R33 | Authenticated webhooks, duplicate/out-of-order events and reconciliation                                                       | lead          | provider sandbox                                | Authenticated inbox duplicate/out-of-order/reconciliation passed combined gate; actual finalized chain receipts recorded                                                                                                                                                                           | Selected multichain provider sandbox unavailable                                                                                                               |
| R34 | Prevent duplicate payout, overspend, double reserve and premature release                                                      | lead/review   | transactional workflows                         | Account/book locks and one-use proofs passed combined concurrency gate and independent review; actual original payout finalized once                                                                                                                                                               | Live-provider outcome/retry acceptance separate                                                                                                                |
| R35 | Historical/sandbox/live and purchased/promo/fees/operating isolation                                                           | lead          | asset contracts                                 | Local real-PG history/rail/asset/backing separation and live-write denial passed. Physical simulation/testnet DBs separate; actual 45/0 catalogs/security comparison preserve zero live history/private browser-runtime roles before/after release                                                 | Isolation requirement satisfied for local/staging scope; no live-provider eligibility/backing approval                                                         |
| R36 | Clearly label deterministic/provider sandbox/live evidence; keep live disabled                                                 | all           | release gates                                   | Live routes absent; simulation UI labelled; separate testnet adapter; only deterministic web sandbox enabled on staging                                                                                                                                                                            | External live-release gates remain open                                                                                                                        |
| R37 | Redis multi-instance atomic IP/account/operation limits and privacy namespaces                                                 | Redis         | isolated Redis                                  | Actual local Redis ten-group trial passed with two HTTP workers and all three purposes, including wallet retry; each concurrent 20-request burst allowed two and throttled 18                                                                                                                      | Hosted multi-instance capacity acceptance                                                                                                                      |
| R38 | Redis timeout/retry/outage and logout/revocation availability                                                                  | Redis/auth    | isolated instances                              | Real isolated outage/OOM/restart and fail-closed/provider/local revocation checks passed; combined local and CI gates passed                                                                                                                                                                       | No hosted outage drill performed; do not infer hosted outage behavior from local tests                                                                         |
| R39 | Redis restart/eviction/memory/availability and latency/error/throttle metrics                                                  | Redis         | isolated Redis                                  | Isolated noeviction/restart/latency evidence; exact3096 hosted policy/Lua probe returned410 with one aggregate Redis success/latency sample.                                                                                                                                                       | Hosted raw INFO denied; no hosted outage or capacity claim                                                                                                     |
| R40 | Preserve narrowed four-account reset, retained/manual accounts and guarded tooling                                             | lead          | reset reports                                   | Encrypted application backup/exact private restore and both migrations rehearsed; guarded owner apply/security comparison passed. 45/0 read-only postflight preserves all four accounts/three retained and selected reset scope                                                                    | Satisfied current guarded preservation; no deletion of protected or unlisted accounts authorized; separately guarded acceptance-disposable cleanup remains R42 |
| R41 | Reject pre-reset credentials and delayed callbacks                                                                             | auth/lead     | original credentials or disposable reproduction | Disposable real-signed delayed-callback/password/wallet/cookie reproduction passed; allowed fallback explicitly identified                                                                                                                                                                         | Original hosted browser credentials unavailable; approved reproduction does not become original hosted replay                                                  |
| R42 | Clean only explicitly created automated acceptance identities                                                                  | lead          | exact identity ledger                           | Previous fixtures cleaned. New approved disposable human signup uniquely attributed privately; protected original four accounts remain. No new deletion executed.                                                                                                                                  | Complete acceptance, then separately guarded exact disposable cleanup preserving protected accounts/history.                                                   |
| R43 | Combined quality, coverage, database isolation and browser release gates                                                       | lead          | disposable databases/CI                         | Earlier858/859 gates retain exact source scope. Reset/replay249fresh/upgrade passes; corrected combined870/249-per-path/four-browser gate passed after documented failures.                                                                                                                        | Combined870 and all five exact819 CI checks passed. Current staging guest/containment and reviewed repair remain pending.                                      |
| R44 | Auth/financial/security/concurrency/provider failure acceptance coverage                                                       | lead/review   | workflows                                       | Combined application858/239/core-browser, SDK125 and exact3096 CI passed. Separate earlier native18/coin22/cookie7-14 retain scope. Operator859/240 and guarded existing simulation approval/receipt passed.                                                                                       | Remaining genuine/provider/all-five-route/device acceptance                                                                                                    |
| R45 | WCAG 2.2 AA checks, keyboard/focus/announcements/mobile/200% zoom                                                              | lead          | changed journeys                                | Core browser, SDK111, native18 and coin22 checks passed; automated WCAG tags, keyboard/cancellation focus, mobile reflow and CSS 200% zoom scoped to recorded fixtures                                                                                                                             | Full WCAG and physical assistive-technology acceptance unverified                                                                                              |
| R46 | Screen-reader and physical-device trials distinct from automation                                                              | lead          | human/device access                             | Automated checks recorded separately; screen-reader attempt explicitly incomplete and physical-device trial unverified                                                                                                                                                                             | Native screen-reader test blocked; physical device/human acceptance needed                                                                                     |
| R47 | Privacy-preserving signup/auth/resend/provider/recovery measurement                                                            | lead/auth     | journeys                                        | Bounded signup/auth/resend/recovery metrics and private log redaction passed combined tests and review                                                                                                                                                                                             | Genuine provider delivery/conversion measurements need hosted journeys                                                                                         |
| R48 | Runtime vs owner separation; no secret/private-data exposure                                                                   | lead/review   | deployment/privacy scan                         | Runtime/owner boundaries and current1121-text/five-secret/two-identifier scans passed. Originalprotected4 preserved; currenttotal5 includes attributed disposable. Later archives need final privacy review.                                                                                       | Complete current secret/artifact scan and safe publication; binary/history/device evidence remain distinct.                                                    |
| R49 | Focused commits, PR #42 update, screenshots, results/config/docs/status                                                        | lead          | integration                                     | Focused application3096 and operator e8 commits pushed. Latest matching screenshots, exact CI/LIVE/guest, genuine wallet/proof and simulation evidence are being reconciled for PR42 publication.                                                                                                  | Finish evidence publication and refresh PR description; overall external acceptance remains open                                                               |
| R50 | Independent security/financial and full-prompt completion audit                                                                | review/lead   | integrated revision                             | Earlier52-row audits retain dated scope. Independent92f/cf4249 reviews read exact source and actual249-per-path/870-gate evidence; final UI source and184/32 results separately reviewed.                                                                                                          | New combined/source/evidence/full52 audit required after final correction; no production completion claim.                                                     |
| R51 | Automatically provision one user-controlled EVM wallet after verified account creation; survive redirect/outage; no app signer | wallet/lead   | supported free-tier provider API, durable job   | Durable user-only provisioning and credential waits deployed; genuine22:38UTC ownership/no additional signer-policy PASS, founder reports wallet assignment. SDK125 and source-isolated tests retain scope.                                                                                        | Default recovery and remaining genuine provisioning/device scenarios; no signing/funding claim                                                                 |
| R52 | Remove new external-wallet linking while preserving retained wallet ownership/sign-in/security                                 | wallet/review | existing retained-credential guards             | New external linking and unknown-wallet signup disabled in Privy mode; retained methods passed real PostgreSQL and strict browser checks; final SDK111 confirms private state and single wallet status; corrected retained-wallet fixture passed four focused groups and four exact-tree CI groups | Genuine hosted/physical retained-wallet ceremony; exact release/guest denial passed                                                                            |

## Approved decisions (do not ask again)

The current task and [financial decision sheet](email-first-accounts.md#financial-decision-sheet)
approve internal YC, 100 YC/USDC, Canada subject to eligibility, crypto purchases
only, all five requested input networks, USDC external withdrawals, 2,500 YC
welcome and 500 YC Toronto-daily grants, permanent independent qualification,
spend-only principal, oldest grants before purchased coins and proportional
mixed-source results. Purchased funds have no profit condition. The promotional
budget is 50 USDC, unfunded/unallocated; user backing cannot fund it. **The founder
superseded the original daily cap: there is no daily withdrawal limit.** The minimum
is a 5 USDC gross debit. A 5 USDC request with a displayed 0.10 USDC network fee
deducts 5 and delivers 4.90; the fee is explicit before authorization. Manual review
remains required. No user transfers. **Completed purchases use USDC withdrawals
only; original-route unused-purchase refunds were superseded.** Failed/incorrect
deposits require reconciliation and auditable corrections. Uncertain reserves
release only after reconciliation proves no payment. Purchased balances and their
remaining profits never need grant qualification. Historical play money is never
redeemable. No paid plan/live financial
activity/additional retained-account deletion is approved.

The founder also approved restarting an interrupted/expired **first** Privy passkey
setup with server-verified login to the same Privy account and fresh possession
of that exact passkey, only when the account has never had financial funds or
another trusted security method. This uses a new one-use challenge and preserves
existing reset/SID/generation fences. Ten restart PostgreSQL groups passed on
each fresh and upgraded database; genuine hosted acceptance remains open.
If YapArena never received the original key details, the founder explicitly
approved verifying the account's single current added Privy key under those same
no-financial-history/no-accepted-strong-method limits. When the original key was
recorded, its exact credential ID and public key must still match. The uncaptured
case does not establish that a historical provider key was never replaced.

## Routine engineering decisions

- Extend this branch and existing draft rather than dropping existing changes.
- Use additive migrations, strict TS, exact integers and isolated local fixtures.
- Deterministic simulation must be visibly labelled and cannot establish provider
  sandbox acceptance. No live account receives fabricated funded balances; explicitly labelled
  valueless simulation credits remain isolated from live liabilities.
- Reuse agents in later review/browser waves; keep migrations/shared routing under
  lead ownership. Shared files require explicit coordination.
- Park automatic wallet work while account credentials await verification. A
  wait before creation does not consume a creation attempt, and parked work
  makes no recurring provider requests. Resume only for the same accepted
  account, provider identity and credential digest after a verified exchange,
  authenticated retry or completed provider-session reset. Preserve prior
  failure counts, immutable creation history and ownership-review fences.

## Approved accounting examples

These examples incorporate the founder's answers, including the later removal of
completed-purchase refunds and the daily withdrawal cap.

1. **Spending inside one grant:** spend its remaining principal first,
   then its earned profit, then the next-oldest grant, then purchased funds. With
   welcome principal 1,000 YC + profit 400 YC, a 1,200 YC stake uses 1,000 principal
   and 200 profit; the remaining 200 profit stays tied to that grant. A qualified
   daily grant remains qualified if it later loses money. Within the same grant,
   losses consume earlier profit first: a stake of 1,000 principal + 200 earlier
   profit returning 1,100 restores 1,000 principal and 100 profit. The full 100
   loss reduces current qualifying net profit; it does not erase past qualification.
2. **Mixed source:** 600 granted + 400 purchased YC earning 100 YC net
   credits 60 to that grant's profit and 40 to the purchased source. The purchased
   profit is immediately withdrawal-eligible; the grant's qualification rule
   applies only to its own profit. A 100 YC net loss leaves 360 purchased YC
   eligible, with no target. Fees count in net result on the same source weights.
   Two different grant lots split results proportionally too; earlier welcome
   profit never qualifies a later daily lot.
3. **Precision:** compute each proportional share in USDC atomic
   integers, allocating floors, then remaining atoms by largest fractional
   remainder with stable source-order ties. Three equal sources sharing 2 atoms
   receive 1,1,0; totals remain exact. Store inputs and allocation in receipts.
4. **Multiple grants:** welcome profit peak 2,500 YC qualifies welcome permanently;
   a newer daily with 100/500 YC profit stays unqualified. If welcome profit falls
   from 2,500 to 700, only its remaining 700 can be withdrawn, subject to backing;
   its principal never becomes withdrawable.
5. **Partial withdrawal:** with purchased 1,000 YC + qualified backed grant profit
   500 YC, a 600 YC gross withdrawal leaves 900 YC withdrawable. Use purchased
   principal, then purchased profit, then qualified promotional profit. Stake
   spending still follows grants first. A 5 USDC gross request with a 0.10 USDC
   fee deducts 500 YC and delivers 4.90 USDC. There is no daily withdrawal cap.
6. **Refund/reversal:** completed purchases use ordinary USDC withdrawals only.
   A never-executed stake releases
   its exact sources without qualification profit. A correction records a new
   linked reversal; if value has already left, freeze the affected financial
   account for review rather than invent negative available funds or silently
   debit unrelated purchases. Approved compensation uses funded operator reserves
   and restores only the original missing source, without creating grant
   qualification profit or cash from grant principal. Error reports have no
   arbitrary submission cutoff; ordinary trading losses remain final.
7. **Finite treasury:** reserve the maximum possible redeemable
   promotional profit _before accepting_ any redeemable promotional stake. Reject
   admission with a clear unavailable message when that independently funded
   treasury cannot cover it. Never promise profit first then impose a hidden cap.
   The 50 USDC may cover very little exposure; exact A4 maximums and purchased
   counterparty collateral require separate reserves. No budget is treated as
   funded. Already-earned backed profit is not capped after the fact.
8. **Grant timing:** welcome issuance occurs once at initial eligible account
   entry and an explicit Claim daily action, once per Toronto calendar day,
   including signup day. No automatic retroactive accumulation.

## Material decisions and external approvals still outstanding

- No remaining ambiguity in the approved grant/purchased qualification, fee debit,
  daily cap removal, completed-purchase refund removal or YES/NO sandbox scope.
- The approved all-strong-methods-lost boundary permits ordinary email access.
  Operations requiring retained strong proof cannot proceed without it; physical
  loss is not automatically detected or converted into an account-wide hold.
  No complete provider-approved manual identity-recovery service is claimed.
- Provider/custody/signing, input assets on each requested route, permitted USDC
  payout networks, fees/finality, legal/provider eligibility and retention.
- The two-business-day review target and error/correction rules below are approved.
  Provider-specific external recovery execution and live operational staffing are
  still unverified. Treasury admission policy is approved; the real budget remains unfunded.
  No unapproved proposal may reach production.

## Decisions received during this execution

These record the founder's clarifications and supersede earlier proposals.

| Decision                                 | Founder answer / consequence                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate security passkey                | Superseded: enroll only through Privy and use that same credential for login and fresh application operation proofs. Preserve previously enrolled independent keys as retained methods.                                                                                                                                                                                                                  |
| First key                                | Approved after email signup before funding. Existing trusted wallet/password approves enrollment; a revoked/lost previous key does not reopen first-key setup.                                                                                                                                                                                                                                           |
| Provider credential changes              | Superseded by [Decision 0008](decisions/0008-auth-simplification.md) step 9: no Privy call on the request path; asynchronous re-check at most every 15 minutes per active account; method changes become notices. No paid production webhooks approved.                                                                                                                                                  |
| Accounting examples 1,3,4,5,6,8          | Approved: principal-first stake selection within oldest grant; exact largest-remainder allocation; permanent independent qualification; purchased sources first for withdrawals; auditable corrections; explicit Toronto daily claims including signup day. The initially approved unused-purchase refund option was later superseded by USDC withdrawals only.                                          |
| Mixed sources                            | Clarified and approved: 600 grant / 400 purchased stake with 100 net profit allocates 60 grant / 40 purchased profit. Purchased-source remaining funds/profit have no grant target. A 100 loss leaves 540 / 360; no loss restoration.                                                                                                                                                                    |
| Loss within one grant                    | Founder selected **lose earlier profit first**. A stake of 1,000 principal + 200 earlier profit returning 1,100 restores 1,000 principal and 100 profit. Full net loss still reduces that lot's qualifying net profit; qualification never relocks.                                                                                                                                                      |
| Finite promotional backing               | Approved internal backing check before admitting new grant-funded exposure; pause new exposure if separate treasury cannot cover it. Previously earned backed profit remains eligible. The 50 USDC budget remains unfunded/unallocated.                                                                                                                                                                  |
| Instrument scope                         | Approved connect sandbox balances to existing YES/NO debate participation; separate future longer-lived idea trading stays gated pending its ownership/redemption rules.                                                                                                                                                                                                                                 |
| External testing                         | Approved free Base Sepolia test USDC / disposable test-only operator keys. No live custody decision or multichain acceptance inferred. NOWPayments remains an investigation candidate, not approved provider.                                                                                                                                                                                            |
| Eligibility                              | Founder confirms no existing written review/provider acceptance. Every live province remains disabled pending review.                                                                                                                                                                                                                                                                                    |
| Withdrawal amount and fee                | Founder chose receive 4.90 / deduct 5 for a 5 USDC request with an explicit 0.10 fee. Minimum applies to gross debit; fee is inside that debit and must leave a positive net amount. No daily withdrawal cap; Toronto calendar days apply to grants only.                                                                                                                                                |
| Completed purchase refunds               | Founder chose USDC withdrawals only after completed purchases. Earlier original-route unused-purchase refund exception is removed. Failed/incorrect deposits still require support, reconciliation and auditable correction.                                                                                                                                                                             |
| Purchased coin eligibility               | Founder reiterated qualification restrictions concern grants only. All unspent purchased-source principal and profit remain withdrawal-eligible; losses do not create a target or restore spent funds.                                                                                                                                                                                                   |
| Review target                            | Approved two Toronto business days, excluding Canadian federal holidays. Show network confirmation separately; delays keep reserves and never authorize another payout.                                                                                                                                                                                                                                  |
| Errors and disputes                      | Approved reports whenever submitted, transaction-evidence review and append-only corrections. Operator-caused shortfalls and costs use separate operator funds. Recovery costs require a disclosed quote and consent; ordinary trading losses remain final.                                                                                                                                              |
| Compensation source                      | Restore only the original balance source. No new withdrawable compensation category, grant-principal conversion or qualification profit.                                                                                                                                                                                                                                                                 |
| Qualification ordering                   | Approved round-closing time then stable UUID tie-break, regardless of result arrival order. Earlier losses must precede later gains for permanent qualification.                                                                                                                                                                                                                                         |
| All strong methods lost                  | Ordinary email access remains possible; withdrawals and other strong-proof operations cannot proceed without a retained credential. Email cannot reset those methods. Physical loss is not automatically detected or converted into an account-wide hold; a complete provider-approved recovery service remains pending.                                                                                 |
| Return after authentication              | Approved returning to the initiating page/action with context preserved for final confirmation. Signing in never automatically submits a stake, payment, wallet change or other initiating mutation.                                                                                                                                                                                                     |
| Lost sole email/Google with retained key | Approved for loss of the sole email or Google login: verify a new email through Privy and authorizing replacement with the retained YapArena security passkey. Preserve internal account/profile/balances; permanently retire the old provider identity. Reject already-bound replacement identities for review; never merge accounts automatically. This does not recover or mutate the old Privy user. |
| Sign out and speaking                    | Superseded 2026-10-22 (founder): Sign out ends only this device; sign out all/other sessions removed, Active sessions list kept. Assigned active speakers alone receive publishing access; logout/suspension disconnect speakers through a durable retry queue. Public watching remains available.                                                                                                       |

The current branch includes fetched `origin/main` (`fd60543`) without dropping
the existing PR. The earlier independently inspected hosted web revision was `d6e2d35`, first observed
live at 20:05:27.923 UTC on 2026-10-20; its five required CI checks passed. The
[Privy-only release](evidence/account-completion-baseline/privy-passkey-release/README.md)
records the two additional migrations, exact assets and hosted guest acceptance.
The earlier `9395242` release first went live at 17:10:25.767 UTC. The
[guarded release record](evidence/account-completion-baseline/staging-release.md)
links the actual backup, rehearsal, migration and deployment evidence. Actual free development-app
settings and public staging flags now enable optional Google and provider
passkeys; email remains enabled and automatic account merging and dashboard
automatic wallet creation remain off. The approved durable server job owns
wallet provisioning. This configuration evidence is separate from genuine hosted
journey acceptance.

The founder approved using the same email inbox in the earlier independent-key
replacement of a lost sole Google login. That new-DID protocol remains legacy
backend compatibility and requires Privy verification plus a retained independent
YapArena key. The current Privy-only key instead signs into its existing DID,
from which retained-proof settings can add email and remove Google. Neither path
merges accounts by matching email. The additional bounded application-to-Cloud
logout trial was also approved within the previously confirmed five included
participant-minutes. Its outcome must be recorded separately from this approval.

The [read-only staging preflight](evidence/account-completion-baseline/staging-database-preflight.json)
verified all three retained accounts plus the one genuine manual signup, absence
of the four selected reset accounts, zero live journals/grants, separate owner
and runtime authority, and no private-schema browser grants. It found 28 applied
and 13 pending migrations in the repeated read-only preflight on 2026-10-20.
After encrypted backup, matching isolated restore and migration rehearsal, all
13 were applied as the separate owner with both named writers suspended. The
[postflight](evidence/account-completion-baseline/staging-database-postflight.json)
confirms 41 applied/zero pending, the same four preserved accounts and zero live
financial history. No additional hosted identity deletion or financial balance
initialization occurred.

Implemented workflows include operation-bound security passkeys and retained
credentials, deliberate provider-method reconciliation, recovery boundaries,
per-request provider inspection, session/media revocation, exact source books,
funded sandbox issuance, grant qualification, YES/NO settlement, withdrawals,
external reconciliation and evidence-reviewed original-source corrections.
The [integrated local gate](evidence/account-completion-baseline/final-integrated-release-gate/README.md)
passed 739/739 with unchanged coverage thresholds, fresh/upgrade isolation and
core browsers. All five [required CI checks](evidence/account-completion-baseline/ci-release/README.md)
also passed for `9395242`. The later Privy-only gate passed 798 tests; all five
[corrective CI checks](evidence/account-completion-baseline/privy-passkey-ci/README.md)
and seven hosted guest groups passed for deployed `d6e2d35`. After the second
encrypted backup/rehearsal, only migrations 12000/13000 were applied, bringing
staging to 43 applied / zero pending with the same four accounts and zero live
history. The later Settings actor-race correction passed its 99-scenario SDK
acceptance and is included in the now-deployed `eba1dc5` release; the final 111
suite preserves that coverage within its recorded synthetic-provider scope.
The deployed guest checks remain
separate from genuine hosted identity and production acceptance.

The [Base Sepolia application-ledger trial](evidence/coin-testnet/ledger/README.md)
verified actual finalized 6 test-USDC funding and 5 test-USDC payout, persisted
signing identity before broadcast, exactly-once ledger settlement and final
external reconciliation. This uses valueless test assets and does not establish
live custody, conversion or five-network provider acceptance. The separate
[LiveKit Cloud trial](evidence/account-completion-baseline/media-cloud-revocation/README.md)
verified disconnect and rejection of original/refreshed speaking tokens while
watch-only access remained. Its original cleanup deadline failure and successful
bounded postflight are retained separately.

## Provider facts and production assumptions

Current official sources and actual configuration observations are recorded in the
[provider review](email-first-provider-review.md) and the new
[capability follow-up](evidence/account-completion-baseline/embedded-wallet-release/provider-capability-followup.md).
Custom OTP sender/template service and production webhooks are verified
Enterprise capabilities and remain unused. Basic application name/logo settings
are described separately without a stated plan restriction; this does not prove
a custom From-domain or selected sender configuration. Free MAU/signature
allowances do not establish a numeric production user-GET request quota.
The selected production app/domain/DNS, own Google OAuth configuration and
provider HttpOnly-cookie setup remain unestablished; YapArena's application
cookie is a separate mechanism. Dated trials retain their recorded revisions.
Actual activity eligibility, custody, network assets and provider-sandbox access
still require approval before reliance. A listed chain or auth feature does not
establish business approval or financial-route support.

## Evidence and completion rule

Every new report must identify tested source revision, environment, command,
outcome and limitations. Distinguish implemented, locally tested, hosted-tested,
provider-sandbox tested, physical-device tested, external-input pending and
disabled awaiting live release. This task remains **incomplete** until every
in-scope acceptance requirement passes or a verified external dependency is
handed off explicitly after all independent work is exhausted.

Post-release publication: reviewed archive commit `1bec9898712955043c9298025b639051b2b1ed9e` is pushed in [PR #42](https://github.com/Boufe/YapArena/pull/42); its description was refreshed on 2026-10-21 at 22:24:50 UTC. This subsequent factual publication note changes no runtime source. The documentation-head checks for that publication remain separate; its deployed-source CI39678375965 and staging eba1dc5 retain their historical scope. The latest 3096ca7 release is recorded at the top of this document. The overall task remains incomplete at the recorded genuine/provider/device/operational/financial gates.
