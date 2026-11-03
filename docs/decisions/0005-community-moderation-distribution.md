# Decision 0005 — Community, moderation, and distribution

Status: development policy for Work Package 5. Product and privacy review remain required before
production rollout. No financial or sponsor behavior is authorized by this decision.

## Boundaries and roles

- A signed-in `participant` may post event chat, like an event once, report public chat or an
  event, and appeal an action affecting their own chat or account. Guests may read visible chat
  and share published event links. Profiles are not required to read, like, or report, but a
  published profile is required to post chat so public authors have an accountable identity.
- A `moderator` may read the private case queue and evidence, dismiss a report, remove a chat
  message, restrict the subject account's community writes for seven days, or pause an event's
  chat. Moderator actions require a reason code and an explanatory note. An appeal must be
  decided by a different moderator. A moderator cannot moderate their own content or case.
- An `operator` controls the debate media lifecycle under decision 0004. Moderator actions
  change only community records. They cannot start, end, void, finalize, or decide a debate,
  publish a winner, or change any future market settlement input.

Roles are assigned through the existing reviewed account-role procedure; there is no public
role-grant endpoint. All permissions are checked by the API for each request. UI visibility is
only a convenience. The case queue contains private reports and is never in public APIs.

## Content, reasons, and transitions

Chat is available only for published, non-demo events while `live`; after the debate it is
read-only. Moderators can pause chat for an event without pausing its video or clock. Chat text
is plain text, 1–500 characters, with no links rendered as HTML. A post is `visible` or
`removed`. Removal hides it from public reads immediately but preserves its original text and
author in the private case evidence until retention expires. A restored post returns to
`visible`; no user edit or self-delete flow is provided in this package.

Reports target a chat message or event. The reporter chooses one of `harassment`, `hate`,
`threat`, `spam`, `privacy`, or `other`, and adds 10–500 characters of context. One account can
report the same target once. Cases start `open` and end `dismissed` or `actioned`. The moderator
records one of the same reason codes and an action-specific note of 10–500 characters.
`remove_chat` applies to chat reports; `restrict_account` applies to a chat author;
`pause_chat` applies to event reports. `dismiss` changes no public state. An actioned case
cannot be acted on again.

The affected chat author or restricted account can appeal once within 30 days of action.
Appeals start `open` and end `upheld` or `overturned`. An overturn restores only the content or
restriction applied by that case, so it cannot undo a later independent action. The appeal
reviewer must be a different moderator from the initial reviewer and cannot be the appellant.
Event chat pauses are operational and may be resumed by a moderator with a case note; they do
not create an individual appeal right. Case and appeal decisions append immutable audit events.

## Immediate chat feedback and submission identity — 2026-10-06

