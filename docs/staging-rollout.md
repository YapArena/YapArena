# Staging rollout (Decisions 0011 to 0013)

Prepared on 2026-10-26 and not run yet. This runbook takes staging from the last deployed release
to current `main`: the migrations from #90 to #107, Yap Coins turn windows and their round rules
([Decision 0012](decisions/0012-live-argument-outline.md)), the transcriber agent, captions and the
AI outline, the speech-to-text provider trial, and matchmaking
([Decision 0011](decisions/0011-live-matchmaking-and-challenges.md)). The founder performs each
step; nothing here runs by itself. Each step says where to do it, gives every command and click,
shows the output that proves it worked, and says what to do when it doesn't. Background is in the
[staging guide](render-staging.md), the [operations runbook](operations.md) and the
[coin sandbox operations](coin-sandbox-operations.md).

Secrets are named here, never written down. Their values live in your password manager, the
private folder from step 0.3, Render's environment and LiveKit Cloud's agent secrets. Never paste
them into a chat, an issue or the repository.

## How to use this runbook

**Where things are.** Each item names one of these places:

- **Terminal:** the macOS Terminal app. Unless an item says otherwise, run commands in the release
  checkout from step 0.4 (`cd ~/yaparena-release`). Paste a command block as it is and press
  Return. Replace every `<PLACEHOLDER>` first, angle brackets included.
