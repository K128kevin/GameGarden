import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";
import { db } from "@/db";
import { recommendations, socialAccounts, type RecommendationTarget } from "@/db/schema";
import { canFollow } from "./social-actions";

type PendingRec = {
  id: string;
  accountId: string | null;
  kind: string;
  rationale: string;
  target: RecommendationTarget | null;
  suggestFollow: boolean;
};

export type FollowMerge = { followId: string; replyId: string; target: RecommendationTarget; rationale: string };

function sameAuthor(a: RecommendationTarget, b: RecommendationTarget) {
  if (a.authorId && b.authorId) return a.authorId === b.authorId;
  return Boolean(a.author && b.author && a.author.toLowerCase() === b.author.toLowerCase());
}

/**
 * Pair each follow suggestion with a reply suggestion to the same person on the same account
 * (that GameGarden can also follow from). Follows without a matching reply are left out.
 */
export function planFollowMerges(recs: PendingRec[], platformOf: Map<string, string>): FollowMerge[] {
  const replies = new Map(recs.filter((r) => r.kind === "reply").map((r) => [r.id, { ...r }]));
  const merges = new Map<string, FollowMerge>();
  const out: FollowMerge[] = [];
  for (const follow of recs) {
    if (follow.kind !== "follow" || !follow.target || !follow.accountId) continue;
    const platform = platformOf.get(follow.accountId);
    if (!platform) continue;
    const ft = follow.target;
    const reply = [...replies.values()].find(
      (r) =>
        r.accountId === follow.accountId &&
        r.target &&
        sameAuthor(r.target, ft) &&
        canFollow(platform, { ...r.target, authorId: r.target.authorId ?? ft.authorId }),
    );
    if (!reply) continue;
    // Several follows for one person (e.g. from two plans) fold into the same reply once.
    const prev = merges.get(reply.id);
    const target = { ...(prev?.target ?? reply.target!), authorId: (prev?.target ?? reply.target!).authorId ?? ft.authorId };
    const why = follow.rationale.trim();
    const base = prev?.rationale ?? reply.rationale.trim();
    const rationale = why && !prev && !reply.suggestFollow ? [base, `Also worth following: ${why}`].filter(Boolean).join(" ") : base;
    const merge = { followId: follow.id, replyId: reply.id, target, rationale };
    merges.set(reply.id, merge);
    out.push(merge);
  }
  // Every merged follow points at the reply's final state.
  return out.map((m) => ({ ...m, target: merges.get(m.replyId)!.target, rationale: merges.get(m.replyId)!.rationale }));
}

/**
 * Fold the user's pending follow suggestions into pending reply suggestions to the same person:
 * the reply gets "Also follow" pre-checked and the separate follow item goes away. Runs after each
 * plan run and when suggestion pages load, so it also covers suggestions made before this existed.
 * Returns how many follow items were merged.
 */
export async function foldPendingFollows(userId: string): Promise<number> {
  const pending = await db
    .select({
      id: recommendations.id,
      accountId: recommendations.accountId,
      kind: recommendations.kind,
      rationale: recommendations.rationale,
      target: recommendations.target,
      suggestFollow: recommendations.suggestFollow,
    })
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending"), inArray(recommendations.kind, ["follow", "reply"])));
  if (!pending.some((r) => r.kind === "follow") || !pending.some((r) => r.kind === "reply")) return 0;

  const accountIds = [...new Set(pending.map((r) => r.accountId).filter(Boolean) as string[])];
  const accts = await db.select({ id: socialAccounts.id, platform: socialAccounts.platform }).from(socialAccounts).where(inArray(socialAccounts.id, accountIds));
  const merges = planFollowMerges(pending, new Map(accts.map((a) => [a.id, a.platform])));

  let merged = 0;
  for (const m of merges) {
    await db.transaction(async (tx) => {
      // Both must still be pending: never drop a follow into a reply that was already scheduled or handled.
      const updated = await tx
        .update(recommendations)
        .set({ suggestFollow: true, target: m.target, rationale: m.rationale })
        .where(and(eq(recommendations.id, m.replyId), eq(recommendations.status, "pending")))
        .returning({ id: recommendations.id });
      if (!updated.length) return;
      const gone = await tx
        .delete(recommendations)
        .where(and(eq(recommendations.id, m.followId), eq(recommendations.status, "pending")))
        .returning({ id: recommendations.id });
      if (!gone.length) {
        tx.rollback(); // folded or handled elsewhere meanwhile; leave the reply as it was
        return;
      }
      merged++;
    }).catch((e) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
  }
  return merged;
}
