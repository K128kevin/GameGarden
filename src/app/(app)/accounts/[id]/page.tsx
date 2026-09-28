import { and, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { contentItems, gameAccounts, gameContent, games, interactions, plans } from "@/db/schema";
import { disconnectAccount, saveAccountGrowth, syncAccountAction } from "@/app/actions";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, formatRelative, msFromNow } from "@/lib/time";
import { getConnector } from "@/platforms/registry";
import { getOwnedAccount, latestSnapshots } from "@/services/accounts";
import { ActionButton } from "@/components/forms";
import { GameLinker } from "@/components/game-linker";
import { PlanOptIn } from "@/components/plan-optin";
import { Badge, btn, Card, CardTitle, ExternalLink, Link, Notice, PageHeader, PlatformBadge, Stat } from "@/components/ui";

export const maxDuration = 300;

export default async function AccountPage({ params, searchParams }: PageProps<"/accounts/[id]">) {
  const { id } = await params;
  const { connected } = await searchParams;
  const user = await requireUser();
  const acct = await getOwnedAccount(user.id, id);
  if (!acct) notFound();
  const { timezone: tz } = await getUserSettings(user.id);
  const connector = getConnector(acct.platform);

  const [snaps, content, inbound, [plan], userGames, links] = await Promise.all([
    latestSnapshots(acct.id, 60),
    db.select().from(contentItems).where(eq(contentItems.accountId, acct.id)).orderBy(desc(contentItems.publishedAt)).limit(40),
    db.select().from(interactions).where(eq(interactions.accountId, acct.id)).orderBy(desc(interactions.occurredAt)).limit(25),
    db.select().from(plans).where(and(eq(plans.accountId, acct.id), eq(plans.kind, "account_growth"))),
    db.select({ id: games.id, name: games.name }).from(games).where(eq(games.userId, user.id)),
    db.select().from(gameAccounts).where(eq(gameAccounts.accountId, acct.id)),
  ]);
  const contentLinks = content.length
    ? await db.select().from(gameContent).where(inArray(gameContent.contentItemId, content.map((c) => c.id)))
    : [];

  const latest = snaps[0];
  const weekCutoff = msFromNow(-6.5 * 86_400_000);
  const weekAgo = snaps.find((s) => s.capturedAt < weekCutoff) ?? snaps[snaps.length - 1];
  const delta = (k: "followers" | "following" | "postsCount") =>
    latest && weekAgo && latest !== weekAgo && latest[k] != null && weekAgo[k] != null ? latest[k]! - weekAgo[k]! : null;
  const extra = (latest?.extra ?? {}) as Record<string, unknown>;
  const linkedGames = userGames.filter((g) => links.some((l) => l.gameId === g.id));

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {acct.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={acct.avatarUrl} alt="" className="h-9 w-9 rounded-full" />
            )}
            {acct.displayName || acct.handle}
            <PlatformBadge platform={acct.platform} />
          </span>
        }
        subtitle={
          <>
            <ExternalLink href={acct.profileUrl}>{acct.handle}</ExternalLink> · last synced {formatRelative(acct.lastSyncedAt)}
          </>
        }
        actions={
          <>
            <ActionButton action={syncAccountAction.bind(null, acct.id)} pendingText="Syncing…">
              Sync now
            </ActionButton>
            <ActionButton
              action={disconnectAccount.bind(null, acct.id)}
              className={btn.danger}
              confirm="Disconnect this account? Its synced history and growth plan will be deleted."
            >
              Disconnect
            </ActionButton>
          </>
        }
      />
      {connected && (
        <div className="mb-4">
          <Notice kind="ok">Connected! Opt in below to get a growth plan for this account.</Notice>
        </div>
      )}
      {acct.status !== "active" && (
        <div className="mb-4">
          <Notice kind="error">
            {acct.statusMessage}{" "}
            {connector.connect.type === "oauth" && (
              <a href={`/api/connect/${connector.id}/start`} className="underline">
                Reconnect
              </a>
            )}
          </Notice>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={acct.platform === "youtube" ? "Subscribers" : "Followers"} value={latest?.followers} delta={delta("followers")} />
        {latest?.following != null && <Stat label="Following" value={latest.following} delta={delta("following")} />}
        {latest?.postsCount != null && <Stat label={acct.platform === "youtube" ? "Videos" : "Posts"} value={latest.postsCount} delta={delta("postsCount")} />}
        {typeof extra.totalKarma === "number" && <Stat label="Karma" value={extra.totalKarma} />}
        {typeof extra.totalViews === "number" && <Stat label="Total views" value={extra.totalViews.toLocaleString()} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardTitle>Recent content ({content.length})</CardTitle>
            {!content.length && <p className="text-sm text-zinc-500">Nothing synced yet.</p>}
            <ul className="divide-y divide-zinc-800">
              {content.map((c) => (
                <li key={c.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    <Badge>{c.kind}</Badge>
                    {c.source === "app" && <Badge color="green">via GameGarden</Badge>}
                    {c.community && <span>r/{c.community}</span>}
                    <span>{formatDateTime(c.publishedAt, tz)}</span>
                    <span className="ml-auto flex gap-2">
                      {Object.entries(c.metrics).map(([k, v]) => (
                        <span key={k}>
                          {v} {k}
                        </span>
                      ))}
                    </span>
                  </div>
                  {c.title && <div className="mt-1 font-medium text-zinc-200">{c.title}</div>}
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-zinc-300">{c.text}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <GameLinker contentId={c.id} games={userGames} linked={contentLinks.filter((l) => l.contentItemId === c.id).map((l) => l.gameId)} />
                    <ExternalLink href={c.url} className="text-xs">
                      open ↗
                    </ExternalLink>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle
              action={
                plan && (
                  <Link href={`/plans/${plan.id}`} className="text-xs text-emerald-300 hover:underline">
                    Open plan →
                  </Link>
                )
              }
            >
              Growth recommendations
            </CardTitle>
            <PlanOptIn
              action={saveAccountGrowth.bind(null, acct.id)}
              enabled={plan?.enabled ?? false}
              goals={plan?.goals ?? ""}
              isNew={!plan?.lastRunAt}
              placeholder="e.g. Reach 1,000 followers by launch; I post devlogs for a cozy farming roguelite; I can post ~1x/day"
            />
          </Card>

          <Card>
            <CardTitle>Linked games</CardTitle>
            {linkedGames.length ? (
              <ul className="space-y-1 text-sm">
                {linkedGames.map((g) => (
                  <li key={g.id}>
                    <Link href={`/games/${g.id}`} className="text-zinc-200 hover:text-emerald-300">
                      {g.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Link this account from a game&apos;s page.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Replies, mentions &amp; comments</CardTitle>
            {!inbound.length && <p className="text-sm text-zinc-500">None yet.</p>}
            <ul className="space-y-3">
              {inbound
                .filter((i) => i.kind !== "like")
                .slice(0, 15)
                .map((i) => (
                  <li key={i.id} className="text-sm">
                    <div className="text-xs text-zinc-500">
                      <Badge>{i.kind}</Badge> {i.authorHandle} · {formatRelative(i.occurredAt)}
                    </div>
                    {i.text && <p className="mt-1 line-clamp-3 text-zinc-300">{i.text}</p>}
                    {i.url && (
                      <ExternalLink href={i.url} className="text-xs">
                        open ↗
                      </ExternalLink>
                    )}
                  </li>
                ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
