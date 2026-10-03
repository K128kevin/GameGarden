import { and, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountSnapshots,
  activityLog,
  contentItems,
  gameAccounts,
  gameContent,
  games,
  interactions,
  planRuns,
  plans,
  recommendations,
  scheduledActions,
  socialAccounts,
  storeSnapshots,
  userSettings,
  type Game,
  type Plan,
  type RecommendationTarget,
  type SocialAccount,
} from "@/db/schema";
import { getConnector } from "@/platforms/registry";
import { truncate, type DiscoveredPost } from "@/platforms/types";
import { normalizeSubreddit } from "@/platforms/reddit";
import { cleanDraft } from "@/lib/drafts";
import { formatDateTime, slotLabelFromId } from "@/lib/time";
import { accountContext, syncAccount } from "./accounts";
import { generatePlanUpdate, type PlanOutputT } from "./ai";
import { repliesInFlight } from "./inbox";
import { refreshStoreData } from "./games";

type RefTarget = { accountId: string; target: RecommendationTarget };

const DEFAULT_COMMUNITIES: Record<string, string[]> = {
  reddit: ["IndieDev", "indiegames", "gamedev", "IndieGaming"],
};

function defaultKeywords(game: Game | null): string[] {
  const kw = ["indie game devlog", "#indiedev", "indie game screenshot"];
  if (game) {
    for (const g of game.genres.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3)) kw.unshift(`${g} indie game`);
  }
  return kw;
}

function nowInZone(tz: string) {
  const now = new Date();
  const offsetMin = -Math.round(
    (now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime()) / 60000,
  );
  return { iso: now.toISOString(), local: formatDateTime(now, tz), utcOffsetMinutes: offsetMin };
}

function snapshotDelta(latest?: Record<string, unknown>, previous?: Record<string, unknown>) {
  if (!latest || !previous) return undefined;
  const delta: Record<string, number> = {};
  for (const [k, v] of Object.entries(latest)) {
    const p = previous[k];
    if (typeof v === "number" && typeof p === "number" && v !== p) delta[k] = v - p;
  }
  return delta;
}

