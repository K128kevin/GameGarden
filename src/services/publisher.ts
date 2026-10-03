import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityLog,
  gameContent,
  recommendations,
  scheduledActions,
  socialAccounts,
  type PublishPayload,
  type SocialAccount,
} from "@/db/schema";
import { getConnector } from "@/platforms/registry";
import { accountContext, upsertOwnContent } from "./accounts";
import { canFollow, canLike, followAuthor, followLabel, likeTarget } from "./social-actions";

/**
 * SAFETY INVARIANT: nothing is ever published except a scheduled_actions row
 * that a signed-in user created by explicitly clicking "Post now" or
 * "Schedule". The planner (LLM) can only create recommendations; it has no
 * code path into this module.
 */

export type ApprovedActionInput = {
  userId: string;
  accountId: string;
  payload: PublishPayload;
  scheduledFor: Date;
  recommendationId?: string | null;
  gameId?: string | null;
};

export function validatePayload(platform: string, payload: PublishPayload): string | null {
  const c = getConnector(platform);
  if (!payload.text.trim() && !(payload.kind === "post" && payload.link)) return "Post text is empty.";
  if (payload.kind === "post" && !c.capabilities.post) return `${c.name} doesn't support publishing new posts from GameGarden.`;
  if (payload.kind === "reply" && !c.capabilities.reply) return `${c.name} doesn't support replies from GameGarden.`;
  if (payload.kind === "reply" && !payload.target) return "A reply needs a target post.";
  if (payload.kind === "post" && c.capabilities.requiresTitle && !payload.title?.trim()) return `${c.name} posts need a title.`;
  if (payload.kind === "post" && c.capabilities.requiresCommunity && !payload.community?.trim())
    return `${c.name} posts need a ${c.capabilities.communityLabel?.toLowerCase() ?? "community"}.`;
  if (c.capabilities.maxLength && payload.text.length > c.capabilities.maxLength)
    return `${c.name} posts are limited to ${c.capabilities.maxLength} characters (this is ${payload.text.length}).`;
  if (payload.alsoLike && (payload.kind !== "reply" || !canLike(platform, payload.target)))
    return `Liking isn't available for this ${c.name} item.`;
  if (payload.alsoFollow && (payload.kind !== "reply" || !canFollow(platform, payload.target)))
    return `Can't ${followLabel(platform).toLowerCase()} this ${c.name} account from GameGarden.`;
  return null;
}

/**
 * Like / follow that the user approved together with a reply. Runs only after the
 * reply itself posted; a failure here never undoes the reply, it's reported instead.
 */
async function runReplyExtras(acct: SocialAccount, payload: PublishPayload) {
  const done: string[] = [];
  const failed: string[] = [];
  if (payload.kind !== "reply" || !payload.target) return { done, failed };
  if (payload.alsoLike) {
    try {
      const r = await likeTarget(acct, payload.target);
      done.push(r.already ? "already liked" : "liked");
    } catch (e) {
      failed.push(`liking failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (payload.alsoFollow) {
    const verb = followLabel(acct.platform).toLowerCase();
    try {
      const r = await followAuthor(acct, payload.target);
      done.push(r.already ? `already ${verb === "subscribe" ? "subscribed" : "following"}` : `${verb === "subscribe" ? "subscribed to" : "followed"} ${payload.target.author ?? "them"}`);
    } catch (e) {
      failed.push(`${verb === "subscribe" ? "subscribing" : "following"} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { done, failed };
}

/** Record a user-approved action. Call only from a user-initiated server action. */
export async function createApprovedAction(input: ApprovedActionInput) {
  const [acct] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.id, input.accountId), eq(socialAccounts.userId, input.userId)));
  if (!acct) throw new Error("Account not found");
  const err = validatePayload(acct.platform, input.payload);
  if (err) throw new Error(err);

  const [row] = await db
    .insert(scheduledActions)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      recommendationId: input.recommendationId ?? null,
      gameId: input.gameId ?? null,
      payload: input.payload,
      scheduledFor: input.scheduledFor,
      approvedAt: new Date(),
      status: "scheduled",
    })
    .returning();

  if (input.recommendationId) {
    await db
      .update(recommendations)
      .set({ status: "scheduled", statusChangedAt: new Date() })
      .where(and(eq(recommendations.id, input.recommendationId), eq(recommendations.userId, input.userId)));
  }
  return row;
}

