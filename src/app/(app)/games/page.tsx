import { eq } from "drizzle-orm";
import { db } from "@/db";
import { games, plans } from "@/db/schema";
import { createGame } from "@/app/actions";
import { requireUser } from "@/lib/session";
import { GameForm } from "@/components/game-form";
import { Badge, Card, CardTitle, EmptyState, Link, PageHeader } from "@/components/ui";

export default async function GamesPage() {
  const user = await requireUser();
  const rows = await db.select().from(games).where(eq(games.userId, user.id)).orderBy(games.createdAt);
  const planRows = await db.select().from(plans).where(eq(plans.userId, user.id));
  return (
    <>
      <PageHeader title="Games" subtitle="Each game can link social accounts, posts, and its Steam / itch.io pages." />
      {rows.length ? (
        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          {rows.map((g) => {
            const plan = planRows.find((p) => p.kind === "game_marketing" && p.gameId === g.id);
            return (
              <Link key={g.id} href={`/games/${g.id}`} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-zinc-100">{g.name}</span>
                  {plan?.enabled && <Badge color="green">marketing plan on</Badge>}
                </div>
                {g.pitch && <p className="mt-1 text-sm text-zinc-400">{g.pitch}</p>}
                <div className="mt-2 flex gap-2 text-xs text-zinc-500">
                  {g.steamAppId && <span>Steam</span>}
                  {g.itchUrl && <span>itch.io</span>}
                  <span>{g.releaseStatus.replace("_", " ")}</span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState title="No games yet">Add your first game below.</EmptyState>
        </div>
      )}
      <Card>
        <CardTitle>Add a game</CardTitle>
        <GameForm action={createGame} submitLabel="Create game" />
      </Card>
    </>
  );
}
