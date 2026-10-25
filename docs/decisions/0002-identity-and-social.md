# Decision 0002 — Identity, profiles, and social graph

Status: implemented for the nonfinancial preview, 2026-09-29.

## Account and authorization model

- A server account owns at most one profile. A profile has one stable handle. A wallet is an
  authentication credential, not an account or a claim that one wallet equals one person.
- EVM wallet sign-in uses a five-minute, one-use Sign-In with Ethereum challenge tied to the
  configured application origin and chain. Signing the message creates a server session; it
  never authorizes a transaction. Wallet connection alone does not sign in. An existing email
  account can link a wallet after signing in; a wallet already linked to another account cannot
  be moved or used to merge profiles automatically.
- Each wallet link or unlink requires a fresh current-password proof or a purpose-specific
  signature from an existing linked wallet that will remain available. A five-minute, one-use
  operation binds this approval to the current account/session and exact target address/chain.
  Linking also requires separate proof of the proposed wallet. Session rotation, audit and an
  in-app notification commit with the mutation. See the
  [credential-change authorization design](../security/wallet-authorization.md). Changing or losing a
  wallet does not move a profile, follow history, or future debate rights. A wallet-only account
  cannot unlink its final sign-in method. There is no automatic recovery for a lost sole wallet;
  a future recovery method needs a separate security design.
- Externally owned accounts can sign in on any valid EVM chain ID. Contract wallet signatures
  require an operator-configured RPC endpoint for their chain. An unconfigured or unavailable
  endpoint fails closed. A wallet address on a different chain is a distinct credential.
- Anonymous browsing remains available. The `participant` role permits profile and follow
  writes. `moderator`, `operator`, and `sponsor` are separate roles and confer no unpublished
  discovery access by themselves. Roles are stored and audited; this package provides no public
  role-grant endpoint. Each future challenge or moderation action must check its own role and
  ownership rules before it ships.

## Account session revocation

Opaque server-side sessions retain independent sign-ins and single-device logout. Owners can
sign out every session, including this device, or sign out other sessions while retaining this
device and its original expiry. Credential removal or replacement atomically advances one
account authentication generation and revokes every preexisting session. A fresh sign-in
through a retained credential is still allowed. F02 may issue a successor only after fresh
retained-credential proof, with its cookie published after the mutation commits.

Current state — 2026-10-22: single-device logout is restored. A later decision had made
normal Sign out end every session; by founder decision on 2026-10-22, Sign out ends only this
device, and the sign-out-every-session and sign-out-other-sessions options were removed. On
2026-10-24 the founder removed the account page's Active sessions list; the session API remains.
See
[Decision 0008](0008-auth-simplification.md) point 4 and the
[revocation contract](../security/account-session-revocation.md#owner-controls-and-semantics).

The [revocation operating contract](../security/account-session-revocation.md) documents
transaction locking, stale authentication rejection, audit, owner controls, operator password
updates, rollout and rollback. Revoking application sessions does not terminate existing
LiveKit connections or external bearer grants. Password recovery and account suspension
remain separate capabilities; no new recovery endpoint is implied.

## Profile and participation data

A signed-in account without a profile must first choose a username and a permanent handle in a
pop-up shown on every page (founder, 2026-10-24). Every profile is public: the pop-up publishes
it and the account page offers no private option. A profile created through the API without a
visibility choice still starts as a private draft, and the account page offers to publish it. Handles cannot be edited once created, so
shared links remain stable. Moderation can mark a profile hidden;
the owner cannot republish it. Follows target only published people or topics. The account page
shows the account's follows and a 90-day identity activity view. Audit entries include session,
profile, follow, role, and wallet-link changes; they do not store a wallet signature or session
token. A wallet address can be public on a blockchain, and linking it to a profile may expose
an association to anyone who knows both; the product should explain that before financial
participation is designed.

## Retention, export, and deletion policy for this preview

- Keep account, profile, linked-wallet, and follow records until an account deletion request is
  fulfilled. Expired SIWE challenges and wallet operations are purged after one day; identity audit entries are purged
  after 90 days by scheduled cleanup. A session expires after the configured duration (seven
  days by default) and expired sessions are purged by the existing cleanup task. Backups follow
  the deployment’s approved retention and restore policy; the repository does not set provider
  backup expiry or establish a restore objective.
- A user's current nonfinancial account data comprises their account identifier and email if
  present, profile, wallet addresses and chain IDs, follows, and the remaining audit activity.
  The authenticated account APIs expose those records in pages. `GET /api/me/export`
  (Privacy & data on the account page) downloads the account's profile, sign-in methods, follows,
  notifications and retained activity as one JSON file. Chat messages, reports, debate
  participation and Yap Coins records are not in it yet; an operator fulfils a request for them
  using a reviewed, owner-scoped database query and a secure delivery channel.
- Self-service account deletion is **not yet implemented**. An operator must verify account
  control, check for any applicable legal hold or future financial record obligation, then remove
  the account and associated profile, wallets, follows, sessions, and challenges. The audit table
  has no account foreign key so the operator must delete that user's audit rows explicitly.
  If the account has debate participation, the operator must first resolve any active event and
  review the event-history retention obligation; participation rows deliberately restrict a
  silent user deletion.
  Deletion from backups follows backup expiry. No request channel or service-level target is
  advertised in the preview until an operator support process exists.
- The manual export/deletion policy above is not a complete executable support tool. Later
  community receipts, moderation holds and replay cleanup tombstones require dependency and
  retention review before an operator removes an account. No tested whole-account deletion
  workflow or support request channel is supplied.
- These preview rules need privacy and legal review before a paid launch. Future financial
  records, eligibility checks, and regulatory retention may require different treatment; this
  decision does not authorize their collection or deletion.

## Verification and limits

The route tests check ownership, role restrictions, malformed input, one-use challenges, session
binding, and wallet conflicts. A PostgreSQL integration check exercises migration-backed profile,
follow, audit, and wallet-link behavior. EOA signatures are tested with an actual signer. Contract
wallet verification still needs a representative live RPC test before those wallets are promised
in a deployed environment. [F02](../security/f02-integration-handoff.md) and
[F03](../security/f03-integration-handoff.md) record local browser and real PostgreSQL race checks.
Physical-device/assistive-technology, real wallet extension and representative-load acceptance
remain release tasks.
