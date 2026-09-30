# Deploying GameGarden

A step-by-step guide to running GameGarden for free on **Vercel (Hobby) + Neon Postgres**, with Google sign-in, the Claude API, and your Bluesky, YouTube and Reddit accounts.

Budget about an hour. Most of it is clicking through the Google Cloud console. Do the steps in order: later steps need values from earlier ones (for example, the OAuth clients need your final app URL).

---

## 0. Recommended choices

| Decision | Recommendation | Why |
| --- | --- | --- |
| Hosting | **Vercel Hobby** (free) | Native Next.js; functions can run up to 300 s with Fluid compute, which plan runs need; free cron. Hobby is for **non-commercial** use, so move to Pro ($20/mo) if this becomes a product. |
| Database | **Neon free tier**, region **AWS us-east-1** | Serverless Postgres with a pooled URL; us-east-1 is next to Vercel's default function region (`iad1`), which keeps queries fast. |
| App URL | `https://<project>.vercel.app` to start | Stable and free. A custom domain can come later (see §10). |
| Production branch | **`main`** | Keep production separate from the `claude/...` work branch. |
| Scheduler | Vercel Cron (built in) **+ cron-job.org every 5 min** | Vercel Hobby cron runs each job only once a day. The pinger makes scheduled posts go out within about 5 minutes of their time. |
| AI model | Default **`claude-opus-5-5`** (Claude Opus 5.5), with a spending limit set in the Anthropic console | Best-quality strategy. Set `ANTHROPIC_MODEL=claude-sonnet-5` later if cost matters more (§9). |
| Access | `ALLOWED_EMAILS=<your Gmail>` | Keeps the instance personal until you're ready to open it up. |

---

## 1. Prepare the GitHub repo

The repository currently has one branch, `claude/laughing-franklin-uqecmx`, and it's the default. Create `main` from it:

1. On GitHub, open **K128kevin/GameGarden → branch dropdown → "View all branches" → New branch**. Name it `main` and use `claude/laughing-franklin-uqecmx` as the source.
2. Go to **Settings → General → Default branch** and switch it to `main`.

From now on, changes land in `main` through pull requests, and Vercel deploys `main` to production.

> The repo is **public**. That's fine: no secrets are committed (`.env*` is gitignored), and everything sensitive lives in Vercel environment variables. If you make it private later, note that GitHub Actions minutes become metered (this only matters for the optional workflow in §7b).

---

## 2. Generate secrets

