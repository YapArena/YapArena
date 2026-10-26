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
without it, the queue still matches players, but debates never start by themselves. Staging's web
service is Render Free, which sleeps after 15 idle minutes. That's fine for this trial with a page
open, but not for a public queue
([capacity and cost](decisions/0011-live-matchmaking-and-challenges.md#capacity-and-cost)).

**Where things are.** Every item below uses these places:

- **Render:** [dashboard.render.com](https://dashboard.render.com), then the staging web service
  or the jobs worker `yaparena-staging-jobs`. Each service's left pane has:
  - **Events:** deploys; a finished deploy reads "Deploy live".
  - **Logs:** a search box at the top filters the lines.
  - **Environment:** its variables.
- **Supabase SQL editor:** [supabase.com/dashboard](https://supabase.com/dashboard), then the
  staging project, **SQL Editor** in the left sidebar, then **+ New query**. Paste the query and
  click **Run** (Cmd+Enter). The result grid appears under the editor.
- **Terminal:** a local terminal in the checkout from step 0.4, with `lk` signed in to the staging
  project.
- **Chrome DevTools:** on a staging page, **View › Developer › Developer Tools** (Cmd+Option+I),
  then the **Network** tab.

**Values you'll fill in:**

| Placeholder                | Where to find it                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `<staging-host>`           | Render → web service → the address under its name at the top, without `https://`, for example `yaparena-staging.onrender.com` |
| `<capacity>`               | The number you choose in 8.1                                                                                                  |
| `<handle-a>`, `<handle-b>` | The handles you give accounts A and B in 8.5                                                                                  |
| `<topic-slug>`             | The "URL slug" you type when creating the trial topic in 8.5, for example `staging-queue-trial`                               |
| `<debate-slug>`            | The end of a debate page's address: `https://<staging-host>/debates/<debate-slug>`                                            |
| `<debate-id>`              | The `id` returned by the first query in the 8.6 checks                                                                        |

**The switches:**

| Variable               | Set on                  | Value                                                                   |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `MATCHMAKING_ENABLED`  | Web **and** jobs worker | `true`. The worker runs the one-second queue sweep and automatic start. |
| `LIVE_DEBATE_CAPACITY` | Web **and** jobs worker | `<capacity>`: debates starting or live at once, plus pending matches.   |
| `USER_STREAM_ENABLED`  | Web                     | Leave unset or `false`: live updates are always on with matchmaking.    |

1. **Choose the capacity.** Use the LiveKit plan you chose in step 0.2:

   | LiveKit plan | Outline off (`LIVE_OUTLINE_ENABLED=false`) | Outline on |
   | ------------ | ------------------------------------------ | ---------- |
   | Build        | 2                                          | 2          |
   | Ship         | 100                                        | 10         |
   | Scale        | 500                                        | 25         |

   Write the number down as `<capacity>`.
   - Check: `<capacity>` is at or below the table's number for your plan and outline setting.
   - If you're unsure, use `2`.

2. **Check both database URLs.**
   1. Render → `yaparena-staging-jobs` → **Environment**.
   2. On the `DATABASE_URL` row, click the eye icon to reveal the value. Read it without copying it,
      then hide it again.
   3. Repeat on the web service.
   - Check: both values contain `:5432/` (the Session pooler).
   - If one contains `:6543/` (the transaction pooler):
     1. In Supabase, open the project's **Connect** button (top bar), then **Session pooler**.
     2. Build the runtime URL as in [create the database](render-staging.md#create-the-database).
     3. Paste it into that service's `DATABASE_URL`, then choose **Save only**; 8.3 deploys.

     Otherwise that service won't start, and its Logs show
     `live queue LISTEN requires a direct or session-pooler connection`.
3. **Turn it on, jobs worker first.** The worker pairs players, so it goes first.
   1. Render → `yaparena-staging-jobs` → **Environment** → **+ Add Environment Variable**. Key
      `MATCHMAKING_ENABLED`, value `true`.
   2. **+ Add Environment Variable** again. Key `LIVE_DEBATE_CAPACITY`, value `<capacity>`.
      If either key already exists, edit its value on its row instead.
   3. Click **Save and deploy**.
   4. Open **Events** and wait until the new deploy reads "Deploy live".
   5. Repeat items 1–4 on the web service.
   - Check, worker: Render → `yaparena-staging-jobs` → **Logs** → search `background job ran`.
     Within a few seconds of the deploy, a line shows `"job":"matchmaking"`. Searching
     `matchmaking sweep failed` shows nothing.
   - Check, web: in the terminal, run

     ```sh
     curl -fsS https://<staging-host>/topics | grep -c data-matchmaking
     ```

     It prints `1`.

   - If the worker line is missing, the variable isn't saved on the worker or its deploy isn't live
     (check its **Events**). If `curl` prints `0`, the same applies to web.
4. **Check live updates.**
   1. In the Supabase SQL editor, run:

      ```sql
      SELECT count(*) FROM pg_stat_activity
      WHERE application_name = 'yaparena-user-streams-listener'
         OR query = 'LISTEN yaparena_results_v1';
      ```

   2. Sign in to `https://<staging-host>` in Chrome, open DevTools → **Network**, type `stream` in
      the **Filter** box, and reload (Cmd+R).
   - Check:
     - The query's grid shows one row with `count` = `1` (one per web process).
     - DevTools shows a row named `stream`, with Status `200` and Type `eventsource`, that stays
       pending.
   - If `count` is `0`: Render → web service → **Logs** → search `listener connection lost`.
     Repeating lines mean the database URL (8.2). The site still works by polling, but "now"
     challenges and matches arrive up to 30 seconds late.
5. **Prepare accounts A and B, and a topic.** Use two Chrome profiles (click the profile icon at
   the top right of Chrome, then **Add**) or two devices, because one browser profile shares its
   sign-in across tabs. In each profile:
   1. Open `https://<staging-host>/account` and sign in with that account's email.
   2. If asked, pick a handle: `<handle-a>` for A, `<handle-b>` for B.
   3. On **Profile**, if the banner shows **Make it public**, click it.
   4. If the outline is on, find the **Debating** card on the same tab. Choose **Language you
      debate in**, tick the agreement box, and click **Save debating settings**.

   Then, as A:
   1. Open `https://<staging-host>/match`.
   2. Under **01 / START A TOPIC**, fill in **URL slug** `<topic-slug>`, a **Title**, a
      **Summary**, **Side A label** `For` and **Side B label** `Against`.
   3. Click **Create private draft**, then **Publish** on its row below.
   - Check:
     - `https://<staging-host>/people/<handle-a>` and `/people/<handle-b>` open both profiles.
     - `https://<staging-host>/topics/<topic-slug>` shows "Take a side and get matched", with
       **Queue for For** and **Queue for Against**.
   - If the queue later answers "Choose your debate language…", click its **Open your account
     settings** link and do item 4.

6. **Queue, accept and start automatically.**
   1. A opens `https://<staging-host>/topics/<topic-slug>`, clicks **Queue for For**, and allows the
      camera and microphone.
   2. B opens the same address, clicks **Queue for Against**, and allows them.
   3. Both click **Accept** in the "Match found" window.
   4. On the debate page, both click **Check camera and join as speaker**.
   - Check:
     - After item 1, A's header shows "In queue · 0:01", counting up. B's page reads
       "1 person waiting for For" under the buttons.
     - Within about two seconds of item 2, both see "Match found" with a countdown from 30.
     - After item 3, both are on the same `https://<staging-host>/debates/<debate-slug>`, showing
       "Waiting for both speakers to join · 1:2x left" above the video.
     - Within about two seconds of item 4, the debate is live. In the SQL editor:

       ```sql
       SELECT id, status FROM yaparena.debates WHERE slug = '<debate-slug>';
       ```

       This returns `status` `live`. Keep its `id` as `<debate-id>`.

       ```sql
       SELECT reason FROM yaparena.event_history WHERE debate_id = '<debate-id>' AND action = 'start';
       ```

       This returns `Automatic start: both speakers are ready and connected.`

     - In the terminal:

       ```sh
       lk egress list --room debate-<debate-id> --active --json
       ```

       This lists one egress whose status is `EGRESS_ACTIVE`. With the outline on,
       `lk agent logs` shows `transcriber joined`.
   - If no "Match found" appears within 10 seconds:
     - In the worker's **Logs**, search `matchmaking sweep failed`.
     - Run the capacity query under "While it runs". If `used` is at `<capacity>`, wait for a
       debate to end.
     - Players on the same side are never matched.
   - If it isn't live within 10 seconds of both joining:
     - In the worker's **Logs**, search `automatic debate start failed`.
     - Compare `lk egress list --active --json` with your plan's recording limit.
7. **Automatic no-show.**
   1. A and B each open the topic again and queue, A for For and B for Against.
   2. Both accept.
   3. Only A clicks **Check camera and join as speaker**.
   - Check:
     - 90 seconds after the match, A's banner reads "This debate was cancelled because a speaker
       didn't join in time.".
     - A's header shows "In queue" again; A keeps their place.
     - `SELECT status FROM yaparena.debates WHERE slug = '<debate-slug>';` returns `cancelled`.
   - If it still shows the countdown at 0:00 after two minutes, search the worker's **Logs** for
     `matchmaking sweep failed`.
8. **Challenge to debate now.** A stays on any signed-in page.
   1. B opens `https://<staging-host>/match`.
   2. Under **02 / CHALLENGE A PERSON**, B fills in **Opponent** `<handle-a>`, **Published topic
      slug** `<topic-slug>`, a **Proposition** (at least 10 characters) and **Your side**
      **Side B — Against**.
   3. B picks **When: Now** and clicks **Send challenge**.
   4. A clicks **Accept** in the "Debate now?" window.
   - Check:
     - B's page notice reads "Challenge sent. @<handle-a> has 2 minutes to answer.", and B's
       header shows "Challenge sent · 1:5x".
     - A sees "Debate now?" at once, naming B's display name and `@<handle-b>`, with a countdown.
     - After item 4, both land on a new `/debates/<debate-slug>`. Continue with item 4 of 8.6.
   - Try "Later" on a second "now" challenge: A clicks **Later**. It stays in A's **Your
     challenges** list on `/match`. Two minutes later, B's **Updates** list on `/match` reads
     "Your challenge to debate now wasn't answered in time. It stays open so you can agree a
     time."
   - If A sees no window, A wasn't online (check 8.4). The challenge then waits in A's **Your
     challenges** list instead.
9. **Challenge at an agreed time.** This takes an hour or more, so start it beside the others.
   1. B fills in the same form as in 8.8, picks **When: Propose times**, enters two times at least
      an hour ahead in **First choice** and **Second choice**, and clicks **Send challenge**.
   2. A opens `/match`. Under **Your challenges**, A clicks **Propose times** on B's challenge,
      enters another time, and clicks **Send times**.
   3. B clicks **Accept <time>** on A's time.
   4. At the start, both open the debate from **Your events** on `/match` and click **Check
      camera and join as speaker**.
   - Check:
     - After item 1, A's entry reads "From @<handle-b> …" with one **Accept <time>** button per
       time, in A's time zone.
     - After item 2, B's entry updates by itself to show A's time.
     - After item 3, both entries read "… · booked · <time>".
     - Five minutes before the start:
       - **Updates** on `/match` shows "Your debate starts in a few minutes. Join now.";
       - the header shows "Debate in 4:5x";
       - the debate page shows "Your debate starts in …".
     - At the start time, it goes live by itself (same checks as 8.6).
   - If a speaker doesn't join, the debate is cancelled 10 minutes after the start (same check as
     8.7).
10. **End the trial debates.** Each ends by itself at its rules' maximum length. In the SQL
    editor,
    `SELECT rules_snapshot->>'maximum_duration_seconds' FROM yaparena.debates WHERE slug = '<debate-slug>';`
    shows that length in seconds. An account with the `operator` role can also end one early: the
    debate page's **Operator controls**, a **Reason for action**, then **End**.
    - Check: `lk egress list --room debate-<debate-id> --active --json` no longer lists an egress,
      and `SELECT status FROM yaparena.debates WHERE slug = '<debate-slug>';` returns `ended`.
    - If the egress stays active after the debate ended, stop it in the terminal with
      `lk egress stop --id <egress-id>`, using the egress ID from that list.

**While it runs, watch** these (SQL in the Supabase SQL editor, the rest where it names):

- **Recordings:** `lk egress list --active --json` in the terminal lists no more egresses than
  `<capacity>`. With the outline on, `lk agent logs` shows no more sessions than the plan allows.
- **Capacity in use**, the count the queue checks before offering a match. It stays at or below
  `<capacity>`; at capacity, queued players wait without a match:

  ```sql
  SELECT (SELECT count(*) FROM yaparena.debates WHERE NOT is_demo AND (status = 'live'
      OR (status IN ('scheduled', 'ready') AND scheduled_at BETWEEN now() - interval '15 minutes'
        AND now() + interval '5 minutes')))
    + (SELECT count(*) FROM yaparena.match_offers WHERE status = 'pending') AS used;
  ```

- **The queue:**
  `SELECT status, count(*) FROM yaparena.matchmaking_tickets WHERE updated_at > now() - interval '1 hour' GROUP BY 1;`
- **Players online** (who can receive "now" challenges):
  `SELECT count(*) FROM yaparena.matchmaking_presence WHERE seen_at > now() - interval '60 seconds';`
- **Database connections:** the 8.4 query stays at `1` per web process.
- **Web service Logs** (search each): `live update failed`, `live update presence failed`,
  `listener connection lost` and `live update stream fell behind`. One-off lines are fine;
  repeating ones are not.
- **Worker Logs** (search each): `matchmaking sweep failed`, `automatic debate start failed` and
  `matchmaking retention cleanup failed`.

**Results notices with matchmaking off.** Live updates also carry the notice when a player's Yap
Coins results are revealed. They are always on with matchmaking. To run them with matchmaking off:

1. Render → web service → **Environment** → **+ Add Environment Variable**. Key
   `USER_STREAM_ENABLED`, value `true`.
2. Click **Save and deploy**.
3. Run the 8.4 checks; the 8.2 port rule applies.

**Turning it off.** Let any trial debate end first (8.10).

1. Render → `yaparena-staging-jobs` → **Environment**. Set `MATCHMAKING_ENABLED` to `false`, then
   **Save and deploy**, and wait for "Deploy live" in **Events**.
2. Repeat on the web service. Set `USER_STREAM_ENABLED` to `false` there too if you set it.

- Check:
  - `curl -fsS https://<staging-host>/topics | grep -c data-matchmaking` prints `0`.
  - The 8.4 query returns `0`.
  - The worker's **Logs** show no `background job ran` line with `"job":"matchmaking"` after the
    deploy.
- What stays:
  - **Queue tickets:** they stay in the database unused, and close as stale if it's turned on
    again.
  - **Booked debates:** debates booked through challenges stay scheduled. Start them with
    **Operator controls**.
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
