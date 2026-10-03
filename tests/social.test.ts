/**
 * Follow suggestions, "also like / follow" with a reply, and Haiku draft regeneration.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/services/ai", () => ({
  MODEL: "mock",
  generatePlanUpdate: vi.fn(async (ctx: { accounts: { ref: string; discoveredConversations: { ref: string; canFollow?: boolean }[] }[] }) => {
    const a = ctx.accounts[0];
    const d1 = a.discoveredConversations[0];
    return {
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      output: {
        assessment: "a",
        strategyChanged: true,
        strategyChangeSummary: "",
        strategy: "s",
        focusKeywords: [],
        focusCommunities: [],
        completedRefs: [],
        recommendations: [
          { kind: "follow", accountRef: a.ref, title: "Follow a fellow dev", rationale: "", draftText: "", draftTitle: "", community: "", link: "", targetRef: d1.canFollow ? d1.ref : "", suggestedTime: "", priority: "medium" },
          { kind: "follow", accountRef: a.ref, title: "Follow someone made up", rationale: "", draftText: "", draftTitle: "", community: "", link: "", targetRef: "D99", suggestedTime: "", priority: "low" },
          { kind: "reply", accountRef: a.ref, title: "Reply to the dev", rationale: "", draftText: "Love the lighting — how did you do it?", draftTitle: "", community: "", link: "", targetRef: d1.ref, suggestedTime: "", priority: "high" },
        ],
      },
    };
  }),
}));

const llmCalls: { model: string; system: string; prompt: string }[] = [];
let llmReply = "Shorter one — promise.";
vi.mock("@/services/llm", () => ({
  anthropic: vi.fn(),
  generateDraftText: vi.fn(async (opts: { model: string; system: string; prompt: string }) => {
    llmCalls.push(opts);
    return { text: llmReply, model: "claude-haiku-4-5", inputTokens: 5, outputTokens: 5 };
  }),
}));

import { db } from "@/db";
import { interactions, plans, recommendations, scheduledActions, socialAccounts, user } from "@/db/schema";
import { connectors } from "@/platforms/registry";
import type { PlatformConnector } from "@/platforms/types";
import { syncInbound, upsertConnectedAccount } from "@/services/accounts";
import { runPlan } from "@/services/planner";
import { createApprovedAction, executeAction } from "@/services/publisher";
import { regenerateRecommendationDraft } from "@/services/regenerate";
import { canFollow, canLike, followAuthor } from "@/services/social-actions";

const likes: unknown[] = [];
const follows: unknown[] = [];
let failLike = false;
let inboundAuthorId: string | null = null;

const fake: PlatformConnector = {
  id: "fakesocial",
  name: "FakeSocial",
  badgeClass: "",
  description: "test",
  capabilities: { post: true, reply: true, like: true, follow: true, followLabel: "Follow", maxLength: 300 },
  isConfigured: () => true,
  configHelp: "",
  connect: { type: "credentials", fields: [], connectWithCredentials: async () => ({ externalId: "x", handle: "x", credentials: {} }) },
  fetchProfile: async () => ({ followers: 1 }),
  fetchOwnContent: async () => [],
  fetchInteractions: async () => [
    { externalId: "c1", kind: "reply", authorHandle: "fan.test", authorId: inboundAuthorId, text: "Cool!", replyTarget: { id: "c1" }, occurredAt: new Date() },
  ],
  discover: async () => [
    { externalId: "p1", authorHandle: "dev.test", authorId: "did:dev", text: "My lighting system", createdAt: new Date(), metrics: {}, replyTarget: { id: "p1" } },
  ],
  resolveOwnContentUrl: async () => null,
  matchesUrl: () => false,
  publish: async (_ctx, payload) => ({ externalId: `pub-${payload.target?.externalId ?? "post"}`, url: null, kind: payload.kind === "reply" ? "reply" : "post" }),
  like: async (_ctx, target) => {
    if (failLike) throw new Error("rate limited");
    likes.push(target.externalId);
    return {};
  },
  follow: async (_ctx, who) => {
    follows.push(who);
    return { url: "https://fake/profile" };
  },
};

const noLikes: PlatformConnector = { ...fake, id: "fakenolike", capabilities: { ...fake.capabilities, like: false, follow: true }, like: undefined };

const userId = `social-user-${Date.now()}`;
let accountId = "";
let planId = "";

beforeAll(async () => {
  connectors.push(fake, noLikes);
  await db.insert(user).values({ id: userId, name: "Social", email: `${userId}@example.com` });
  accountId = (await upsertConnectedAccount(userId, "fakesocial", { externalId: "me", handle: "me.test", credentials: {} })).id;
  const [p] = await db.insert(plans).values({ userId, kind: "account_growth", accountId }).returning();
  planId = p.id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

describe("follow suggestions", () => {
  it("stores follow suggestions only when they point at a real person from the context", async () => {
    const r = await runPlan(planId, { slot: "manual-social", trigger: "manual" });
    expect(r.status).toBe("succeeded");
    const recs = await db.select().from(recommendations).where(eq(recommendations.planId, planId));
    const follow = recs.find((x) => x.title === "Follow a fellow dev")!;
    expect(follow.kind).toBe("follow");
    expect(follow.target?.authorId).toBe("did:dev");
    expect(follow.target?.author).toBe("dev.test");
    expect(recs.find((x) => x.title === "Follow someone made up")!.kind).toBe("engage"); // invented ref → manual task
    expect(follows).toHaveLength(0); // nothing followed without a click
  });

  it("follows the referenced author (what the Follow button calls)", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.planId, planId), eq(recommendations.kind, "follow")));
    const [acct] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    expect(canFollow("fakesocial", rec.target)).toBe(true);
    await followAuthor(acct, rec.target!);
    expect(follows.at(-1)).toEqual({ id: "did:dev", handle: "dev.test" });
  });

  it("YouTube-style connectors without handle follow need an author id", () => {
    expect(canFollow("fakesocial", { externalId: "x", author: "someone" })).toBe(false); // no followByHandle, no id
    expect(canFollow("fakesocial", { externalId: "x", authorId: "UC123" })).toBe(true);
    expect(canLike("fakenolike", { externalId: "x", data: { id: "x" } })).toBe(false);
  });
});

describe("also like / follow with a reply", () => {
  it("likes and follows after the reply posts", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.planId, planId), eq(recommendations.kind, "reply")));
    expect(rec.draftText).toBe("Love the lighting, how did you do it?"); // dash cleaned
    const action = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "reply", text: rec.draftText!, target: rec.target, alsoLike: true, alsoFollow: true },
      scheduledFor: new Date(),
      recommendationId: rec.id,
    });
    expect(likes).toHaveLength(0); // nothing until it publishes
    const done = await executeAction(action.id);
    expect(done?.status).toBe("published");
    expect(done?.error).toBeNull();
    expect(likes).toEqual(["p1"]);
    expect(follows.at(-1)).toEqual({ id: "did:dev", handle: "dev.test" });
  });

  it("a failed like doesn't fail the reply; it's reported", async () => {
    failLike = true;
    const action = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "reply", text: "thanks!", target: { externalId: "p2", data: { id: "p2" }, author: "dev.test", authorId: "did:dev" }, alsoLike: true },
      scheduledFor: new Date(),
    });
    const done = await executeAction(action.id);
    failLike = false;
    expect(done?.status).toBe("published");
    expect(done?.error).toMatch(/Reply posted, but liking failed: rate limited/);
  });

  it("rejects like/follow options the platform or target can't support", async () => {
    const other = await upsertConnectedAccount(userId, "fakenolike", { externalId: "me2", handle: "me2", credentials: {} });
    await expect(
      createApprovedAction({
        userId,
        accountId: other.id,
        payload: { kind: "reply", text: "hi", target: { externalId: "z", data: { id: "z" } }, alsoLike: true },
        scheduledFor: new Date(),
      }),
    ).rejects.toThrow(/Liking isn't available/);
    await expect(
      createApprovedAction({ userId, accountId, payload: { kind: "post", text: "hi", alsoFollow: true }, scheduledFor: new Date() }),
    ).rejects.toThrow(/Can't follow/);
    const rows = await db.select().from(scheduledActions).where(eq(scheduledActions.accountId, other.id));
    expect(rows).toHaveLength(0);
  });

  it("stores author ids on synced replies and backfills old rows", async () => {
    const [acct] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    await syncInbound(acct); // first sync: connector didn't provide an id yet
    let [c1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "c1")));
    expect(c1.authorId).toBeNull();
    inboundAuthorId = "did:fan";
    await syncInbound(acct);
    [c1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "c1")));
    expect(c1.authorId).toBe("did:fan");
  });
});

describe("regenerate a suggested draft with Haiku", () => {
  it("uses Haiku, the note, the current edit and the target, and saves a cleaned draft", async () => {
    const [rec] = await db
      .insert(recommendations)
      .values({
        planId,
        runId: (await db.select().from(recommendations).where(eq(recommendations.planId, planId)))[0].runId,
        userId,
        accountId,
        kind: "reply",
        title: "Reply to a question",
        draftText: "Original long draft",
        target: { externalId: "q9", author: "asker", excerpt: "When's the demo?", data: { id: "q9" } },
      })
      .returning();
    const r = await regenerateRecommendationDraft(userId, rec.id, "make it shorter", "My edited draft");
    const call = llmCalls.at(-1)!;
    expect(call.model).toBe("haiku");
    expect(call.prompt).toContain("make it shorter");
    expect(call.prompt).toContain("My edited draft"); // builds on unsaved edits
    expect(call.prompt).toContain("When's the demo?");
    expect(r.draft).toBe("Shorter one, promise.");
    const [saved] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(saved.draftText).toBe("Shorter one, promise.");
    expect(saved.status).toBe("pending");
  });

  it("parses a new title when the post needs one", async () => {
    const runId = (await db.select().from(recommendations).where(eq(recommendations.planId, planId)))[0].runId;
    const [rec] = await db
      .insert(recommendations)
      .values({ planId, runId, userId, accountId, kind: "post", title: "Devlog post", draftTitle: "Old title", draftText: "Old body" })
      .returning();
    llmReply = "TITLE: How I built dynamic lighting\nBODY:\nIt took three rewrites.";
    const r = await regenerateRecommendationDraft(userId, rec.id, "", "");
    expect(llmCalls.at(-1)!.prompt).toContain("TITLE:");
    expect(r).toEqual({ draft: "It took three rewrites.", title: "How I built dynamic lighting" });
  });

  it("won't regenerate someone else's or an already-handled suggestion", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.planId, planId), eq(recommendations.kind, "post")));
    await expect(regenerateRecommendationDraft("someone-else", rec.id, "", "")).rejects.toThrow(/not found/);
    await db.update(recommendations).set({ status: "dismissed" }).where(eq(recommendations.id, rec.id));
    await expect(regenerateRecommendationDraft(userId, rec.id, "", "")).rejects.toThrow(/already dismissed/);
  });
});
