import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, games, planRuns, plans, recommendations, scheduledActions, socialAccounts } from "@/db/schema";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, formatRelative, nextPlanSlot, slotLabelFromId } from "@/lib/time";
import { toRecView } from "@/lib/views";
import { RecommendationCard } from "@/components/recommendation-card";
import { Badge, btn, Card, CardTitle, EmptyState, Link, PageHeader, PlatformBadge, Stat } from "@/components/ui";

export const maxDuration = 300;

export default async function Dashboard() {
  const user = await requireUser();
  const { timezone: tz } = await getUserSettings(user.id);

  const [accts, gameRows, planRows, pendingRecs, upcoming, activity] = await Promise.all([
    db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id)),
    db.select().from(games).where(eq(games.userId, user.id)),
    db.select().from(plans).where(eq(plans.userId, user.id)),
    db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, user.id), eq(recommendations.status, "pending")))
      .orderBy(asc(recommendations.suggestedFor))
      .limit(6),
    db
      .select()
      .from(scheduledActions)
      .where(and(eq(scheduledActions.userId, user.id), inArray(scheduledActions.status, ["scheduled", "failed"])))
      .orderBy(asc(scheduledActions.scheduledFor))
      .limit(6),
    db.select().from(activityLog).where(eq(activityLog.userId, user.id)).orderBy(desc(activityLog.createdAt)).limit(12),
  ]);
  const acctMap = new Map(accts.map((a) => [a.id, a]));
  const gameNames = new Map(gameRows.map((g) => [g.id, g.name]));
  const updatedPlans = planRows.filter((p) => p.lastRunAt && (!p.lastViewedAt || p.lastRunAt > p.lastViewedAt));
  const latestRuns = updatedPlans.length
    ? await db
        .select()
        .from(planRuns)
        .where(inArray(planRuns.planId, updatedPlans.map((p) => p.id)))
        .orderBy(desc(planRuns.startedAt))
    : [];
  const planName = (p: (typeof planRows)[number]) =>
    p.kind === "account_growth" ? `${acctMap.get(p.accountId!)?.handle ?? "Account"} growth` : `${gameNames.get(p.gameId!) ?? "Game"} marketing`;
  const activePlans = planRows.filter((p) => p.enabled);

  return (
    <>
      <PageHeader
        title={`Welcome back${user.name ? `, ${user.name.split(" ")[0]}` : ""}`}
        subtitle={
          <>
            Next planning run: <span className="text-zinc-200">{formatDateTime(nextPlanSlot(), tz)}</span> ({formatRelative(nextPlanSlot())})
          </>
        }
        actions={
          <Link href="/compose" className={btn.primary}>
            Compose
          </Link>
        }
      />

      {updatedPlans.length > 0 && (
        <div className="mb-6 rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-4">
          <div className="flex items-center gap-2 font-medium text-emerald-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> Your growth plans were updated
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {updatedPlans.map((p) => {
              const run = latestRuns.find((r) => r.planId === p.id && r.status === "succeeded");
              return (
                <li key={p.id}>
                  <Link href={`/plans/${p.id}`} className="text-emerald-300 hover:underline">
                    {planName(p)}
                  </Link>{" "}
                  <span className="text-zinc-400">
                    — {run ? slotLabelFromId(run.slot) : "updated"} {formatRelative(p.lastRunAt)}
                    {run?.strategyChanged ? " · strategy revised" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Accounts" value={accts.length} />
        <Stat label="Games" value={gameRows.length} />
        <Stat label="Active plans" value={activePlans.length} />
        <Stat label="Scheduled" value={upcoming.filter((u) => u.status === "scheduled").length} />
      </div>

      {(accts.length === 0 || gameRows.length === 0 || activePlans.length === 0) && (
        <Card className="mb-6">
          <CardTitle>Getting started</CardTitle>
          <ol className="space-y-2 text-sm">
            <Step done={accts.length > 0} href="/accounts">
              Connect a Bluesky, YouTube, or Reddit account
            </Step>
            <Step done={gameRows.length > 0} href="/games">
              Add a game (with its Steam / itch.io page) and link accounts to it
            </Step>
            <Step done={activePlans.length > 0} href="/accounts">
              Opt an account or game in to AI growth recommendations
            </Step>
          </ol>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Up next</h2>
            <Link href="/plans" className="text-xs text-emerald-300 hover:underline">
              All plans →
            </Link>
          </div>
          {pendingRecs.length ? (
            pendingRecs.map((r) => <RecommendationCard key={r.id} rec={toRecView(r, acctMap, tz, gameNames)} />)
          ) : (
            <EmptyState title="No pending recommendations">
              {activePlans.length
                ? "You're all caught up. New suggestions arrive with the next planning run."
                : "Opt an account or game in to growth recommendations to get started."}
            </EmptyState>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle action={<Link href="/schedule" className="text-xs text-emerald-300 hover:underline">View all</Link>}>
              Scheduled
            </CardTitle>
            {upcoming.length ? (
              <ul className="space-y-3">
                {upcoming.map((u) => {
                  const a = acctMap.get(u.accountId);
                  return (
                    <li key={u.id} className="text-sm">
                      <div className="flex items-center gap-1.5">
                        {a && <PlatformBadge platform={a.platform} />}
                        {u.status === "failed" && <Badge color="red">failed</Badge>}
                        <span className="text-xs text-zinc-400">{formatDateTime(u.scheduledFor, tz)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-zinc-300">{u.payload.title ?? u.payload.text}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Nothing scheduled.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Recent activity</CardTitle>
            {activity.length ? (
              <ul className="space-y-2.5">
                {activity.map((l) => (
                  <li key={l.id} className="text-sm">
                    <div className="text-zinc-300">{l.message}</div>
                    <div className="text-xs text-zinc-500">{formatRelative(l.createdAt)}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No activity yet.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({ done, href, children }: { done: boolean; href: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-500 text-emerald-950" : "border border-zinc-600 text-zinc-500"}`}>
        {done ? "✓" : ""}
      </span>
      {done ? <span className="text-zinc-500 line-through">{children}</span> : <Link href={href} className="text-zinc-200 hover:text-emerald-300">{children}</Link>}
    </li>
  );
}