/** Load everything the planner needs and build the (compact) JSON context for the LLM. */
async function buildContext(plan: Plan, accts: SocialAccount[], game: Game | null, discovered: Map<string, DiscoveredPost[]>) {
  const refs = new Map<string, RefTarget>();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, plan.userId));
  const tz = settings?.timezone ?? "America/New_York";
  const sinceLastRun = plan.lastRunAt ?? new Date(Date.now() - 7 * 86_400_000);

  const gameLinkedIds = game
    ? new Set(
        (await db.select({ id: gameContent.contentItemId }).from(gameContent).where(eq(gameContent.gameId, game.id))).map(
          (r) => r.id,
        ),
      )
    : new Set<string>();

  // Map content produced from recommendations → recommendation title (to show outcomes).
  const appActions = accts.length
    ? await db
        .select({ resultExternalId: scheduledActions.resultExternalId, recTitle: recommendations.title })
        .from(scheduledActions)
        .leftJoin(recommendations, eq(recommendations.id, scheduledActions.recommendationId))
        .where(and(inArray(scheduledActions.accountId, accts.map((a) => a.id)), eq(scheduledActions.status, "published")))
    : [];
  const recByExternal = new Map(appActions.filter((a) => a.resultExternalId).map((a) => [a.resultExternalId!, a.recTitle]));

  let pCount = 0;
  let iCount = 0;
  let dCount = 0;
  const accountsCtx = [];
  for (const [idx, a] of accts.entries()) {
    const connector = getConnector(a.platform);
    const aRef = `A${idx + 1}`;
    const snaps = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, a.id))
      .orderBy(desc(accountSnapshots.capturedAt))
      .limit(40);
    // Keep ~1 snapshot per day for history, plus the latest.
    const byDay = new Map<string, (typeof snaps)[number]>();
    for (const s of snaps) {
      const day = s.capturedAt.toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, s);
    }
    const history = [...byDay.values()].slice(0, 14).map((s) => ({
      date: s.capturedAt.toISOString().slice(0, 10),
      followers: s.followers,
      following: s.following,
      posts: s.postsCount,
      ...s.extra,
    }));

    const content = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.accountId, a.id))
      .orderBy(desc(contentItems.publishedAt))
      .limit(game ? 40 : 25);
    const ownIds = new Set(content.map((c) => c.parentExternalId).filter(Boolean));
    const recentContent = content
      .filter((c) => !game || gameLinkedIds.has(c.id) || content.indexOf(c) < 12)
      .slice(0, 25)
      .map((c) => ({
        ref: `P${++pCount}`,
        kind: c.kind,
        publishedAt: formatDateTime(c.publishedAt, tz),
        postedVia: c.source === "app" ? "GameGarden" : "manually on the platform",
        fromRecommendation: c.externalId ? (recByExternal.get(c.externalId) ?? undefined) : undefined,
        aboutThisGame: game ? gameLinkedIds.has(c.id) : undefined,
        community: c.community ?? undefined,
        title: c.title ?? undefined,
        text: truncate(c.text, 400),
        isReply: Boolean(c.parentExternalId),
        metrics: c.metrics,
        new: c.firstSeenAt > sinceLastRun ? true : undefined,
      }));

    const inFlight = await repliesInFlight([a.id]);
    const inbound = await db
      .select()
      .from(interactions)
      .where(and(eq(interactions.accountId, a.id), gt(interactions.occurredAt, new Date(Date.now() - 5 * 86_400_000))))
      .orderBy(desc(interactions.occurredAt))
      .limit(40);
    const interactionsCtx = inbound.map((i) => {
      const ref = `I${++iCount}`;
      const replyable = Boolean(i.replyTarget && connector.capabilities.reply);
      const canFollow = Boolean((i.authorId || i.authorHandle) && connector.capabilities.follow);
      if (replyable || canFollow) {
        refs.set(ref, {
          accountId: a.id,
          target: {
            externalId: i.externalId,
            url: i.url,
            author: i.authorHandle,
            authorId: i.authorId,
            excerpt: truncate(i.text, 280),
            data: i.replyTarget,
          },
        });
      }
      return {
        ref,
        kind: i.kind,
        author: i.authorHandle,
        text: truncate(i.text, 400),
        when: formatDateTime(i.occurredAt, tz),
        newSinceLastRun: i.firstSeenAt > sinceLastRun,
        alreadyRepliedByUser: ownIds.has(i.externalId) || i.status === "replied",
        inboxStatus:
          i.status === "dismissed" ? "user dismissed: no reply needed" : inFlight.has(i.externalId) ? "reply already scheduled" : undefined,
        replyable,
        canFollow: canFollow || undefined,
      };
    });
    // Aggregate likes/follows instead of listing each.
    const summaryKinds = new Set(["like", "follow"]);
    const aggregated = interactionsCtx.filter((i) => summaryKinds.has(i.kind));
    const conversational = interactionsCtx.filter((i) => !summaryKinds.has(i.kind));

    const discoveredCtx = (discovered.get(a.id) ?? []).map((d) => {
      const ref = `D${++dCount}`;
      const replyable = Boolean(d.replyTarget && connector.capabilities.reply);
      const canFollow = Boolean((d.authorId || d.authorHandle) && connector.capabilities.follow);
      if (replyable || canFollow) {
        refs.set(ref, {
          accountId: a.id,
          target: {
            externalId: d.externalId,
            url: d.url,
            author: d.authorHandle,
            authorId: d.authorId,
            community: d.community,
            excerpt: truncate(d.title ? `${d.title}: ${d.text}` : d.text, 280),
            data: d.replyTarget,
          },
        });
      }
      return {
        ref,
        author: d.authorHandle,
        community: d.community ?? undefined,
        title: d.title ?? undefined,
        text: truncate(d.text, 350),
        posted: formatDateTime(d.createdAt, tz),
        metrics: d.metrics,
        matchedQuery: d.matchedQuery,
        replyable: replyable || undefined,
        canFollow: canFollow || undefined,
      };
    });

    accountsCtx.push({
      ref: aRef,
      platform: connector.name,
      handle: a.handle,
      displayName: a.displayName,
      capabilities: connector.capabilities,
      statsHistoryNewestFirst: history,
      recentContent,
      interactions: conversational,
      likesAndFollowsLast5Days: {
        likes: aggregated.filter((i) => i.kind === "like").length,
        newFollowers: aggregated.filter((i) => i.kind === "follow").map((i) => i.author),
      },
      discoveredConversations: discoveredCtx,
    });
  }

  // Previous runs (long-term memory).
  const runs = await db
    .select()
    .from(planRuns)
    .where(and(eq(planRuns.planId, plan.id), eq(planRuns.status, "succeeded")))
    .orderBy(desc(planRuns.startedAt))
    .limit(8);

  // Recommendation history and outcomes.
  const recs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.planId, plan.id))
    .orderBy(desc(recommendations.createdAt))
    .limit(50);
  const pendingRefs = new Map<string, string>();
  let rCount = 0;
  const recHistory = recs.map((r) => {
    const ref = `R${++rCount}`;
    if (r.status === "pending") pendingRefs.set(ref, r.id);
    return {
      ref,
      created: formatDateTime(r.createdAt, tz),
      kind: r.kind,
      title: r.title,
      status: r.status,
      userNote: r.userNote ?? undefined,
      draft: r.draftText ? truncate(r.draftText, 160) : undefined,
      suggestedFor: r.suggestedFor ? formatDateTime(r.suggestedFor, tz) : undefined,
    };
  });

  const upcoming = accts.length
    ? await db
        .select()
        .from(scheduledActions)
        .where(and(inArray(scheduledActions.accountId, accts.map((a) => a.id)), eq(scheduledActions.status, "scheduled")))
        .orderBy(scheduledActions.scheduledFor)
    : [];

  const recentActivity = await db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.userId, plan.userId),
        gte(activityLog.createdAt, sinceLastRun),
        or(
          eq(activityLog.planId, plan.id),
          accts.length ? inArray(activityLog.accountId, accts.map((a) => a.id)) : sql`false`,
          game ? eq(activityLog.gameId, game.id) : sql`false`,
        ),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(30);

  let gameCtx: Record<string, unknown> | undefined;
  if (game) {
    const store = async (s: "steam" | "itch") => {
      const rows = await db
        .select()
        .from(storeSnapshots)
        .where(and(eq(storeSnapshots.gameId, game.id), eq(storeSnapshots.store, s)))
        .orderBy(desc(storeSnapshots.capturedAt))
        .limit(2);
      if (!rows[0]) return undefined;
      return { latest: rows[0].data, changeSincePrevious: snapshotDelta(rows[0].data, rows[1]?.data) };
    };
    gameCtx = {
      name: game.name,
      pitch: game.pitch,
      description: truncate(game.description, 1500),
      genres: game.genres,
      releaseStatus: game.releaseStatus,
      releaseDate: game.releaseDate,
      steamUrl: game.steamUrl,
      itchUrl: game.itchUrl,
      steam: await store("steam"),
      itch: await store("itch"),
    };
  }

  const context = {
    now: nowInZone(tz),
    userTimezone: tz,
    plan: {
      type: plan.kind === "account_growth" ? "Grow this social media account" : "Market this game across its linked accounts",
      userGoals: plan.goals || "(none given — infer sensible goals for an indie game developer)",
      currentLongTermStrategy: plan.strategy || "(none yet — this is the first run; write it)",
      strategyLastUpdated: plan.strategyUpdatedAt ? formatDateTime(plan.strategyUpdatedAt, tz) : null,
      focusKeywords: plan.focusKeywords,
      focusCommunities: plan.focusCommunities,
      previousRunAt: plan.lastRunAt ? formatDateTime(plan.lastRunAt, tz) : null,
    },
    game: gameCtx,
    accounts: accountsCtx,
    previousRunsNewestFirst: runs.map((r) => ({
      when: formatDateTime(r.startedAt, tz),
      run: slotLabelFromId(r.slot),
      assessment: truncate(r.assessment, 1200),
      strategyChange: r.strategyChangeSummary || undefined,
    })),
    recommendationHistoryNewestFirst: recHistory,
    alreadyScheduled: upcoming.map((u) => ({
      when: formatDateTime(u.scheduledFor, tz),
      account: `A${accts.findIndex((a) => a.id === u.accountId) + 1}`,
      kind: u.payload.kind,
      text: truncate(u.payload.text, 160),
    })),
    userActivitySinceLastRun: recentActivity.map((l) => ({ when: formatDateTime(l.createdAt, tz), what: l.message })),
  };
  return { context, refs, pendingRefs, accountRefs: new Map(accts.map((a, i) => [`A${i + 1}`, a])) };
}

