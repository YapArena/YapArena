# Staging rollout (Decisions 0011 to 0013)

Prepared on 2026-10-26 and not run yet. This runbook takes staging from the last deployed release
to current `main`: the migrations from #90 to #107, Yap Coins turn windows and their round rules
([Decision 0012](decisions/0012-live-argument-outline.md)), the transcriber agent, captions and the
AI outline, and matchmaking ([Decision 0011](decisions/0011-live-matchmaking-and-challenges.md)).
Each step names a check that proves it worked and what to do when the check fails. Nothing here
runs by itself; the founder performs each step. It links the existing guides rather than repeating
them: the [staging guide](render-staging.md), the [operations runbook](operations.md) and the
[coin sandbox operations](coin-sandbox-operations.md).

Secrets are named, never written down here. Keep their values in the password manager, Render's
environment and LiveKit Cloud's agent secrets.

## 0. Before you start

1. **Choose the commit.** Take the newest `main` commit whose CI run passed every job, and copy the
   web and encoder image digests from that run's summary
   ([CI-published images](render-staging.md#deploy-the-ci-published-images)).
   - Check: `gh run list --branch main --limit 3` shows `success` for that commit.
   - If no recent run passed, stop and ask for the failing job to be fixed first.
2. **Decide the accounts and plans.** Before step 5:
   - **LiveKit:** at most 2 live debates on Build, 10 on Ship and 25 on Scale for the
     transcriber; Ship allows 100 concurrent recordings. `LIVE_DEBATE_CAPACITY` must stay at or
     below the smallest limit.
   - **ElevenLabs:** a plan whose realtime concurrency covers the trial.
   - **Anthropic:** API billing (Claude Haiku 5.5 live, Claude Sonnet 5.5 cleanup).
   - **Render and Supabase:** the hub's plan lists Render always-on, Supabase paid and encoder
     sizing for a public launch; staging can stay on today's plans for the trial.
3. **Back up the database.** Follow [create a backup](operations.md#create-a-backup) or take a
   Supabase backup.
   - Check: the backup (or Supabase's backup list) shows today's time.
4. **Prepare a local checkout** of the chosen commit for the operator scripts:
   - Node 24, then `npm ci` and `npm run build`. `npm ci` is needed because #96 added the
     `@livekit/agents` packages; the CI images already contain them.
   - The LiveKit CLI (`lk`), signed in to the staging project.
   - Check: `node --version` prints v24, and `lk project list` shows the staging project.

## 1. Apply the owner migrations

Web refuses to start while migrations are pending, so the owner applies them first. Run the
reviewed web image as a one-off process with the owner URL, as in step 2 of
[deploy the web service](render-staging.md#deploy-the-web-service)
(`node scripts/migrate-database.ts`). This release adds:

| Migration                                        | PR   |
| ------------------------------------------------ | ---- |
| `1792971645611_add-turn-trading-windows`         | #90  |
| `1792972953000_allow-automatic-sandbox-openings` | #92  |
| `1792973000000_add-matchmaking-queue`            | #91  |
| `1792973607742_add-account-device-checks`        | #91  |
| `1792974319697_signal-matchmaking-changes`       | #91  |
| `1792975000000_add-live-transcription`           | #96  |
| `1792984532958_add-turn-window-rules`            | #100 |
| `1792984636802_add-replay-joining`               | #102 |
| `1792984650000_add-seat-reservations`            | #101 |
| `1792984708611_add-live-outline`                 | #99  |
| `1792986588837_add-challenge-scheduling`         | #107 |

Staging may also be missing older ones; the runner applies every pending migration in order.

- Check: the job prints `Database migrations completed with the migration identity.` As the owner
  (Supabase SQL editor or `psql`),
  `SELECT name FROM yaparena_migrations.pgmigrations ORDER BY run_on DESC, id DESC LIMIT 11;`
  lists the eleven names above.
- If it prints `Wrong migration identity`, the URL is not the owner's; fix the URL and rerun. Any
  other failure stops the release: keep the old release running, keep the job's output, and do not
  deploy. Migrations are never rolled back.

## 2. Deploy web and the jobs worker together

Deploy both, straight after step 1 and to the same web digest, as in
[deploy a later commit](render-staging.md#deploy-a-later-commit), then the encoder from the same CI
run. Don't wait between them: once #100's migration is in, the previous release can no longer
settle five-day rounds, so its coin loop fails until the new release runs.

- Check:
  - `curl -fsS https://<staging-host>/ready` returns status 200 with `"ready"`.
  - `SMOKE_BASE_URL=https://<staging-host> node scripts/smoke-staging.ts` prints every check
    with its expected status.
  - The worker's Render log shows `background worker started`, and the encoder passes its startup
    checks.
- If `/ready` fails with pending migrations, step 1 didn't complete. If the worker logs coin
  loop errors, confirm it runs the same digest as web. To back out, set the previous digests (see
  [Rollback](#rollback)).

## 3. Turn on Yap Coins turn windows

Needs `COIN_SANDBOX_ENABLED=true`. Set `TURN_WINDOWS_ENABLED=true` on **both** web and the jobs
worker, then deploy both ([enable turn trading windows](render-staging.md#enable-turn-trading-windows)).
It is safe for user-created debates: their rounds reveal after five days (#100) and debaters
can't take positions in their own debate.

- Check: start a debate with two test speakers. Within about a second,
  `GET https://<staging-host>/api/public/debates/<id>/windows` lists a window with `turnNumber` 1,
  `revealMode` `five_day`, and a new one at each turn change.
- If the route answers 404, the switch is off on web. If no window appears, it is off on the
  worker, which opens windows. To turn it off, set it to `false` on both and deploy.

## 4. Per-round reveal for founder-created debates (optional)

Every debate is five-day unless the owner records per-round reveal before its first round. For
each founder-created debate that should reveal per round, run the operator command from the local
checkout, with `COIN_SANDBOX_OWNER_DATABASE_URL` and `COIN_SANDBOX_RAIL` in the operator's
private environment ([coin sandbox operations](coin-sandbox-operations.md#reveal-mode-and-debaters)):

```sh
node scripts/coin-sandbox-operator.ts set-reveal-mode < /private/path/reveal-mode.json
```

The JSON has `debateId`, `mode` (`per_round`) and `reason`.

- Check: it prints status `recorded` (`unchanged` when it was already recorded).
- If it says the reveal mode is locked once a round opens, the debate already has a round and
  stays five-day.

## 5. Deploy the transcriber agent to LiveKit Cloud

Follow steps 1 to 3 of [enable live transcription and captions](render-staging.md#enable-live-transcription-and-captions):

1. Generate the ingest secret.
2. Stage the agent and create it once with `lk agent create --region eu-central`. The region can't
   change later.
3. Set its secrets with `lk agent update-secrets`:
   - `YAPARENA_INGEST_URL`, `TRANSCRIPTION_INGEST_SECRET` and `TRANSCRIPTION_PROVIDER`;
   - for the trial, `TRANSCRIPTION_SHADOW_PROVIDER` and `ELEVEN_API_KEY`;
   - `ANTHROPIC_API_KEY`, for the AI outline.

   LiveKit sets its own URL and keys.

- Check: `lk agent status` (or the LiveKit Cloud dashboard's Agents page) shows the agent running.
  `lk agent logs` shows it registered, with no ingest errors.
- If the build fails, restage from the chosen commit and run `lk agent deploy` again. Never run
  the agent locally with `start` against staging: it would compete for real debates.

## 6. Turn on captions and the AI outline

On **both** web and the jobs worker, set `LIVE_OUTLINE_ENABLED=true` and the same
`TRANSCRIPTION_INGEST_SECRET` as the agent (and `TRANSCRIBER_AGENT_NAME` if you changed it), then
deploy both.

- Check, following step 5 of
  [enable live transcription and captions](render-staging.md#enable-live-transcription-and-captions):
  1. Two test debaters choose a language and agree on their account's Profile tab ("Debating").
  2. When their debate becomes ready, `lk agent logs` shows `transcriber joined`.
  3. Captions appear under the video, and the AI outline panel fills within seconds of each
     sentence.
  4. After each turn, `SELECT final_source FROM yaparena.outline_windows WHERE debate_id='<id>'`
     shows `cleanup` (or `frozen`).
- If the agent logs ingest 401s, the two ingest secrets differ. If it never joins, check
  `TRANSCRIBER_AGENT_NAME` on both sides. If there are captions but no outline,
  `ANTHROPIC_API_KEY` is missing. To turn everything off, set `LIVE_OUTLINE_ENABLED=false` and
  deploy; the agent then receives no debates.

## 7. Run the provider trial

Run the [transcription provider trial](transcription-provider-trial.md): two sessions with the
providers swapped, hand-corrected references, and the report script. Then choose the primary
provider. Set `TRANSCRIPTION_PROVIDER` to it and remove `TRANSCRIPTION_SHADOW_PROVIDER` (the shadow
doubles speech-to-text cost).

- Check: the report prints one row per provider and language, and the trial's results table is
  filled in.
- Send the results to S for the post-trial docs PR.

## 8. Matchmaking (M)

The live topic queue, direct challenges and personal live updates
([Decision 0011](decisions/0011-live-matchmaking-and-challenges.md)). Step 1 applied their
migrations (#91, #101 and #107). Everything stays off until `MATCHMAKING_ENABLED` is set, and
turning it off again is the rollback. Automatic start and recording need live video configured;
without it the queue still matches players, but debates never start by themselves. Staging's web
service is Render Free, which sleeps after 15 idle minutes. That's fine for this trial with a page
open, but not for a public queue
([capacity and cost](decisions/0011-live-matchmaking-and-challenges.md#capacity-and-cost)).

| Variable               | Set on                  | Value                                                                   |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `MATCHMAKING_ENABLED`  | Web **and** jobs worker | `true`. The worker runs the one-second queue sweep and automatic start. |
| `LIVE_DEBATE_CAPACITY` | Web **and** jobs worker | Debates starting or live at once, plus pending matches. Default `2`.    |
| `USER_STREAM_ENABLED`  | Web                     | Leave `false`: live updates are always on with matchmaking (see below). |

1. **Choose the capacity.** Use the smallest limit from step 0.2 for your LiveKit plan: 2 on Build;
   on Ship, 10 with the live outline on or 100 without it.
   - Check: the value is at or below that limit, and it is the same on web and the worker.
   - If unsure, keep the default `2` for the trial.
2. **Check both database URLs.** In Render, open web's and the worker's environment and, without
   copying the value, confirm `DATABASE_URL` is the runtime Session pooler URL on port 5432. Live
   updates hold one LISTEN connection per web process, which the 6543 pooler can't carry.
   - Check: port 5432 on both.
   - If it is 6543, replace it with the runtime Session pooler URL; otherwise startup refuses with
     `live queue LISTEN requires a direct or session-pooler connection`.
3. **Turn it on, on both services.** Set `MATCHMAKING_ENABLED=true` and `LIVE_DEBATE_CAPACITY` on
   **both** the jobs worker and web before deploying either, then deploy the worker and web. The
   worker pairs players: with the switch on web only, players can queue but are never matched.
   - Check:
     - The worker's Render log shows one `background job ran` line with `job: "matchmaking"`
       within a few seconds, and no `matchmaking sweep failed` lines.
     - `curl -fsS https://<staging-host>/topics/<topic-slug> | grep -c data-matchmaking` prints
       `1`, and the topic page shows "Take a side and get matched".
   - If not, the switch isn't saved on that service or the service didn't redeploy.
4. **Check live updates.** As the owner (Supabase SQL editor):
   `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'yaparena-user-streams-listener' OR query = 'LISTEN yaparena_results_v1';`
   - Check:
     - It prints `1`, one per web process.
     - In a signed-in browser, DevTools → Network shows `/api/me/stream` open with status 200.
   - If it prints `0`, look for repeating `user-streams listener connection lost` lines in web's
     log; that is usually the URL from 8.2. The site still works by polling, but "now"
     challenges and matches arrive up to 30 seconds late.
5. **Prepare two test accounts, A and B,** in two browser profiles or two devices; one browser
   shares its sign-in across tabs.
   - **Each account:** sign in, publish a profile with a handle, allow the camera and microphone,
     and (with the outline on) choose a language and agree on the Profile tab, as in step 6.
   - **A topic:** on `/match`, "Start a topic", then publish it.
   - Check: both profiles open at `/people/<handle>`, and the topic at `/topics/<topic-slug>`.
   - If the queue later answers "Choose your debate language…", follow its "Open your account
     settings" link.
6. **Queue, accept and start automatically.** A opens the topic and clicks "Queue for <side A>",
   allowing the camera check. B opens the same page and clicks "Queue for <side B>". Both click
   Accept, then "Check camera and join as speaker" on the debate page.
   - Check:
     - A's header shows "In queue", and B's page says "1 person waiting for <side A>".
     - Within about two seconds of B queueing, both see "Match found" with a 30-second countdown.
     - After Accept, both open the same `/debates/<slug>`, showing "Waiting for both speakers to
       join".
     - Within about two seconds of the second speaker joining, the debate goes live by itself.
       LiveKit shows one recording for the room, and with the outline on, `transcriber joined`
       follows.
     - `SELECT reason FROM yaparena.event_history WHERE debate_id = '<id>' AND action = 'start';`
       returns "Automatic start: both speakers are ready and connected."
   - If no match appears, check the worker log and the capacity query below; two players on the
     same side are never matched. If it doesn't start, look for `automatic debate start failed` in
     the worker log, then start it as operator to finish the trial.
7. **Automatic no-show.** A and B queue again and accept; only A joins as speaker.
   - Check: 90 seconds later, A's page says "This debate was cancelled because a speaker didn't
     join in time.", and A is back in the queue at their place.
   - If it still waits after two minutes, check the worker log for sweep errors.
8. **Challenge to debate now.** A stays on any signed-in page. On `/match`, B uses "Challenge a
   person": B finds A by handle or name, picks the topic, writes a proposition, picks a side,
   chooses "Now" and sends it.
   - Check:
     - B's notice says "@<A> has 2 minutes to answer." and B's header shows "Challenge sent".
     - A sees "Debate now?" at once, with a countdown.
     - Accept opens the room for both, then continue as in 8.6.
     - On a second challenge, A's "Later" keeps it in A's list on `/match`. Two minutes later, B's
       Updates on `/match` say it "wasn't answered in time".
   - If A sees no popup, A wasn't online (8.4); the challenge waits in A's list instead.
9. **Challenge at an agreed time.** This needs an hour or more, so run it beside the others.
   1. B challenges A with "Propose times" and two times at least an hour ahead.
   2. A clicks "Propose times" and sends another time.
   3. B accepts A's time.
   4. Both join as speakers at the start.
   - Check:
     - A's list on `/match` shows "From @<B>", with "Accept <time>" buttons in A's own time zone.
     - After A's counter, B's list updates by itself with A's time.
     - After B accepts, both lists say "booked".
     - Five minutes before the start, both get "Your debate starts in a few minutes. Join now." in
       Updates, a header "Debate in 4:59", and a countdown on the debate page.
     - At the start time, it goes live by itself.
   - If a speaker doesn't join, it is cancelled 10 minutes after the start.
10. **End the trial debates** as operator, or let them reach their maximum duration.
    - Check: each recording stops in LiveKit.
    - If one doesn't stop, end it as operator.

**While it runs, watch:**

- **LiveKit:** concurrent recordings and rooms (and agent sessions with the outline) stay at or
  below `LIVE_DEBATE_CAPACITY`. At capacity, queued players wait without a match.
- **Capacity in use**, the count the queue checks before offering a match:

  ```sql
  SELECT (SELECT count(*) FROM yaparena.debates WHERE NOT is_demo AND (status = 'live'
      OR (status IN ('scheduled', 'ready') AND scheduled_at BETWEEN now() - interval '15 minutes'
        AND now() + interval '5 minutes')))
    + (SELECT count(*) FROM yaparena.match_offers WHERE status = 'pending') AS used;
  ```

- **The queue:**
  `SELECT status, count(*) FROM yaparena.matchmaking_tickets WHERE updated_at > now() - interval '1 hour' GROUP BY 1;`
- **Players online** (they can receive "now" challenges):
  `SELECT count(*) FROM yaparena.matchmaking_presence WHERE seen_at > now() - interval '60 seconds';`
- **Database connections:** the 8.4 query stays at one per web process.
- **Web log:** `live update failed`, `live update presence failed`,
  `user-streams listener connection lost` and `live update stream fell behind`. One-off lines are
  fine; repeating ones are not.
- **Worker log:** `matchmaking sweep failed`, `automatic debate start failed` and
  `matchmaking retention cleanup failed`.

**Results notices with matchmaking off.** Live updates also carry the notice when a player's Yap
Coins results are revealed. They are always on with matchmaking. To run them with matchmaking off,
set `USER_STREAM_ENABLED=true` on web, with the same port 5432 rule, and check 8.4.

**Turning it off.** Finish any trial debate, then set `MATCHMAKING_ENABLED=false` on the worker and
web (and `USER_STREAM_ENABLED=false` if set), and deploy both.

- Check:
  - The `data-matchmaking` count in 8.3 prints `0`.
  - The 8.4 query prints `0`.
  - The worker logs no more matchmaking lines.
- What stays:
  - **Queue tickets:** they stay in the database unused, and close as stale if it's turned on
    again.
  - **Booked debates:** debates booked through challenges stay scheduled; start them as operator.
  - **Open challenges:** they can still be answered on `/match`.

## Rollback

- **Migrations** are additive and stay; never roll back the schema.
- **Feature switches:** set `TURN_WINDOWS_ENABLED` or `LIVE_OUTLINE_ENABLED` to `false` on web and
  the worker and deploy. Removing only `ANTHROPIC_API_KEY` from the agent keeps captions and stops
  the outline.
- **Code:** setting the previous digests works for web and the encoder. After #100's migration the
  previous release can't settle five-day rounds, though, so prefer fixing forward
  ([deploy a later commit](render-staging.md#deploy-a-later-commit)).
- **Agent:** restage the previous commit and run `lk agent deploy` again.
- **Matchmaking:** set `MATCHMAKING_ENABLED=false` on web and the worker and deploy; see
  [turning it off](#8-matchmaking-m) for what stays.
