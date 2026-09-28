import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { games, storeSnapshots, userSettings, type Game } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { fetchItchSnapshot } from "@/stores/itch";
import { fetchSteamSnapshot } from "@/stores/steam";

export async function getOwnedGame(userId: string, gameId: string) {
  const [g] = await db
    .select()
    .from(games)
    .where(and(eq(games.id, gameId), eq(games.userId, userId)));
  return g ?? null;
}

/** Fetch fresh Steam/itch.io data and store a snapshot (so trends are visible over time). */
export async function refreshStoreData(game: Game) {
  const errors: string[] = [];
  if (game.steamAppId) {
    try {
      const data = await fetchSteamSnapshot(game.steamAppId);
      if (!data.name && data.totalReviews == null) throw new Error("couldn't load the store page (is the app public?)");
      await db.insert(storeSnapshots).values({ gameId: game.id, store: "steam", data });
    } catch (e) {
      errors.push(`Steam: ${(e as Error).message}`);
    }
  }
  if (game.itchUrl) {
    try {
      const [s] = await db.select().from(userSettings).where(eq(userSettings.userId, game.userId));
      const key = s?.itchApiKey ? decrypt(s.itchApiKey) : null;
      const data = await fetchItchSnapshot(game.itchUrl, key);
      if (!data.title && data.views == null) throw new Error("couldn't load the page (is it public?)");
      await db.insert(storeSnapshots).values({ gameId: game.id, store: "itch", data });
    } catch (e) {
      errors.push(`itch.io: ${(e as Error).message}`);
    }
  }
  return errors;
}

export async function storeHistory(gameId: string, store: "steam" | "itch", limit = 10) {
  return db
    .select()
    .from(storeSnapshots)
    .where(and(eq(storeSnapshots.gameId, gameId), eq(storeSnapshots.store, store)))
    .orderBy(desc(storeSnapshots.capturedAt))
    .limit(limit);
}