function clampTime(iso: string): Date {
  const now = Date.now();
  let t = new Date(iso).getTime();
  if (Number.isNaN(t) || t < now + 10 * 60_000) t = now + 30 * 60_000;
  if (t > now + 7 * 86_400_000) t = now + 7 * 86_400_000;
  return new Date(Math.round(t / 60_000) * 60_000);
}

async function persistOutput(
  plan: Plan,
  runId: string,
  game: Game | null,
  output: PlanOutputT,
  built: Awaited<ReturnType<typeof buildContext>>,
) {
  const now = new Date();
  // Previous pending suggestions are superseded by this run (or detected as done).
  const completed = new Set(output.completedRefs.map((r) => built.pendingRefs.get(r)).filter(Boolean) as string[]);
  if (completed.size) {
    await db
      .update(recommendations)
      .set({ status: "done", statusChangedAt: now, userNote: "Detected as done manually by the planner" })
      .where(inArray(recommendations.id, [...completed]));
  }
  await db
    .update(recommendations)
    .set({ status: "expired", statusChangedAt: now })
    .where(and(eq(recommendations.planId, plan.id), eq(recommendations.status, "pending"), lt(recommendations.createdAt, now)));

  const rows = [];
  for (const r of output.recommendations) {
    const acct = built.accountRefs.get(r.accountRef) ?? (built.accountRefs.size === 1 ? [...built.accountRefs.values()][0] : undefined);
    const connector = acct ? getConnector(acct.platform) : null;
    let kind = r.kind;
    let target: RecommendationTarget | null = null;
    if (kind === "reply") {
      const ref = built.refs.get(r.targetRef);
      // Invalid or non-replyable target → manual task.
      if (!ref || (acct && ref.accountId !== acct.id) || !ref.target.data || !connector?.capabilities.reply) kind = "engage";
      else target = ref.target;
    } else if (kind === "follow") {
      const ref = built.refs.get(r.targetRef);
      const who = ref?.target.authorId || ref?.target.author;
      if (!ref || (acct && ref.accountId !== acct.id) || !who || !connector?.capabilities.follow) kind = "engage";
      else target = ref.target;
    }
    if (kind === "post" && connector && !connector.capabilities.post) kind = "content";
    rows.push({
      planId: plan.id,
      runId,
      userId: plan.userId,
      accountId: acct?.id ?? null,
      gameId: game?.id ?? null,
      kind,
      title: r.title,
      rationale: r.rationale,
      draftText: cleanDraft(r.draftText),
      draftTitle: cleanDraft(r.draftTitle),
      community: r.community ? normalizeSubreddit(r.community) : null,
      link: r.link || null,
      target,
      suggestedFor: clampTime(r.suggestedTime),
      priority: r.priority,
      status: "pending",
    });
  }
  if (rows.length) await db.insert(recommendations).values(rows);

  const strategyChanged = output.strategyChanged || !plan.strategy;
  await db
    .update(plans)
    .set({
      strategy: output.strategy,
      strategyUpdatedAt: strategyChanged ? now : plan.strategyUpdatedAt,
      focusKeywords: output.focusKeywords.slice(0, 10),
      focusCommunities: output.focusCommunities.map(normalizeSubreddit).filter(Boolean).slice(0, 10),
      lastRunAt: now,
    })
    .where(eq(plans.id, plan.id));
  return { count: rows.length, strategyChanged };
}

