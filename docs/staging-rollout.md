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

Placeholder: M adds this section in a follow-up PR.

## Rollback

- **Migrations** are additive and stay; never roll back the schema.
- **Feature switches:** set `TURN_WINDOWS_ENABLED` or `LIVE_OUTLINE_ENABLED` to `false` on web and
  the worker and deploy. Removing only `ANTHROPIC_API_KEY` from the agent keeps captions and stops
  the outline.
- **Code:** setting the previous digests works for web and the encoder. After #100's migration the
  previous release can't settle five-day rounds, though, so prefer fixing forward
  ([deploy a later commit](render-staging.md#deploy-a-later-commit)).
- **Agent:** restage the previous commit and run `lk agent deploy` again.