Historical checkpoint: the polling-only and key-expiry behavior in this section was superseded
by [decision 0006](0006-durable-community-delivery.md) and additive receipt migration
`1791345540042_preserve-chat-idempotency.js`. Current keys remain bound for the room/account
lifetime after body purge; retries return canonical tombstones and conflicting text remains 409.
See [the current receipt/rollout contract](../community-operations.md#chat-submission-migration-and-rollout).
The original October 6 behavior below is preserved as decision history.

A new logical submission uses a random UUID v4 `clientMessageId`. The backend binds that key to
trimmed plain text for the authenticated account and event. A partial unique index and the existing
transaction/account lock serialize identical and competing requests. Accepted retries return the
original message ID and acceptance time before new-write role, profile, restriction, live/pause,
and posting-limit checks; they never write or charge another allowance. Authentication, ownership
and current published event/topic access still apply. A different payload returns HTTP 409
`CHAT_PAYLOAD_CONFLICT`. A removed acceptance returns `state: removed` and `body: null`; acknowledging
it cannot restore it. Restoration remains an independent moderator appeal decision.

The public message shape is `id`, `debateId`, `authorName`, `body`, `state`, `createdAt`, `revision`,
and `clientMessageId`. IDs and moderation revisions remain decimal strings. `createdAt` records
acceptance, not a retry. History and polling normally return `clientMessageId: null`; authenticated
reads with `own=1` expose it only on the requester's messages. No private author account ID is
returned. Pending rows reconcile by this owner-only correlation or an already bound server ID,
never text, time or author name. Polling remains the transport. POST acknowledgment never advances
the read cursor. A state-change trigger increments `revision`, including changes made by older
server code. Lower revisions cannot reverse a removal; restoration requires a newer revision.
Polling returns visible `watched` rows and separate redacted `removed` tombstones, so already-open
legacy clients continue hiding messages absent from `watched`.

Keys stay with their message throughout its existing 365-day retention period, extended by the
existing open-case/appeal holds. They expire only when that message is purged; no additional body,
receipt or hash archive is retained. After purge a reused key is a new write subject to all checks
and allowances. Idempotency is therefore guaranteed while the stored acceptance remains, not
forever. Legacy requests without a key remain accepted during transition but have no deduplication
guarantee. Invalid supplied keys, including null, are rejected; new clients always supply a key.

The browser captures an immutable submission and clears its captured composer value synchronously.
Later typing stays independent. Sending, confirmed, delivery-unconfirmed, rejected and cooldown
states have row-level feedback. Network failure, timeout, invalid acknowledgments, HTTP 408 and 5xx
mean uncertain delivery. Explicit unchanged retries reuse the key; recovering text appends to an
existing draft and requires an explicit send. An unchanged recovered draft reuses its original key;
editing or appending to other text creates a new submission and key. Recovery does not automatically send
on reconnect. Recoverable submissions live in page memory; reload/navigation recovery is outside
this change. Confirmed records can be discarded with bounded feed retention once their transport
settles. Chat text and drafts never enter product analytics or application request logs.

The changed chat interface targets WCAG 2.2 AA. Status regions announce connection changes and
brief outcomes, rather than reading the entire feed. Countdown ticks are not live announcements.
Keyboard sending respects Shift+Enter and IME composition; asynchronous responses do not move
focus to the composer. Automated accessibility and viewport checks supplement physical-device,
assistive-technology and staging review; they cannot close those release gates.

## Restriction scope, content visibility and names — 2026-11-02

Security audit findings YA-07 and YA-22 widen this decision; the rest stands.

- An active restriction now also refuses, with HTTP 403 and code `account_restricted`: creating
  a profile; changing a username, bio, avatar or publication state, except making the profile
  private; following; creating or publishing a topic; opening, accepting or proposing times for
  a challenge; joining an open request; entering the live queue or accepting a queue match; and
  marking ready for a debate. Unliking, unfollowing, leaving the queue, declining and
  withdrawing stay open. No new debate seats a restricted account, even when the other player
  accepts; a queue match is cancelled and the other player requeued.
- Moderators hide a topic, profile or debate from public pages, and restore it, at
  `/moderation`. Hiding needs a reason code; both need a 10–500 character note. Restoring returns
  the state the latest hide replaced (an item hidden outside the app returns to draft if it is a
  profile and to published otherwise). Each change is a content action with an audit event in
  the community audit trail, and its owners receive an account notification. A topic's creator
  and everyone who debated on it, a profile's owner, and a debate's speakers cannot decide it.
  Hiding changes publication only; it does not end, void or settle a debate.
- Handles and usernames that name staff or the service (`admin`, `moderator`, `support`,
  `yaparena` and similar) are refused when written, as are control and invisible formatting
  characters in names, bios, topics, propositions and chat (line breaks stay in bios and chat;
  emoji joiners stay). Rows saved earlier are unchanged until edited. Chat still shows the
  username without the handle, as [Decision 0014](0014-user-avatars.md) records.

## Abuse, retention, and release

[Decision 0006](0006-durable-community-delivery.md) adds a gated durable public SSE transport with
bounded HTTP degraded recovery. It preserves this decision's submission identity, moderation,
access and evidence policies. Stream cursors are independent of message-history pagination.

Server-side account locks serialize community writes, including concurrent requests. Chat is
limited to one post per 10 seconds and 30 per hour per account. Reports are limited to five per
24 hours. Likes use idempotent add/remove operations, a unique account/event key, and at most
ten actual like-state changes per hour per account; repeat requests that change no state do not
consume the allowance. A
restricted account cannot post, like, or report until the restriction expires or is overturned.
Global API and origin protections also apply; they do not replace account limits.

Visible chat, likes, resolved cases, appeals, and their audit events are retained for 365 days.
Content visibility actions and their audit events are too, except the latest hide of an item
that is still hidden, which restoring needs.
Open cases and appeals are held until resolved; the hourly cleanup then purges eligible older
records. Operators must export a redacted case summary before expiry if a longer legal hold is
approved. Do not put private case text, signed replay URLs, or account identifiers in public
share metadata or overlays.

Event links, QR codes, Open Graph metadata, and overlays use only the published proposition,
topic, speaker display names, schedule, and event status. They expose no chat count, likes,
reports, score, hidden tally, winner, sponsor, or financial field. Visible engagement is not
official event support. QR generation is server-side from the canonical event URL only, never
from a caller-supplied URL.

Before production use, finish the measured desktop/mobile trial in the media report, test
moderation operations with real browsers, review privacy retention with counsel, and verify the
changed chat interface against its WCAG 2.2 AA target. Staging may use test accounts and non-sensitive test content while these
gates remain open.
