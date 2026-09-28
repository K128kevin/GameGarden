/**
 * End-to-end service flow against a real Postgres (DATABASE_URL), with a fake
 * platform connector and a mocked LLM. Verifies: sync → plan run → recommendations
 * → user approval → publish, plus the approval invariant and history clearing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const published: unknown[] = [];

vi.mock("@/services/ai", () => ({
  MODEL: "mock",
  generatePlanUpdate: vi.fn(async (ctx: { accounts: { ref: string; interactions: { ref: string }[]; discoveredConversations: { ref: string }[] }[] }) => {
    const a = ctx.accounts[0];
    return {
      model: "mock-model",
      inputTokens: 100,
      outputTokens: 50,
      output: {
        assessment: "First run. Followers at 10.",
        strategyChanged: true,
        strategyChangeSummary: "Initial plan",
        strategy: "## Goals\nGrow to 100 followers",
        focusKeywords: ["cozy games"],
        focusCommunities: ["r/IndieDev"],
        completedRefs: [],
        recommendations: [
          {
            kind: "reply",
            accountRef: a.ref,
            title: "Thank the commenter",
            rationale: "Engagement",
            draftText: "Thanks so much!",
            draftTitle: "",
            community: "",
            link: "",
            targetRef: a.interactions[0]?.ref ?? "",
            suggestedTime: new Date(Date.now() + 3600_000).toISOString(),
            priority: "high",
          },
          {
            kind: "reply",
            accountRef: a.ref,
            title: "Join a conversation",
            rationale: "Visibility",
            draftText: "Love the art style!",
            draftTitle: "",
            community: "",
            link: "",
            targetRef: "D999", // invalid ref → should degrade to a manual task
            suggestedTime: "not a date",
            priority: "medium",
          },
          {
            kind: "post",
            accountRef: a.ref,
            title: "Share a GIF",
            rationale: "Show progress",
            draftText: "New dash mechanic!",
            draftTitle: "",
            community: "",
            link: "",
            targetRef: "",
            suggestedTime: new Date(Date.now() + 7200_000).toISOString(),
            priority: "high",
          },
        ],
      },
    };
  }),
}));

import { db } from "@/db";
import {
  activityLog,
  contentItems,
  interactions,
  planRuns,
  plans,
  recommendations,
  scheduledActions,
  socialAccounts,
  user,
} from "@/db/schema";
import { connectors } from "@/platforms/registry";
import type { PlatformConnector } from "@/platforms/types";
import { upsertConnectedAccount } from "@/services/accounts";
import { clearPlanHistory, runPlan, runScheduledSlot } from "@/services/planner";
import { createApprovedAction, executeAction, publishDueActions } from "@/services/publisher";

const fake: PlatformConnector = {
  id: "fakebook",
  name: "Fakebook",
  badgeClass: "",
  description: "test",
  capabilities: { post: true, reply: true, maxLength: 300 },
  isConfigured: () => true,
  configHelp: "",
  connect: { type: "credentials", fields: [], connectWithCredentials: async () => ({ externalId: "x", handle: "x", credentials: {} }) },
  fetchProfile: async () => ({ followers: 10, following: 5, postsCount: 3 }),
  fetchOwnContent: async () => [
    { externalId: "p1", kind: "post", text: "hello world", publishedAt: new Date(Date.now() - 86400_000), metrics: { likes: 3 } },
  ],
  fetchInteractions: async () => [
    {
      externalId: "i1",
      kind: "reply",
      authorHandle: "fan",
      text: "Looks great!",
      replyTarget: { id: "i1" },
      occurredAt: new Date(Date.now() - 3600_000),
    },
  ],
  discover: async () => [
    { externalId: "d1", authorHandle: "dev", text: "my game", createdAt: new Date(), metrics: {}, replyTarget: { id: "d1" } },
  ],
  resolveOwnContentUrl: async () => null,
  matchesUrl: () => false,
  publish: async (_ctx, payload) => {
    published.push(payload);
    return { externalId: `pub-${published.length}`, url: "https://fake/1", kind: payload.kind === "reply" ? "reply" : "post" };
  },
};

const userId = `test-user-${Date.now()}`;
let accountId = "";
let planId = "";

beforeAll(async () => {
  connectors.push(fake);
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}@example.com` });
  const acct = await upsertConnectedAccount(userId, "fakebook", { externalId: "ext-1", handle: "tester", credentials: { token: "secret" } });
  accountId = acct.id;
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

describe("growth plan flow", () => {
  it("stores credentials encrypted", async () => {
    const [a] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    expect(a.credentials).not.toContain("secret");
  });

  it("runs a plan: syncs, calls the model, stores recommendations", async () => {
    const [p] = await db.insert(plans).values({ userId, kind: "account_growth", accountId, goals: "grow" }).returning();
    planId = p.id;
    const r = await runPlan(planId, { slot: "manual-1", trigger: "manual" });
    expect(r.status).toBe("succeeded");

    const items = await db.select().from(contentItems).where(eq(contentItems.accountId, accountId));
    expect(items).toHaveLength(1);
    const inbound = await db.select().from(interactions).where(eq(interactions.accountId, accountId));
    expect(inbound).toHaveLength(1);

    const recs = await db.select().from(recommendations).where(eq(recommendations.planId, planId));
    expect(recs).toHaveLength(3);
    const reply = recs.find((x) => x.title === "Thank the commenter")!;
    expect(reply.kind).toBe("reply");
    expect(reply.target?.externalId).toBe("i1");
    const bad = recs.find((x) => x.title === "Join a conversation")!;
    expect(bad.kind).toBe("engage"); // invalid target downgraded
    expect(bad.suggestedFor!.getTime()).toBeGreaterThan(Date.now()); // invalid time clamped to future

    const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
    expect(plan.strategy).toContain("Goals");
    expect(plan.focusCommunities).toEqual(["IndieDev"]);
    expect(plan.lastRunAt).not.toBeNull();
    // Nothing published by the planner.
    expect(published).toHaveLength(0);
    expect(await db.select().from(scheduledActions).where(eq(scheduledActions.userId, userId))).toHaveLength(0);
  });

  it("is idempotent per slot", async () => {
    const again = await runPlan(planId, { slot: "manual-1", trigger: "manual" });
    expect(again.status).toBe("skipped");
  });

  it("publishes only after explicit approval, at the scheduled time", async () => {
    const [reply] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.planId, planId), eq(recommendations.title, "Thank the commenter")));

    // Scheduled in the future → tick does nothing yet.
    const future = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "reply", text: reply.draftText!, target: reply.target },
      scheduledFor: new Date(Date.now() + 3600_000),
      recommendationId: reply.id,
    });
    expect(await publishDueActions(Date.now() + 10_000)).toHaveLength(0);
    expect(published).toHaveLength(0);
    const [recAfter] = await db.select().from(recommendations).where(eq(recommendations.id, reply.id));
    expect(recAfter.status).toBe("scheduled");

    // Make it due → published exactly once.
    await db.update(scheduledActions).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(scheduledActions.id, future.id));
    const results = await publishDueActions(Date.now() + 10_000);
    expect(results).toEqual([{ id: future.id, status: "published" }]);
    expect(published).toHaveLength(1);
    expect(await executeAction(future.id)).toBeNull(); // can't double-publish
    const [recDone] = await db.select().from(recommendations).where(eq(recommendations.id, reply.id));
    expect(recDone.status).toBe("posted");
    const appItems = await db.select().from(contentItems).where(and(eq(contentItems.accountId, accountId), eq(contentItems.source, "app")));
    expect(appItems).toHaveLength(1);
  });

  it("rejects invalid payloads before approval", async () => {
    await expect(
      createApprovedAction({ userId, accountId, payload: { kind: "post", text: "x".repeat(301) }, scheduledFor: new Date() }),
    ).rejects.toThrow(/300 characters/);
  });

  it("scheduled slot only runs plans opted in before the slot", async () => {
    const slot = { id: "2099-01-01-am", startsAt: new Date(Date.now() - 1000) };
    await db.update(plans).set({ optedInAt: new Date(Date.now() + 60_000) }).where(eq(plans.id, planId));
    const skipped = await runScheduledSlot(slot, Date.now() + 60_000);
    expect(skipped.results.find((r) => r.planId === planId)).toBeUndefined();

    await db.update(plans).set({ optedInAt: new Date(Date.now() - 60_000) }).where(eq(plans.id, planId));
    const ran = await runScheduledSlot({ ...slot, startsAt: new Date() }, Date.now() + 60_000);
    expect(ran.results.find((r) => r.planId === planId)?.status).toBe("succeeded");
    // Previous pending recommendations were superseded.
    const recs = await db.select().from(recommendations).where(eq(recommendations.planId, planId));
    expect(recs.filter((r) => r.status === "expired").length).toBeGreaterThan(0);
    const again = await runScheduledSlot({ ...slot, startsAt: new Date() }, Date.now() + 60_000);
    expect(again.results.find((r) => r.planId === planId)).toBeUndefined();
  });

  it("clears plan history but keeps approved scheduled posts", async () => {
    const keep = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "post", text: "keep me" },
      scheduledFor: new Date(Date.now() + 86400_000),
    });
    await clearPlanHistory(planId, userId);
    expect(await db.select().from(recommendations).where(eq(recommendations.planId, planId))).toHaveLength(0);
    expect(await db.select().from(planRuns).where(eq(planRuns.planId, planId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.planId, planId))).toHaveLength(0);
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
    expect(plan.strategy).toBe("");
    const [kept] = await db.select().from(scheduledActions).where(eq(scheduledActions.id, keep.id));
    expect(kept.status).toBe("scheduled");
  });
});
