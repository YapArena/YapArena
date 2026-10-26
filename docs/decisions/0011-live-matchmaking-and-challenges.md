# Decision 0011 — Live matchmaking queue and direct challenges

Status: product choices confirmed by the founder, 2026-10-25. Design only; nothing here is
implemented. Once implemented, this replaces the open queue, the one-hour minimum and the
one-active-event rule of [Decision 0003](0003-topics-matching-events.md). References were
verified against `origin/main` at `7b407c8`.

## Why

Today a debater posts a request with their own statement, a side and a start time at least one
hour away (`src/features/matching/router.ts:98-103`). Others must open `/match`, find the post
in a list of up to 50 (`repository.ts:446`) and click Join. Nobody is alerted: notifications are
only fetched when a page loads. Going live needs an operator with a typed reason
(`src/features/media/router.ts:275-289`), and no-shows are operator-only after 15 minutes
(`repository.ts:725-731`). The [PRD](../product-prd.md) already makes matchmaking and direct
challenges P0 (D12).

## Founder decisions (2026-10-25)

1. **Queue:** a user picks any published topic, chooses For or Against, and is paired with a user
   who chose the opposite side. The queue is live only; it never schedules.
2. **Accept:** both users accept within 30 seconds, then enter the room and the debate starts.
3. **Challenges:** a user challenges a specific person by handle or name, either now or at a time
   both agree on. An unanswered challenge stays pending; the target can accept later or agree a
   different time. Scheduling exists only for direct challenges.
