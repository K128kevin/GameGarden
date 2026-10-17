/** "Already following": no Also-follow box, Follow button or follow suggestion for people you follow. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

type Conv = { ref: string; author: string; canFollow?: boolean; youFollow?: boolean };
const seen: Conv[][] = [];
vi.mock("@/services/ai", () => ({
  MODEL: "mock",
  generatePlanUpdate: vi.fn(async (ctx: { accounts: { ref: string; discoveredConversations: Conv[] }[] }) => {
    const a = ctx.accounts[0];
    seen.push(a.discoveredConversations);
    const friend = a.discoveredConversations.find((d) => d.author === "friend.test")!;
    const stranger = a.discoveredConversations.find((d) => d.author === "stranger.test")!;
    const rec = (kind: string, title: string, targetRef: string) => ({
      kind, accountRef: a.ref, title, rationale: "", draftText: kind === "reply" ? "Nice work!" : "", draftTitle: "", community: "", link: "", targetRef, suggestedTime: "", priority: "medium",
    });
    return {
      model: "mock", inputTokens: 1, outputTokens: 1,
      output: {
        assessment: "a", strategyChanged: true, strategyChangeSummary: "", strategy: "s", focusKeywords: [], focusCommunities: [], completedRefs: [],
        recommendations: [rec("follow", "Follow your friend", friend.ref), rec("reply", "Reply to your friend", friend.ref), rec("follow", "Follow a stranger", stranger.ref)],
      },
    };
  }),
}));
vi.mock("@/services/llm", () => ({ anthropic: vi.fn(), generateDraftText: vi.fn() }));

import { db } from "@/db";
import { followedAccounts, plans, recommendations, socialAccounts, user } from "@/db/schema";
import { toRecView } from "@/lib/views";
import { connectors } from "@/platforms/registry";
import type { PlatformConnector } from "@/platforms/types";
import { syncAccount, upsertConnectedAccount } from "@/services/accounts";
import { followedLookup } from "@/services/following";
import { runPlan } from "@/services/planner";
import { followAuthor } from "@/services/social-actions";

let following = { ids: ["did:Friend", "did:old"], complete: true };
const fake: PlatformConnector = {
  id: "fakefollowing",
  name: "FakeFollowing",
  badgeClass: "",
  description: "test",
  capabilities: { post: true, reply: true, like: true, follow: true, followLabel: "Follow", maxLength: 300 },
  isConfigured: () => true,
  configHelp: "",
  connect: { type: "credentials", fields: [], connectWithCredentials: async () => ({ externalId: "x", handle: "x", credentials: {} }) },
  fetchProfile: async () => ({ followers: 1 }),
  fetchOwnContent: async () => [],
  fetchInteractions: async () => [],
  fetchFollowing: async () => following,
  discover: async () => [
    { externalId: "f1", authorHandle: "friend.test", authorId: "did:friend", text: "Devlog #12", createdAt: new Date(), metrics: {}, replyTarget: { id: "f1" } },
    { externalId: "s1", authorHandle: "stranger.test", authorId: "did:stranger", text: "My first jam", createdAt: new Date(), metrics: {}, replyTarget: { id: "s1" } },
  ],
  resolveOwnContentUrl: async () => null,
  matchesUrl: () => false,
  publish: async () => ({ externalId: "p", url: null, kind: "reply" }),
  like: async () => ({}),
  follow: async () => ({}),
};

const userId = `following-user-${Date.now()}`;
let accountId = "";
let planId = "";
const account = async () => (await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0];
const keys = async () => (await db.select().from(followedAccounts).where(eq(followedAccounts.accountId, accountId))).map((r) => r.authorKey).sort();

beforeAll(async () => {
  connectors.push(fake);
  await db.insert(user).values({ id: userId, name: "Following", email: `${userId}@example.com` });
  accountId = (await upsertConnectedAccount(userId, "fakefollowing", { externalId: "me", handle: "me.test", credentials: {} })).id;
  planId = (await db.insert(plans).values({ userId, kind: "account_growth", accountId }).returning())[0].id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

describe("already following", () => {
  it("syncs who you follow (a complete list replaces, a partial one only adds)", async () => {
    await syncAccount(await account());
    expect(await keys()).toEqual(["did:friend", "did:old"]); // ids compared case-insensitively
    following = { ids: ["did:friend", "did:new"], complete: true };
    await syncAccount(await account());
    expect(await keys()).toEqual(["did:friend", "did:new"]); // unfollowed did:old dropped
    following = { ids: ["did:another"], complete: false };
    await syncAccount(await account());
    expect(await keys()).toEqual(["did:another", "did:friend", "did:new"]);
  });

  it("the planner marks people you follow and never suggests following them", async () => {
    const r = await runPlan(planId, { slot: "manual-following", trigger: "manual" });
    expect(r.status).toBe("succeeded");
    const convs = seen.at(-1)!;
    expect(convs.find((c) => c.author === "friend.test")).toMatchObject({ youFollow: true });
    expect(convs.find((c) => c.author === "friend.test")!.canFollow).toBeUndefined();
    expect(convs.find((c) => c.author === "stranger.test")).toMatchObject({ canFollow: true });
    const recs = await db.select().from(recommendations).where(eq(recommendations.planId, planId));
    expect(recs.map((x) => x.title).sort()).toEqual(["Follow a stranger", "Reply to your friend"]); // follow for friend dropped
    expect(recs.find((x) => x.title === "Reply to your friend")!.suggestFollow).toBe(false);
  });

  it("hides the Also-follow box on a reply to someone you follow, but keeps it for others", async () => {
    const recs = await db.select().from(recommendations).where(eq(recommendations.planId, planId));
    const acctMap = new Map([[accountId, await account()]]);
    const isFollowed = await followedLookup(recs);
    const friendReply = toRecView(recs.find((x) => x.title === "Reply to your friend")!, acctMap, "UTC", undefined, isFollowed);
    expect(friendReply.followable).toBe(false);
    expect(friendReply.alreadyFollowing).toBe(true);
    expect(friendReply.likeable).toBe(true); // liking still offered
    const strangerFollow = toRecView(recs.find((x) => x.title === "Follow a stranger")!, acctMap, "UTC", undefined, isFollowed);
    expect(strangerFollow.followable).toBe(true);
  });

  it("follows made in GameGarden count right away, and the next sync clears matching follow suggestions", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.planId, planId), eq(recommendations.kind, "follow")));
    await followAuthor(await account(), rec.target!);
    expect(await keys()).toContain("did:stranger");
    expect((await followedLookup([rec]))(accountId, rec.target)).toBe(true);

    following = { ids: ["did:friend", "did:stranger"], complete: true };
    await syncAccount(await account());
    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(after.status).toBe("done");
    expect(after.userNote).toBe("Already following");
  });
});
