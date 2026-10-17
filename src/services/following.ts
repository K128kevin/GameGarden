import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { followedAccounts, recommendations, type RecommendationTarget, type SocialAccount } from "@/db/schema";
import { getConnector } from "@/platforms/registry";
import type { AccountContext } from "@/platforms/types";

/** The key we store for a person: their platform id (or, failing that, handle), lower-cased. */
export function followKey(target: Pick<RecommendationTarget, "authorId" | "author"> | null | undefined): string | null {
  const k = target?.authorId || target?.author;
  return k ? k.toLowerCase() : null;
}

/**
 * Refresh who this account follows from the platform. Best-effort; runs with the full sync before
 * each plan run. A complete list replaces what we had; a truncated one only adds.
 */
export async function syncFollowing(acct: SocialAccount, ctx: AccountContext) {
  const connector = getConnector(acct.platform);
  if (!connector.fetchFollowing) return null;
  const { ids, complete } = await connector.fetchFollowing(ctx);
  const keys = [...new Set(ids.map((id) => id.toLowerCase()))];
  await db.transaction(async (tx) => {
    if (complete) {
      await tx
        .delete(followedAccounts)
        .where(and(eq(followedAccounts.accountId, acct.id), keys.length ? notInArray(followedAccounts.authorKey, keys) : sql`true`));
    }
    for (let i = 0; i < keys.length; i += 1000) {
      await tx
        .insert(followedAccounts)
        .values(keys.slice(i, i + 1000).map((authorKey) => ({ accountId: acct.id, authorKey })))
        .onConflictDoNothing();
    }
  });
  // Pending "follow X" suggestions for people you already follow are done.
  const pendingFollows = await db
    .select({ id: recommendations.id, target: recommendations.target })
    .from(recommendations)
    .where(and(eq(recommendations.accountId, acct.id), eq(recommendations.kind, "follow"), eq(recommendations.status, "pending")));
  const keySet = new Set(keys);
  const done = pendingFollows.filter((r) => {
    const k = followKey(r.target);
    return k && keySet.has(k);
  });
  if (done.length) {
    await db
      .update(recommendations)
      .set({ status: "done", statusChangedAt: new Date(), userNote: "Already following" })
      .where(inArray(recommendations.id, done.map((r) => r.id)));
  }
  return { count: keys.length, complete };
}

/** Remember a follow made from GameGarden right away (before the next sync). */
export async function markFollowed(accountId: string, target: Pick<RecommendationTarget, "authorId" | "author">) {
  const authorKey = followKey(target);
  if (!authorKey) return;
  await db.insert(followedAccounts).values({ accountId, authorKey }).onConflictDoNothing();
}

/** Which of these (account, person) pairs are already followed. */
export async function followedLookup(items: { accountId: string | null; target: Pick<RecommendationTarget, "authorId" | "author"> | null }[]) {
  const pairs = items
    .map((i) => ({ accountId: i.accountId, key: followKey(i.target) }))
    .filter((p): p is { accountId: string; key: string } => Boolean(p.accountId && p.key));
  const found = new Set<string>();
  if (pairs.length) {
    const rows = await db
      .select({ accountId: followedAccounts.accountId, key: followedAccounts.authorKey })
      .from(followedAccounts)
      .where(
        and(
          inArray(followedAccounts.accountId, [...new Set(pairs.map((p) => p.accountId))]),
          inArray(followedAccounts.authorKey, [...new Set(pairs.map((p) => p.key))]),
        ),
      );
    for (const r of rows) found.add(`${r.accountId}|${r.key}`);
  }
  return (accountId: string | null, target: Pick<RecommendationTarget, "authorId" | "author"> | null | undefined) => {
    const key = followKey(target);
    return Boolean(accountId && key && found.has(`${accountId}|${key}`));
  };
}

export type IsFollowed = Awaited<ReturnType<typeof followedLookup>>;
