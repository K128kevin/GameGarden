import { and, eq, isNotNull, or, isNull, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { plans, recommendations, scheduledActions } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { SignOutButton } from "@/components/auth-buttons";
import { NavLinks } from "@/components/nav";
import { checkInboundForUser } from "@/services/accounts";
import { countInbox } from "@/services/inbox";
import { publishDueForUser } from "@/services/publisher";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Backstop for a missing/late heartbeat: whenever you open the app, publish
  // any of your already-approved scheduled items whose time has passed.
  after(async () => {
    await publishDueForUser(user.id);
    await checkInboundForUser(user.id);
  });
  const [updated] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(plans)
    .where(
      and(
        eq(plans.userId, user.id),
        isNotNull(plans.lastRunAt),
        or(isNull(plans.lastViewedAt), sql`${plans.lastRunAt} > ${plans.lastViewedAt}`),
      ),
    );
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recommendations)
    .where(and(eq(recommendations.userId, user.id), eq(recommendations.status, "pending")));
  const [scheduled] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledActions)
    .where(and(eq(scheduledActions.userId, user.id), eq(scheduledActions.status, "scheduled")));

  const inboxCount = await countInbox(user.id);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-zinc-800 bg-zinc-950/80 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-5 py-4">
          <span className="text-xl">🌱</span>
          <span className="font-semibold tracking-tight text-zinc-50">GameGarden</span>
        </div>
        <NavLinks counts={{ plans: updated.n, recommendations: pending.n, schedule: scheduled.n, inbox: inboxCount }} />
        <div className="hidden border-t border-zinc-800 px-3 py-3 md:absolute md:bottom-0 md:block md:w-full">
          <div className="truncate px-2.5 pb-1 text-xs text-zinc-500">{user.email}</div>
          <SignOutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