export type RunResult = { status: "succeeded" | "failed" | "skipped"; runId?: string; error?: string };

/** Claim a run row for (plan, slot). Returns null if already done / in progress. */
async function claimRun(planId: string, slot: string, trigger: "scheduled" | "manual") {
  const [inserted] = await db.insert(planRuns).values({ planId, slot, trigger }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  // Retry a failed run once, or a run that died mid-flight.
  const [retried] = await db
    .update(planRuns)
    .set({ status: "running", attempts: sql`${planRuns.attempts} + 1`, startedAt: new Date(), error: null })
    .where(
      and(
        eq(planRuns.planId, planId),
        eq(planRuns.slot, slot),
        lt(planRuns.attempts, 2),
        or(
          eq(planRuns.status, "failed"),
          and(eq(planRuns.status, "running"), lt(planRuns.startedAt, new Date(Date.now() - 15 * 60_000))),
        ),
      ),
    )
    .returning();
  return retried ?? null;
}

export async function runPlan(planId: string, opts: { slot: string; trigger: "scheduled" | "manual" }): Promise<RunResult> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan || !plan.enabled) return { status: "skipped" };
  const run = await claimRun(plan.id, opts.slot, opts.trigger);
  if (!run) return { status: "skipped" };

  try {
    let accts: SocialAccount[] = [];
    let game: Game | null = null;
    if (plan.kind === "account_growth" && plan.accountId) {
      accts = await db.select().from(socialAccounts).where(eq(socialAccounts.id, plan.accountId));
    } else if (plan.kind === "game_marketing" && plan.gameId) {
      [game] = await db.select().from(games).where(eq(games.id, plan.gameId));
      const links = await db.select().from(gameAccounts).where(eq(gameAccounts.gameId, plan.gameId));
      accts = links.length
        ? await db.select().from(socialAccounts).where(inArray(socialAccounts.id, links.map((l) => l.accountId)))
        : [];
      if (game) await refreshStoreData(game);
    }
    if (!accts.length && !game) throw new Error("This plan has no account to analyze.");

    // 1. Sync what happened on each account since the last run.
    const syncErrors: string[] = [];
    for (const a of accts) {
      const r = await syncAccount(a);
      if (!r.ok) syncErrors.push(`${getConnector(a.platform).name} ${a.handle}: ${r.error}`);
    }

    // 2. Discover relevant conversations on each platform.
    const keywords = plan.focusKeywords.length ? plan.focusKeywords : defaultKeywords(game);
    const discovered = new Map<string, DiscoveredPost[]>();
    for (const a of accts) {
      const communities = plan.focusCommunities.length ? plan.focusCommunities : (DEFAULT_COMMUNITIES[a.platform] ?? []);
      try {
        const [fresh] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, a.id));
        discovered.set(a.id, await getConnector(a.platform).discover(accountContext(fresh), { keywords, communities, limit: 15 }));
      } catch {
        discovered.set(a.id, []);
      }
    }

    // 3. Ask the model for an updated assessment, strategy, and actions.
    const [freshPlan] = await db.select().from(plans).where(eq(plans.id, plan.id));
    const built = await buildContext(freshPlan, accts, game, discovered);
    const ai = await generatePlanUpdate({ ...built.context, syncWarnings: syncErrors.length ? syncErrors : undefined });

    // 4. Persist.
    const { count, strategyChanged } = await persistOutput(freshPlan, run.id, game, ai.output, built);
    await db
      .update(planRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        assessment: ai.output.assessment,
        strategyChanged,
        strategyChangeSummary: ai.output.strategyChangeSummary || null,
        model: ai.model,
        inputTokens: ai.inputTokens,
        outputTokens: ai.outputTokens,
        metrics: { recommendations: count, syncErrors },
      })
      .where(eq(planRuns.id, run.id));
    await db.insert(activityLog).values({
      userId: plan.userId,
      planId: plan.id,
      accountId: plan.accountId,
      gameId: plan.gameId,
      type: "plan_updated",
      message: `Plan updated (${slotLabelFromId(opts.slot)}): ${count} new recommendation${count === 1 ? "" : "s"}${strategyChanged ? ", strategy revised" : ""}`,
      data: { runId: run.id },
    });
    return { status: "succeeded", runId: run.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(planRuns).set({ status: "failed", finishedAt: new Date(), error: message }).where(eq(planRuns.id, run.id));
    return { status: "failed", runId: run.id, error: message };
  }
}