/** Atomically claim and publish one approved action. Returns the final row. */
export async function executeAction(actionId: string) {
  const [claimed] = await db
    .update(scheduledActions)
    .set({ status: "publishing", attempts: sql`${scheduledActions.attempts} + 1` })
    .where(
      and(
        eq(scheduledActions.id, actionId),
        eq(scheduledActions.status, "scheduled"),
        isNotNull(scheduledActions.approvedAt),
      ),
    )
    .returning();
  if (!claimed) return null;

  const [acct] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, claimed.accountId));
  const rec = claimed.recommendationId
    ? (await db.select().from(recommendations).where(eq(recommendations.id, claimed.recommendationId)))[0]
    : null;

  try {
    if (!acct) throw new Error("Account was disconnected");
    const connector = getConnector(acct.platform);
    const result = await connector.publish(accountContext(acct), claimed.payload);

    const [item] = await upsertOwnContent(
      acct.id,
      [
        {
          externalId: result.externalId || `app-${claimed.id}`,
          kind: result.kind,
          url: result.url ?? null,
          title: claimed.payload.title ?? null,
          text: claimed.payload.text,
          community: claimed.payload.community ?? null,
          parentExternalId: claimed.payload.target?.externalId ?? null,
          publishedAt: new Date(),
          metrics: {},
        },
      ],
      "app",
    );
    const gameId = claimed.gameId ?? rec?.gameId ?? null;
    if (gameId && item) {
      await db.insert(gameContent).values({ gameId, contentItemId: item.id }).onConflictDoNothing();
    }

    const extras = await runReplyExtras(acct, claimed.payload);
    const [done] = await db
      .update(scheduledActions)
      .set({
        status: "published",
        publishedAt: new Date(),
        resultExternalId: result.externalId,
        resultUrl: result.url ?? null,
        // The reply itself posted; surface any like/follow problem without marking it failed.
        error: extras.failed.length ? `Reply posted, but ${extras.failed.join("; ")}` : null,
      })
      .where(eq(scheduledActions.id, claimed.id))
      .returning();
    if (rec) {
      await db.update(recommendations).set({ status: "posted", statusChangedAt: new Date() }).where(eq(recommendations.id, rec.id));
    }
    await db.insert(activityLog).values({
      userId: claimed.userId,
      planId: rec?.planId ?? null,
      accountId: acct.id,
      gameId,
      type: "published",
      message: `Published ${claimed.payload.kind} on ${connector.name}${claimed.payload.community ? ` in r/${claimed.payload.community}` : ""}${
        extras.done.length ? ` (${extras.done.join(", ")})` : ""
      }${extras.failed.length ? `. Note: ${extras.failed.join("; ")}` : ""}`,
      data: { actionId: claimed.id, url: result.url, recommendationId: rec?.id ?? null, extras },
    });
    return done;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const [failed] = await db
      .update(scheduledActions)
      .set({ status: "failed", error: message })
      .where(eq(scheduledActions.id, claimed.id))
      .returning();
    if (rec) {
      await db.update(recommendations).set({ status: "failed", statusChangedAt: new Date() }).where(eq(recommendations.id, rec.id));
    }
    await db.insert(activityLog).values({
      userId: claimed.userId,
      planId: rec?.planId ?? null,
      accountId: claimed.accountId,
      type: "publish_failed",
      message: `Publishing failed: ${message}`,
      data: { actionId: claimed.id },
    });
    return failed;
  }
}

/** Publish every approved action whose time has come. Called by the cron tick. */
export async function publishDueActions(deadline: number, opts: { userId?: string } = {}) {
  // Anything stuck in "publishing" for 15+ minutes was interrupted mid-flight.
  // We do NOT retry it automatically (it may have been posted) — flag it instead.
  await db
    .update(scheduledActions)
    .set({ status: "failed", error: "Interrupted while publishing. Check the platform before retrying." })
    .where(
      and(eq(scheduledActions.status, "publishing"), lt(scheduledActions.updatedAt, new Date(Date.now() - 15 * 60_000))),
    );

  const due = await db
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(
      and(
        eq(scheduledActions.status, "scheduled"),
        isNotNull(scheduledActions.approvedAt),
        lte(scheduledActions.scheduledFor, new Date()),
        opts.userId ? eq(scheduledActions.userId, opts.userId) : undefined,
      ),
    )
    .orderBy(scheduledActions.scheduledFor)
    .limit(25);

  const results: { id: string; status: string }[] = [];
  for (const { id } of due) {
    if (Date.now() > deadline) break;
    const r = await executeAction(id);
    if (r) results.push({ id, status: r.status });
  }
  return results;
}

/** Publish one user's due, already-approved items (used when they open the app). */
export function publishDueForUser(userId: string) {
  return publishDueActions(Date.now() + 30_000, { userId }).catch(() => []);
}
