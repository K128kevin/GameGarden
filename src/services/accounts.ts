import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountSnapshots,
  activityLog,
  contentItems,
  interactions,
  socialAccounts,
  type SocialAccount,
} from "@/db/schema";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { getConnector } from "@/platforms/registry";
import {
  PlatformError,
  type AccountContext,
  type ConnectedAccountInfo,
  type InboundInteraction,
  type OwnContent,
} from "@/platforms/types";

export function accountContext(acct: SocialAccount): AccountContext {
  const ctx: AccountContext = {
    account: { id: acct.id, externalId: acct.externalId, handle: acct.handle },
    credentials: decryptJson(acct.credentials),
    async saveCredentials(next) {
      await db.update(socialAccounts).set({ credentials: encryptJson(next) }).where(eq(socialAccounts.id, acct.id));
    },
  };
  return ctx;
}

export async function upsertConnectedAccount(userId: string, platform: string, info: ConnectedAccountInfo) {
  const values = {
    userId,
    platform,
    externalId: info.externalId,
    handle: info.handle,
    displayName: info.displayName ?? null,
    profileUrl: info.profileUrl ?? null,
    avatarUrl: info.avatarUrl ?? null,
    credentials: encryptJson(info.credentials),
    status: "active",
    statusMessage: null,
  };
  const [row] = await db
    .insert(socialAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [socialAccounts.userId, socialAccounts.platform, socialAccounts.externalId],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  await db.insert(activityLog).values({
    userId,
    accountId: row.id,
    type: "account_connected",
    message: `Connected ${getConnector(platform).name} account ${info.handle}`,
  });
  return row;
}

export async function upsertOwnContent(accountId: string, items: OwnContent[], source: "synced" | "app" = "synced") {
  if (!items.length) return [];
  const now = new Date();
  return db
    .insert(contentItems)
    .values(
      items.map((i) => ({
        accountId,
        externalId: i.externalId,
        kind: i.kind,
        url: i.url ?? null,
        title: i.title ?? null,
        text: i.text ?? "",
        community: i.community ?? null,
        parentExternalId: i.parentExternalId ?? null,
        publishedAt: i.publishedAt,
        metrics: i.metrics,
        source,
        lastSyncedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [contentItems.accountId, contentItems.externalId],
      set: {
        metrics: sql`excluded.metrics`,
        text: sql`excluded.text`,
        title: sql`coalesce(excluded.title, ${contentItems.title})`,
        url: sql`coalesce(excluded.url, ${contentItems.url})`,
        lastSyncedAt: now,
      },
    })
    .returning();
}

async function markAccountError(acct: SocialAccount, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const reauth = e instanceof PlatformError && e.reauth;
  await db
    .update(socialAccounts)
    .set({ status: "error", statusMessage: reauth ? `Reconnect needed: ${message}` : message })
    .where(eq(socialAccounts.id, acct.id));
}

export type SyncResult = { ok: boolean; error?: string; newContent: number; newInteractions: number };

/** Pull profile stats, own content, and inbound interactions from the platform. */
export async function syncAccount(acct: SocialAccount): Promise<SyncResult> {
  const connector = getConnector(acct.platform);
  const ctx = accountContext(acct);
  try {
    const profile = await connector.fetchProfile(ctx);
    await db.insert(accountSnapshots).values({
      accountId: acct.id,
      followers: profile.followers ?? null,
      following: profile.following ?? null,
      postsCount: profile.postsCount ?? null,
      extra: profile.extra ?? {},
    });

    const before = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(eq(contentItems.accountId, acct.id));
    const own = await connector.fetchOwnContent(ctx, { limit: 50 });
    await upsertOwnContent(acct.id, own);
    const after = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(eq(contentItems.accountId, acct.id));

    const newInteractions = await upsertInteractions(acct.id, await connector.fetchInteractions(ctx, { limit: 50 }));

    await db
      .update(socialAccounts)
      .set({ lastSyncedAt: new Date(), inboundCheckedAt: new Date(), status: "active", statusMessage: null })
      .where(eq(socialAccounts.id, acct.id));
    return { ok: true, newContent: after[0].c - before[0].c, newInteractions };
  } catch (e) {
    await markAccountError(acct, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e), newContent: 0, newInteractions: 0 };
  }
}

/** Insert new interactions; returns how many were new. Marks ones the platform shows you already answered. */
async function upsertInteractions(accountId: string, inbound: InboundInteraction[]): Promise<number> {
  if (!inbound.length) return 0;
  const inserted = await db
    .insert(interactions)
    .values(
      inbound.map((i) => ({
        accountId,
        externalId: i.externalId,
        kind: i.kind,
        authorHandle: i.authorHandle ?? null,
        authorId: i.authorId ?? null,
        text: i.text,
        url: i.url ?? null,
        onExternalId: i.onExternalId ?? null,
        replyTarget: i.replyTarget ?? null,
        occurredAt: i.occurredAt,
        status: i.alreadyReplied ? "replied" : "open",
      })),
    )
    .onConflictDoNothing()
    .returning({ id: interactions.id });
  // Backfill author ids on rows stored before they were tracked (needed to follow people).
  const withAuthor = inbound.filter((i) => i.authorId);
  if (withAuthor.length) {
    const values = sql.join(
      withAuthor.map((i) => sql`(${i.externalId}, ${i.authorId})`),
      sql`, `,
    );
    await db.execute(
      sql`update ${interactions} set author_id = v.aid from (values ${values}) as v(eid, aid) where ${interactions.accountId} = ${accountId} and ${interactions.externalId} = v.eid and ${interactions.authorId} is null`,
    );
  }
  const answered = inbound.filter((i) => i.alreadyReplied).map((i) => i.externalId);
  if (answered.length) {
    await db
      .update(interactions)
      .set({ status: "replied" })
      .where(
        and(eq(interactions.accountId, accountId), eq(interactions.status, "open"), inArray(interactions.externalId, answered)),
      );
  }
  return inserted.length;
}

/**
 * Light check between planning runs: new replies/mentions/comments plus your own
 * recent posts (to detect what you've already answered). No model call.
 */
export async function syncInbound(acct: SocialAccount): Promise<{ ok: boolean; newInteractions: number; error?: string }> {
  const connector = getConnector(acct.platform);
  const ctx = accountContext(acct);
  try {
    await upsertOwnContent(acct.id, await connector.fetchOwnContent(ctx, { limit: 25 }));
    const newInteractions = await upsertInteractions(acct.id, await connector.fetchInteractions(ctx, { limit: 50 }));
    await db
      .update(socialAccounts)
      .set({ inboundCheckedAt: new Date(), status: "active", statusMessage: null })
      .where(eq(socialAccounts.id, acct.id));
    return { ok: true, newInteractions };
  } catch (e) {
    await markAccountError(acct, e);
    return { ok: false, newInteractions: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export const INBOUND_CHECK_MINUTES = 30;

/**
 * Atomically claim accounts whose last light check is older than `minutes`, so
 * overlapping ticks/page views don't check the same account twice.
 */
async function claimStaleAccounts(minutes: number, opts: { userId?: string; limit: number }) {
  const cutoff = new Date(Date.now() - minutes * 60_000);
  const candidates = await db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.status, "active"),
        opts.userId ? eq(socialAccounts.userId, opts.userId) : undefined,
        or(isNull(socialAccounts.inboundCheckedAt), lt(socialAccounts.inboundCheckedAt, cutoff)),
      ),
    )
    .orderBy(sql`${socialAccounts.inboundCheckedAt} asc nulls first`)
    .limit(opts.limit);
  const claimed: SocialAccount[] = [];
  for (const c of candidates) {
    const [row] = await db
      .update(socialAccounts)
      .set({ inboundCheckedAt: new Date() })
      .where(
        and(
          eq(socialAccounts.id, c.id),
          or(isNull(socialAccounts.inboundCheckedAt), lt(socialAccounts.inboundCheckedAt, cutoff)),
        ),
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

/** Run light checks for accounts that are due (called from the heartbeat). */
export async function checkInboundDue(deadline: number, opts: { userId?: string; minutes?: number } = {}) {
  const accts = await claimStaleAccounts(opts.minutes ?? INBOUND_CHECK_MINUTES - 5, { userId: opts.userId, limit: 25 });
  let checked = 0;
  let newInteractions = 0;
  for (const a of accts) {
    if (Date.now() > deadline) break;
    const r = await syncInbound(a);
    checked++;
    newInteractions += r.newInteractions;
  }
  return { checked, newInteractions };
}

export async function getOwnedAccount(userId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.userId, userId)));
  return row ?? null;
}

export async function latestSnapshots(accountId: string, limit = 30) {
  return db
    .select()
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, accountId))
    .orderBy(desc(accountSnapshots.capturedAt))
    .limit(limit);
}

/** Page-view backstop: check this user's accounts if not checked in the last 10 minutes. */
export function checkInboundForUser(userId: string) {
  return checkInboundDue(Date.now() + 45_000, { userId, minutes: 10 }).catch(() => ({ checked: 0, newInteractions: 0 }));
}