Run this locally (macOS/Linux, or Git Bash on Windows). You'll paste the output into Vercel in §6.

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "CRON_SECRET=$(openssl rand -hex 32)"
```

**Save all three in a password manager.** In particular:

- `ENCRYPTION_KEY` encrypts stored platform tokens and app passwords. If you lose or change it, every connected account must be reconnected.
- Changing `BETTER_AUTH_SECRET` signs everyone out, which is harmless.
- `CRON_SECRET` is hex, so it's safe to put in HTTP headers everywhere.

---

## 3. Pick your Vercel project name (and therefore your URL)

Decide the project name now, for example `gamegarden-kevin`. Your production URL will be:

```
https://gamegarden-kevin.vercel.app
```

Check that it's free by visiting it: a Vercel 404 "DEPLOYMENT_NOT_FOUND" page means it's available. The rest of this guide calls this URL **`APP_URL`**.

---

## 4. Create the database (Neon)

1. Sign up at <https://neon.tech> (the free plan is enough).
2. **Create project**: name `gamegarden`, Postgres 16 or 17, region **AWS US East 1 (N. Virginia)**. AWS US East 2 (Ohio) is fine too; just match it with Vercel's Cleveland (`cle1`) function region in §6.
3. On the project dashboard, click **Connect** and copy two connection strings:
   - **Pooled** (host contains `-pooler`) → this becomes `DATABASE_URL`.
   - **Direct** (toggle "Connection pooling" off) → this becomes `DATABASE_URL_UNPOOLED`, which migrations use.

   Both should end with `?sslmode=require`.

> Alternative: add Neon from inside Vercel (**Project → Storage → Neon**). It sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for you. Either route works; creating the project directly on neon.tech keeps the ordering in this guide simpler.

Tables are created automatically on the first deploy (`npm run vercel-build` runs `drizzle-kit migrate`).

---

## 5. Create the API credentials

### 5a. Google: sign-in and YouTube (required)

In <https://console.cloud.google.com>:

1. **Create a project**, e.g. `GameGarden`.
2. **Enable the YouTube API**: *APIs & Services → Library* → search **YouTube Data API v3** → **Enable**.
3. **Configure the consent screen** (*Google Auth Platform*, formerly "OAuth consent screen"):
   - **Branding**: app name `GameGarden`, your email as support and developer contact. Set the app home page to `APP_URL`.
   - **Audience**: user type **External**.
   - **Data access**: you can leave this empty. The app asks for `openid email profile` at sign-in and for `youtube.force-ssl` only when you click "Connect YouTube".
4. **Create the OAuth client**: *Clients → Create client → Web application*, named `GameGarden web`.
   - **Authorized JavaScript origins**:
     - `APP_URL` (e.g. `https://gamegarden-kevin.vercel.app`)
     - `http://localhost:3000`
   - **Authorized redirect URIs** (exact, no trailing slash):
     - `APP_URL/api/auth/callback/google`
     - `APP_URL/api/connect/youtube/callback`
     - `http://localhost:3000/api/auth/callback/google`
     - `http://localhost:3000/api/connect/youtube/callback`
   - Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`.
5. **Publish the app** (*Audience → Publish app → In production*). This matters:
   - While the app is in **Testing**, Google makes refresh tokens expire after **7 days**, so YouTube would disconnect every week.
   - In production without verification, you'll see a one-time "Google hasn't verified this app" screen when connecting YouTube. Click **Advanced → Go to GameGarden**.
   - Unverified apps can have up to 100 users, which is plenty for personal use. Verification only matters if you open the app to others (§11).

**YouTube quota:** each plan run uses about 200 of the 10,000 free daily units, mostly for two searches. Posting a comment costs about 50 units.

### 5b. Anthropic: Claude API (required)

1. Go to <https://console.anthropic.com> → **Settings → Billing** and add credit. Pay-as-you-go; $10–20 goes a long way.
2. **Settings → Limits**: set a **monthly spend limit** (e.g. $25) so a bug or runaway usage can't surprise you.
3. Create the key **inside a workspace**: *Settings → Workspaces → Default* (or a new `GameGarden` workspace) → **API keys → Create key**, named `gamegarden-prod`. It goes into `ANTHROPIC_API_KEY`. Workspace keys also let you give GameGarden its own spend limit.
   - If you already have an organization-level key (one that isn't scoped to a workspace), you can keep it. Also set `ANTHROPIC_WORKSPACE_ID` to the workspace ID (`wrkspc_…`, shown under *Settings → Workspaces*). Otherwise every call fails with *"must include the anthropic-workspace-id header"*.

### 5c. Reddit (optional; needs approval)

Reddit closed self-service API access under its **Responsible Builder Policy**: new apps need approval before they can get OAuth tokens. Plan for a wait, possibly with no reply.

1. Log in with the Reddit account you'll post from, and go to <https://www.reddit.com/prefs/apps>. Click **create another app…**:
   - type **web app**
   - name `GameGarden`
   - redirect URI `APP_URL/api/connect/reddit/callback`
2. Submit an API access request as described in Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy). Describe it honestly: a personal, low-volume tool that reads your own account's activity and a few subreddits, and posts only content you approve, from your own account.
3. Once approved, set these variables:
   - `REDDIT_CLIENT_ID`: the string under the app name
   - `REDDIT_CLIENT_SECRET`
   - `REDDIT_USER_AGENT=web:gamegarden:v0.1 (by /u/<your-username>)`

Until then, leave the Reddit variables unset. The Accounts page will show Reddit as "not configured", and everything else works.

### 5d. Bluesky and itch.io (no server setup)

- **Bluesky**: nothing to configure. You'll create an app password when connecting (§8).
- **itch.io** (optional): under itch.io **Settings → API keys**, generate a key and paste it into GameGarden's **Settings** page (not Vercel) to track views and downloads.

---

## 6. Create the Vercel project

1. Sign up at <https://vercel.com> with GitHub, and allow access to `K128kevin/GameGarden`.
2. **Add New… → Project → Import** `GameGarden`.
3. **Project name**: the name you picked in §3.
4. **Framework preset**: Next.js (auto-detected).
5. **Build and Output Settings → Build Command**: override to `npm run vercel-build`. This runs database migrations and then `next build`.
6. **Environment Variables**: add these (all environments are fine for now; see the note on previews below):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** URL (§4) |
| `DATABASE_URL_UNPOOLED` | Neon **direct** URL (§4) |
| `BETTER_AUTH_URL` | `APP_URL`, e.g. `https://gamegarden-kevin.vercel.app` (no trailing slash) |
| `BETTER_AUTH_SECRET` | from §2 |
| `ENCRYPTION_KEY` | from §2 |
| `CRON_SECRET` | from §2 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | §5a |
| `ANTHROPIC_API_KEY` | §5b |
| `ALLOWED_EMAILS` | your Google email, e.g. `k128kevin@gmail.com` (comma-separate to add more) |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` | §5c, only once approved |
| `ANTHROPIC_MODEL` | *(optional)* leave unset for `claude-opus-5-5` |
| `ANTHROPIC_WORKSPACE_ID` | *(only if your API key isn't scoped to a workspace)* the workspace ID, `wrkspc_…` |

7. Click **Deploy**. The build log should show `migrations applied successfully` followed by the Next.js build.

### After the first deploy

- **Production branch**: *Settings → Environments → Production*. Make sure the branch is `main`.
- **Fluid compute**: *Settings → Functions*. Confirm it's **enabled**; it's the default for new projects. Without it, Hobby functions stop after 60 s and plan runs will time out.
- **Function region**: *Settings → Functions → Function Region*. Pick the region that matches your Neon project: **Washington, D.C. (iad1)** for AWS us-east-1, or **Cleveland (cle1)** for AWS us-east-2 (Ohio). Redeploy afterwards; region changes only apply to new deployments.
- **Preview deployments**: previews run migrations too, and sign-in won't work on preview URLs because they aren't registered with Google. Recommended: *Settings → Git → Ignored Build Step → "Only build production"*. If that option isn't offered, use a custom command:

  ```bash
  if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi
  ```

  (Exit 1 means build, exit 0 means skip.)
- **Cron jobs**: *Settings → Cron Jobs* should list four `/api/cron/tick` entries (13:00, 14:00, 01:00, 02:00 UTC). They cover 9 AM and 9 PM Eastern in both daylight and standard time; extra calls do nothing. Vercel sends your `CRON_SECRET` automatically.

---

## 7. Set up a frequent heartbeat (so scheduled posts go out on time)

Vercel Hobby cron runs each job **once a day, at some point within the scheduled hour**. That's enough to trigger the planning runs, but a post you schedule for 3:15 PM would otherwise wait until the next tick. Add one of these; the first is recommended.

### 7a. cron-job.org (recommended; free, every 5 minutes)

1. Sign up at <https://cron-job.org> → **Create cronjob**.
2. **URL**: `APP_URL/api/cron/tick`
3. **Schedule**: every **5 minutes**.
4. **Advanced → Headers**: add `Authorization` with the value `Bearer <CRON_SECRET>`.
5. **Notifications**: enable "notify me when the job fails" (e.g. after 3 consecutive failures).
6. Click **Test run**. You should get HTTP 200 with JSON like `{"slot":"2026-09-28-am","published":[],"planning":"checking in background",...}`.

The endpoint answers in well under a second and does any planning in the background, so cron-job.org's 30-second timeout isn't a problem.

### 7b. GitHub Actions (alternative, free on a public repo)

`.github/workflows/tick.yml` pings every 15 minutes. GitHub may delay scheduled runs, and it pauses schedules after 60 days without repo activity. To enable it, go to repo **Settings → Secrets and variables → Actions**:

- **Secrets**: `CRON_SECRET`
- **Variables**: `APP_URL` = your URL, `ENABLE_TICK` = `true`

---

## 8. First-run checklist

Work through these in order. Each one tests a different part of the system.

1. **Heartbeat.** Replace the placeholders and run:

   ```bash
   curl -s -H "Authorization: Bearer <CRON_SECRET>" https://<APP_URL>/api/cron/tick
   ```

   You should get JSON back. A 401 means the secret doesn't match.
2. **Sign in.** Open `APP_URL` → **Sign in with Google** and pick the account listed in `ALLOWED_EMAILS`. You should land on the dashboard.
3. **Settings.** Confirm your time zone. All times you see and schedule use it; planning runs always happen at 9 AM and 9 PM Eastern.
4. **Connect Bluesky.** On bsky.app go to **Settings → Privacy and security → App passwords → Add** and name it `GameGarden`. Leave "Allow access to your direct messages" **unchecked**. In GameGarden, open **Accounts → Connect Bluesky** and enter your handle and the app password. You should see your follower count and recent posts.
5. **Connect YouTube.** Open **Accounts → Connect YouTube** and choose the Google account or Brand Account that owns the channel. The "unverified app" screen is expected (§5a).
6. **Add your game.** Under **Games → Add a game**, fill in the pitch, description, genres, and Steam and/or itch.io URLs. These are what the strategist works from, so be specific about the audience and comparable games. Then tick the **Linked accounts** and save.
7. **Test publishing safely.** Under **Compose**, pick Bluesky, write a harmless post, set a time about 10 minutes out, and click **Schedule**. Check **Schedule**: it should flip to *published* within about 5 minutes of that time (it depends on the pinger). If you'd rather not post publicly, click **Cancel** before it's due; that tests the cancel path instead.
8. **First plan.** On your Bluesky account page, open **Growth recommendations**, tick opt-in, and write concrete goals, for example:

   > "Reach 1,000 followers before our Steam Next Fest demo in February. I'm a solo dev making a cozy pixel-art roguelite; I can post about once a day and reply in the evenings."

   Click **Save**. The first run takes 1–3 minutes, then you'll land on the plan page with an assessment, a long-term strategy, and drafted actions. Check **Run history** at the bottom to see the model used and token counts.
9. **Game plan.** On the game page, opt in to **Marketing recommendations** the same way. Good goals mention wishlists, the demo or launch date, and the communities you care about.
10. **Wait for the next scheduled run** (9 AM or 9 PM Eastern). You should see a **"new"** badge next to *Growth plans* and a banner on the dashboard.

Day-to-day:
- Use **"✓ I did this"** when you act on a suggestion outside the app.
- Use **Dismiss** with a short reason when a suggestion is wrong. The strategist reads your notes on the next run.

---

## 9. Costs and monitoring

**Expected monthly cost:**

| Item | Cost |
| --- | --- |
| Vercel Hobby, Neon free, cron-job.org, Google APIs | $0 |
| Claude, default `claude-opus-5-5` | roughly **$0.20–0.35 per plan run**, so about **$12–20/month per active plan** at 2 runs a day, plus any manual "Run analysis now" clicks |
| Claude with `ANTHROPIC_MODEL=claude-sonnet-5` | less than half of that |
| Inbox reply drafts (only when you click **Draft reply**) | about $0.003 each with Haiku 4.5 (default), $0.01 with Sonnet 5.5, $0.04 with Opus 5.5 |

**Recommendations:**
- **Start small:** one account plan and one game plan (about $25–35/month on Opus 5.5, or about $15 on Sonnet 5), and add more once you see value. Every active plan runs twice a day even when there's little new activity, so **pause plans you're not using**; they keep their history.
- **Watch spend:** the Anthropic console's **Usage** page shows spend per day. Each plan's Run history also shows token counts per run.
- **Watch the scheduler:** in *Vercel → Project → Logs*, filter by `/api/cron/tick`. Background runs log a `[tick]` line with the results, and failed runs also show on the plan page with the error message.
- **Watch the database:** the Neon dashboard shows storage. The free tier's 0.5 GB is years of personal use.

---

## 10. Optional: custom domain

1. *Vercel → Settings → Domains → Add* (e.g. `gamegarden.yourdomain.com`) and follow the DNS instructions.
2. Update **`BETTER_AUTH_URL`** to the new domain and redeploy.
3. Add the new domain's origin and redirect URIs to the **Google OAuth client** (§5a) and the **Reddit app** (§5c).
4. Update the **cron-job.org URL**.

---

## 11. Before opening it to other people

GameGarden already keeps each user's data separate. When you're ready to let others in:

- [ ] **Allow sign-ups:** remove `ALLOWED_EMAILS` (or add their emails).
- [ ] **Vercel Pro** if there's any commercial use (the Hobby terms are non-commercial).
- [ ] **Google verification.** In the Google Auth Platform, complete **Branding** verification and **Data access** verification for the sensitive `youtube.force-ssl` scope. This needs:
  - a homepage
  - a **privacy policy** and **terms** page (the app doesn't have these yet; they're an easy addition)
  - a short demo video of the YouTube flow

  It typically takes days to weeks.
- [ ] **Reddit:** get approval for multi-user or commercial use under the Responsible Builder Policy.
- [ ] **Cost controls.** Claude cost grows with each active plan, so consider a per-user limit on active plans, or letting users bring their own API key.
- [ ] **Capacity:** upgrade Neon if storage or compute limits get close.

---

## 12. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Build fails at `drizzle-kit migrate` | `DATABASE_URL` / `DATABASE_URL_UNPOOLED` isn't set for that environment (often a preview build). Set the variables, or skip preview builds (§6). |
| Google says `Error 400: redirect_uri_mismatch` | The redirect URI must match exactly: `https`, no trailing slash, same domain as `BETTER_AUTH_URL`. |
| Clicking "Sign in with Google" does nothing; the browser's network tab shows 403 `Invalid origin` | The address you're on doesn't match `BETTER_AUTH_URL`. Open the production URL (not a deployment-specific `…-<hash>-….vercel.app` URL; production now redirects those automatically), or fix `BETTER_AUTH_URL` (e.g. it's still `http://localhost:3000`) and **redeploy**. The sign-in page shows a warning explaining which of these it is. |
| Sign-in returns to the home page with an error | Your email isn't in `ALLOWED_EMAILS`, or `BETTER_AUTH_URL` doesn't match the URL you're using. |
| `/api/cron/tick` returns 401 | The header must be exactly `Authorization: Bearer <CRON_SECRET>`, matching Vercel's value. |
| Plan run failed: `ANTHROPIC_API_KEY is not set`, 401, or credit errors | Check the key in Vercel (then redeploy) and your Anthropic billing and limits. |
| Plan run failed: `This API key is not scoped to a workspace … anthropic-workspace-id header` | Create the API key inside a workspace (§5b), or keep the key and set `ANTHROPIC_WORKSPACE_ID=wrkspc_…`. Then redeploy and click **Run analysis now**. |
| Plan run failed with a timeout | Fluid compute is off (§6), or you have many plans. Runs that don't finish in time are picked up by the next tick in the same slot. |
| YouTube disconnects about weekly | The Google app is still in **Testing**. Publish it (§5a step 5), then reconnect YouTube. |
| "No YouTube channel found" | That Google account has no channel. Reconnect and choose the Brand Account that owns the channel. |
| YouTube `quotaExceeded` | The daily quota resets at midnight Pacific. Reduce manual runs, or request more quota in the Cloud console. |
| Reddit shows "not configured" | The Reddit variables aren't set yet (see §5c). |
| Reddit 401/403 after connecting | The app isn't approved yet, or `REDDIT_USER_AGENT` doesn't follow the `web:name:version (by /u/you)` format. |
| Bluesky "login failed" | The app password was revoked or mistyped. Create a new one and reconnect. |
| All connected accounts suddenly error | `ENCRYPTION_KEY` changed. Restore the original value, or reconnect every account. |
| Scheduled post stays "scheduled" after its time | Nothing is calling the heartbeat often enough. Vercel's free cron only runs around 9 AM and 9 PM ET, so set up cron-job.org (§7). The **Schedule** page shows a warning saying whether no heartbeat has arrived or calls are being rejected for a wrong `CRON_SECRET`. In the meantime, due posts go out when you open GameGarden, and overdue items have a **Post now** button. |
| Steam/itch.io stats missing | Click **Refresh store data** on the game page; the error explains what failed (e.g. the store page isn't public yet). |

---

## Local development (optional)

```bash
cp .env.example .env.local        # fill in values; a local Postgres or a Neon dev branch both work
npm install
npm run db:migrate
npm run dev                       # http://localhost:3000
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/tick
npm run lint && npm run typecheck && npm test
```

The `http://localhost:3000` redirect URIs from §5a make Google sign-in and YouTube connection work locally with the same OAuth client.
