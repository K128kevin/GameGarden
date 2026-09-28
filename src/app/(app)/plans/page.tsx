import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { games, planRuns, plans, recommendations, socialAccounts } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { isPlanUpdated, planTitle } from "@/lib/plan-names";
import { formatRelative, nextPlanSlot, slotLabelFromId } from "@/lib/time";
import { Badge, EmptyState, Link, PageHeader, PlatformBadge } from "@/components/ui";

export default async function PlansPage() {
  const user = await requireUser();
  const rows = await db.select().from(plans).where(eq(plans.userId, user.id)).orderBy(desc(plans.lastRunAt));
  const accts = new Map((await db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id))).map((a) => [a.id, a]));
  const gameMap = new Map((await db.select().from(games).where(eq(games.userId, user.id))).map((g) => [g.id, g]));
  const pendingCounts = new Map(
    (
      await db
        .select({ planId: recommendations.planId, n: sql<number>`count(*)::int` })
        .from(recommendations)
        .where(and(eq(recommendations.userId, user.id), eq(recommendations.status, "pending")))
        .groupBy(recommendations.planId)
    ).map((r) => [r.planId, r.n]),
  );
  const lastRuns = new Map<string, typeof planRuns.$inferSelect>();
  for (const p of rows) {
    const [r] = await db.select().from(planRuns).where(eq(planRuns.planId, p.id)).orderBy(desc(planRuns.startedAt)).limit(1);
    if (r) lastRuns.set(p.id, r);
  }

  return (
    <>
      <PageHeader
        title="Growth plans"
        subtitle={`Plans update automatically at 9 AM and 9 PM ET (next: ${formatRelative(nextPlanSlot())}).`}
      />
      {!rows.length ? (
        <EmptyState title="No plans yet">
          Opt in from an <Link href="/accounts" className="underline">account</Link> or{" "}
          <Link href="/games" className="underline">game</Link> page to create one.
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {rows.map((p) => {
            const acct = p.accountId ? accts.get(p.accountId) : undefined;
            const game = p.gameId ? gameMap.get(p.gameId) : undefined;
            const run = lastRuns.get(p.id);
            return (
              <Link key={p.id} href={`/plans/${p.id}`} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-100">{planTitle(p, acct?.handle, game?.name)}</span>
                  {acct && <PlatformBadge platform={acct.platform} />}
                  {game && <Badge color="violet">game</Badge>}
                  {!p.enabled && <Badge>paused</Badge>}
                  {isPlanUpdated(p) && <Badge color="green">● updated</Badge>}
                  {run?.status === "failed" && <Badge color="red">last run failed</Badge>}
                  {run?.status === "running" && <Badge color="amber">running…</Badge>}
                  <span className="ml-auto text-xs text-zinc-500">
                    {p.lastRunAt ? `${run ? slotLabelFromId(run.slot) : "Updated"} · ${formatRelative(p.lastRunAt)}` : "Not run yet"}
                  </span>
                </div>
                <div className="mt-1 text-sm text-zinc-400">
                  {pendingCounts.get(p.id) ?? 0} pending recommendation{pendingCounts.get(p.id) === 1 ? "" : "s"}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
