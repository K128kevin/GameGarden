# 🌱 GameGarden

Social media marketing and account growth for indie game developers.

- **Connect accounts:** Bluesky, YouTube, and Reddit today. Platforms are plug-ins (see [Adding a platform](#adding-a-platform)).
- **Organize by game:** each game has linked accounts, linked posts, and its Steam and itch.io pages, with store stats tracked over time.
- **AI growth plans:** opt an **account** in for *growth* recommendations, or a **game** in for *marketing* recommendations. Twice a day (9:00 AM and 9:00 PM US Eastern) GameGarden:
  1. syncs the account(s): follower stats, your recent posts and their metrics (including anything you posted manually), and new replies, mentions and comments;
  2. searches the platform for relevant conversations (keywords and subreddits that the strategist keeps up to date);
  3. sends all of that, plus the long-term strategy, earlier run assessments, and the history of past recommendations (what you scheduled, dismissed and why, or ignored), to Claude;
  4. stores an assessment of what changed, a revised long-term strategy, and new recommended actions. Posts and replies come with drafts and suggested times.
- **Approval first:** schedule a recommendation for its suggested time with one click, edit it, pick another time, or post it now. **Nothing is ever posted unless you clicked Post now or scheduled it yourself.**
- **Clear signals:** plans updated since you last looked get a "new" badge in the nav and a banner on the dashboard and plan page.
- **History:** every run, recommendation, and action is kept, and each plan has a **Clear history** button.
- **Sign in with Google.**

## Stack

| Piece | Choice | Free tier |
| --- | --- | --- |
| App | Next.js 16 (App Router, server actions), TypeScript, Tailwind v4 | Vercel Hobby |
| DB | Postgres via Drizzle ORM | Neon or Supabase free |
| Auth | Better Auth + Google OAuth | — |
| AI | Claude API (`@anthropic-ai/sdk`, structured outputs) | pay-as-you-go |
| Scheduler | Vercel Cron + an optional external pinger | free |

## How scheduling works

There is one idempotent heartbeat endpoint, `GET /api/cron/tick` (it needs `Authorization: Bearer $CRON_SECRET`). Each call:

1. publishes **approved** scheduled items that are due;
2. works out the current planning slot (`YYYY-MM-DD-am/pm`, 9 AM or 9 PM `America/New_York`, so daylight saving time is handled) and runs every enabled plan that hasn't run for that slot yet. Runs are keyed per (plan, slot), so extra calls never cause double runs.

`vercel.json` calls the tick at 13:00, 14:00, 01:00 and 02:00 UTC. That covers 9 AM and 9 PM Eastern in both EDT and EST, and it fits Vercel Hobby's limit of one run per day per cron job. Calls outside a slot do nothing.

Scheduled posts go out on the next tick after their time. On Vercel Hobby the only built-in ticks are the four above, so to publish on time, add a free pinger that calls the tick every 5–15 minutes:

- **cron-job.org** (recommended, free): create a job for `https://YOUR-APP/api/cron/tick` every 5 minutes with the header `Authorization: Bearer YOUR_CRON_SECRET`.
- **GitHub Actions**: `.github/workflows/tick.yml` is included. It's free on public repos and disabled until you set the repo variable `ENABLE_TICK=true`, the variable `APP_URL`, and the secret `CRON_SECRET`.

The tick publishes due posts and then responds right away; planning runs continue in the background (`after()`), so pingers with short timeouts work fine.

When you opt an account or game in, the first plan is generated right away. After that, updates arrive with the scheduled runs, or whenever you click **Run analysis now**.

## Safety model

- The planner (LLM) only writes `recommendations` rows. It has no code path to the publisher.
- The publisher (`src/services/publisher.ts`) only acts on `scheduled_actions` rows. Those rows are created only by signed-in user clicks (Post now, Schedule, Compose, Retry), always carry `approved_at`, and are claimed atomically so nothing publishes twice.
- Editing a scheduled item counts as re-approving it. A failed post, or one interrupted mid-publish, is **never retried automatically**.
- Platform credentials (OAuth tokens, Bluesky app passwords, itch.io API keys) are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
- `ALLOWED_EMAILS` restricts sign-up while the app is personal. Remove it to let anyone sign in, since all data is already scoped per user.

## Deploying (free)

**Full step-by-step guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** It covers Neon, Google OAuth and YouTube, Claude, Reddit approval, Vercel settings, the heartbeat pinger, a first-run checklist, costs, and troubleshooting.

Short version:
1. Create a Neon Postgres database (pooled URL → `DATABASE_URL`, direct URL → `DATABASE_URL_UNPOOLED`).
2. Create a Google OAuth web client with redirect URIs `APP_URL/api/auth/callback/google` and `APP_URL/api/connect/youtube/callback`. Enable YouTube Data API v3, and **publish** the consent screen so tokens don't expire after 7 days.
3. Create a Claude API key and set a spend limit.
4. Import the repo into Vercel, set the build command to `npm run vercel-build`, and add the variables from `.env.example`.
5. Point cron-job.org at `APP_URL/api/cron/tick` every 5 minutes with `Authorization: Bearer $CRON_SECRET`.

**Cost:** each plan run is one Claude call, typically 15–30k input tokens and 4–8k output tokens. With the default `claude-opus-5` that is roughly $0.25–0.35 per run, so about $15–20 a month per active plan at two runs a day. Set `ANTHROPIC_MODEL=claude-sonnet-5` to cut that by more than half. Requests enable Anthropic's server-side refusal fallback (`fallbacks: "default"`).

## Local development

```bash
cp .env.example .env.local   # fill in values
npm install
npm run db:migrate           # needs DATABASE_URL
npm run dev
```

Trigger a tick locally with `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/tick`.

```bash
npm run lint && npm run typecheck && npm test   # tests need DATABASE_URL (a local Postgres is fine)
```

After changing `src/db/schema.ts`, run `npm run db:generate` to create a migration in `drizzle/`.

## Project layout

```
src/
  app/                 routes: dashboard, plans, accounts, games, schedule, compose, settings
    actions.ts         all server actions (every mutation checks ownership)
    api/cron/tick      heartbeat: publish due items + run the current planning slot
    api/connect/[platform]/{start,callback}   generic OAuth connect flow
  platforms/           one file per platform + types.ts (interface) + registry.ts
  stores/              Steam and itch.io data fetchers
  services/
    accounts.ts        sync profile/content/interactions
    planner.ts         builds LLM context, runs plans, persists results, clears history
    ai.ts              Claude call + output schema + system prompt
    publisher.ts       the only code that publishes (approval-gated)
  db/schema.ts         Drizzle schema
drizzle/               SQL migrations
tests/                 vitest (time slots, output parsing, full plan→approve→publish flow)
```

## Adding a platform

1. Create `src/platforms/<name>.ts` that implements `PlatformConnector` from `src/platforms/types.ts`:
   - `connect`: either `oauth` (`getAuthorizationUrl` / `exchangeCode`) or `credentials` (form fields + `connectWithCredentials`);
   - `fetchProfile`, `fetchOwnContent`, `fetchInteractions`, `discover`;
   - `publish`, `resolveOwnContentUrl`, `matchesUrl`;
   - `capabilities` (whether it can post or reply, character limits, required title or community). The planner reads these, so it never suggests an action the platform can't do.
2. Add it to the `connectors` array in `src/platforms/registry.ts`.

The accounts page, OAuth routes (`/api/connect/<id>/…`), sync, planner, composer, and publisher all pick it up automatically. The `platform` column is free text, so no migration is needed. `tests/flow.test.ts` registers a fake connector this way.

## Platform notes

- **Bluesky:** connects with an app password (atproto OAuth could be added later as another `connect` type). Can post (300 characters) and reply. Discovery uses post search.
- **YouTube:** can comment on videos and reply to comments. The API doesn't allow uploads or Community posts from here, so video and Short ideas arrive as *Create content* tasks with a drafted title and description. Search costs 100 quota units per call, so each run makes at most 2 searches (the daily quota is 10,000).
- **Reddit:** can create self or link posts (title and subreddit required) and comments. The strategist follows each subreddit's self-promotion norms.
- **Steam / itch.io:** public store data (reviews, price, release info). Add an itch.io API key in Settings to track views and downloads.
