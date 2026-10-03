/** Inbox: light reply checks, filtering, model-selectable drafts, and posting. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const calls: { model: string; system: string; prompt: string }[] = [];
vi.mock("@/services/llm", () => ({
  anthropic: vi.fn(),
  generateDraftText: vi.fn(async (opts: { model: string; system: string; prompt: string }) => {
    calls.push(opts);
    return { text: '"Thanks so much — the demo is coming soon!"', model: opts.model, inputTokens: 10, outputTokens: 5 };
  }),
}));

import { db } from "@/db";
import { contentItems, interactions, planRuns, plans, recommendations, scheduledActions, socialAccounts, user } from "@/db/schema";
import { replyModel } from "@/lib/reply-models";
import { connectors } from "@/platforms/registry";
import type { InboundInteraction, OwnContent, PlatformConnector } from "@/platforms/types";
import { checkInboundDue, syncInbound, upsertConnectedAccount } from "@/services/accounts";
import { countInbox, draftInboxReply, listInbox, repliesInFlight } from "@/services/inbox";
import { createApprovedAction, executeAction } from "@/services/publisher";
import { DRAFTING_RULES } from "@/services/drafting-rules";

const now = Date.now();
let inbound: InboundInteraction[] = [
  { externalId: "q1", kind: "reply", authorHandle: "fan", text: "Is there a demo?", onExternalId: "mypost", replyTarget: { id: "q1" }, occurredAt: new Date(now - 3600_000) },
  { externalId: "q2", kind: "comment", authorHandle: "pal", text: "Nice!", replyTarget: { id: "q2" }, occurredAt: new Date(now - 7200_000), alreadyReplied: true },
  { externalId: "q3", kind: "mention", authorHandle: "dev", text: "cc @me", replyTarget: { id: "q3" }, occurredAt: new Date(now - 5000_000) },
  { externalId: "l1", kind: "like", authorHandle: "x", text: "", occurredAt: new Date(now - 100_000) },
  { externalId: "old", kind: "reply", authorHandle: "y", text: "old one", replyTarget: { id: "old" }, occurredAt: new Date(now - 10 * 86400_000) },
];
const own: OwnContent[] = [
  { externalId: "mypost", kind: "post", text: "New dash mechanic, feels great", publishedAt: new Date(now - 86400_000), metrics: {} },
  // An answer the user already wrote on the platform to q3
  { externalId: "myreply", kind: "reply", text: "hey thanks!", parentExternalId: "q3", publishedAt: new Date(now - 4000_000), metrics: {} },
];
let fetchCount = 0;

const fake: PlatformConnector = {
  id: "fakeinbox",
  name: "FakeInbox",
  badgeClass: "",
  description: "test",
  capabilities: { post: true, reply: true, maxLength: 300 },
  isConfigured: () => true,
  configHelp: "",
  connect: { type: "credentials", fields: [], connectWithCredentials: async () => ({ externalId: "x", handle: "x", credentials: {} }) },
  fetchProfile: async () => ({ followers: 1 }),
  fetchOwnContent: async () => own,
  fetchInteractions: async () => {
    fetchCount++;
    return inbound;
  },
  discover: async () => [],
  resolveOwnContentUrl: async () => null,
  matchesUrl: () => false,
  publish: async (_ctx, payload) => ({ externalId: `pub-${payload.target?.externalId}`, url: null, kind: "reply" }),
};

const userId = `inbox-user-${now}`;
let accountId = "";

beforeAll(async () => {
  connectors.push(fake);
  await db.insert(user).values({ id: userId, name: "Inbox", email: `${userId}@example.com` });
  const a = await upsertConnectedAccount(userId, "fakeinbox", { externalId: "me", handle: "me.test", credentials: {} });
  accountId = a.id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

describe("inbox", () => {
  it("light check stores replies and marks ones already answered", async () => {
    const r = await syncInbound((await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0]);
    expect(r.ok).toBe(true);
    expect(r.newInteractions).toBe(5);
    const [q2] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q2")));
    expect(q2.status).toBe("replied");
  });

  it("lists only open, recent, unanswered messages that need a reply", async () => {
    const entries = await listInbox(userId);
    expect(entries.map((e) => e.interaction.externalId)).toEqual(["q1"]); // q2 answered, q3 replied on platform, like, old
    expect(entries[0].onPost?.text).toContain("dash mechanic");
    expect(await countInbox(userId)).toBe(1);
  });

  it("throttles the between-run check per account", async () => {
    await db.update(socialAccounts).set({ inboundCheckedAt: new Date(now - 60 * 60_000) }).where(eq(socialAccounts.id, accountId));
    const before = fetchCount;
    const first = await checkInboundDue(Date.now() + 10_000, { userId });
    expect(first.checked).toBe(1);
    const second = await checkInboundDue(Date.now() + 10_000, { userId });
    expect(second.checked).toBe(0);
    expect(fetchCount).toBe(before + 1);
  });

  it("defaults reply drafts to Haiku", () => {
    expect(replyModel(undefined).id).toBe("claude-haiku-4-5");
    expect(replyModel("bogus").key).toBe("haiku");
    expect(replyModel("sonnet").id).toBe("claude-sonnet-5-5");
    expect(replyModel("opus").id).toBe("claude-opus-5-5");
  });

  it("drafts with the chosen model, the shared writing rules, and a cleaned result", async () => {
    const [q1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
    const { draft } = await draftInboxReply(userId, q1.id, "opus", "say it's coming in February");
    const call = calls.at(-1)!;
    expect(call.model).toBe("opus");
    expect(call.system).toContain(DRAFTING_RULES);
    expect(call.prompt).toContain("Is there a demo?");
    expect(call.prompt).toContain("New dash mechanic"); // what they replied to
    expect(call.prompt).toContain("hey thanks!"); // voice sample
    expect(call.prompt).toContain("February"); // user guidance
    expect(draft).toBe("Thanks so much, the demo is coming soon!"); // quotes and em dash removed
    const [saved] = await db.select().from(interactions).where(eq(interactions.id, q1.id));
    expect(saved.draftModel).toBe("claude-opus-5-5");
    expect(saved.draftText).toBe(draft);
  });

  it("rejects drafting for someone else's message", async () => {
    const [q1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
    await expect(draftInboxReply("someone-else", q1.id, "haiku", "")).rejects.toThrow(/not found/);
  });

  it("a reply scheduled from the growth plan clears the item; canceling brings it back", async () => {
    const [q1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
    // The planner recommended replying to q1 and the user clicked "Schedule" on the recommendation.
    const [plan] = await db.insert(plans).values({ userId, kind: "account_growth", accountId }).returning();
    const [run] = await db.insert(planRuns).values({ planId: plan.id, slot: "manual-test", trigger: "manual", status: "succeeded" }).returning();
    const [rec] = await db
      .insert(recommendations)
      .values({
        planId: plan.id,
        runId: run.id,
        userId,
        accountId,
        kind: "reply",
        title: "Answer the demo question",
        draftText: "Soon!",
        target: { externalId: "q1", data: q1.replyTarget },
      })
      .returning();
    expect(await countInbox(userId)).toBe(1);
    const action = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "reply", text: "Soon!", target: { externalId: "q1", data: q1.replyTarget } },
      scheduledFor: new Date(Date.now() + 3600_000),
      recommendationId: rec.id,
    });
    expect(await countInbox(userId)).toBe(0);
    expect((await repliesInFlight([accountId])).has("q1")).toBe(true);

    // A failed reply is still "in flight" (retry lives on the Schedule page), so it stays out of the Inbox.
    await db.update(scheduledActions).set({ status: "failed" }).where(eq(scheduledActions.id, action.id));
    expect(await countInbox(userId)).toBe(0);

    // Canceling it puts the message back.
    await db.update(scheduledActions).set({ status: "canceled" }).where(eq(scheduledActions.id, action.id));
    expect(await countInbox(userId)).toBe(1);
    expect((await repliesInFlight([accountId])).has("q1")).toBe(false);
  });

  it("a scheduled *post* (not a reply) doesn't hide anything", async () => {
    const a = await createApprovedAction({ userId, accountId, payload: { kind: "post", text: "unrelated" }, scheduledFor: new Date(Date.now() + 3600_000) });
    expect(await countInbox(userId)).toBe(1);
    await db.update(scheduledActions).set({ status: "canceled" }).where(eq(scheduledActions.id, a.id));
  });

  it("items left with the old 'scheduled' status come back once nothing is in flight", async () => {
    await db.update(interactions).set({ status: "scheduled" }).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
    expect(await countInbox(userId)).toBe(1);
    await db.update(interactions).set({ status: "open" }).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
  });

  it("posting a reply (approved) removes it from the inbox", async () => {
    const [q1] = await db.select().from(interactions).where(and(eq(interactions.accountId, accountId), eq(interactions.externalId, "q1")));
    const action = await createApprovedAction({
      userId,
      accountId,
      payload: { kind: "reply", text: "Soon!", target: { externalId: "q1", data: q1.replyTarget } },
      scheduledFor: new Date(),
    });
    const r = await executeAction(action.id);
    expect(r?.status).toBe("published");
    const mine = await db.select().from(contentItems).where(and(eq(contentItems.accountId, accountId), eq(contentItems.parentExternalId, "q1")));
    expect(mine).toHaveLength(1);
    expect(await countInbox(userId)).toBe(0);
  });
});