- **Render:** [dashboard.render.com](https://dashboard.render.com), in the workspace that holds
  `yaparena-staging-web`. Staging has three services: the web service `yaparena-staging-web`, the
  jobs worker `yaparena-staging-jobs` and the replay encoder `yaparena-replay-worker`. Click a
  service's name to open it. Its left pane has:
  - **Events:** deploys; a finished deploy reads "Deploy live".
  - **Logs:** a search box at the top filters the lines.
  - **Environment:** its variables. The eye icon on a row reveals the value.
  - **Settings** and **Metrics**.
- **Supabase SQL editor:** [supabase.com/dashboard](https://supabase.com/dashboard), the staging
  project, **SQL Editor** in the left sidebar, then **+ New query**. Paste the query, click **Run**
  (Cmd+Return) and read the grid under the editor. The editor runs as an administrator, so use it
  only for the queries given here.
- **LiveKit Cloud:** [cloud.livekit.io](https://cloud.livekit.io), the staging project: the one
  whose URL matches `LIVEKIT_PUBLIC_URL` in the Render web service's **Environment**
  (`wss://<name>.livekit.cloud`). **Agents** in its left sidebar lists the transcriber.
- **Two browser profiles:** test accounts A and B each need their own Chrome profile (the profile
  icon at the top right of Chrome, then **Add**) or their own device, because one profile shares its
  sign-in across tabs.

Staging's address is `https://yaparena-staging-web.onrender.com` (step 8 calls its host
`<staging-host>`). Render Free puts it to sleep after 15 idle minutes, so the first request after a
pause can take about a minute.

**Values you'll fill in:**

| Placeholder                                                                | What it is                                                                      | Where you get it                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| `<COMMIT_SHA>`, `<RUN_ID>`                                                 | The release commit (40 characters) and its CI run                               | Step 0.1                                    |
| `<WEB_IMAGE>`, `<ENCODER_IMAGE>`                                           | `ghcr.io/boufe/yaparena@sha256:…` and `ghcr.io/boufe/yaparena-encoder@sha256:…` | Step 0.1                                    |
| `<MAC_HOME>`                                                               | Your home folder, for example `/Users/yourname`                                 | Terminal: `echo $HOME`                      |
| `<PROJECT_REF>`, `<POOLER_HOST>`                                           | The Supabase project ID and its session pooler host                             | Step 0.3                                    |
| `<OWNER_PASSWORD>`, `<RUNTIME_PASSWORD>`                                   | The `yaparena_owner` and `yaparena_runtime` database passwords                  | Step 0.3                                    |
| `<INGEST_SECRET>`                                                          | The secret the agent and the app share                                          | Step 5.1                                    |
| `<ELEVENLABS_KEY>`, `<ANTHROPIC_KEY>`                                      | API keys                                                                        | Steps 5.2 and 5.3                           |
| `<handle-a>`, `<handle-b>`, `<topic-slug>`, `<debate-slug>`, `<debate-id>` | The test accounts' handles, the trial topic, and a debate's address and ID      | [Start a test debate](#start-a-test-debate) |

### Start a test debate

Steps 3, 6 and 7 each need a live debate between test accounts A and B. Until matchmaking is on
(step 8), an operator starts it. Afterwards, the topic queue (step 8, items 5 and 6) is quicker
because the debate starts by itself.

1. **Accounts (once).** In A's profile, open `https://yaparena-staging-web.onrender.com/account`
   and sign in with test account A's email. If asked, pick a handle: `<handle-a>`. On the
   **Profile** tab, if the banner shows **Make it public**, click it. Do the same for B in B's
   profile, with `<handle-b>`. From step 6 on, both also fill in the **Debating** card (step 6,
   item 4).
2. **Operator (once).** One of your test accounts needs the `operator` role. In the SQL editor,
   list who has it:

   ```sql
   SELECT r.user_id, p.handle
   FROM yaparena.account_roles r
   LEFT JOIN yaparena.public_profiles p USING (user_id)
   WHERE r.role = 'operator';
   ```

   If none of the rows is a test account of yours, give the role to A:

   ```sql
   INSERT INTO yaparena.account_roles (user_id, role)
   SELECT user_id, 'operator' FROM yaparena.public_profiles WHERE handle = '<handle-a>'
   ON CONFLICT DO NOTHING;
   ```

   - Check: signed in as that account, `https://yaparena-staging-web.onrender.com/api/me/roles`
     shows `"operator"` in its `roles` list.

3. **Topic (once).** As A, open `https://yaparena-staging-web.onrender.com/match`. Under
   **01 / START A TOPIC**, fill in **URL slug** `<topic-slug>` (for example `staging-trial`), a
   **Title**, a **Summary** of at least 10 characters, **Side A label** `For` and **Side B label**
   `Against`. Click **Create private draft ↗**, then **Publish** on its row. The notice reads
   "Topic published."
4. **Request.** As A, under **02 / OPEN A REQUEST**, choose **Type** `Open matchmaking`, fill in
   **Published topic slug** `<topic-slug>`, a **Proposition** of at least 10 characters, **Your
   side** `Side A`, and a **Proposed start** at least 1 hour 5 minutes from now. Click **Open
   request ↗**. The notice reads "Request opened. It expires after 24 hours or 30 minutes before
   the proposed start."
5. **Join.** As B, on the same `/match` page, under **OPEN QUEUE / Join a debate**, click **Join**
   on A's request, then **OK**. The notice reads "Joined. Your event is scheduled."
6. **Speakers.** A and B each click the debate's row under **YOUR EVENTS**. It opens
   `https://yaparena-staging-web.onrender.com/debates/<debate-slug>`. Both click **Check camera and
   join as speaker** and allow the camera and microphone.
7. **Debate ID.** In the SQL editor:

   ```sql
   SELECT id, status FROM yaparena.debates WHERE slug = '<debate-slug>';
   ```

   Keep `id` as `<debate-id>`. `status` reads `ready` once both speakers have joined.

8. **Start.** As the operator, on the debate page, open **Operator controls** under the video, type
   a **Reason for action** (for example `Staging rollout check`) and click **Start**. You don't
   need to wait for the proposed start time.
   - Check: the item 7 query returns `live`.
   - If it says "both speakers must be connected before start", wait until both speakers' video
     appears, then click **Start** again.

The debate ends by itself after its rules' maximum length;
`SELECT rules_snapshot->>'maximum_duration_seconds' FROM yaparena.debates WHERE slug = '<debate-slug>';`
shows it in seconds. To end it early: **Operator controls**, a **Reason for action**, then **End**.

## 0. Before you start

### 0.1 Choose the commit and its images

Terminal, in any folder:

```sh
gh run list --repo Boufe/YapArena --workflow CI --branch main --event push --limit 5 \
  --json status,conclusion,databaseId,headSha,displayTitle \
  --jq '.[] | "\(.status) \(.conclusion) \(.databaseId) \(.headSha) \(.displayTitle)"'
```

Each line reads `<status> <conclusion> <run id> <commit SHA> <title>`, newest first. Take the first
line that starts with `completed success`: its third word is `<RUN_ID>` and its fourth is
`<COMMIT_SHA>`. Open `https://github.com/Boufe/YapArena/actions/runs/<RUN_ID>` in the browser. On
its **Summary** page, scroll down to **web image** and **encoder image**, and copy each
`ghcr.io/…@sha256:…` line: they are `<WEB_IMAGE>` and `<ENCODER_IMAGE>`.

- Check: the summary lists both images, and the commit's title is a merge of #119 or later.
- If:
  - `gh` says you aren't logged in: run `gh auth login`, choose **GitHub.com**, **HTTPS** and
    **Login with a web browser**, then rerun.
  - None of the five lines is `completed success`: stop and ask for the failing job to be fixed
    first. For example, the 2026-10-26 runs failed the encoder's OpenSSL scan until #123.
  - The commit is a merge after #124: newer PRs may add migrations. Run
    `ls ~/yaparena-release/migrations | tail -15` after step 0.4 and compare it with the table in
    step 1; read the PR of any name that isn't there before continuing.

### 0.2 Decide the accounts and plans

- **LiveKit Cloud:** the plan sets how many debates can run at once. Build allows 100 connections,
  5 agent sessions and 2 recordings at once; Ship 1,000, 20 and 100
  ([pricing](https://livekit.com/pricing), read 2026-10-26). Step 8.1 turns that into
  matchmaking's capacity. Deepgram speech-to-text runs on LiveKit Inference and is billed by
  LiveKit: $0.0048 a minute on Build and Ship, after the plan's included credits.
- **ElevenLabs:** only for the trial (step 7). Any plan with API access to speech to text works;
  the trial uses one realtime stream at a time. Your plan is at
  [elevenlabs.io/app/subscription](https://elevenlabs.io/app/subscription).
- **Anthropic:** the AI outline calls Claude Haiku 5.5 live and Claude Sonnet 5.5 once per turn,
  paid from prepaid API credits. In the [Claude Console](https://platform.claude.com), open
  **Settings → Billing** and buy credits (for example $20 for the trial).
- **Render and Supabase:** today's plans (web Free, jobs worker Starter, Supabase Free) are enough
  for this rollout and the trial. The public-launch plan is a separate decision.

### 0.3 Make your private folder

The scripts read database URLs from files outside the repository. Terminal:

```sh
mkdir -p ~/yaparena-private/trial && chmod 700 ~/yaparena-private
echo $HOME
```

The second line prints `<MAC_HOME>`.

1. **Certificate.** In Supabase, open the staging project's **Project Settings** (gear icon at the
   bottom of the left sidebar), then **Database**, then **Download certificate** under **SSL
   Configuration**. Then, in the Terminal:

   ```sh
   mv ~/Downloads/prod-ca-2021.crt ~/yaparena-private/supabase-ca.crt
   head -1 ~/yaparena-private/supabase-ca.crt
   ```

   It prints `-----BEGIN CERTIFICATE-----`. If the download has another name, use that name in
   the `mv` line.

2. **Host and project ID.** In Supabase, click **Connect** in the top bar and choose **Session
   pooler** (port 5432; never the transaction pooler on port 6543). The string reads
   `postgresql://postgres.<PROJECT_REF>:[YOUR-PASSWORD]@<POOLER_HOST>:5432/postgres`. Note the
   two values.
3. **Passwords.** `<OWNER_PASSWORD>` and `<RUNTIME_PASSWORD>` are in your password manager from
   when the roles were provisioned ([database isolation](security/database-isolation.md)). The
   runtime one is also inside `DATABASE_URL` in the Render web service's **Environment**, between
   the `:` and the `@`. If a password has characters other than letters, digits, `-`, `_`, `.` and
   `~`, encode it:

   ```sh
   read -rs "PW?Password: " && echo && PW="$PW" node -e 'console.log(encodeURIComponent(process.env.PW))'; unset PW
   ```

   Paste the password at the prompt (it stays hidden), press Return, and use the printed value.

4. **Owner file.** Run `nano ~/yaparena-private/owner.env`, type these three lines with your values,
   save with Ctrl+O and Return, and quit with Ctrl+X:

   ```text
   DATABASE_URL='postgresql://yaparena_owner.<PROJECT_REF>:<OWNER_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=<MAC_HOME>/yaparena-private/supabase-ca.crt'
   COIN_SANDBOX_OWNER_DATABASE_URL='<the same URL as DATABASE_URL>'
   COIN_SANDBOX_RAIL=simulation
   ```

5. **Runtime file**, read-only, for the trial report. Run `nano ~/yaparena-private/runtime.env`:

   ```text
   TRANSCRIPTION_TRIAL_DATABASE_URL='postgresql://yaparena_runtime.<PROJECT_REF>:<RUNTIME_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=<MAC_HOME>/yaparena-private/supabase-ca.crt'
   ```

6. Make both files readable only by you:

   ```sh
   chmod 600 ~/yaparena-private/*.env
   ```

- Check: these print `yaparena_owner` and then `yaparena_runtime`:

  ```sh
  (set -a; source ~/yaparena-private/owner.env; psql "$DATABASE_URL" -tAc 'SELECT current_user')
  (set -a; source ~/yaparena-private/runtime.env; psql "$TRANSCRIPTION_TRIAL_DATABASE_URL" -tAc 'SELECT current_user')
  ```

- If it prints:
  - `password authentication failed`: the password is wrong, or it needs encoding (item 3).
  - `Tenant or user not found`: the user part must be `yaparena_owner.<PROJECT_REF>` (or
    `yaparena_runtime.<PROJECT_REF>`).
  - `root certificate file … does not exist`: fix the `sslrootcert` path.
  - `command not found: psql`: run `brew install postgresql@17`, then retry.

### 0.4 Prepare the release checkout

Terminal. The first line is your existing YapArena clone; change it if yours is elsewhere:

```sh
cd ~/Documents/Codex/YapArena
git fetch origin
git worktree add --detach ~/yaparena-release <COMMIT_SHA>
cd ~/yaparena-release
node --version
npm ci
npm run build
```

If `~/yaparena-release` already exists from an earlier release, replace the third line with
`git -C ~/yaparena-release checkout --detach <COMMIT_SHA>`. `npm ci` matters: #96 added the
`@livekit/agents` packages.

Then install the LiveKit CLI and link it to the staging project:

```sh
brew install livekit-cli
lk cloud auth
lk project list
```

`lk cloud auth` opens the browser: sign in to LiveKit Cloud, select the staging project and
confirm. If the terminal asks whether to make it the default project, answer yes.

- Check:
  - `node --version` prints `v24.` followed by more digits.
  - `npm run build` ends without an `error` line.
  - `git -C ~/yaparena-release log -1 --format=%H` prints `<COMMIT_SHA>`.
  - `lk project list` marks the staging project with `*`, and its URL matches Render's
    `LIVEKIT_PUBLIC_URL`.
  - `pg_dump --version` prints `pg_dump (PostgreSQL) 17.` and more digits.
- If:
  - Node isn't version 24: install Node 24 from [nodejs.org](https://nodejs.org), open a new
    Terminal window and rerun from `cd ~/yaparena-release`.
  - The `*` is on another project: `lk project set-default <name of the staging project>`.

### 0.5 Back up the database

Supabase Free makes no automatic backups, so take one now. Terminal:

```sh
(set -a; source ~/yaparena-private/owner.env; pg_dump --format=custom --schema=yaparena --schema=yaparena_migrations --file="$HOME/yaparena-private/staging-before-rollout.dump" --dbname="$DATABASE_URL")
pg_restore --list ~/yaparena-private/staging-before-rollout.dump | head -5
```

- Check: the first command prints nothing. The second prints lines starting with `;`, including
  `; Archive created at` and today's date.
- If:
  - It says `server version mismatch`: install the server's version
    (`brew install postgresql@<its major version>`) and use that `pg_dump`.
  - It says `permission denied`: stop; `owner.env` doesn't sign in as the owner (step 0.3 check).
  - The project is on Supabase Pro: **Database → Backups** also lists today's daily backup.

## 1. Apply the owner migrations

Web refuses to start while migrations are pending, so the owner applies them first. The release
checkout holds the same migration files as the release images.

1. Note where staging stands. In the SQL editor:

   ```sql
   SELECT count(*) AS applied, max(name) AS newest FROM yaparena_migrations.pgmigrations;
   ```

2. Terminal:

   ```sh
   cd ~/yaparena-release
   node --env-file="$HOME/yaparena-private/owner.env" scripts/migrate-database.ts
   ```

This release adds:

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

- Check: it prints `Database migrations completed with the migration identity.` Then, in the SQL
  editor:

  ```sql
  SELECT name, run_on FROM yaparena_migrations.pgmigrations ORDER BY name DESC LIMIT 11;
  ```

  It lists the eleven names above, from `1792986588837_add-challenge-scheduling` down to
  `1792971645611_add-turn-trading-windows`. The `applied` count from item 1 grew by the number of
  names that were new.

- If it prints:
  - `Database migration failed (28P01).`: wrong owner password; fix `owner.env`.
  - `Database migration failed (ENOTFOUND).`: wrong pooler host.
  - `ENOENT: no such file or directory` with the certificate's path: fix `sslrootcert`.
  - `Database migration failed (check provisioning and migration review).`: the URL doesn't sign
    in as `yaparena_owner` (step 0.3 check).
  - Any other `Database migration failed (…)`: a migration failed. Stop: keep the old release
    running, copy the output, send it to S, and deploy nothing. Migrations are never rolled back.

## 2. Deploy web, the jobs worker and the encoder

Do this straight after step 1, without waiting between services: once #100's migration is in, the
previous release can no longer settle five-day rounds, so its coin loop fails until the new release
runs.

First, see how each service gets its code. In Render, open the service, then **Settings**. A
service that shows an **Image URL** is image-backed (use A). One that shows a **Repository** and a
**Branch** builds from GitHub (use B). Check all three; they may differ.

**A. Image-backed services.** For each service, in this order:

1. `yaparena-staging-web` → **Settings** → **Image URL** → **Edit**. Paste `<WEB_IMAGE>`, then
   **Save Changes**.
2. `yaparena-staging-jobs`: the same, also with `<WEB_IMAGE>`; the worker runs the web image.
3. `yaparena-replay-worker`: the same, with `<ENCODER_IMAGE>`.
4. Open each service's **Events**. If no new deploy started within a minute, click **Manual
   Deploy** (top right), then **Deploy latest reference**.

Leave each service's Docker Command as it is: `/bin/sh /app/scripts/start-staging.sh` for web,
`node dist/worker.js` for the jobs worker and `node dist/replay-worker.js` for the encoder.

**B. Services built from GitHub.** On each of the three, click **Manual Deploy** (top right), then
**Deploy a specific commit**, choose or paste `<COMMIT_SHA>`, and click **Deploy**.

Wait until each service's **Events** shows "Deploy live". Web, on Render Free, can take several
minutes.

- Check, Terminal:

  ```sh
  curl -fsS https://yaparena-staging-web.onrender.com/ready
  ```

  prints `{"status":"ready"}`.

  ```sh
  cd ~/yaparena-release
  SMOKE_BASE_URL=https://yaparena-staging-web.onrender.com node scripts/smoke-staging.ts
  ```

  prints a JSON report whose `results` list seven paths: `status` 200 for each, except 401 for
  `/api/measurement/dashboard` and `/measurement`. A failing check stops with an `AssertionError`
  naming the path.

- Check, Render **Logs** (search each):
  - `yaparena-staging-web`: `server started`, once after the deploy.
  - `yaparena-staging-jobs`: `background worker started`, then `background job ran` lines.
  - `yaparena-replay-worker`: `Automatic replay worker started`.
- If:
  - Web's deploy fails and its **Logs** show `database migrations are pending`: step 1 didn't
    complete. Finish it, then deploy web again.
  - The worker's **Logs** repeat coin errors: it isn't running the same commit or image as web;
    compare the two services' **Settings**.
  - To go back, see [Rollback](#rollback).

## 3. Turn on Yap Coins turn windows

Each live turn becomes one Yap Coins trading window. It's safe for user-created debates: their
rounds reveal five days after the debate (#100), and debaters can't take positions in their own
debate.

1. Render → `yaparena-staging-web` → **Environment**. Confirm `COIN_SANDBOX_ENABLED` is `true`.
   Click **+ Add Environment Variable**, enter key `TURN_WINDOWS_ENABLED` and value `true` (if the
   key already exists, edit the value on its row instead), then choose **Save and deploy**.
2. Do the same on `yaparena-staging-jobs`: it opens the windows.
3. Wait for "Deploy live" in both services' **Events**.

- Check: [start a test debate](#start-a-test-debate). Once it's live, Terminal:

  ```sh
  curl -fsS https://yaparena-staging-web.onrender.com/api/public/debates/<debate-id>/windows | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.revealMode,r.windows.map(w=>w.turnNumber+w.side).join(" "))})'
  ```

  Within a second of the start it prints `five_day 1A` (or `1B` if B speaks first). Run it again
  after the first turn change: `five_day 1A 2B`.

- If:
  - curl reports error 404: web doesn't have the switch; check its **Environment** and **Events**.
  - It prints `five_day` and nothing else: the worker doesn't have the switch.
  - To turn it off: set `TURN_WINDOWS_ENABLED` to `false` on both services and **Save and deploy**.

## 4. Per-round reveal for founder-created debates (optional)

Every debate is five-day unless the owner records per-round reveal before its first round opens,
that is, before it goes live. Skip this step unless a founder-created debate should reveal each
round at its cutoff.

1. Get its ID. In the SQL editor,
   `SELECT id, status FROM yaparena.debates WHERE slug = '<debate-slug>';` must show `scheduled` or
   `ready`. Its `id` is `<debate-id>`.
2. Run `nano ~/yaparena-private/reveal-mode.json`, type this line, save and quit:

   ```json
   {
     "debateId": "<debate-id>",
     "mode": "per_round",
     "reason": "Founder-created debate"
   }
   ```

3. Terminal:

   ```sh
   cd ~/yaparena-release
   node --env-file="$HOME/yaparena-private/owner.env" scripts/coin-sandbox-operator.ts set-reveal-mode < ~/yaparena-private/reveal-mode.json
   ```

- Check: it prints
  `{"command":"set-reveal-mode","environment":"sandbox","rail":"simulation","status":"recorded","processed":0}`
  (`"unchanged"` instead of `"recorded"` if it was already recorded). In the SQL editor,
  `SELECT mode FROM yaparena.coin_debate_reveal_modes WHERE debate_id = '<debate-id>';` returns
  `per_round`.
- If it prints:
  - `Sandbox operator command failed; inspect private database audit evidence.`: run
    `SELECT count(*) FROM yaparena.coin_debate_rounds WHERE debate_id = '<debate-id>';`. Above 0
    means a round already opened and the debate stays five-day; 0 means the debate ID is wrong.
  - `COIN_SANDBOX_RAIL must explicitly select simulation or base-sepolia` or
    `dedicated owner connection required`: fix `owner.env` (step 0.3).

## 5. Deploy the transcriber agent to LiveKit Cloud

### 5.1 Make the ingest secret

Terminal:

```sh
openssl rand -hex 32
```

It prints 64 characters: `<INGEST_SECRET>`. Save it in your password manager, for example as
"YapArena staging transcription ingest secret". The agent, web and the jobs worker all get this
same value.

### 5.2 Create the ElevenLabs key (for the trial)

1. Open [elevenlabs.io/app](https://elevenlabs.io/app) and sign in with the account whose plan you
   chose in step 0.2.
2. In the left sidebar, click **Developers**, then the **API Keys** tab, then **Create API key**.
3. Name it `yaparena-staging-transcriber`. Keep **Restrict key** on, set **Speech to Text** to
   **Access** and everything else to **No access**. Optionally set a credit limit.
4. Click **Create** and copy the key; it is shown only once. This is `<ELEVENLABS_KEY>`; save it in
   your password manager.

### 5.3 Create the Anthropic key (for the AI outline)

1. Open the [Claude Console](https://platform.claude.com) and sign in with the account that holds
   the API credits from step 0.2.
2. Click **Settings**, then **API keys**, then **Create Key**. Choose the **Default** workspace,
   name it `yaparena-staging-outline`, and click **Add**.
3. Copy the key, which starts with `sk-ant-` and is shown only once. This is `<ANTHROPIC_KEY>`;
   save it in your password manager.

### 5.4 Write the agent's secrets file

Run `nano ~/yaparena-private/transcriber-secrets.env`, type these lines with your values (no
quotes, no spaces around `=`), save and quit:

```text
YAPARENA_INGEST_URL=https://yaparena-staging-web.onrender.com
TRANSCRIPTION_INGEST_SECRET=<INGEST_SECRET>
TRANSCRIPTION_PROVIDER=deepgram
TRANSCRIPTION_SHADOW_PROVIDER=elevenlabs
ELEVEN_API_KEY=<ELEVENLABS_KEY>
ANTHROPIC_API_KEY=<ANTHROPIC_KEY>
```

Then `chmod 600 ~/yaparena-private/transcriber-secrets.env`. Deepgram runs through LiveKit
Inference and needs no key. LiveKit sets the agent's own URL and keys. The other settings
([staging guide](render-staging.md#enable-live-transcription-and-captions)) keep their defaults.

### 5.5 Stage and deploy the agent

Terminal:

```sh
cd ~/yaparena-release
node scripts/stage-transcriber.ts ~/yaparena-transcriber-deploy
lk agent list
```

The first command prints `staged the transcriber build context in <MAC_HOME>/yaparena-transcriber-deploy`.

**If `lk agent list` shows no agent** (the first time):

```sh
cd ~/yaparena-transcriber-deploy
lk agent create --region us-east --secrets-file ~/yaparena-private/transcriber-secrets.env .
```

Answer `y` if it asks you to confirm. It writes `livekit.toml` into the folder (later restaging
keeps it), then builds and deploys the agent. The region can't change later. `us-east` (Ashburn,
Virginia) is the nearest to Render's Ohio web service and to North American debaters; choose
`eu-central` (Frankfurt) only if most debaters will be in Europe.

**If an agent already exists:**

```sh
cd ~/yaparena-transcriber-deploy
lk agent update-secrets --secrets-file ~/yaparena-private/transcriber-secrets.env
lk agent deploy .
```

- Check:
  - `lk agent status` shows one row whose **Status** is `Running`. While it says `Building` or
    `Setting Up`, wait a minute and run it again.
  - `lk agent logs` shows `registered worker`. Press Ctrl+C to stop following the logs.
  - LiveKit Cloud's **Agents** page shows the same agent as running.
- If the status is:
  - `Build Failed`: `lk agent logs --log-type build` shows why. Restage (the first command block),
    then run `lk agent deploy .` in `~/yaparena-transcriber-deploy`.
  - `CrashLoop`: `lk agent logs` names the bad setting, for example
    `TRANSCRIPTION_INGEST_SECRET must be at least 32 bytes` or
    `ELEVEN_API_KEY is required for ElevenLabs transcription`. Fix the file, then run
    `lk agent update-secrets --secrets-file ~/yaparena-private/transcriber-secrets.env` there.
- Never run the agent locally with `start` against staging: it would compete for real debates.

## 6. Turn on captions and the AI outline

1. Render → `yaparena-staging-web` → **Environment**. Add (or edit) `LIVE_OUTLINE_ENABLED` with
   value `true` and `TRANSCRIPTION_INGEST_SECRET` with value `<INGEST_SECRET>`, then choose **Save
   and deploy**.
2. Do the same on `yaparena-staging-jobs`: it sends the agent to debates.
3. Wait for "Deploy live" in both services' **Events**.
4. In A's and B's browser profiles, open `https://yaparena-staging-web.onrender.com/account`,
   **Profile** tab, **Debating** card. Choose **Language you debate in** (`Français` for A and
   `English` for B, as the trial needs), tick the agreement box, and click **Save debating
   settings**. It reads "Saved. You're ready to debate."
5. In a second Terminal tab, follow the agent's logs:

   ```sh
   cd ~/yaparena-transcriber-deploy
   lk agent logs
   ```

6. [Start a test debate](#start-a-test-debate).

- Check:
  - The **Debating** card appears at all; it stays hidden while web doesn't have the switch.
  - Within a second of the debate becoming ready, the logs show
    `{"message":"transcriber joined","debateId":"<debate-id>","provider":"deepgram","shadow":"elevenlabs"}`.
  - Captions appear under the video. The **AI outline** panel fills within a few seconds of each
    sentence, and the logs show `live outline call` lines; after a turn's first call, their
    `cacheReadTokens` is above 0.
  - A few seconds after each turn, the logs show a `window cleanup call` line.
  - In the SQL editor, during the debate,

    ```sql
    SELECT role, provider, count(*) FROM yaparena.transcript_segments
    WHERE debate_id = '<debate-id>' GROUP BY 1, 2;
    ```

    returns two rows, `primary` `deepgram` and `shadow` `elevenlabs`, whose counts grow.

  - After each turn,

    ```sql
    SELECT turn_number, final_source, final_model FROM yaparena.outline_windows
    WHERE debate_id = '<debate-id>' ORDER BY 1;
    ```

    shows `cleanup` with a Claude Sonnet model, or `frozen` when no cleanup arrived within a minute.

- If the logs show:
  - `debate is not awaiting transcription` with `"status":"unknown"`: the app refused the agent.
    The ingest secret differs between the agent and web, `YAPARENA_INGEST_URL` is wrong, or web
    lacks `LIVE_OUTLINE_ENABLED`.
  - Nothing at all for this debate: the worker didn't send the agent. Search the worker's **Logs**
    for `transcriber dispatch failed`, and check that both speakers saved the **Debating** card.
  - `transcript update refused` with `"status":403`: that speaker hasn't agreed on the **Debating**
    card.
  - `speech provider error` with `"provider":"elevenlabs"`: check the ElevenLabs key, its **Speech
    to Text** permission and the plan.
  - `live outline call failed` with `"status":401`: the Anthropic key is wrong; with `400`, the
    credits have probably run out (step 0.2).
- To turn it off: set `LIVE_OUTLINE_ENABLED` to `false` on web and the worker and **Save and
  deploy**. The agent then gets no debates.

## 7. Run the provider trial

Two debates read from the same scripts. Session 1 uses Deepgram for captions and the outline and
runs ElevenLabs in the shadow on the same audio; session 2 swaps them. What it measures and the
targets are in the [transcription provider trial](transcription-provider-trial.md). Allow about an
hour for the sessions and an hour for scoring.

You need test accounts A (French) and B (English) with the **Debating** card saved (step 6, item 4) on two computers or phones with the microphones users would use; a third device as viewer,
ideally a phone that can record its screen; and the operator account.

### 7.1 Write the scripts

Write `~/yaparena-private/trial/script-fr.txt` for A and `~/yaparena-private/trial/script-en.txt`
for B: five turns each, about 60 seconds of speech per turn (130 to 150 words), on the trial topic.
Include numbers ("1,2 million", "2035"), proper names and technical terms, and in two turns, a
sentence that ends right at the turn deadline. Speakers read naturally, at a normal pace.

### 7.2 Session 1: Deepgram primary, ElevenLabs shadow

1. Check that `~/yaparena-private/transcriber-secrets.env` says `TRANSCRIPTION_PROVIDER=deepgram`
   and `TRANSCRIPTION_SHADOW_PROVIDER=elevenlabs`, as step 5 deployed it.
2. In a second Terminal tab, keep the agent's logs for this session:

   ```sh
   cd ~/yaparena-transcriber-deploy
   lk agent logs | tee ~/yaparena-private/trial/agent-session-1.log
   ```

3. Start a test debate (A on side A, B on side B), items 4 to 8 of
   [start a test debate](#start-a-test-debate).
4. On the viewer phone, open `https://yaparena-staging-web.onrender.com/debates/<debate-slug>`,
   tap **Join as viewer** and **Enable sound**, and start a screen recording (iPhone: Control
   Center, then **Screen Recording**; Android: Quick Settings, then **Screen record** with media
   sound). Keep the captions and the AI outline panel in view.
5. A and B read their scripts, one turn each, until the debate ends.
6. Stop the screen recording, then press Ctrl+C in the second tab. Keep the debate's ID as
   `<debate-id-1>`.

- Check, in the SQL editor:

  ```sql
  SELECT turn_number, side, language, role, provider, count(*) AS segments
  FROM yaparena.transcript_segments WHERE debate_id = '<debate-id-1>'
  GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 4;
  ```

  Every turn has a `primary` `deepgram` row and a `shadow` `elevenlabs` row. Keep this result: it
  gives each turn's number and language for the references (7.4).

- If a turn has no `shadow` row, search the session's log for `speech provider error`.

### 7.3 Session 2: ElevenLabs primary, Deepgram shadow

1. Swap the providers. Terminal:

   ```sh
   cd ~/yaparena-transcriber-deploy
   lk agent update-secrets --secrets TRANSCRIPTION_PROVIDER=elevenlabs --secrets TRANSCRIPTION_SHADOW_PROVIDER=deepgram
   lk agent status
   ```

   The update restarts the agent; rerun `lk agent status` until it shows `Running`. Then change
   the same two lines in `~/yaparena-private/transcriber-secrets.env`, so that a later update from
   the file doesn't swap them back.

2. Repeat 7.2 from item 2, with `agent-session-2.log`, a new debate `<debate-id-2>` and the same
   scripts.

- Check: the log's `transcriber joined` line shows `"provider":"elevenlabs","shadow":"deepgram"`,
  and the 7.2 query for `<debate-id-2>` shows `primary` `elevenlabs` and `shadow` `deepgram` rows.

### 7.4 Write the reference transcripts

A reference is what the speakers actually said, written by a person. Make one per session:

1. A few minutes after a debate ends, open its page and click **Play replay**.
2. For each turn, start from the script's text and correct it to what was said: words skipped,
   repeated, changed or added. Never copy either provider's text.
3. Run `nano ~/yaparena-private/trial/reference-1.json` and write one entry per turn, with the
   turn number and language from the 7.2 query:

   ```json
   {
     "turns": [
       {
         "turnNumber": 1,
         "language": "fr",
         "text": "Le nucléaire est pilotable : il produit à la demande."
       },
       {
         "turnNumber": 2,
         "language": "en",
         "text": "Renewables are cheaper and faster to build."
       }
     ]
   }
   ```

   Leave out any turn you don't want scored. Write `reference-2.json` the same way for session 2.

- Check:

  ```sh
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.turns.length+" turns")' ~/yaparena-private/trial/reference-1.json
  ```

  prints `10 turns` (or however many you wrote). A `SyntaxError` names the place to fix, usually a
  missing comma or quote.

Scoring lowercases, removes punctuation and splits French elisions (`l'énergie` is `l'` and
`énergie`), the same way for the reference and both providers, so only words count.

### 7.5 Run the report

Look up the current prices per hour of audio. Deepgram Nova-3 on LiveKit Inference is on
[livekit.com/pricing](https://livekit.com/pricing): $0.0048 a minute ($0.288 an hour) on Build and
Ship when read on 2026-10-26. ElevenLabs Scribe v2 Realtime is on
[elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) (the script's default is $0.39 an
hour); call it `<ELEVENLABS_PER_HOUR>`. Terminal:

```sh
cd ~/yaparena-release
node --env-file="$HOME/yaparena-private/runtime.env" scripts/transcription-trial.ts <debate-id-1> ~/yaparena-private/trial/reference-1.json --deepgram-per-hour=0.288 --elevenlabs-per-hour=<ELEVENLABS_PER_HOUR> | tee ~/yaparena-private/trial/report-1.json
node --env-file="$HOME/yaparena-private/runtime.env" scripts/transcription-trial.ts <debate-id-2> ~/yaparena-private/trial/reference-2.json --deepgram-per-hour=0.288 --elevenlabs-per-hour=<ELEVENLABS_PER_HOUR> | tee ~/yaparena-private/trial/report-2.json
```

- Check: each prints JSON with four `rows`, one per provider and language. One row looks like this
  (the numbers are only an example):

  ```json
  {
    "provider": "deepgram",
    "role": "primary",
    "language": "en",
    "turns": 5,
    "words": 690,
    "errors": 41,
    "substitutions": 25,
    "deletions": 9,
    "insertions": 7,
    "wer": 0.0594,
    "latencyP50Ms": 420,
    "latencyP95Ms": 910,
    "audioMinutes": 5.1,
    "costPerMinute": 0.0048,
    "estimatedCost": 0.0245
  }
  ```

  `wer` is the word error rate as a fraction: 0.0594 is 5.9%. The latencies run from the end of
  speech to the final text. `estimatedCost` is this session's cost in US dollars.

- If it prints:
  - `"rows": []`: the debate ID is wrong, or the reference's turn numbers don't match the debate.
  - `trial report failed; check the database URL and the debate id`: check `runtime.env` with the
    step 0.3 check, then the ID.
  - `the reference needs turns: [{ turnNumber, language, text }]`: fix the JSON's field names.
  - `Cannot find module` with `dist`: run `npm run build` in `~/yaparena-release`.

### 7.6 Measure the caption and outline delays

Use the two screen recordings: session 1 shows Deepgram's captions, session 2 ElevenLabs'. On a
Mac, open each in QuickTime Player. **Window → Show Movie Inspector** shows its frame rate (FPS).
To time a delay, pause where the event starts, press the Right arrow key one frame at a time until
the result shows, and divide the number of presses by the frame rate.

1. **Captions:** for ten sentence ends, time from the last word heard to the caption showing that
   sentence's final text. Note the median and the largest. Target: 1 second or less.
2. **Outline:** for ten sentences, time from the sentence's end to the AI outline panel's change.
   Note the median and the largest. Target: 3 seconds typical, 5 at most.
3. **The model's share** of the outline delay, in milliseconds per call:

   ```sh
   grep '"live outline call"' ~/yaparena-private/trial/agent-session-1.log | grep -o '"latencyMs":[0-9]*'
   ```

   The rest of the delay is the app and LiveKit delivery.

### 7.7 Fan-out check (optional)

Decision 0012 expects 500 viewers to receive the outline through LiveKit without extra work for the
web service. The LiveKit CLI simulates at most 50 viewers, and LiveKit's acceptable use policy
restricts load tests on LiveKit Cloud, so this is a small check; ask LiveKit before testing more.
The simulated viewers don't run the page: the check covers LiveKit's delivery, not browser code.

1. During a debate with the outline on (a third session, or session 2), in a third Terminal tab:

   ```sh
   lk load-test --room debate-<debate-id> --subscribers 50 --duration 5m
   ```

   It downloads the debate's audio and video 50 times, so use a fast connection.

- Check:
  - The viewer phone's outline keeps updating within the delays you measured.
  - Render → `yaparena-staging-web` → **Metrics**: CPU stays flat during those 5 minutes.
  - The table that `lk load-test` prints at the end shows packet loss near 0%.

### 7.8 Record the results and choose the provider

1. Copy the results table from the [trial](transcription-provider-trial.md#results) into
   `~/yaparena-private/trial/results.md` and fill in one row per report row. Give WER as a
   percentage. The caption and outline delays belong to the primary rows.
2. Send `results.md`, `report-1.json` and `report-2.json` to the hub session for S's post-trial
   docs PR. They contain no transcript text, account details or secrets. Don't send the scripts,
   references or recordings.
3. Choose the primary provider: the lower WER, at an acceptable latency and cost. Then run it alone
   (the shadow doubles speech-to-text cost). In `~/yaparena-private/transcriber-secrets.env`, set
   `TRANSCRIPTION_PROVIDER` to `deepgram` or `elevenlabs`, delete the
   `TRANSCRIPTION_SHADOW_PROVIDER` line, and delete the `ELEVEN_API_KEY` line if Deepgram won. Then:

   ```sh
   cd ~/yaparena-transcriber-deploy
   lk agent update-secrets --secrets-file ~/yaparena-private/transcriber-secrets.env --overwrite
   ```

   `--overwrite` replaces all the agent's secrets with the file's, which removes the shadow.

- Check: at the next debate, the `transcriber joined` line shows `"shadow":"none"`.
- If Deepgram won, you can delete the ElevenLabs key: **Developers** → **API Keys**, the key's
  menu, **Delete**.

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

| Placeholder                | Where to find it                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `<staging-host>`           | Render → web service → the address under its name at the top, without `https://`: `yaparena-staging-web.onrender.com` |
| `<capacity>`               | The number you choose in 8.1                                                                                          |
| `<handle-a>`, `<handle-b>` | The handles you give accounts A and B in 8.5                                                                          |
| `<topic-slug>`             | The "URL slug" you type when creating the trial topic in 8.5, for example `staging-queue-trial`                       |
| `<debate-slug>`            | The end of a debate page's address: `https://<staging-host>/debates/<debate-slug>`                                    |
| `<debate-id>`              | The `id` returned by the first query in the 8.6 checks                                                                |

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

- **Migrations** are additive and stay; never roll back the schema. The step 0.5 backup is for a
  data accident, not for undoing a release.
- **Feature switches:** in Render, open the service's **Environment**, set `TURN_WINDOWS_ENABLED` or
  `LIVE_OUTLINE_ENABLED` to `false`, and choose **Save and deploy**; do it on both
  `yaparena-staging-web` and `yaparena-staging-jobs`. To stop only the AI outline and keep
  captions, delete the `ANTHROPIC_API_KEY` line from `~/yaparena-private/transcriber-secrets.env`,
  then, in `~/yaparena-transcriber-deploy`, run
  `lk agent update-secrets --secrets-file ~/yaparena-private/transcriber-secrets.env --overwrite`.
- **Code:** prefer fixing forward ([deploy a later commit](render-staging.md#deploy-a-later-commit)):
  after #100's migration, the previous release can't settle five-day rounds. To go back anyway, take
  the previous release's images or commit from an older line of step 0.1's list. Image-backed
  services: **Settings** → **Image URL** → **Edit**, paste the previous image, **Save Changes**.
  Services built from GitHub: **Manual Deploy** → **Deploy a specific commit** → the previous
  commit.
- **Agent:** in the Terminal,

  ```sh
  cd ~/yaparena-transcriber-deploy
  lk agent versions
  lk agent rollback --version <previous version>
  ```

  `lk agent versions` lists the deployed versions and their dates.

- **Matchmaking:** set `MATCHMAKING_ENABLED=false` on web and the worker and deploy; see
  [turning it off](#8-matchmaking-m) for what stays.
