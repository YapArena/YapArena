# Decision 0003 — Topics, matching, and event lifecycle

Status: implemented for the nonfinancial preview, 2026-09-29. Policies below are preview
defaults requiring product and operating review before a paid launch.

The confirmed but unimplemented [live matchmaking decision](0011-live-matchmaking-and-challenges.md)
will replace the open queue, the one-hour minimum and the one-active-event rule below.

The later [media prototype decision](0004-live-debate-replay.md) adds recording and readiness
gates to live and replay transitions. The `preview-1` timing gaps below remain true for events
created under that historical rule snapshot.

The subsequent [replay automation decision](../replay-automation.md) replaces the prototype's
per-recording operator publication gate with verified automatic ended-to-replay publication
when enabled. It does not change financial participation closure or publish outcomes.

## Topic and event identity

A participant may create a topic as a private draft, define the two side labels, and publish it.
The topic slug and side mapping are immutable after creation. Public discovery shows only
published topics. The creator cannot edit a published topic through this package; a future
moderation and correction process must preserve topic history and any later market rights.

Every debate has one proposition, exactly two different participant accounts and public
profiles, opposite sides A and B, one start time in UTC, and a snapshot of the enabled
platform-wide rules version. A participant cannot negotiate per-event economic rules.
`preview-1` explicitly has no financial terms or paid cutoff. It records the two-speaker
format while speaking time, extensions, and maximum duration await the media package's
approved rules. A future rule version applies only to newly formed events.

## Request and matching policy

- Direct challenges name a published target profile. Open queue requests can be joined by a
  different participant who accepts the listed proposition, opposite side, and start time.
  A user with no published non-demo profile cannot issue or accept requests. The queue is a
  self-service matching pool; automatic ranking and opponent recommendations are not present.
- Start time must be 1 hour to 90 days in the future. A request expires after 24 hours or
  30 minutes before its proposed start, whichever comes first. An expired request cannot be
  accepted. A user can have one outgoing open request. An incoming challenge does not reserve
  the target's event slot until acceptance.
- Acceptance creates a debate and both participant reservations in one database transaction.
  Per-user transaction locks and a unique active-participant constraint prevent concurrent
  acceptances from assigning a person to two active events. Other open requests involving
  either speaker close as `conflicted` and notify affected accounts. Retries against accepted,
  declined, withdrawn, expired, or conflicted requests return a conflict.
- The initiator can withdraw an open request. A direct target can decline it. These actions,
  expiration, conflicts, acceptance, and event changes are recorded in durable history and
  surfaced through account notifications. Notification delivery is in-app only; email and push
  delivery are future work.

## Event states and authority

The request is the pre-event `challenged` or `queued` stage. Accepting it and scheduling the
event occur atomically, so the event's first persisted status is `scheduled`. Database status
values also reserve `draft` and `accepted` for future workflows, but this package does not
create events in those states.

| Transition                            | Authority and condition                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled` → `ready`                 | Each of the two speakers confirms readiness; the second confirmation changes status.                                                       |
| `ready` → `live`                      | Operator action with a recorded reason at any time after both speakers are ready. One server timestamp records live start.                 |
| `live` → `ended`                      | Operator action with a recorded reason. One server timestamp records live end and releases active speaker reservations.                    |
| `ended` → `replay`                    | Operator action with a recorded reason. The media package must supply and verify a recording before using this status operationally.       |
| `scheduled`/`ready` → `scheduled`     | Operator reschedule with a reason and a new start at least one hour ahead; prior readiness is cleared.                                     |
| `scheduled`/`ready` → `cancelled`     | Operator cancellation with a reason, or a documented no-show after start plus 15 minutes while at least one speaker is not ready.          |
| Active or ended event → `void_review` | Operator opens a review with a reason. A live event receives a server end time and its speaker reservations are released.                  |
| `void_review` → `cancelled`           | Operator resolves the nonfinancial schedule by cancellation. Financial void, refunds, and appeal outcomes require separate approved rules. |

`finalized` is retained for a future approved publication and settlement workflow. Neither
this package nor a replay state publishes a winner, creates a market, computes a paid cutoff,
or settles funds. The live end time is distinct from all future financial deadlines. A
cancelled event does not imply a financial refund policy. The API does not expose an action
to finalize an event.

## Boundaries and release checks

The public page uses only published topic, profile, and event data and displays the status and
rules version. It never discloses a tally or winner. Operator transitions require the operator
role and a reason; participant readiness is owner-scoped. Event history and incident reasons
are visible through the account API only to speakers and operators. Event and request history is
append-only through the application. The topic and matching APIs return bounded lists.

Unit and HTTP tests cover field validation, roles, ownership, malformed IDs, transition
gates, and failure responses. A PostgreSQL integration check exercises two concurrent
acceptances for the same target, direct and queue side mapping, rescheduling, no-show,
readiness, timestamps, notifications, and the ability to match again after an event ends.
Browser accessibility, notification usability, representative-load measurements, and an
operator incident drill remain release checks. The later [media decision](0004-live-debate-replay.md)
and [replay automation](../replay-automation.md) now define the recording/readiness gates;
[hosted trials](../replay-starter-trial-2026-10-07.md) verify selected real media paths without
closing physical-device or production-capacity acceptance.