/** Run every enabled plan for the given scheduled slot (idempotent). */
export async function runScheduledSlot(slot: { id: string; startsAt: Date }, deadline: number) {
  const due = await db
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        eq(plans.enabled, true),
        lt(plans.optedInAt, slot.startsAt),
        sql`not exists (select 1 from ${planRuns} r where r.plan_id = ${plans.id} and r.slot = ${slot.id} and (r.status = 'succeeded' or r.attempts >= 2 or (r.status = 'running' and r.started_at > now() - interval '15 minutes')))`,
      ),
    );
  const results: { planId: string; status: string; error?: string }[] = [];
  for (const p of due) {
    // Leave headroom: a plan run takes up to a couple of minutes.
    if (Date.now() > deadline) break;
    const r = await runPlan(p.id, { slot: slot.id, trigger: "scheduled" });
    results.push({ planId: p.id, status: r.status, error: r.error });
  }
  return { attempted: results.length, remaining: due.length - results.length, results };
}

/** Clear all history for a plan (runs, recommendations, strategy, log). */
export async function clearPlanHistory(planId: string, userId: string) {
  const [plan] = await db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
  if (!plan) throw new Error("Plan not found");
  await db.transaction(async (tx) => {
    // Approved scheduled posts stay scheduled (the user approved them); only the link is dropped.
    await tx.delete(recommendations).where(eq(recommendations.planId, plan.id));
    await tx.delete(planRuns).where(eq(planRuns.planId, plan.id));
    await tx.delete(activityLog).where(eq(activityLog.planId, plan.id));
    await tx
      .update(plans)
      .set({ strategy: "", strategyUpdatedAt: null, focusKeywords: [], focusCommunities: [], lastRunAt: null, lastViewedAt: null, optedInAt: new Date() })
      .where(eq(plans.id, plan.id));
    await tx.insert(activityLog).values({
      userId,
      accountId: plan.accountId,
      gameId: plan.gameId,
      type: "plan_cleared",
      message: "Cleared growth plan history",
    });
  });
}
