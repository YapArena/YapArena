# Production rollout (yaparena.com)

Prepared on 2026-10-29 and not run yet. This runbook builds production as a separate copy of the
staging stack and puts it at **https://yaparena.com**. The founder performs each step; nothing here
runs by itself. Each step says where to do it, how long it takes, every command and click, the
output that proves it worked, and what to do when it doesn't. Background is in the
[staging guide](render-staging.md), the [staging rollout](staging-rollout.md) (the same procedures
on staging), the [database isolation runbook](security/database-isolation.md) and the
[operations runbook](operations.md).

Secrets are named here, never written down. Their values live in your password manager, the
private folder from step 0.3, Render, and each provider's dashboard. Never paste them into a chat,
an issue or the repository. **Never copy a staging secret into production:** production gets its
own value of every secret, and shares no project, tenant, bucket or key with staging.

**Decisions (founder, 2026-10-29):**

- **One address.** `https://yaparena.com` is the only canonical address. `https://www.yaparena.com`
  and every `http://` address only redirect there, keeping the path and query.
- **Full launch.** Video debates, Yap Coins turn windows, the AI outline and matchmaking are on from
  the first day, so all video setup (step 7) happens before the DNS switch.
- **Nothing blocks the DNS switch.** The privacy policy and terms pages, the F04 database check on
  production, a tried restore, uptime alerts and account deletion all follow after launch
  ([step 9](#9-open-items-at-launch)).
- **One image per release.** Staging and production both run CI-published image digests, and
  production only ever runs a digest staging ran first. Step 1 switches staging's services to CI
  images once.
- **Empty start.** Production's database starts empty. No staging account, debate or coin is copied.

## At a glance

Plan four sittings. Start step 2 a day early: moving the nameservers can take up to a day.

| Step                                                       | What happens                                                | Where                         | Time               |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- | ------------------ |
| [0](#0-before-you-start)                                   | Accounts, plans, tools, private folder                      | Browser, Terminal             | 1–1½ h             |
| [1](#1-switch-staging-to-ci-images-and-choose-the-release) | Staging runs CI images; the launch release is chosen        | GitHub, Render, Terminal      | 45 min             |
| [2](#2-move-yaparenacoms-dns-to-cloudflare)                | yaparena.com's DNS moves to Cloudflare                      | Registrar, Cloudflare         | 30 min, then ≤ 1 d |
| [3](#3-resend-for-sign-in-emails)                          | Resend sends from `no-reply@yaparena.com`                   | Resend, Cloudflare            | 30 min             |
| [4](#4-google-sign-in-client)                              | Production's own Google sign-in client                      | Google Cloud                  | 20 min             |
| [5](#5-auth0-production-tenant)                            | Auth0 tenant on `auth.yaparena.com`                         | Auth0, Cloudflare             | 1–1½ h             |
| [6](#6-production-database)                                | Supabase project, identities, migrations, first backup      | Supabase, Terminal            | 1 h                |
| [7](#7-video-livekit-r2-replay-edge-and-transcriber)       | LiveKit, R2, the replay edge, the transcriber agent         | LiveKit, Cloudflare, Terminal | 1½ h               |
| [8](#8-render-services)                                    | `yaparena-web`, `yaparena-jobs` and `yaparena-encoder`      | Render, Terminal              | 1 h                |
| [9](#9-open-items-at-launch)                               | What follows after launch                                   | Separate tasks                | —                  |
| [10](#10-connect-yaparenacom)                              | yaparena.com points at production; certificates             | Render, Cloudflare            | 30 min–1 h         |
| [11](#11-launch-checks)                                    | Redirects, sign-up, sign-out, a two-account debate, staging | Browsers, phone, Terminal     | 1–1½ h             |
| [Releasing](#releasing-from-now-on), [Rollback](#rollback) | Every later release, and going back                         | GitHub, Render, Terminal      | 45 min per release |

Everything can be undone except the migrations and what's fixed when it's created: the Auth0
tenant's name and region, the LiveKit project's region, the transcriber agent's region and the
Google project's ID. Nobody can reach production until step 10, so steps 0 to 8 are safe to pause.

## Accounts and monthly costs

Prices as read on 2026-10-29 on each provider's pricing page; check them again before you confirm.
The fixed part is about **$96 a month** (Render $21, Supabase $25, LiveKit $50), plus usage.

| Account                                       | What it's for                                       | Plan                                  | Monthly cost                                                                                     | Used in    |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Render, the workspace that holds staging      | `yaparena-web`, `yaparena-jobs`, `yaparena-encoder` | Hobby workspace; each service Starter | $7 per service, $21 in all. Hobby includes 5 GB of outbound bandwidth, then $0.15 per GB         | 1, 8, 10   |
| Supabase, a **new** organization              | The production database                             | Pro                                   | $25, which includes $10 of compute: one Micro database. Daily backups kept 7 days                | 6, 9       |
| Auth0, a **new** tenant                       | Sign-in on `auth.yaparena.com`                      | Free (a card on file, not charged)    | $0 up to 25,000 monthly active users; includes one custom domain                                 | 5          |
| Resend (new)                                  | Sign-in code emails from `no-reply@yaparena.com`    | Free to start                         | $0 for 3,000 emails a month and **100 a day**; Pro is $20 for 50,000 a month with no daily limit | 3, 5       |
| Google Cloud, a new project                   | Production's Google sign-in client                  | No plan                               | $0                                                                                               | 4          |
| LiveKit Cloud, a **new** project              | Video, recording, the transcriber agent             | Ship                                  | $50: 600 recording minutes, 5,000 agent minutes, $5 of speech-to-text, then per minute           | 7          |
| Cloudflare, the account that holds staging R2 | DNS, the media bucket, the replay edge              | Free; Workers Free                    | $0: R2 10 GB free, then $0.015 per GB; Workers 100,000 requests a day, Workers Paid $5 for more  | 2, 7, 10   |
| Claude Console, a new workspace               | The AI outline (Claude Haiku and Sonnet)            | Prepaid credits                       | About $0.50 per 10-minute debate                                                                 | 7          |
| A password manager                            | Every secret below                                  | Any                                   | —                                                                                                | Throughout |
| Two email addresses you can read              | Your production account and a second test one       | Free (`you+b@gmail.com` works)        | —                                                                                                | 11         |

Three limits to watch after launch:

- **Resend's 100 emails a day.** Every email-code sign-in sends one. If you expect more than about
  80 a day, move to Pro before announcing the site.
- **Render's 5 GB of bandwidth.** Pages, scripts and images count; video and replays don't (they go
  through LiveKit and Cloudflare). Render's **Billing** page shows the month's use.
- **Workers Free's 100,000 requests a day.** Each replay viewer makes a request for every few
  seconds of video. Past the limit the edge answers with Cloudflare error 1027; Workers Paid ($5)
  lifts it.

Staging keeps its own accounts and plans: web on Render Free, its Supabase project on Free, its own
Auth0 tenant, LiveKit project, R2 bucket and edge.

## How to use this runbook

**Where things are.** Each item names one of these places. Production's names never contain
`staging`; check the name before every click.

- **Terminal:** the macOS Terminal app. Unless an item says otherwise, run commands in the release
  checkout from step 1.2 (`cd ~/yaparena-release`). Paste a command block as it is and press
  Return. Replace every `<PLACEHOLDER>` first, angle brackets included.
- **Render:** [dashboard.render.com](https://dashboard.render.com), the workspace that holds staging.
  Production adds `yaparena-web` (web service), `yaparena-jobs` and `yaparena-encoder` (background
  workers). Staging's are `yaparena-staging-web`, `yaparena-staging-jobs` and
  `yaparena-replay-worker`. A service's left pane has **Events**, **Logs**, **Environment**,
  **Settings** and **Metrics**, as in the [staging rollout](staging-rollout.md#how-to-use-this-runbook).
- **Supabase SQL editor:** [supabase.com/dashboard](https://supabase.com/dashboard), the
  `yaparena-production` project, **SQL Editor**, then **+ New query**. Check the project name at the
  top before running anything.
- **Cloudflare:** [dash.cloudflare.com](https://dash.cloudflare.com), the account that holds the
  staging R2 bucket. **DNS → Records** is under the `yaparena.com` site; **R2** and **Workers &
  Pages** are in the left sidebar at the account level.
- **Auth0:** [manage.auth0.com](https://manage.auth0.com). The tenant menu at the top left switches
  between the staging tenant and `yaparena-production`.
- **LiveKit Cloud:** [cloud.livekit.io](https://cloud.livekit.io), the project menu at the top left.

**Values you'll fill in:**

| Placeholder                                                  | What it is                                                                                     | Where you get it  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------- |
| `<COMMIT_SHA>`, `<RUN_ID>`                                   | The launch release's commit (40 characters) and its CI run                                     | Step 1.1          |
| `<WEB_IMAGE>`, `<ENCODER_IMAGE>`                             | `ghcr.io/yaparena/yaparena@sha256:…` and `ghcr.io/yaparena/yaparena-encoder@sha256:…`          | Step 1.1          |
| `<MAC_HOME>`                                                 | Your home folder, for example `/Users/yourname`                                                | `echo $HOME`      |
| `<YOUR_EMAIL>`                                               | An address you read, for reports and support                                                   | You               |
| `<AUTH0_CNAME_TARGET>`                                       | The host Auth0 gives for `auth.yaparena.com`                                                   | Step 5.2          |
| `<PROJECT_REF>`, `<POOLER_HOST>`                             | The production Supabase project ID and its session pooler host                                 | Step 6.2          |
| `<ADMIN_PASSWORD>`, `<OWNER_PASSWORD>`, `<RUNTIME_PASSWORD>` | The production `postgres`, `yaparena_owner` and `yaparena_runtime` passwords                   | Steps 6.1 and 6.3 |
| `<LIVEKIT_HOST>`                                             | The production LiveKit project's host, `yaparena-production-….livekit.cloud`                   | Step 7.1          |
| `<R2_ACCOUNT_ID>`                                            | Your Cloudflare account ID                                                                     | Step 7.2          |
| `<SIGNING_SECRET>`, `<INGEST_SECRET>`                        | The replay edge secret and the transcriber ingest secret, both new                             | Steps 7.3 and 7.5 |
| `<RENDER_HOST>`                                              | `yaparena-web`'s own address, for example `yaparena-web.onrender.com` (Render may add letters) | Step 8.3          |
| `<handle-a>`, `<handle-b>`, `<topic-slug>`, `<debate-slug>`  | Your production accounts' handles, the first topic and a debate's address                      | Step 11           |

**DNS records production adds** in Cloudflare (all **DNS only**, the grey cloud):

| Type  | Name                | Content                                     | Step |
| ----- | ------------------- | ------------------------------------------- | ---- |
| MX    | `send`              | Resend's feedback host, priority 10         | 3    |
| TXT   | `send`              | Resend's SPF value                          | 3    |
| TXT   | `resend._domainkey` | Resend's DKIM key                           | 3    |
| TXT   | `_dmarc`            | `v=DMARC1; p=none; rua=mailto:<YOUR_EMAIL>` | 3    |
| CNAME | `auth`              | `<AUTH0_CNAME_TARGET>`                      | 5.2  |
| CNAME | `@`                 | `<RENDER_HOST>`                             | 10   |
| CNAME | `www`               | `<RENDER_HOST>`                             | 10   |

Wrangler creates `replay.yaparena.com` itself in step 7.3; it is the only proxied (orange) record.

## 0. Before you start

### 0.1 Log in to each account

Time: 30 minutes, plus 10 for each new account.

1. **Render.** Sign in at [dashboard.render.com](https://dashboard.render.com) and pick the staging
   workspace. Under **Workspace Settings → Billing**, make sure a card is on file: Starter services
   are billed per month.
   - Check: the service list shows the three staging services.
2. **Supabase.** Sign in. Production goes in a **new organization** (step 6.1), so staging's
   organization keeps its plan.
3. **Auth0.** Sign in at [manage.auth0.com](https://manage.auth0.com). Step 5.1 creates the tenant.
4. **Resend.** Sign up at [resend.com](https://resend.com) with `<YOUR_EMAIL>`.
5. **Google Cloud.** Sign in at [console.cloud.google.com](https://console.cloud.google.com) with the
   Google account that should own the sign-in client. Accept the terms if it's the first time.
6. **LiveKit Cloud.** Sign in at [cloud.livekit.io](https://cloud.livekit.io).
7. **Cloudflare.** Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) with the account that
   holds staging's R2 bucket.
8. **Claude Console.** Sign in at [platform.claude.com](https://platform.claude.com).
9. **Password manager.** Make a folder named "YapArena production". Every secret in this runbook
   goes there, never in the staging folder.

### 0.2 Check the tools

Time: 5 minutes if the [staging rollout's tools](staging-rollout.md#02-install-the-tools) are
installed; 15 otherwise.

```sh
gh auth status
lk --version
psql --version
node --version
```

- Check: `Logged in to github.com`, an `lk` version, `(PostgreSQL) 17.` (or newer) and `v24.`.
- If one is missing, install it as in the staging rollout's step 0.2.

### 0.3 Make the production private folder

Time: 2 minutes. Terminal:

```sh
mkdir -p ~/yaparena-private/production && chmod 700 ~/yaparena-private ~/yaparena-private/production
echo $HOME
```

The second line prints `<MAC_HOME>`. Production's files go in this folder, never next to staging's.

## 1. Switch staging to CI images and choose the release

Production runs only an image that staging ran first. Today staging's three services build from
GitHub, so this step switches them, once, to the images CI publishes. Their plan, address,
environment and Blueprint entries don't change.

### 1.1 Choose the launch release

Time: 5 minutes. Terminal, in any folder:

```sh
gh run list --repo YapArena/YapArena --workflow CI --branch main --event push --limit 5 \
  --json status,conclusion,databaseId,headSha,displayTitle \
  --jq '.[] | "\(.status) \(.conclusion) \(.databaseId) \(.headSha) \(.displayTitle)"'
```

Take the first line that starts with `completed success`: its third word is `<RUN_ID>` and its fourth
is `<COMMIT_SHA>`. Open `https://github.com/YapArena/YapArena/actions/runs/<RUN_ID>`; on its
**Summary** page, under **web image** and **encoder image**, copy each `ghcr.io/…@sha256:…` line:
they are `<WEB_IMAGE>` and `<ENCODER_IMAGE>`.

- Check: both lines start with `ghcr.io/yaparena/` (older pages say `ghcr.io/boufe/`; the images
  moved with the repository).
- The privacy and terms pages ([9.1](#91-privacy-and-terms-pages)) come in a later release, through
  [Releasing from now on](#releasing-from-now-on).

### 1.2 Prepare the release checkout

Time: 10 minutes. Terminal:

```sh
cd ~/Documents/Codex/YapArena
git fetch origin
git -C ~/yaparena-release checkout --detach <COMMIT_SHA> 2>/dev/null || git worktree add --detach ~/yaparena-release <COMMIT_SHA>
cd ~/yaparena-release
npm ci
npm run build
```

- Check: `git -C ~/yaparena-release log -1 --format=%H` prints `<COMMIT_SHA>`, and `npm run build`
  ends without an `error` line.

### 1.3 Migrate staging

Time: 5 minutes. Exactly as [step 1 of the staging rollout](staging-rollout.md#1-apply-the-owner-migrations),
with staging's owner file:

```sh
cd ~/yaparena-release
node --env-file="$HOME/yaparena-private/owner.env" scripts/migrate-database.ts
```

- Check: `Database migrations completed with the migration identity.`

### 1.4 Switch staging's three services to images

Time: 20 minutes.

1. Render → **Blueprints** (left sidebar). If a Blueprint lists `yaparena-staging-web`, open it,
   then **Settings**, and set **Auto Sync** to **No**. Its file still describes builds from GitHub,
   so a sync would conflict with the image source.
2. `yaparena-staging-web` → **Settings** → **Build** → **Source** → **Edit**. Choose an existing
   image, paste `<WEB_IMAGE>`, and click **Save Changes**. Keep **Docker Command**
   `/bin/sh /app/scripts/start-staging.sh`, the health check `/ready` and every variable.
3. `yaparena-staging-jobs`: the same, with `<WEB_IMAGE>` and Docker Command `node dist/worker.js`.
4. `yaparena-replay-worker`: the same, with `<ENCODER_IMAGE>` and Docker Command
   `node dist/replay-worker.js`.
5. Each service's **Events**: wait for "Deploy live". If none started within a minute, click
   **Manual Deploy** → **Deploy latest reference**.

- Check, Terminal:

  ```sh
  curl -fsS https://yaparena-staging-web.onrender.com/ready
  SMOKE_BASE_URL=https://yaparena-staging-web.onrender.com node scripts/smoke-staging.ts
  curl -sI https://yaparena-staging-web.onrender.com/ | grep -i x-robots-tag
  ```

  The first prints `{"status":"ready"}`. The second prints a JSON report with `status` 200 for each
  path, except 401 for `/api/measurement/dashboard` and `/measurement`. The third prints
  `x-robots-tag: noindex` once the release contains this runbook's pull request.

- Check, Render: each service's **Settings** shows the **Image URL** you pasted. **Logs** show
  `server started` (web), `background worker started` (jobs) and `Automatic replay worker started`
  (encoder).
- If Render offers no image choice for an existing service, stop: the fallback in the
  [staging guide](render-staging.md#switch-the-existing-services) creates new services with new
  addresses, which this rollout doesn't change. Ask the hub.

### 1.5 Test the release on staging

Time: 30 minutes. Run one debate between two test accounts, as in
[8.5 of the staging rollout](staging-rollout.md#85-queue-accept-and-start-automatically): queue,
accept, captions, the AI outline, a turn window, and the replay after it ends.

- Check: the same results as the staging rollout's checks. If anything fails, stop: production
  takes only a release staging passed.

## 2. Move yaparena.com's DNS to Cloudflare

Time: 30 minutes of clicks, then up to a day for the nameservers.

1. Cloudflare → **Domains** → **Onboard a domain**. Enter `yaparena.com`, keep the quick scan of
   existing DNS records, and click **Continue**. Choose the **Free** plan.
2. Cloudflare lists the records its scan found. The scan can miss some, so compare with the list at
   your registrar. Delete the registrar's **parking** records: an `A` record for `yaparena.com` or
   `www` pointing at the registrar's parking or forwarding address, any `CNAME` for `www` to a
   parking host, and any `AAAA` records (Render serves IPv4 only): the record's **Edit** →
   **Delete**. Keep `MX` and `TXT` records only if you already receive email at yaparena.com.
   **Continue**.
3. Cloudflare shows two nameservers, such as `ada.ns.cloudflare.com`. At your registrar, turn
   **DNSSEC** off first if it's on. Then open yaparena.com's nameserver settings, choose **custom
   nameservers**, remove all the existing ones, enter exactly those two, and save.
4. Back in Cloudflare, the site shows **Pending Nameserver Update** until the change is seen. Its
   **Overview** page has a button to check again. Cloudflare emails you when the site is active.
5. Under the yaparena.com site, **SSL/TLS** → **Overview**. The default is **Automatic SSL/TLS**;
   choose **Custom SSL/TLS** → **Full** and save. Never choose **Flexible**: a proxied record would
   then loop between HTTP and HTTPS.
6. Optional, once active: **DNS** → **Settings** → **DNSSEC** → **Enable**, then add the `DS` record
   it shows at your registrar.

- Check, Terminal:

  ```sh
  dig +short NS yaparena.com @1.1.1.1
  ```

  prints the two Cloudflare nameservers, and **Domains** shows yaparena.com as **Active**.

- If after a day it still shows the old nameservers, check the spelling at the registrar.
- From now on, add records in Cloudflare only; the registrar's DNS no longer applies.

## 3. Resend for sign-in emails

Time: 30 minutes.

Auth0 sends sign-in codes. Production's tenant sends them through Resend from
`no-reply@yaparena.com` (Decision 0009 point 11: production has its own email provider).

1. Resend → **Domains** → **+ Add domain**. Enter `yaparena.com`, choose the region
   **North Virginia (us-east-1)**, and click **Add**.
2. Resend lists three records: an `MX` and a `TXT` named `send`, and a `TXT` named
   `resend._domainkey`. If Resend offers **Sign in to Cloudflare** (automatic setup), use it.
   Otherwise, for each record: Cloudflare → yaparena.com → **DNS** → **Records** → **+ Add record**,
   copy the type, name, content and (for MX) priority exactly, and save.
3. Add the DMARC record, which Resend doesn't create: **+ Add record**, type `TXT`, name `_dmarc`,
   content `v=DMARC1; p=none; rua=mailto:<YOUR_EMAIL>;`. `p=none` only reports; after two clean
   weeks of reports, change it to `p=quarantine`.
4. Resend → the domain → **Verify DNS Records**.
5. Resend → **API Keys** → **+ Create API key**. Name `auth0-production`, permission **Sending
   access**, domain `yaparena.com`. Click **Add** and copy the key (shown once, starts with `re_`)
   into the password manager as "Resend production SMTP".

- Check: the domain's status reads **Verified**. It often takes about 15 minutes and can take up to
  72 hours.
- The region can't change later without deleting and re-adding the domain.
- If a record stays **Pending**: in Cloudflare, check that its name is exactly `send` or
  `resend._domainkey` (Cloudflare adds `.yaparena.com` itself) and that the content has no extra
  quotes.

## 4. Google sign-in client

Time: 20 minutes.

Production gets its own Google OAuth client, so its consent screen names yaparena.com and staging's
client stays separate.

1. [console.cloud.google.com](https://console.cloud.google.com) → the project menu at the top →
   **New project**. Name `yaparena-production` (the project ID under it can't change later), then
   **Create**, and select it.
2. Menu → **Google Auth Platform** → **Branding** → **Get started**. **App Information**: app name
   `YAP Arena`, user support email `<YOUR_EMAIL>`, **Next**. **Audience**: **External**, **Next**.
   **Contact Information**: `<YOUR_EMAIL>`, **Next**. Tick the agreement, **Continue**, **Create**.
3. **Branding**: application home page `https://yaparena.com`, privacy policy
   `https://yaparena.com/privacy`, terms of service `https://yaparena.com/terms`. Google requires all
   three links for a public app; the pages come in a later release ([9.1](#91-privacy-and-terms-pages)),
   so the links don't open until then. Under **Authorized domains**, add `yaparena.com`. Leave the
   logo empty: uploading one starts Google's brand verification. **Save**; if the page then offers
   **Publish branding**, click it.
4. **Audience** → **Publish app** → **Confirm**. Publishing status reads **In production**. While
   it says **Testing**, only listed test users can sign in with Google.
5. **Clients** → **+ Create client**. Type **Web application**, name `auth0-production`. Under
   **Authorized JavaScript origins**, add `https://auth.yaparena.com`. Under **Authorized redirect
   URIs**, add exactly `https://auth.yaparena.com/login/callback` (no trailing slash). **Create**.
6. Copy the **Client ID** and the **Client secret** into the password manager as "Google OAuth
   production" straight away: Google shows the secret only once. If you lose it, open the client,
   **Add Secret**, and delete the old one.

- Check: **Clients** lists `auth0-production` with the redirect URI above, and **Audience** reads
  **In production**.
- The app asks only for name, email and profile picture (`openid`, `email`, `profile`), which need
  no Google app verification.
- Until Google verifies the brand, its sign-in screen shows the domain instead of "YAP Arena".
  Brand verification is optional and can come after launch: it needs yaparena.com verified in
  [Google Search Console](https://search.google.com/search-console) (a `TXT` record in Cloudflare)
  and the privacy and terms pages live, then **Branding** → **Verify branding**.

## 5. Auth0 production tenant

### 5.1 Create the tenant

Time: 10 minutes.

1. Auth0 → the tenant menu at the top left → **Create Tenant**.
2. **Tenant Domain** `yaparena-production`, **Region** **US**. **Create**.
3. In the new tenant: **Settings** → **General** → **Environment Tag** → **Production** → **Save**.
   Production rate limits apply only to tenants tagged Production.

- Check: the tenant menu shows `yaparena-production` with a Production tag. Its default domain is
  `yaparena-production.us.auth0.com`; the app never uses it, because production refuses
  `*.auth0.com`.
- The region and the tenant name can't change later. Auth0 also offers Canada (CA), but Render,
  Supabase and LiveKit keep data in the US either way, so US keeps everything in one country. The
  privacy page (9.1) names the region you pick.

### 5.2 Custom domain `auth.yaparena.com`

Time: 20 minutes, mostly waiting.

1. Auth0 needs a card on file for a custom domain, even on the Free plan; it isn't charged.
   **Settings** → **Payment & Billing** → **Add Payment Details** → enter the card → **Update**.
2. **Branding** → **Custom Domains**. Domain `auth.yaparena.com`, certificate type **Auth0-managed
   certificates**, **Add Domain**.
3. Auth0 shows a `CNAME` record. Its content is `<AUTH0_CNAME_TARGET>`. In Cloudflare → **DNS** →
   **+ Add record**: type `CNAME`, name `auth`, target `<AUTH0_CNAME_TARGET>`, **Proxy status: DNS
   only** (grey cloud), **Save**. Auth0 can't issue its certificate behind Cloudflare's proxy. Keep
   the record for good: Auth0 renews the certificate through it every three months.
4. Back in Auth0, click **Verify**. It usually takes a few minutes; wait until the status reads
   **Ready**.
5. On the same page, turn on **Use Custom Domain in Emails**.

- Check, Terminal:

  ```sh
  curl -fsS https://auth.yaparena.com/.well-known/openid-configuration | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).issuer))'
  ```

  prints `https://auth.yaparena.com/`.

- If verification fails: check the record is grey (DNS only) and named `auth`. Auth0 asks you to
  wait at least four hours before trying again; don't delete and re-add the domain.

### 5.3 Send emails through Resend

Time: 10 minutes. Set the provider before the email connection, so no code is ever sent from
Auth0's test provider.

1. **Branding** → **Email Provider** → turn on **Use my own email provider** → **SMTP Provider**.
2. **From**: `no-reply@yaparena.com`. **Host**: `smtp.resend.com`. **Port**: `587`. **Username**:
   `resend`. **Password**: the Resend key from step 3. **Save**.
3. **Send Test Email** to `<YOUR_EMAIL>`.

- Check: the email arrives from `no-reply@yaparena.com`. In Gmail, **⋮** → **Show original** shows
  `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`. Resend → **Emails** lists it as **Delivered**.
- If Auth0 reports an SMTP error: check the key has **Sending access** for yaparena.com, and try
  port `465`. Auth0 → **Monitoring** → **Logs** shows the failure.
- Never rely on Auth0's built-in provider here: Auth0 doesn't support it for production, and it
  sends at most 10 emails a minute.

### 5.4 Identifier First

Time: 2 minutes. **Authentication** → **Authentication Profile** → **Identifier First**, then
**Save** if the page shows it. Universal Login offers email codes only with Identifier First.

### 5.5 The email code connection

Time: 5 minutes.

1. **Authentication** → **Passwordless** → turn **Email** on, then click **Email**.
2. On its **Settings** tab, the connection name is `email` (the app asks for it by that name).
   **From**: `no-reply@yaparena.com`, the same address as the email provider. Take **Subject**,
   **Message**, **OTP Expiry** and **OTP Length** from the staging tenant (step 5.8). Leave
   **Disable Sign Ups** off. **Save**.

### 5.6 The Google connection

Time: 5 minutes.

1. **Authentication** → **Social**. A new tenant usually already lists `google-oauth2` on Auth0's
   shared developer keys, which don't work with a custom domain. Click it. If it isn't there:
   **Create Connection** → **Google / Gmail** → **Continue**, and keep the name `google-oauth2`.
2. Paste the **Client ID** and **Client Secret** from step 4. Keep **Basic Profile** (the email and
   whether Google verified it) and set the other permissions as in the staging tenant. **Save
   Changes**.

### 5.7 The application

Time: 10 minutes.

1. **Applications** → **Applications** → **+ Create Application**. Name `YAP Arena`, type **Regular
   Web Applications**, **Create**.
2. **Settings** tab:
   - **Allowed Callback URLs**: `https://yaparena.com/api/auth/callback`
   - **Allowed Logout URLs**: `https://yaparena.com/`
   - **Allowed Web Origins**: `https://yaparena.com`

   Leave the other URL fields empty and click **Save Changes** at the bottom.

3. **Credentials** tab: **Authentication Method** must be **Client Secret (Post)**, which the app
   uses. Choose it if it isn't, and save.
4. **Connections** tab: turn **on** only `email` and `google-oauth2`. Turn **off**
   `Username-Password-Authentication` and anything else.
5. Copy **Client ID** and **Client Secret** (tick **Reveal Client Secret**) from **Settings** into
   the password manager as "Auth0 production application".

- Check: **Connections** shows exactly two on. A new tenant's **Default App** can stay; it has no
  callback URLs.

### 5.8 Compare with the staging tenant

Time: 15 minutes. Open the staging tenant in a second tab and compare, page by page:

| Page                                               | Must match staging                                    | Differs on purpose                           |
| -------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| **Authentication Profile**                         | Identifier First                                      | —                                            |
| **Passwordless → Email → Settings**                | OTP expiry, OTP length, template wording              | The **From** address                         |
| **Social → google-oauth2**                         | Attributes                                            | Client ID and secret (step 4)                |
| **Applications → YAP Arena → Settings**            | Type, **ID Token Expiration**, grant types (Advanced) | The three URLs                               |
| **Applications → YAP Arena → Connections**         | Only `email` and `google-oauth2`                      | —                                            |
| **Settings → General**                             | Friendly name, logo, support email                    | Environment tag (Production)                 |
| **Settings → Advanced → Login Session Management** | Inactivity timeout, require log in after              | —                                            |
| **Settings → Advanced**                            | **Enable Application Connections** off                | —                                            |
| **Branding → Universal Login**                     | Colors, logo, text                                    | —                                            |
| **Branding → Email Templates**                     | Every enabled template's text                         | —                                            |
| **Branding → Custom Domains**, **Email Provider**  | —                                                     | Production only: `auth.yaparena.com`, Resend |

Change production, never staging, where they differ.

## 6. Production database

### 6.1 Create the project

Time: 15 minutes.

1. Supabase → the organization menu → **New organization**. Name `YapArena Production`, type
   **Company**, plan **Pro**, add a card. Staging's organization keeps its own plan; a Supabase plan
   covers every project in its organization.
2. In the new organization: **New project**. Name `yaparena-production`. **Database password**:
   click **Generate a password** and save it in the password manager as "Supabase production
   postgres" (`<ADMIN_PASSWORD>`). Region **East US (Ohio)**. Compute **Micro**. **Create new
   project**, and wait until it's ready.
3. **Integrations** → **Data API**: turn **Enable Data API** off and save. The app uses its own
   API, never Supabase's; with it off, none of Supabase's generated REST endpoints answer.
4. **Project Settings** → **Database** → **SSL Configuration**: turn **Enforce SSL on incoming
   connections** on (the database restarts for a moment), then download the certificate in the same
   section.
5. Terminal:

   ```sh
   mv ~/Downloads/prod-ca-2021.crt ~/yaparena-private/production/supabase-ca.crt
   head -1 ~/yaparena-private/production/supabase-ca.crt
   ```

   It prints `-----BEGIN CERTIFICATE-----`. If the download has another name, use it in the `mv`
   line.

- Check: the project's home page shows region East US (Ohio) and the organization's billing shows
  Pro.

### 6.2 Note the connection values

Time: 2 minutes. In the project, **Connect** (top bar) → **Session pooler** (port 5432; never the
transaction pooler on 6543). The string reads
`postgresql://postgres.<PROJECT_REF>:[YOUR-PASSWORD]@<POOLER_HOST>:5432/postgres`. Note the two
values.

### 6.3 Create the two application identities

Time: 15 minutes.

1. Make the two passwords. Terminal:

   ```sh
   openssl rand -hex 32
   openssl rand -hex 32
   ```

   Save the first as "Supabase production yaparena_owner" (`<OWNER_PASSWORD>`) and the second as
   "Supabase production yaparena_runtime" (`<RUNTIME_PASSWORD>`). Hex passwords never need encoding.

2. If `<ADMIN_PASSWORD>` has characters other than letters, digits, `-`, `_`, `.` and `~`, encode it
   with the helper in [step 0.4 of the staging rollout](staging-rollout.md#04-make-your-private-folder)
   and use the printed value below.
3. Run `nano ~/yaparena-private/production/admin.env`, type these three lines, save (Ctrl+O, Return)
   and quit (Ctrl+X):

   ```text
   DATABASE_ADMIN_URL='postgresql://postgres.<PROJECT_REF>:<ADMIN_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=<MAC_HOME>/yaparena-private/production/supabase-ca.crt'
   DATABASE_OWNER_PASSWORD=<OWNER_PASSWORD>
   DATABASE_RUNTIME_PASSWORD=<RUNTIME_PASSWORD>
   ```

4. Terminal:

   ```sh
   chmod 600 ~/yaparena-private/production/admin.env
   cd ~/yaparena-release
   node --env-file="$HOME/yaparena-private/production/admin.env" scripts/provision-database.ts
   ```

- Check: it prints
  `Application identities and ownership provisioned; run the separate migration job next.`
- Then delete the file; the passwords stay in the password manager:

  ```sh
  rm ~/yaparena-private/production/admin.env
  ```

- If it prints `Database provisioning failed (28P01).`, the admin password is wrong or needs
  encoding. `(ENOTFOUND)`: the pooler host is wrong.

### 6.4 The owner and runtime files

Time: 5 minutes.

1. `nano ~/yaparena-private/production/owner.env`:

   ```text
   DATABASE_URL='postgresql://yaparena_owner.<PROJECT_REF>:<OWNER_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=<MAC_HOME>/yaparena-private/production/supabase-ca.crt'
   COIN_SANDBOX_OWNER_DATABASE_URL='<the same URL as DATABASE_URL>'
   COIN_SANDBOX_RAIL=simulation
   ```

2. `nano ~/yaparena-private/production/runtime.env`:

   ```text
   DATABASE_URL='postgresql://yaparena_runtime.<PROJECT_REF>:<RUNTIME_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=<MAC_HOME>/yaparena-private/production/supabase-ca.crt'
   ```

3. `chmod 600 ~/yaparena-private/production/*.env`

- Check: these print `yaparena_owner`, then `yaparena_runtime`:

  ```sh
  (set -a; source ~/yaparena-private/production/owner.env; psql "$DATABASE_URL" -tAc 'SELECT current_user')
  (set -a; source ~/yaparena-private/production/runtime.env; psql "$DATABASE_URL" -tAc 'SELECT current_user')
  ```

- If it prints `Tenant or user not found`, the user part must be `yaparena_owner.<PROJECT_REF>` (or
  `yaparena_runtime.<PROJECT_REF>`).

### 6.5 Apply the migrations

Time: 5 minutes. The release checkout holds the same migrations as `<WEB_IMAGE>`. Terminal:

```sh
cd ~/yaparena-release
node --env-file="$HOME/yaparena-private/production/owner.env" scripts/migrate-database.ts
ls migrations | grep -c '^[0-9].*\.js$'
```

- Check: the first command prints `Database migrations completed with the migration identity.` In
  the SQL editor,

  ```sql
  SELECT count(*) AS applied, max(name) AS newest FROM yaparena_migrations.pgmigrations;
  ```

  returns `applied` equal to the number the `ls` line printed (65 at `740254d`), and `newest` equal
  to the last file in `~/yaparena-release/migrations`.

- If it prints `Database migration failed (…)`, use the table in
  [step 1 of the staging rollout](staging-rollout.md#1-apply-the-owner-migrations).

### 6.6 The first backup

Time: 5 minutes. Supabase Pro makes a daily backup by itself; the first appears under **Database →
Backups** the next day. Take one now as well:

```sh
(set -a; source ~/yaparena-private/production/owner.env; pg_dump --format=custom --schema=yaparena --schema=yaparena_migrations --file="$HOME/yaparena-private/production/initial.dump" --dbname="$DATABASE_URL")
pg_restore --list ~/yaparena-private/production/initial.dump | head -3
```

- Check: the first command prints nothing; the second prints lines starting with `;` and today's
  date. The next day, **Database → Backups** lists a backup.

### 6.7 The runtime URL for Render

Render reads the certificate from a secret file, so its URL ends differently from `runtime.env`.
Save this in the password manager as "Supabase production runtime URL (Render)":

```text
postgresql://yaparena_runtime.<PROJECT_REF>:<RUNTIME_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt
```

Never give Render the owner or admin URL; the app refuses to start with either.

## 7. Video: LiveKit, R2, replay edge and transcriber

### 7.1 LiveKit project

Time: 10 minutes.

1. LiveKit Cloud → the project menu → **New project**. Name `yaparena-production`, data region
   **United States** (the default; it can't change later).
2. **Settings** → **Billing**: choose **Ship**.
3. **Settings** → **API keys** → **Create key**. Name `yaparena-production-app`. Copy the **API
   key**, the **API secret** and the project URL (`wss://<LIVEKIT_HOST>`) into the password manager
   as "LiveKit production".
4. **Settings** → **Webhooks** → **Create new webhook**. Name `yaparena`, URL
   `https://yaparena.com/api/media/webhook`, **Signing API key** `yaparena-production-app`,
   **Create**. Until step 10 it can't reach the app; that's expected.

- Check: **Settings → Project** shows the Ship plan's limits.

### 7.2 Private R2 bucket

Time: 15 minutes.

1. Cloudflare → **R2 Object Storage** → **Create bucket**. Name `yaparena-production-media` (the
   replay edge's configuration uses this name). Leave **Location** automatic and the storage class
   **Standard**. **Create bucket**.
2. The bucket → **Settings**: **Public Development URL** reads disabled, and there is no custom
   domain. Buckets are private unless you turn these on.
3. Same page, **CORS Policy** → **Add CORS policy** → **JSON** tab, paste and **Save**:

   ```json
   [
     {
       "AllowedOrigins": ["https://yaparena.com"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

4. **R2 Object Storage** → **Overview** → **Account Details** → **API Tokens** → **Manage** →
   **Create Account API token**. Name `yaparena-production-media`, permission **Object Read &
   Write**, applied to the bucket `yaparena-production-media` only, TTL **Forever**. **Create
   Account API token**.
5. Copy the **Access Key ID**, the **Secret Access Key** and the S3 endpoint
   (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`) into the password manager as "R2 production
   media". The secret is shown once.

- Check: the bucket's **Settings** shows public access disabled and the CORS rule with
  `https://yaparena.com`.

### 7.3 Replay edge on `replay.yaparena.com`

Time: 15 minutes. The configuration is in the repository:
[`edge/wrangler.production.toml`](../edge/wrangler.production.toml) (worker
`yaparena-replay-production`, `APP_ORIGIN=https://yaparena.com`, bucket
`yaparena-production-media`, custom domain `replay.yaparena.com`). Terminal:

```sh
cd ~/yaparena-release
npx wrangler@4.151.1 login
npx wrangler@4.151.1 deploy --config edge/wrangler.production.toml
```

`login` opens the browser: sign in to Cloudflare and click **Allow**. `deploy` creates the worker and
the `replay.yaparena.com` record with its certificate. It refuses if a `CNAME` named `replay` already
exists in Cloudflare; delete that record first.

Make the signing secret and give it to the worker:

```sh
openssl rand -hex 32
npx wrangler@4.151.1 secret put REPLAY_SIGNING_SECRET --config edge/wrangler.production.toml
```

Save the first line's output as "Replay edge production signing secret" (`<SIGNING_SECRET>`), and
paste it at the second command's prompt.

- Check, after a minute:

  ```sh
  curl -sI https://replay.yaparena.com/ | grep -iE '^(HTTP|access-control-allow-origin)'
  ```

  prints `HTTP/2 403` and `access-control-allow-origin: https://yaparena.com`. A 403 is correct: the
  edge refuses every request without a signed link from the app.

- If `curl` can't resolve the name, wait five minutes; the record is new. If the second line shows
  another origin, the wrong configuration was deployed.

### 7.4 Anthropic key for the AI outline

Time: 10 minutes.

1. Claude Console → **Settings** → **Workspaces** → **Create workspace**. Name `yaparena-production`.
   Set its monthly spend limit (staging used $50).
2. **Settings** → **API keys** → **Create key**, in the `yaparena-production` workspace. Name
   `yaparena-production-outline`. Copy the key (starts with `sk-ant-`) into the password manager. A
   key must belong to a workspace; an organization-level key is refused.
3. **Settings** → **Billing**: make sure the organization has credits and auto-reload is set as you
   want.

### 7.5 Transcriber agent

Time: 20 minutes, mostly LiveKit building the agent.

1. Make the ingest secret:

   ```sh
   openssl rand -hex 32
   ```

   Save it as "Transcriber production ingest secret" (`<INGEST_SECRET>`). Web, the jobs worker and
   the agent get this same value; staging's is different.

2. `nano ~/yaparena-private/production/transcriber-secrets.env` (no quotes, no spaces around `=`):

   ```text
   YAPARENA_INGEST_URL=https://yaparena.com
   TRANSCRIPTION_INGEST_SECRET=<INGEST_SECRET>
   TRANSCRIPTION_PROVIDER=deepgram
   ANTHROPIC_API_KEY=<the key from 7.4>
   ```

   Then `chmod 600 ~/yaparena-private/production/transcriber-secrets.env`. Deepgram runs through
   LiveKit and needs no key. There is no shadow provider in production.

3. Link the LiveKit CLI to the production project and make it the default for now:

   ```sh
   lk cloud auth
   lk project list
   ```

   In the browser, pick `yaparena-production`. If asked to make it the default, answer yes. In the
   list, the `*` must be on the production project; if not, `lk project set-default <its name>`.

4. Stage and create the agent, in its own folder (staging's stays in `~/yaparena-transcriber-deploy`):

   ```sh
   cd ~/yaparena-release
   node scripts/stage-transcriber.ts ~/yaparena-transcriber-production
   cd ~/yaparena-transcriber-production
   lk agent create --region us-east --secrets-file ~/yaparena-private/production/transcriber-secrets.env .
   ```

   Answer `y` if asked. The region can't change later; `us-east` is nearest to Ohio.

5. Wait, then check:

   ```sh
   lk agent status
   lk agent logs
   ```

   `Running`, and `registered worker` in the logs (Ctrl+C stops them).

6. Switch the CLI back to staging, so later staging commands don't reach production:

   ```sh
   lk project list
   lk project set-default <the staging project's name>
   ```

- If the status is `CrashLoop`, `lk agent logs` names the setting (see
  [5.5 of the staging rollout](staging-rollout.md#55-stage-and-deploy-the-agent)). Fix the file, then
  run `lk agent update-secrets --secrets-file ~/yaparena-private/production/transcriber-secrets.env`
  in `~/yaparena-transcriber-production`, with the production project as default.

## 8. Render services

[`render.production.yaml`](../render.production.yaml) describes `yaparena-web` and `yaparena-jobs`.
It is a separate Blueprint from staging's `render.yaml`: syncing one never changes the other.

### 8.1 Pin the launch image

Time: 5 minutes, or about 30 if a pin is needed.

The Blueprint creates both services on the image named in the file. Terminal:

```sh
cd ~/Documents/Codex/YapArena
git fetch origin
git show origin/main:render.production.yaml | grep 'url:'
```

- Check: both lines end with the digest in `<WEB_IMAGE>`.
- If not, ask the hub for a one-line pull request that pins `<WEB_IMAGE>` in
  `render.production.yaml`, and merge it. Don't create the Blueprint before the file names the
  image staging ran.

### 8.2 Create the services from the Blueprint

Time: 15 minutes.

1. Render → **+ New** → **Blueprint**. Connect `YapArena/YapArena` if asked. **Branch** `main`,
   **Blueprint Path** `render.production.yaml`, **Blueprint Name** `yaparena-production`.
2. Render lists `yaparena-web` and `yaparena-jobs` and asks for the values marked `sync: false`:
   - `yaparena-web` → `DATABASE_URL`: the runtime URL from step 6.7.
   - `yaparena-web` → `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`: step 5.7.
   - `yaparena-jobs` → `DATABASE_URL`: the same runtime URL.
3. **Deploy Blueprint**. Render creates the services and starts their first deploy.
4. **Blueprints** → `yaparena-production` → **Settings**: set **Auto Sync** to **No**. Later releases
   change the image in each service's settings; a sync would put the file's image back.

- Expected: both first deploys **fail** at the database step, because the certificate isn't there
  yet. **Logs** show `ENOENT` and `/etc/secrets/supabase-ca.crt`. Nothing is public, and 8.3 fixes
  it.
- If Render can't pull the image, the packages may have become private; see
  [registry access](render-staging.md#registry-access).

### 8.3 Secret files and the remaining variables

Time: 20 minutes.

1. `yaparena-web` → **Environment** → **Secret Files** → **+ Add Secret File**:
   - `supabase-ca.crt`: the contents of the certificate. Terminal:
     `pbcopy < ~/yaparena-private/production/supabase-ca.crt`, then paste.
   - `landing-headline-font.b64`: the font's base64 text, as in
     [deploying the headline font](landing-page.md#deploying-the-headline-font). It's the same
     licensed font as staging; it isn't a credential.
2. `yaparena-jobs` → **Environment** → **Secret Files**: `supabase-ca.crt`, the same contents.
3. Add the variables marked **dashboard** in the [variables table](#production-variables) to
   `yaparena-web` and `yaparena-jobs`: **+ Add Environment Variable** for each, then **Save only**.
4. `yaparena-web`'s page shows its own address at the top, `https://<RENDER_HOST>`. Note it.

### 8.4 The encoder

Time: 10 minutes.

1. Render → **+ New** → **Background Worker** → **Existing Image**. Image URL `<ENCODER_IMAGE>`.
   **Connect**.
2. Name `yaparena-encoder`, region **Ohio**, instance type **Starter**.
3. **Advanced** → **Docker Command** `node dist/replay-worker.js`. **Secret Files** → add
   `supabase-ca.crt` as in 8.3. **Environment Variables**: the rows marked for the encoder in the
   [variables table](#production-variables).
4. **Deploy Background Worker** later, in 8.5; if the form deploys at once, that's fine.

### 8.5 Deploy, in order

Time: 15 minutes. Step 6.5 migrated the database for this release. Then:

1. `yaparena-jobs` → **Manual Deploy** → **Deploy latest reference**. Wait for "Deploy live".
2. `yaparena-web`: the same.
3. `yaparena-encoder`: the same.

- Check, Terminal:

  ```sh
  curl -fsS https://<RENDER_HOST>/ready
  SMOKE_BASE_URL=https://<RENDER_HOST> node scripts/smoke-staging.ts
  curl -s https://<RENDER_HOST>/robots.txt
  curl -sI https://<RENDER_HOST>/ | grep -ci x-robots-tag
  curl -s -o /dev/null -w '%{http_code}\n' https://<RENDER_HOST>/metrics
  ```

  In order: `{"status":"ready"}`; the smoke report as in step 1.4; `User-agent: *` and
  `Disallow: /api/`; `0` (production may be indexed); `404` (`/metrics` needs the token).

- Check, **Logs**:
  - `yaparena-web`: `server started` with `"auth0":true`, and `landing font loaded`.
  - `yaparena-jobs`: `background worker started` with `"media":true`, then `background job ran`
    lines, one with `"job":"matchmaking"`.
  - `yaparena-encoder`: `Automatic replay worker started`.
- If web logs `database migrations are pending`, run step 6.5 with this release. If it logs
  `production requires AUTH0_ISSUER_BASE_URL…` or `the production service requires an Auth0 custom
domain`, check the Auth0 variables. A `landing font unavailable` warning means the font file is
  missing or misnamed.
- Sign-in doesn't work on `<RENDER_HOST>`: Auth0 returns only to `https://yaparena.com`. Step 11
  tests it.

### Production variables

Each service reads only what it lists. "Blueprint" values come from `render.production.yaml`;
"dashboard" values are added in 8.3 or 8.4. **Own** means production's own new secret: never copy
it from staging, and never reuse it there.

| Variable                                        | Web | Jobs | Encoder | Production value or source                                           | Compared with staging       |
| ----------------------------------------------- | --- | ---- | ------- | -------------------------------------------------------------------- | --------------------------- |
| `NODE_ENV`                                      | ✓   | ✓    | ✓       | `production` (Blueprint; encoder: dashboard)                         | Same                        |
| `NODE_OPTIONS`                                  | ✓   | ✓    | ✓       | `--max-semi-space-size=4`                                            | Same                        |
| `PORT`, `TRUST_PROXY`                           | ✓   |      |         | `10000`, `1` (Blueprint)                                             | Same                        |
| `RUN_BACKGROUND_JOBS`                           | ✓   |      |         | `false` (Blueprint); `yaparena-jobs` runs the jobs                   | Same                        |
| `COMMUNITY_STREAM_ENABLED`                      | ✓   |      |         | `false` (Blueprint)                                                  | Same                        |
| `PRODUCTION_SERVICE`                            | ✓   |      |         | `true` (Blueprint)                                                   | Production web only         |
| `APP_ORIGIN`                                    | ✓   | ✓    | ✓       | `https://yaparena.com`                                               | Differs                     |
| `DATABASE_URL`                                  | ✓   | ✓    | ✓       | Runtime URL from step 6.7                                            | Own                         |
| `METRICS_TOKEN`                                 | ✓   |      |         | Generated by the Blueprint                                           | Own                         |
| `AUTH0_ISSUER_BASE_URL`                         | ✓   |      |         | `https://auth.yaparena.com` (Blueprint)                              | Differs                     |
| `AUTH0_CLIENT_ID`                               | ✓   |      |         | Step 5.7                                                             | Differs                     |
| `AUTH0_CLIENT_SECRET`                           | ✓   |      |         | Step 5.7                                                             | Own                         |
| `LANDING_FONT_FILE`                             | ✓   |      |         | `/etc/secrets/landing-headline-font.b64` (Blueprint)                 | Same                        |
| `COIN_SANDBOX_ENABLED`                          | ✓   | ✓    |         | `true` (dashboard)                                                   | Same                        |
| `TURN_WINDOWS_ENABLED`                          | ✓   | ✓    |         | `true` (dashboard)                                                   | Same                        |
| `LIVE_OUTLINE_ENABLED`                          | ✓   | ✓    |         | `true` (dashboard)                                                   | Same                        |
| `TRANSCRIPTION_INGEST_SECRET`                   | ✓   | ✓    |         | `<INGEST_SECRET>` from 7.5 (dashboard)                               | Own                         |
| `MATCHMAKING_ENABLED`                           | ✓   | ✓    |         | `true` (dashboard)                                                   | Same                        |
| `LIVE_DEBATE_CAPACITY`                          | ✓   | ✓    |         | `10` (dashboard): LiveKit Ship with the outline on                   | Differs (staging: 2)        |
| `LIVEKIT_URL`                                   | ✓   | ✓    | ✓       | `https://<LIVEKIT_HOST>` (dashboard)                                 | Differs                     |
| `LIVEKIT_PUBLIC_URL`                            | ✓   | ✓    | ✓       | `wss://<LIVEKIT_HOST>` (dashboard)                                   | Differs                     |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`         | ✓   | ✓    | ✓       | Step 7.1 (dashboard)                                                 | Own                         |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_PUBLIC_ENDPOINT` | ✓   | ✓    | ✓       | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, both (dashboard) | Same account, so same value |
| `MEDIA_S3_REGION`                               | ✓   | ✓    | ✓       | `auto` (dashboard)                                                   | Same                        |
| `MEDIA_S3_BUCKET`                               | ✓   | ✓    | ✓       | `yaparena-production-media` (dashboard)                              | Differs                     |
| `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`    | ✓   | ✓    | ✓       | Step 7.2 (dashboard)                                                 | Own                         |
| `MEDIA_REPLAY_EDGE_URL`                         | ✓   | ✓    | ✓       | `https://replay.yaparena.com` (dashboard)                            | Differs                     |
| `MEDIA_REPLAY_SIGNING_SECRET`                   | ✓   | ✓    | ✓       | `<SIGNING_SECRET>` from 7.3 (dashboard)                              | Own                         |
| `MEDIA_REPLAY_PACKAGING_ENABLED`                | ✓   | ✓    | ✓       | `true` (dashboard)                                                   | Same                        |

Secret files: `supabase-ca.crt` on all three; `landing-headline-font.b64` on web only.

**Never set in production**, on any service:

- `DATABASE_MIGRATION_URL`, `DATABASE_ADMIN_URL`, `DATABASE_OWNER_PASSWORD`,
  `DATABASE_RUNTIME_PASSWORD`, `COIN_SANDBOX_OWNER_DATABASE_URL`: owner and admin credentials. The
  app refuses to start with any of them.
- `AUTH0_*` and `PRODUCTION_SERVICE` on the jobs worker or the encoder: web only.
- `HOMEPAGE_REFERENCE_ENABLED`: refused in production.
- `MEDIA_REPLAY_EDGE_ROOMS`: a canary allowlist; production serves every eligible replay.
- `COIN_SANDBOX_WEBHOOK_SECRET`, `USER_STREAM_ENABLED` (live updates are on with matchmaking),
  `MEDIA_WORKER_TOOLS` (image builds only), `A4_MODE` (unset is `disabled`), `REDIS_*` (one
  instance keeps its limits in memory).

## 9. Open items at launch

The founder decided on 2026-10-29 that none of these blocks the DNS switch. Each follows after launch
as a separate task; until it's done, its risk stays open.

### 9.1 Privacy and terms pages

A separate pull request adds `/privacy` and `/terms`, with text you approve. Decision 0009 point 11
requires the policy to name Auth0, Google and the data region; it also names Supabase and Render
(Ohio), LiveKit, Cloudflare, Resend, Deepgram and Anthropic, and what each receives. Until then,
people sign up without a published policy, and the links on Google's sign-in setup (step 4) lead
nowhere.

- Done when: production serves both pages, after staging ran that release first.

### 9.2 F04 database check on production

The [hosted operator checklist](security/database-isolation.md#hosted-operator-checklist--required-to-close-f04)
on `yaparena-production`. It's simplest before step 10, while the database holds no user data. Ask
the hub to run it with you.

- Done when: the checklist's evidence for this project is recorded (Data API disabled and no private
  schema exposed, the read-only SQL inventory, Render's runtime-only credentials, and the probes),
  and F04's row in the [status table](nonfinancial-implementation-plan.md#current-implementation-and-evidence)
  says so.

### 9.3 Restore test

Restore one daily backup of `yaparena-production` into a new scratch project (**Database →
Backups** → **Restore to a New Project**, available on Pro), compare its table counts with
production, then delete the scratch project. Ask the hub for the exact procedure.

- Done when: you've restored once and written down how long it took.

### 9.4 Uptime alerts

An outside check that alerts your phone. Until it exists, nothing tells you when the site or the
jobs worker stops; check `https://yaparena.com/ready` and Render's **Events** yourself.

- Done when: stopping a test target sends an alert within five minutes, and alerts cover
  `https://yaparena.com/ready` and the jobs worker stopping.

### 9.5 Account deletion

Prompt 12c ([Decision 0009](decisions/0009-auth0.md) point 13). Until then, a user who wants their
account deleted asks you, and you remove it by hand.

## 10. Connect yaparena.com

Time: 30 minutes to an hour, mostly waiting for certificates. Do steps 10 and 11 in one sitting. From
here on, the public can reach production; don't announce it until step 11 passes.

1. Render → `yaparena-web` → **Settings** → **Custom Domains**. The Blueprint added `yaparena.com`;
   Render added `www.yaparena.com`, which redirects to `yaparena.com`. If they're missing: **+ Add
   Custom Domain**, enter `yaparena.com` (never `www.yaparena.com`), **Save**.
   - Check: the `www.yaparena.com` row says it redirects to `yaparena.com`. If it's the other way
     round, delete both and add `yaparena.com` again.
2. Cloudflare → yaparena.com → **DNS** → **Records**. Delete any remaining `A`, `AAAA` or `CNAME`
   record named `yaparena.com` (`@`) or `www`. Then **+ Add record** twice:
   - type `CNAME`, name `@`, target `<RENDER_HOST>`, **DNS only**;
   - type `CNAME`, name `www`, target `<RENDER_HOST>`, **DNS only**.

   Cloudflare flattens the `@` record by itself; the list may show "CNAME flattening".

3. Render, **Custom Domains**: click **Verify** on each row. Wait until both show **Certificate
   Issued** (or **Verified**). It can take a few minutes; click **Verify** again if it fails.
4. Check, Terminal:

   ```sh
   curl -fsS https://yaparena.com/ready
   ```

   prints `{"status":"ready"}`.

5. Turn off the Render address: **Settings** → **Custom Domains** → **Render Subdomain** →
   **Disable**.

- Check:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://<RENDER_HOST>/ready
  ```

  prints `404`.

- The Hobby workspace includes two custom domains; `yaparena.com` and `www.yaparena.com` use both.
  A third (on any service in the workspace) costs extra.
- `replay.yaparena.com` and `auth.yaparena.com` are Cloudflare and Auth0 domains, not Render ones.

## 11. Launch checks

Time: 1–1½ hours. Two browser profiles, as in the staging rollout: profile A for your own account,
profile B for `you+b@…`.

### 11.1 Redirects and pages

Terminal:

```sh
curl -sI 'https://www.yaparena.com/some/path?x=1' | grep -iE '^(HTTP|location)'
curl -sIL -o /dev/null -w '%{url_effective}\n' 'http://www.yaparena.com/some/path?x=1'
curl -sIL -o /dev/null -w '%{url_effective}\n' 'http://yaparena.com/topics'
curl -s https://yaparena.com/ | grep -o '<link rel="canonical" href="[^"]*"'
SMOKE_BASE_URL=https://yaparena.com node scripts/smoke-staging.ts
curl -s https://yaparena.com/robots.txt
curl -s -o /dev/null -w '%{http_code}\n' https://yaparena.com/metrics
```

- Check, in order:
  - a `301` or `308` with `location: https://yaparena.com/some/path?x=1`;
  - `https://yaparena.com/some/path?x=1`;
  - `https://yaparena.com/topics`;
  - `<link rel="canonical" href="https://yaparena.com/"`;
  - the smoke report as in step 1.4;
  - `User-agent: *` and `Disallow: /api/`;
  - `404`.
- If a redirect goes to `www`, step 10.1 added the wrong domain first.

### 11.2 Sign up with Google

In profile A, open `https://yaparena.com` and click **Continue with Google**. Choose your Google
account.

- Check:
  - The address bar shows `auth.yaparena.com`, then Google, never `*.auth0.com`. Google's screen
    names yaparena.com (or YAP Arena once Google has verified the brand, step 4).
  - You land on `https://yaparena.com/home` and the handle pop-up asks for a username and handle.
    Choose them: `<handle-a>`.
  - Render → `yaparena-web` → **Logs** shows no `auth` error.
- If Google says `redirect_uri_mismatch`, step 4's redirect URI isn't exactly
  `https://auth.yaparena.com/login/callback`. If Auth0 says `Callback URL mismatch`, check step 5.7.

### 11.3 Sign up with an email code

In profile B, open `https://yaparena.com` and click **Continue with email**. Enter `you+b@…`.

- Check: the code email arrives from `no-reply@yaparena.com` within a minute. After you type it, you
  land on `/home` and choose `<handle-b>`.
- If no email arrives: Resend → **Emails** shows whether it was sent; Auth0 → **Monitoring** →
  **Logs** shows the error.

### 11.4 Sign out

In profile B, open the account menu and click **Sign out**.

- Check: you end on `https://yaparena.com/`, signed out. Signing in again with the same address works.

### 11.5 Make your account the operator

In the production SQL editor:

```sql
INSERT INTO yaparena.account_roles (user_id, role)
SELECT user_id, 'operator' FROM yaparena.public_profiles WHERE handle = '<handle-a>'
ON CONFLICT DO NOTHING;
```

- Check: signed in as A, `https://yaparena.com/api/me/roles` shows `"operator"`.

### 11.6 A two-account debate

Time: 30 minutes.

1. As A, create and publish the first topic on `https://yaparena.com/match` (**01 / START A TOPIC**),
   as in [start a test debate](staging-rollout.md#start-a-test-debate), item 3. Its slug is
   `<topic-slug>`.
2. Both accounts save the **Debating** card on `/account` → **Profile** (language and agreement).
3. Queue A for one side and B for the other on `https://yaparena.com/topics/<topic-slug>`, accept,
   and join as speakers, as in
   [8.5 of the staging rollout](staging-rollout.md#85-queue-accept-and-start-automatically).
4. Talk for two turns, then end it as operator (**Operator controls** → reason → **End**).

- Check:
  - The debate goes live by itself; captions appear and the **AI outline** fills.
  - The production agent's logs show `transcriber joined` (Terminal: `lk project set-default` to
    production, `cd ~/yaparena-transcriber-production`, `lk agent logs`; switch back afterwards).
  - A Yap Coins window opens for each turn.
  - A few minutes after the end, the replay plays on the debate page. In Chrome's DevTools
    **Network** tab, its requests go to `replay.yaparena.com` with status 200 or 206.
  - `yaparena-encoder`'s **Logs** show the job completing.
- These test accounts and the debate stay in production. Unpublish the topic afterwards if you
  don't want it public.

### 11.7 Staging still works on its own

```sh
curl -fsS https://yaparena-staging-web.onrender.com/ready
curl -sI https://yaparena-staging-web.onrender.com/ | grep -i x-robots-tag
curl -s https://yaparena-staging-web.onrender.com/robots.txt
```

- Check: `{"status":"ready"}` (the first call can take a minute while it wakes); `x-robots-tag:
noindex`; `User-agent: *` and `Disallow: /`.
- Sign in on staging: the address bar shows staging's `*.auth0.com` tenant, never
  `auth.yaparena.com`.
- Render: `yaparena-staging-web` still shows the Free plan.

When every check passes, production is live.

## Feature flags at launch

The founder chose a full launch: production matches staging's switches, with capacity for LiveKit
Ship. Set them on web and the jobs worker together.

| Flag                             | Staging             | Production at launch  | Why                                                 |
| -------------------------------- | ------------------- | --------------------- | --------------------------------------------------- |
| `COIN_SANDBOX_ENABLED`           | `true`              | `true`                | Yap Coins are always on (Decision 0013); play money |
| `TURN_WINDOWS_ENABLED`           | `true`              | `true`                | One Yap Coins window per turn                       |
| `LIVE_OUTLINE_ENABLED`           | `true`              | `true`                | Captions and the AI outline                         |
| `MATCHMAKING_ENABLED`            | `true`              | `true`                | The live queue and challenges                       |
| `LIVE_DEBATE_CAPACITY`           | `2` (LiveKit Build) | `10`                  | LiveKit Ship with the outline on                    |
| `MEDIA_REPLAY_PACKAGING_ENABLED` | `true`              | `true`                | Adaptive replays through the encoder                |
| `COMMUNITY_STREAM_ENABLED`       | `false`             | `false`               | A separate rollout gate                             |
| `USER_STREAM_ENABLED`            | unset               | unset                 | On with matchmaking                                 |
| `A4_MODE`                        | check staging       | unset (`disabled`)    | Bot runs are staging demonstrations                 |
| Agent `TRANSCRIPTION_PROVIDER`   | `deepgram`          | `deepgram`, no shadow | The founder's choice until the ElevenLabs retest    |

To turn one off: set it to `false` on web and the jobs worker and **Save and deploy**, jobs first.

## Releasing from now on

Time: about 45 minutes per release, plus testing.

Every release goes through staging first, as one pair of images. Production never runs a digest
staging hasn't run, hotfixes included.

1. **Choose:** step 1.1, a `main` commit whose CI run passed every job. Note `<WEB_IMAGE>` and
   `<ENCODER_IMAGE>` from that one run.
2. **Prepare:** step 1.2's commands with the new `<COMMIT_SHA>`.
3. **Migrate staging:** step 1.3.
4. **Deploy to staging:** on `yaparena-staging-web`, `yaparena-staging-jobs` and
   `yaparena-replay-worker`, **Settings** → **Image URL** → **Edit**, paste the web image (the
   encoder image on the encoder), **Save Changes**. Wait for "Deploy live".
5. **Test on staging:** the step 1.4 checks and whatever the release changes. Staging's web is Render
   Free: it sleeps after 15 idle minutes, and its first request then takes about a minute.
6. **Migrate production:** step 6.5's command, with production's owner file.
7. **Deploy to production,** in order: `yaparena-jobs` (web image), then `yaparena-web` (web image),
   then `yaparena-encoder` (encoder image). Same clicks as item 4.
8. **Check production:** `curl -fsS https://yaparena.com/ready`, the smoke script against
   `https://yaparena.com`, and each service's startup log line (8.5).
9. **The agent and the edge,** only if the release changed them:
   - Agent: restage and deploy to staging (`~/yaparena-transcriber-deploy`, staging the default
     project), test, then production (`~/yaparena-transcriber-production`, production the default,
     then back to staging): `node scripts/stage-transcriber.ts <folder>`, then `lk agent deploy .`
     in that folder.
   - Edge: deploy staging's edge as before, test a replay, then
     `npx wrangler@4.151.1 deploy --config edge/wrangler.production.toml`.

Keep the production Blueprint's **Auto Sync** off. If you ever sync it, first make sure
`render.production.yaml` names the image production runs, and check afterwards that the Render
subdomain is still disabled.

## Rollback

- **Code:** on each production service, **Settings** → **Image URL** → **Edit**, paste the previous
  release's image, **Save Changes**: jobs, then web, then the encoder. The previous images are in
  the earlier lines of step 1.1's list. Migrations stay: they're additive and never rolled back. If
  the previous release can't run on the newer schema, fix forward instead.
- **Feature flags:** set the flag to `false` on web and the jobs worker, **Save and deploy**.
- **Agent:** with production as the default project, in `~/yaparena-transcriber-production`,
  `lk agent versions`, then `lk agent rollback --version <previous version>`.
- **Edge:** `npx wrangler@4.151.1 deployments list --config edge/wrangler.production.toml`, then
  `npx wrangler@4.151.1 rollback <version ID> --config edge/wrangler.production.toml`.
- **Take the site offline:** Render → `yaparena-web` → **Settings** → **Maintenance Mode** →
  **Enable**; it shows a maintenance page on yaparena.com without touching DNS. Disable it to
  return.
- **Data accident:** Supabase → **Database** → **Backups** → restore. Only for lost or damaged
  data, never to undo a release.
- **Auth0, Google, Resend, Cloudflare settings:** each can be changed back in its dashboard.
  Staging's tenant, project and bucket are never involved.

## If you get stuck

- Stop at the item that failed. Later steps assume the earlier checks passed.
- Copy the step number, the command or click, and the exact output or log line. Leave out passwords,
  keys and full database URLs.
- Send that to the hub session.
- Before step 10, nothing is public: a half-built production costs only its monthly plans. After
  step 10, Maintenance Mode ([Rollback](#rollback)) takes the site offline while you fix it.
