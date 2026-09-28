import { and, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { contentItems, gameAccounts, gameContent, plans, socialAccounts } from "@/db/schema";
import { deleteGame, linkPostByUrl, refreshGameStores, saveGameMarketing, setGameAccounts, updateGame } from "@/app/actions";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, formatRelative } from "@/lib/time";
import { getOwnedGame, storeHistory } from "@/services/games";
import type { ItchSnapshot } from "@/stores/itch";
import type { SteamSnapshot } from "@/stores/steam";
import { ActionButton, ActionForm, SubmitButton } from "@/components/forms";
import { GameForm } from "@/components/game-form";
import { GameLinker } from "@/components/game-linker";
import { PlanOptIn } from "@/components/plan-optin";
import { Badge, btn, Card, CardTitle, ExternalLink, input, Link, PageHeader, PlatformBadge, Stat } from "@/components/ui";

export const maxDuration = 300;

export default async function GamePage({ params }: PageProps<"/games/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const game = await getOwnedGame(user.id, id);
  if (!game) notFound();
  const { timezone: tz } = await getUserSettings(user.id);

  const [accts, links, [plan], steam, itch, linkedContent] = await Promise.all([
    db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id)),
    db.select().from(gameAccounts).where(eq(gameAccounts.gameId, game.id)),
    db.select().from(plans).where(and(eq(plans.gameId, game.id), eq(plans.kind, "game_marketing"))),
    storeHistory(game.id, "steam", 10),
    storeHistory(game.id, "itch", 10),
    db
      .select({ item: contentItems, linkedAt: gameContent.linkedAt })
      .from(gameContent)
      .innerJoin(contentItems, eq(contentItems.id, gameContent.contentItemId))
      .where(eq(gameContent.gameId, game.id))
      .orderBy(desc(contentItems.publishedAt))
      .limit(50),
  ]);
  const linkedIds = new Set(links.map((l) => l.accountId));
  const acctMap = new Map(accts.map((a) => [a.id, a]));
  const recentUnlinked = linkedIds.size
    ? await db
        .select()
        .from(contentItems)
        .where(inArray(contentItems.accountId, [...linkedIds]))
        .orderBy(desc(contentItems.publishedAt))
        .limit(15)
    : [];
  const linkedContentIds = new Set(linkedContent.map((l) => l.item.id));

  const s = steam[0]?.data as SteamSnapshot | undefined;
  const sPrev = steam[1]?.data as SteamSnapshot | undefined;
  const i = itch[0]?.data as ItchSnapshot | undefined;
  const iPrev = itch[1]?.data as ItchSnapshot | undefined;
  const d = (a?: number, b?: number) => (a != null && b != null ? a - b : null);

  return (
    <>
      <PageHeader
        title={game.name}
        subtitle={game.pitch}
        actions={
          <>
            {plan && (
              <Link href={`/plans/${plan.id}`} className={btn.secondary}>
                Marketing plan
              </Link>
            )}
            <ActionButton action={refreshGameStores.bind(null, game.id)} pendingText="Refreshing…">
              Refresh store data
            </ActionButton>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {(s || i) && (
            <Card>
              <CardTitle>Store pages</CardTitle>
              {s && (
                <div className="mb-4">
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    <ExternalLink href={game.steamUrl}>Steam</ExternalLink>
                    {s.reviewScore && <Badge color="blue">{s.reviewScore}</Badge>}
                    {s.comingSoon && <Badge color="amber">coming soon</Badge>}
                    <span className="ml-auto text-xs text-zinc-500">updated {formatRelative(steam[0].capturedAt)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Reviews" value={s.totalReviews ?? 0} delta={d(s.totalReviews, sPrev?.totalReviews)} />
                    <Stat label="Positive" value={s.positiveReviews ?? 0} delta={d(s.positiveReviews, sPrev?.positiveReviews)} />
                    <Stat label="Price" value={s.price ?? "—"} />
                  </div>
                </div>
              )}
              {i && (
                <div>
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    <ExternalLink href={game.itchUrl}>itch.io</ExternalLink>
                    {i.rating?.average != null && (
                      <Badge color="blue">
                        ★ {i.rating.average.toFixed(1)} ({i.rating.count})
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-zinc-500">updated {formatRelative(itch[0].capturedAt)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Views" value={i.views ?? "—"} delta={d(i.views, iPrev?.views)} />
                    <Stat label="Downloads" value={i.downloads ?? "—"} delta={d(i.downloads, iPrev?.downloads)} />
                    <Stat label="Price" value={i.price ?? "—"} />
                  </div>
                  {i.views == null && (
                    <p className="mt-2 text-xs text-zinc-500">
                      Add an itch.io API key in <Link href="/settings" className="underline">Settings</Link> to track views &amp; downloads.
                    </p>
                  )}
                </div>
              )}
            </Card>
          )}

          <Card>
            <CardTitle>Posts about this game ({linkedContent.length})</CardTitle>
            <ActionForm action={linkPostByUrl.bind(null, game.id)} className="mb-4" resetOnSuccess>
              <div className="flex gap-2">
                <input name="url" placeholder="Paste a post URL from a connected account to link it" className={input} />
                <SubmitButton className={btn.secondary} pendingText="Linking…">
                  Link
                </SubmitButton>
              </div>
            </ActionForm>
            <ul className="divide-y divide-zinc-800">
              {linkedContent.map(({ item }) => {
                const a = acctMap.get(item.accountId);
                return (
                  <li key={item.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                      {a && <PlatformBadge platform={a.platform} />}
                      <span>{a?.handle}</span>
                      <span>· {formatDateTime(item.publishedAt, tz)}</span>
                      <span className="ml-auto flex gap-2">
                        {Object.entries(item.metrics).map(([k, v]) => (
                          <span key={k}>
                            {v} {k}
                          </span>
                        ))}
                      </span>
                    </div>
                    {item.title && <div className="mt-1 font-medium text-zinc-200">{item.title}</div>}
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-300">{item.text}</p>
                    <div className="mt-1 flex items-center justify-between">
                      <GameLinker contentId={item.id} games={[{ id: game.id, name: game.name }]} linked={[game.id]} />
                      <ExternalLink href={item.url} className="text-xs">
                        open ↗
                      </ExternalLink>
                    </div>
                  </li>
                );
              })}
            </ul>
            {recentUnlinked.filter((c) => !linkedContentIds.has(c.id)).length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">Recent posts from linked accounts you can tag</summary>
                <ul className="mt-2 divide-y divide-zinc-800">
                  {recentUnlinked
                    .filter((c) => !linkedContentIds.has(c.id))
                    .map((c) => (
                      <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                        <p className="line-clamp-2 text-sm text-zinc-400">{c.title ?? c.text}</p>
                        <GameLinker contentId={c.id} games={[{ id: game.id, name: game.name }]} linked={[]} />
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </Card>

          <Card>
            <CardTitle>Game details</CardTitle>
            <GameForm action={updateGame.bind(null, game.id)} game={game} submitLabel="Save changes" />
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle>Marketing recommendations</CardTitle>
            <PlanOptIn
              action={saveGameMarketing.bind(null, game.id)}
              enabled={plan?.enabled ?? false}
              goals={plan?.goals ?? ""}
              isNew={!plan?.lastRunAt}
              placeholder="e.g. Get 5,000 Steam wishlists before Next Fest in February; build a Discord community"
            />
            {linkedIds.size === 0 && <p className="mt-3 text-xs text-amber-300">Link at least one account below so the strategist has channels to work with.</p>}
          </Card>

          <Card>
            <CardTitle>Linked accounts</CardTitle>
            {accts.length ? (
              <ActionForm action={setGameAccounts.bind(null, game.id)} className="space-y-2">
                {accts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm text-zinc-200">
                    <input type="checkbox" name="accountIds" value={a.id} defaultChecked={linkedIds.has(a.id)} className="h-4 w-4 accent-emerald-500" />
                    <PlatformBadge platform={a.platform} /> {a.handle}
                  </label>
                ))}
                <SubmitButton className={`${btn.secondary} mt-2`} pendingText="Saving…">
                  Save
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="text-sm text-zinc-500">
                <Link href="/accounts" className="underline">Connect an account</Link> first.
              </p>
            )}
          </Card>

          <Card>
            <CardTitle>Danger zone</CardTitle>
            <ActionButton action={deleteGame.bind(null, game.id)} className={btn.danger} confirm={`Delete ${game.name}? This removes its plan and history.`}>
              Delete game
            </ActionButton>
          </Card>
        </div>
      </div>
    </>
  );
}
