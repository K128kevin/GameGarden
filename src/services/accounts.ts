import { and, desc, eq, sql } from "drizzle-orm";
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
import { PlatformError, type AccountContext, type ConnectedAccountInfo, type OwnContent } from "@/platforms/types";

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

    let newInteractions = 0;
    const inbound = await connector.fetchInteractions(ctx, { limit: 50 });
    if (inbound.length) {
      const inserted = await db
        .insert(interactions)
        .values(
          inbound.map((i) => ({
            accountId: acct.id,
            externalId: i.externalId,
            kind: i.kind,
            authorHandle: i.authorHandle ?? null,
            text: i.text,
            url: i.url ?? null,
            onExternalId: i.onExternalId ?? null,
            replyTarget: i.replyTarget ?? null,
            occurredAt: i.occurredAt,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: interactions.id });
      newInteractions = inserted.length;
    }

    await db
      .update(socialAccounts)
      .set({ lastSyncedAt: new Date(), status: "active", statusMessage: null })
      .where(eq(socialAccounts.id, acct.id));
    return { ok: true, newContent: after[0].c - before[0].c, newInteractions };
  } catch (e) {
    await markAccountError(acct, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e), newContent: 0, newInteractions: 0 };
  }
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
