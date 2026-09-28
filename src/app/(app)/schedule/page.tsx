import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { games, scheduledActions, socialAccounts } from "@/db/schema";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, formatRelative, msFromNow, toLocalInput } from "@/lib/time";
import { HeartbeatNotice } from "@/components/heartbeat-notice";
import { ScheduledControls } from "@/components/scheduled-item";
import { Badge, btn, EmptyState, ExternalLink, Link, PageHeader, PlatformBadge, StatusBadge } from "@/components/ui";

export const maxDuration = 60;

export default async function SchedulePage() {
  const user = await requireUser();
  const { timezone: tz } = await getUserSettings(user.id);
  const accts = new Map((await db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id))).map((a) => [a.id, a]));
  const gameNames = new Map((await db.select().from(games).where(eq(games.userId, user.id))).map((g) => [g.id, g.name]));
  const upcoming = await db
    .select()
    .from(scheduledActions)
    .where(and(eq(scheduledActions.userId, user.id), inArray(scheduledActions.status, ["scheduled", "publishing", "failed"])))
    .orderBy(asc(scheduledActions.scheduledFor));
  const past = await db
    .select()
    .from(scheduledActions)
    .where(and(eq(scheduledActions.userId, user.id), notInArray(scheduledActions.status, ["scheduled", "publishing", "failed"])))
    .orderBy(desc(scheduledActions.scheduledFor))
    .limit(30);

  // Give the heartbeat a few minutes of slack before calling something overdue.
  const overdueCutoff = msFromNow(-10 * 60_000);
  const isOverdue = (a: (typeof upcoming)[number]) => a.status === "scheduled" && a.scheduledFor < overdueCutoff;
  const overdueCount = upcoming.filter(isOverdue).length;

  const Row = ({ a }: { a: (typeof upcoming)[number] }) => {
    const acct = accts.get(a.accountId);
    const overdue = isOverdue(a);
    return (
      <li className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {acct && <PlatformBadge platform={acct.platform} />}
          <span className="text-zinc-400">{acct?.handle}</span>
          <Badge>{a.payload.kind}</Badge>
          {a.payload.community && <Badge color="amber">r/{a.payload.community}</Badge>}
          {a.gameId && gameNames.get(a.gameId) && <Badge color="violet">{gameNames.get(a.gameId)}</Badge>}
          <StatusBadge status={a.status} />
          {overdue && <Badge color="amber">overdue</Badge>}
          <span className="ml-auto text-xs text-zinc-400">
            {formatDateTime(a.publishedAt ?? a.scheduledFor, tz)} ({formatRelative(a.publishedAt ?? a.scheduledFor)})
          </span>
        </div>
        {a.payload.target?.excerpt && (
          <p className="mt-2 border-l-2 border-zinc-700 pl-2 text-xs text-zinc-500">
            ↳ replying to {a.payload.target.author ? `@${a.payload.target.author}` : "post"}: {a.payload.target.excerpt}
          </p>
        )}
        {a.payload.title && <div className="mt-2 font-medium text-zinc-100">{a.payload.title}</div>}
        <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">{a.payload.text}</p>
        {a.error && <p className="mt-2 text-sm text-red-300">{a.error}</p>}
        {a.resultUrl && (
          <ExternalLink href={a.resultUrl} className="mt-2 inline-block text-xs">
            View post ↗
          </ExternalLink>
        )}
        <p className="mt-2 text-xs text-zinc-600">Approved {formatDateTime(a.approvedAt, tz)}</p>
        <ScheduledControls
          id={a.id}
          status={a.status}
          text={a.payload.text}
          title={a.payload.title ?? null}
          whenLocal={toLocalInput(a.scheduledFor, tz)}
          overdue={overdue}
        />
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Everything here was approved by you. Scheduled items publish automatically at their time."
        actions={
          <Link href="/compose" className={btn.primary}>
            New post
          </Link>
        }
      />
      <div className="mb-6 empty:hidden">
        <HeartbeatNotice overdueCount={overdueCount} />
      </div>
      <h2 className="mb-3 text-sm font-semibold text-zinc-100">Upcoming</h2>
      {upcoming.length ? (
        <ul className="mb-8 space-y-3">
          {upcoming.map((a) => (
            <Row key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <div className="mb-8">
          <EmptyState title="Nothing scheduled">Schedule a recommendation or compose a post.</EmptyState>
        </div>
      )}
      <h2 className="mb-3 text-sm font-semibold text-zinc-100">History</h2>
      {past.length ? (
        <ul className="space-y-3">
          {past.map((a) => (
            <Row key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">No history yet.</p>
      )}
    </>
  );
}
