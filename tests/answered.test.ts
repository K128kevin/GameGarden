/** Inbox items you've already answered (in GameGarden or on the platform) are cleared automatically. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/services/llm", () => ({ anthropic: vi.fn(), generateDraftText: vi.fn() }));

import { db } from "@/db";
import { interactions, socialAccounts, user } from "@/db/schema";
import { connectors } from "@/platforms/registry";
import type { InboundInteraction, OwnContent, PlatformConnector } from "@/platforms/types";
import { syncAccount, syncInbound, upsertConnectedAccount } from "@/services/accounts";
import { countInbox, listInbox } from "@/services/inbox";

const now = Date.now();
const inbound: InboundInteraction[] = [
  { externalId: "a1", kind: "reply", authorHandle: "fan", text: "Is there a demo?", replyTarget: { id: "a1" }, occurredAt: new Date(now - 3600_000) },
  { externalId: "a2", kind: "mention", authorHandle: "pal", text: "cc @me", replyTarget: { id: "a2" }, occurredAt: new Date(now - 7200_000) },
  { externalId: "a3", kind: "reply", authorHandle: "dev", text: "Love it", replyTarget: { id: "a3" }, occurredAt: new Date(now - 9000_000) },
  { externalId: "a4", kind: "quote", authorHandle: "q", text: "Look at this", replyTarget: { id: "a4" }, occurredAt: new Date(now - 9500_000) },
  { externalId: "a5", kind: "comment", authorHandle: "z", text: "Wishlisted", replyTarget: { id: "a5" }, occurredAt: new Date(now - 9800_000) },
  { externalId: "l1", kind: "like", authorHandle: "x", text: "", occurredAt: new Date(now - 100_000) },
  { externalId: "old", kind: "reply", authorHandle: "y", text: "old one", replyTarget: { id: "old" }, occurredAt: new Date(now - 10 * 86400_000) },
];
let own: OwnContent[] = [];
let answeredOnPlatform: string[] = [];
let findRepliedFails = false;
const asked: string[][] = [];
const ownLimits: number[] = [];

const fake: PlatformConnector = {
  id: "fakeanswered",
  name: "FakeAnswered",
  badgeClass: "",
  description: "test",
  capabilities: { post: true, reply: true, maxLength: 300 },
  isConfigured: () => true,
  configHelp: "",
  connect: { type: "credentials", fields: [], connectWithCredentials: async () => ({ externalId: "x", handle: "x", credentials: {} }) },
  fetchProfile: async () => ({ followers: 1 }),
  fetchOwnContent: async (_ctx, { limit }) => {
    ownLimits.push(limit);
    return own;
  },
  fetchInteractions: async () => inbound,
  findReplied: async (_ctx, ids) => {
    asked.push(ids);
    if (findRepliedFails) throw new Error("rate limited");
    return ids.filter((id) => answeredOnPlatform.includes(id));
  },
  discover: async () => [],
  resolveOwnContentUrl: async () => null,
  matchesUrl: () => false,
  publish: async () => ({ externalId: "p", url: null, kind: "reply" }),
};

const userId = `answered-user-${now}`;
let accountId = "";
const account = async () => (await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0];
const status = async (externalId: string) =>
  (await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, externalId))))[0].status;

beforeAll(async () => {
  connectors.push(fake);
  await db.insert(user).values({ id: userId, name: "Answered", email: `${userId}@example.com` });
  accountId = (await upsertConnectedAccount(userId, "fakeanswered", { externalId: "me", handle: "me.test", credentials: {} })).id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

describe("auto-clearing answered inbox items", () => {
  it("asks the platform only about open, recent messages that need a reply", async () => {
    const r = await syncInbound(await account());
    expect(r.ok).toBe(true);
    expect(asked.at(-1)!.sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]); // no likes, nothing older than the inbox window
    expect(ownLimits.at(-1)).toBe(100); // reads a wider window of your own replies
    expect(await countInbox(userId)).toBe(5);
  });

  it("marks a message replied when you answered it on the platform (outside GameGarden)", async () => {
    answeredOnPlatform = ["a2"];
    await syncInbound(await account());
    expect(await status("a2")).toBe("replied");
    expect((await listInbox(userId)).map((e) => e.interaction.externalId)).toEqual(["a1", "a3", "a4", "a5"]);
  });

  it("marks a message replied once one of your synced replies points at it", async () => {
    own = [{ externalId: "myreply", kind: "reply", text: "thanks!", parentExternalId: "a3", publishedAt: new Date(), metrics: {} }];
    await syncInbound(await account());
    expect(await status("a3")).toBe("replied");
    expect(asked.at(-1)).not.toContain("a3"); // already settled, not asked about again
    expect(asked.at(-1)).not.toContain("a2");
  });

  it("also runs during full plan syncs", async () => {
    answeredOnPlatform = ["a2", "a4"];
    const r = await syncAccount(await account());
    expect(r.ok).toBe(true);
    expect(await status("a4")).toBe("replied");
    expect(await countInbox(userId)).toBe(2); // a1 and a5 still open
  });

  it("leaves dismissed items alone and survives a failing platform check", async () => {
    await db.update(interactions).set({ status: "dismissed" }).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "a1")));
    answeredOnPlatform = ["a1"];
    findRepliedFails = true;
    const before = asked.length;
    const r = await syncInbound(await account());
    expect(r.ok).toBe(true);
    expect(asked).toHaveLength(before + 1); // the check ran (and threw) ...
    expect(asked.at(-1)).toEqual(["a5"]); // ... asking only about open items
    expect(await status("a1")).toBe("dismissed");
    expect(await status("a5")).toBe("open");
  });
});