4. **The browse-and-join list is removed.**
5. **Recording stays mandatory** for every debate.
6. **Bookings block only overlapping times** (see [seats](#seats-and-time-reservations)).
7. **Several pending challenges** per user are allowed.
8. **Scale:** about 100 people online at launch; the design must reach 1,000. Paid Render,
   Supabase and LiveKit plans are acceptable.
9. **Later:** a cooldown for declining or ignoring matches.

## The claim being debated

A topic is a claim, for example "Canada should expand nuclear power", with two sides, For and
Against. Strangers paired automatically cannot agree on a claim in 30 seconds, so a queue debate's
proposition is the topic title. New topics are created as a claim with For/Against sides; existing
topics keep their side labels because side mapping is immutable (Decision 0003). A direct
challenge may add a narrower statement within the topic, which the target reads before accepting.

## Queue flow

1. **Enter.** Requires a published profile, a camera and microphone check in the last 30 minutes
   (no longer tied to one debate), no active ticket and no booking that the queue reservation
   would overlap. The ticket keeps its original queue time as its priority.
2. **Pair.** In the same transaction, take the oldest searching ticket on the same topic and the
   opposite side with `FOR UPDATE SKIP LOCKED`. When found, create an offer with a server-enforced
   30-second deadline. A 1-second sweep retries pairing for tickets that missed.
3. **Accept.** Both accept → `completeMatch` (`repository.ts:154`) creates the debate starting now.
   Decline or timeout → whoever accepted returns to the queue with their original priority; the
   other ticket ends. No cooldown yet.
4. **Room.** Both are sent to `/debates/<slug>`. They have 90 seconds to join. The server starts
   the debate when both are ready and connected; operator controls remain as an override.
5. **No-show.** When the join window closes, the debate is cancelled automatically, both seats are
   released and the user who joined is requeued at the front.
6. **Presence.** A ticket stays alive only while the user's live connection is open, with a short
   grace period for reconnects. Closing the tab removes the user from the queue.

The `/match` page and topic pages show how many people wait on each side ("1 waiting on
Against"), with one-click "Queue on this side". Counts only; never who is waiting.

## Challenge flow

1. The challenger picks the person, the topic and their side, then **Now** or **1–3 proposed
   times**. Search covers handle and display name.
2. **Now, target online:** the target gets a popup with 2 minutes to accept, then the queue's
   room flow. Not answered, or target offline → the challenge becomes pending.
3. **Pending:** the target accepts a proposed time, proposes other times or declines. Either side
   can counter until one accepts the other's time. Times show in each viewer's time zone. Pending
   challenges expire after 7 days. Accepting creates a scheduled debate.
4. **At the booked time:** both get an in-app reminder and a 10-minute join window, then the same
   automatic start and no-show handling. Off-site reminders need a new channel (below).
5. **Later:** saved weekly availability so the form suggests times that suit both.

## Seats and time reservations

Today a user holds one seat from acceptance until the debate ends
(`event_participants_one_active`, `migrations/1785922000000_add_matching_lifecycle.js:167`),
so a Friday booking blocks every other match until Friday. The seat becomes a time reservation:

- A scheduled debate reserves from 5 minutes before its start to its latest possible end (start +
  join window + the rule version's maximum duration).
- A queue or Now match reserves from now to now + join window + maximum duration.
- Reservations for one user must not overlap. With the current 10-minute test rules, entering the
  queue is therefore blocked in about the 17 minutes before a booking, and a queued user is removed
  with "Your scheduled debate starts soon."

The overlap check runs under the existing per-user advisory lock (`lockUsers`,
`repository.ts:67-75`), which every seat-taking path must take. No migration creates Postgres
extensions today, so an exclusion constraint (`btree_gist`) is not proposed. The one open
outgoing request limit (`match_requests_one_open_outgoing`, same migration, line 121) becomes a
cap of 10 in code.

## Data and server changes

- **New tables:** `matchmaking_tickets` (user, topic, side, status, priority time) with one active
  ticket per user; `match_offers` (two tickets, deadline, each acceptance, result, debate);
  `challenge_time_proposals` (challenge, proposer, start, status).
- **Changed:** `match_requests` gets a now/scheduled mode and a nullable agreed time;
  `event_participants` gets reservation start and end; device checks gain a user-level form.
  All through new migrations.
- **Retired:** new `kind = 'queue'` requests and the `/api/matching/queue` routes. Open legacy posts
  expire at cutover with a notification.
- **Automatic start:** triggered from the ready route, the LiveKit participant-joined webhook and
  the sweep. It begins recording, starts the clock and records a system actor in `event_history`.
  A recording failure is retried within the join window; then the debate is cancelled and both
  users are requeued.
- **Capacity gate:** an offer is made only while starting and live debates are below a configured
  limit at or under the LiveKit plan's concurrent recordings. Otherwise tickets wait.
- **Sweep:** one 1-second job in the jobs worker under `runExclusiveDatabaseJob`: offer deadlines,
  stale tickets, pairing retries, join-window no-shows, automatic-start backup, Now-to-pending
  conversion and reminders. The hourly request expiry (`src/platform/runtime.ts:164`) is too slow
  for these.

## Live delivery to the browser

An authenticated per-user stream (for example `GET /api/me/stream`) opens on every page for
signed-in users. It carries queue state, offers, challenge changes and "debate starting" events.
It reuses `src/platform/sse.ts` and the LISTEN pattern with a new channel carrying only a user id,
separate from the public room stream, which must not carry personal state
([Decision 0006](0006-durable-community-delivery.md)). The web process records which users are
connected, which gives queue presence and the "online" test for Now challenges. Polling a small
state endpoint is the fallback when the stream fails.

The stream is chosen over polling because Chrome limits timers in tabs hidden for 5 minutes to
once a minute, which would miss a 30-second window. The popup plays a sound, flashes the tab title
and, with permission, shows a system notification. A mobile browser that has left the page cannot
be reached; Web Push through `frontend/sw.ts` (also for installed iOS home-screen apps) and email
reminders are a separate later decision. Nothing in the repository sends either today.

## Capacity and cost

Estimates assume about a third of online users are debating. LiveKit figures are from
[its pricing page](https://livekit.com/pricing) on 2026-10-25.

| Item            | ~100 online                                     | ~1,000 online                                     |
| --------------- | ----------------------------------------------- | ------------------------------------------------- |
| Debates at once | ~15                                             | ~150                                              |
| Render web      | One always-on paid instance                     | Two or more, after a shared rate limiter          |
| Supabase        | Paid plan with restore-tested backups           | Larger compute                                    |
| LiveKit         | Ship, $50/mo: 100 recordings, 1,000 connections | Scale, $500/mo: 500 recordings, 5,000 connections |
| Replay encoder  | Several or larger instances                     | Many more, or a different packaging approach      |

LiveKit Build includes 60 recording minutes a month, about six 10-minute debates, so Ship is
required from launch. Ship includes 600 minutes, then $0.02 per minute: about $0.20 per 10-minute
debate. In short staging tests the encoder took about 1.5× a recording's length on 0.5 CPU, one
at a time ([trial](../replay-starter-trial-2026-10-07.md)), so one instance packages about four
10-minute debates an hour. Replays remain watchable as signed MP4 while packaging catches up. The
Free Render web sleeps after 15 idle minutes ([staging](../render-staging.md)) and cannot host a
live queue. The matchmaking logic itself is light for Postgres at both sizes.

## Risk: empty queues

Many user-created topics with two sides each split a small audience. Mitigations in order:
waiting counts per side, a list of topics with someone waiting, then queueing on several topics
at once, an "either side" option, and offering to turn a long wait into a challenge.

## Delivery phases

1. **Queue loop:** tickets, offers and the 30-second accept; per-user stream with polling
   fallback; user-level device check; time reservations; automatic start, join window, no-show
   and requeue; capacity gate; waiting counts; removal of the browse-and-join list.
2. **Challenges:** Now and pending modes, time proposals, several pending, search by name,
   scheduled automatic start and no-show, in-app reminders.
3. **Later:** off-site reminders, availability suggestions, multi-topic queue, either side,
   cooldowns and skill-based pairing.

Before a public launch the owner moves Render web to an always-on paid plan, LiveKit to Ship,
Supabase to a paid plan, and sizes encoder capacity.

## Interfaces with the live outline and betting work

Built in parallel with the live argument outline and turn-aligned trading windows (Decision 0012)
and the YAP coin betting interface. Matchmaking owns these contracts:

- **One start function** in `src/features/media/` serves operator and automatic start. The outline
  work's transcriber dispatch is a single call inside it.
- **Debater settings before queueing.** Language and transcription/public-outline consent are an
  account-level setting owned by the outline work. Queue entry and challenge acceptance check it,
  because a 30-second accept leaves no time for forms.
- **Lifecycle.** Automatic start records a system actor; automatic no-show cancels the debate. The
  transcriber stops on end or cancellation, and open coin rounds on a cancelled or `void_review`
  debate are voided automatically by the round owner.
- **Capacity.** `LIVE_DEBATE_CAPACITY` stays at or below both LiveKit's concurrent recordings and
  its transcriber agent sessions.
- **Format.** Turn length drives trading windows and reservation length, so a new rule version is
  agreed across the three works first.

## Verification

PostgreSQL concurrency tests: simultaneous opposite-side entries create exactly one offer; the
oldest ticket is paired first; accept, decline and timeout races; requeue priority; overlapping
reservations; the capacity gate. HTTP tests for roles, ownership and deadlines. A browser journey
with two accounts from queue to automatic start. A hosted LiveKit trial for concurrent recordings.

## Proposed values awaiting confirmation

Now-challenge window 2 minutes; queue join window 90 seconds; scheduled join window 10 minutes;
pending expiry 7 days; 10 outgoing pending challenges; reservation lead 5 minutes. The debate
format (currently 60-second turns and a 10-minute maximum) sets reservation length and recording
cost.
