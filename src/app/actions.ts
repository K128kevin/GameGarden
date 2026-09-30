"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import {
  activityLog,
  contentItems,
  gameAccounts,
  gameContent,
  interactions,
  games,
  plans,
  recommendations,
  scheduledActions,
  socialAccounts,
  userSettings,
  type PublishPayload,
} from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { requireUser, getUserSettings } from "@/lib/session";
import { parseLocalInput } from "@/lib/time";
import { getConnector } from "@/platforms/registry";
import {
  accountContext,
  getOwnedAccount,
  syncAccount,
  syncInbound,
  upsertConnectedAccount,
  upsertOwnContent,
} from "@/services/accounts";
import { getOwnedGame, refreshStoreData } from "@/services/games";
import {
  draftInboxReply,
  getOwnedInteraction,
  listInbox,
  reopenInteractionForTarget,
  setInteractionStatus,
} from "@/services/inbox";
import { replyModel } from "@/lib/reply-models";
import { clearPlanHistory, runPlan } from "@/services/planner";
import { createApprovedAction, executeAction, validatePayload } from "@/services/publisher";
import { parseSteamAppId } from "@/stores/steam";
import { normalizeItchUrl } from "@/stores/itch";

export type ActionState = { error?: string; ok?: string } | null;

const str = (fd: FormData, k: string) => (fd.get(k) as string | null)?.trim() ?? "";

function fail(e: unknown): ActionState {
  return { error: e instanceof Error ? e.message : String(e) };
}

async function log(userId: string, type: string, message: string, extra: Partial<typeof activityLog.$inferInsert> = {}) {
  await db.insert(activityLog).values({ userId, type, message, ...extra });
}

/* ------------------------------- Accounts -------------------------------- */

export async function connectWithCredentials(platform: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const connector = getConnector(platform);
  if (connector.connect.type !== "credentials") return { error: "This platform uses OAuth." };
  const values: Record<string, string> = {};
  for (const f of connector.connect.fields) {
    values[f.name] = str(fd, f.name);
    if (f.required && !values[f.name]) return { error: `${f.label} is required.` };
  }
  let id: string;
  try {
    const info = await connector.connect.connectWithCredentials(values);
    const acct = await upsertConnectedAccount(user.id, platform, info);
    await syncAccount(acct);
    id = acct.id;
  } catch (e) {
    return fail(e);
  }
  redirect(`/accounts/${id}?connected=1`);
}

export async function disconnectAccount(accountId: string) {
  const user = await requireUser();
  const acct = await getOwnedAccount(user.id, accountId);
  if (!acct) return;
  await db.delete(socialAccounts).where(eq(socialAccounts.id, acct.id));
  await log(user.id, "account_disconnected", `Disconnected ${getConnector(acct.platform).name} account ${acct.handle}`);
  redirect("/accounts");
}

export async function syncAccountAction(accountId: string): Promise<ActionState> {
  const user = await requireUser();
  const acct = await getOwnedAccount(user.id, accountId);
  if (!acct) return { error: "Account not found" };
  const r = await syncAccount(acct);
  revalidatePath(`/accounts/${accountId}`);
  return r.ok ? { ok: `Synced: ${r.newContent} new posts, ${r.newInteractions} new interactions.` } : { error: r.error };
}

/* ------------------------------ Growth plans ----------------------------- */

async function upsertPlan(userId: string, kind: "account_growth" | "game_marketing", targetId: string, enabled: boolean, goals: string) {
  const col = kind === "account_growth" ? plans.accountId : plans.gameId;
  const [existing] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.userId, userId), eq(plans.kind, kind), eq(col, targetId)));
  if (existing) {
    const [row] = await db
      .update(plans)
      .set({ enabled, goals, ...(enabled && !existing.enabled ? { optedInAt: new Date() } : {}) })
      .where(eq(plans.id, existing.id))
      .returning();
    return { plan: row, newlyEnabled: enabled && !existing.enabled };
  }
  const [row] = await db
    .insert(plans)
    .values({
      userId,
      kind,
      accountId: kind === "account_growth" ? targetId : null,
      gameId: kind === "game_marketing" ? targetId : null,
      enabled,
      goals,
    })
    .returning();
  return { plan: row, newlyEnabled: enabled };
}

export async function saveAccountGrowth(accountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const acct = await getOwnedAccount(user.id, accountId);
  if (!acct) return { error: "Account not found" };
  const enabled = fd.get("enabled") === "on";
  const { plan, newlyEnabled } = await upsertPlan(user.id, "account_growth", acct.id, enabled, str(fd, "goals"));
  await log(user.id, enabled ? "opt_in" : "opt_out", `${enabled ? "Opted in to" : "Paused"} growth recommendations for ${acct.handle}`, {
    planId: plan.id,
    accountId: acct.id,
  });
  if (newlyEnabled && !plan.lastRunAt) {
    const r = await runPlan(plan.id, { slot: `manual-${Date.now()}`, trigger: "manual" });
    revalidatePath("/", "layout");
    if (r.status === "failed") return { error: `Opted in, but the first plan run failed: ${r.error}` };
    redirect(`/plans/${plan.id}`);
  }
  revalidatePath("/", "layout");
  return { ok: enabled ? "Saved. Recommendations update at 9 AM and 9 PM ET." : "Recommendations paused." };
}

export async function saveGameMarketing(gameId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const game = await getOwnedGame(user.id, gameId);
  if (!game) return { error: "Game not found" };
  const enabled = fd.get("enabled") === "on";
  const { plan, newlyEnabled } = await upsertPlan(user.id, "game_marketing", game.id, enabled, str(fd, "goals"));
  await log(user.id, enabled ? "opt_in" : "opt_out", `${enabled ? "Opted in to" : "Paused"} marketing recommendations for ${game.name}`, {
    planId: plan.id,
    gameId: game.id,
  });
  if (newlyEnabled && !plan.lastRunAt) {
    const r = await runPlan(plan.id, { slot: `manual-${Date.now()}`, trigger: "manual" });
    revalidatePath("/", "layout");
    if (r.status === "failed") return { error: `Opted in, but the first plan run failed: ${r.error}` };
    redirect(`/plans/${plan.id}`);
  }
  revalidatePath("/", "layout");
  return { ok: enabled ? "Saved. Recommendations update at 9 AM and 9 PM ET." : "Recommendations paused." };
}

async function ownedPlan(userId: string, planId: string) {
  const [p] = await db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
  if (!p) throw new Error("Plan not found");
  return p;
}

export async function runPlanNow(planId: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    const plan = await ownedPlan(user.id, planId);
    if (!plan.enabled) return { error: "Enable this plan first." };
    const r = await runPlan(plan.id, { slot: `manual-${Date.now()}`, trigger: "manual" });
    revalidatePath("/", "layout");
    return r.status === "succeeded" ? { ok: "Plan updated." } : { error: r.error ?? "Run skipped (another run is in progress)." };
  } catch (e) {
    return fail(e);
  }
}

export async function updatePlanSettings(planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const plan = await ownedPlan(user.id, planId);
    const enabled = fd.get("enabled") === "on";
    await db
      .update(plans)
      .set({ goals: str(fd, "goals"), enabled, ...(enabled && !plan.enabled ? { optedInAt: new Date() } : {}) })
      .where(eq(plans.id, plan.id));
    if (enabled !== plan.enabled) {
      await log(user.id, enabled ? "opt_in" : "opt_out", `${enabled ? "Resumed" : "Paused"} plan recommendations`, { planId: plan.id });
    }
    revalidatePath("/", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function clearPlanHistoryAction(planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (str(fd, "confirm").toLowerCase() !== "clear") return { error: 'Type "clear" to confirm.' };
  try {
    await clearPlanHistory(planId, user.id);
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/", "layout");
  return { ok: "History cleared. The next run will start a fresh plan." };
}

export async function markPlanViewed(planId: string) {
  const user = await requireUser();
  await db
    .update(plans)
    .set({ lastViewedAt: new Date() })
    .where(and(eq(plans.id, planId), eq(plans.userId, user.id)));
  revalidatePath("/", "layout");
}

/* ---------------------------- Recommendations ---------------------------- */

async function ownedRec(userId: string, recId: string) {
  const [r] = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.id, recId), eq(recommendations.userId, userId)));
  if (!r) throw new Error("Recommendation not found");
  return r;
}

function payloadFromForm(rec: typeof recommendations.$inferSelect, fd: FormData): PublishPayload {
  return {
    kind: rec.kind === "reply" ? "reply" : "post",
    text: str(fd, "text"),
    title: str(fd, "title") || null,
    community: str(fd, "community") || null,
    link: rec.link,
    target: rec.target,
  };
}

/**
 * Explicit user approval: schedule (mode=schedule) or publish now (mode=now).
 * This is the only path from a recommendation to the publisher.
 */
export async function approveRecommendation(recId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const rec = await ownedRec(user.id, recId);
    if (!["pending", "failed", "expired"].includes(rec.status)) return { error: `This recommendation is already ${rec.status}.` };
    if (!rec.accountId) return { error: "This recommendation has no account." };
    if (rec.kind !== "post" && rec.kind !== "reply") return { error: "This is a manual task — mark it done when finished." };
    const settings = await getUserSettings(user.id);
    const mode = str(fd, "mode");
    if (!["now", "schedule", "schedule_custom"].includes(mode)) return { error: "Choose Post now or Schedule." };
    let when = new Date();
    if (mode === "schedule" || mode === "schedule_custom") {
      when =
        mode === "schedule_custom"
          ? (parseLocalInput(str(fd, "when"), settings.timezone) ?? new Date(NaN))
          : (rec.suggestedFor ?? new Date());
      if (Number.isNaN(when.getTime())) return { error: "Invalid time." };
      if (when.getTime() < Date.now() - 60_000) return { error: "That time is in the past — pick a future time or post now." };
    }
    const payload = payloadFromForm(rec, fd);
    await db
      .update(recommendations)
      .set({ draftText: payload.text, draftTitle: payload.title ?? null, community: payload.community ?? null })
      .where(eq(recommendations.id, rec.id));
    const action = await createApprovedAction({
      userId: user.id,
      accountId: rec.accountId,
      payload,
      scheduledFor: when,
      recommendationId: rec.id,
      gameId: rec.gameId,
    });
    const scheduling = mode !== "now";
    await log(user.id, scheduling ? "scheduled" : "approved", `${scheduling ? "Scheduled" : "Approved and posted"}: ${rec.title}`, {
      planId: rec.planId,
      accountId: rec.accountId,
      gameId: rec.gameId,
      data: { recommendationId: rec.id, actionId: action.id },
    });
    if (!scheduling) {
      const result = await executeAction(action.id);
      revalidatePath("/", "layout");
      if (result?.status === "failed") return { error: `Publishing failed: ${result.error}` };
      return { ok: "Posted!" };
    }
    revalidatePath("/", "layout");
    return { ok: "Scheduled." };
  } catch (e) {
    return fail(e);
  }
}

export async function setRecommendationStatus(recId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const rec = await ownedRec(user.id, recId);
    const status = str(fd, "status");
    if (!["done", "dismissed", "pending"].includes(status)) return { error: "Invalid status" };
    const note = str(fd, "note") || null;
    await db
      .update(recommendations)
      .set({ status, statusChangedAt: new Date(), userNote: note ?? rec.userNote })
      .where(eq(recommendations.id, rec.id));
    const verb = status === "done" ? "Marked done" : status === "dismissed" ? "Dismissed" : "Restored";
    await log(user.id, `recommendation_${status}`, `${verb}: ${rec.title}${note ? ` — note: "${note}"` : ""}`, {
      planId: rec.planId,
      accountId: rec.accountId,
      gameId: rec.gameId,
      data: { recommendationId: rec.id },
    });
    revalidatePath("/", "layout");
    return { ok: verb };
  } catch (e) {
    return fail(e);
  }
}

/* ---------------------------- Scheduled actions -------------------------- */

async function ownedAction(userId: string, id: string) {
  const [a] = await db
    .select()
    .from(scheduledActions)
    .where(and(eq(scheduledActions.id, id), eq(scheduledActions.userId, userId)));
  if (!a) throw new Error("Scheduled item not found");
  return a;
}

export async function cancelScheduled(id: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    const a = await ownedAction(user.id, id);
    if (a.status !== "scheduled" && a.status !== "failed") return { error: `Can't cancel an item that is ${a.status}.` };
    await db.update(scheduledActions).set({ status: "canceled" }).where(eq(scheduledActions.id, a.id));
    if (a.recommendationId) {
      await db.update(recommendations).set({ status: "pending", statusChangedAt: new Date() }).where(eq(recommendations.id, a.recommendationId));
    }
    if (a.payload.kind === "reply") await reopenInteractionForTarget(a.accountId, a.payload.target?.externalId);
    await log(user.id, "schedule_canceled", `Canceled scheduled ${a.payload.kind}: "${a.payload.text.slice(0, 60)}"`, { accountId: a.accountId });
    revalidatePath("/", "layout");
    return { ok: "Canceled." };
  } catch (e) {
    return fail(e);
  }
}

export async function updateScheduled(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const a = await ownedAction(user.id, id);
    if (a.status !== "scheduled") return { error: `Can't edit an item that is ${a.status}.` };
    const settings = await getUserSettings(user.id);
    const when = parseLocalInput(str(fd, "when"), settings.timezone);
    if (!when || when.getTime() < Date.now() - 60_000) return { error: "Pick a future time." };
    const payload: PublishPayload = { ...a.payload, text: str(fd, "text"), title: str(fd, "title") || a.payload.title };
    const [acct] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, a.accountId));
    const err = validatePayload(acct.platform, payload);
    if (err) return { error: err };
    // Editing counts as re-approval of the new content.
    await db.update(scheduledActions).set({ payload, scheduledFor: when, approvedAt: new Date() }).where(eq(scheduledActions.id, a.id));
    revalidatePath("/schedule");
    return { ok: "Updated." };
  } catch (e) {
    return fail(e);
  }
}

/** Publish a scheduled item immediately instead of waiting for its time (explicit user click = approval). */
export async function publishScheduledNow(id: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    const a = await ownedAction(user.id, id);
    if (a.status !== "scheduled") return { error: `Can't post an item that is ${a.status}.` };
    await db
      .update(scheduledActions)
      .set({ scheduledFor: new Date(), approvedAt: new Date() })
      .where(and(eq(scheduledActions.id, a.id), eq(scheduledActions.status, "scheduled")));
    const r = await executeAction(a.id);
    revalidatePath("/", "layout");
    if (!r) return { error: "It's already being published." };
    return r.status === "published" ? { ok: "Posted!" } : { error: r.error ?? "Publishing failed" };
  } catch (e) {
    return fail(e);
  }
}

/** Retry a failed item right now (explicit user click = approval). */
export async function retryScheduled(id: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    const a = await ownedAction(user.id, id);
    if (a.status !== "failed") return { error: "Only failed items can be retried." };
    await db
      .update(scheduledActions)
      .set({ status: "scheduled", scheduledFor: new Date(), approvedAt: new Date(), error: null })
      .where(eq(scheduledActions.id, a.id));
    const r = await executeAction(a.id);
    revalidatePath("/", "layout");
    return r?.status === "published" ? { ok: "Posted!" } : { error: r?.error ?? "Retry failed" };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------- Inbox --------------------------------- */

export type DraftReplyState = { error?: string; draft?: string; modelLabel?: string } | null;

/** Generate a reply draft with the model the user picked (Haiku by default). Never publishes. */
export async function draftReplyAction(interactionId: string, _prev: DraftReplyState, fd: FormData): Promise<DraftReplyState> {
  const user = await requireUser();
  try {
    const model = replyModel(str(fd, "model")).key;
    const { draft, model: m } = await draftInboxReply(user.id, interactionId, model, str(fd, "guidance"));
    revalidatePath("/inbox");
    return { draft, modelLabel: m.label };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Explicit approval: post the reply now, or schedule it. */
export async function postInboxReply(interactionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const entry = await getOwnedInteraction(user.id, interactionId);
    if (!entry) return { error: "Message not found" };
    const { interaction: i, account: a } = entry;
    if (!i.replyTarget) return { error: "This item can't be replied to from GameGarden." };
    const mode = str(fd, "mode");
    if (mode !== "now" && mode !== "schedule") return { error: "Choose Post now or Schedule." };
    const settings = await getUserSettings(user.id);
    const when = mode === "schedule" ? parseLocalInput(str(fd, "when"), settings.timezone) : new Date();
    if (!when || (mode === "schedule" && when.getTime() < Date.now())) return { error: "Pick a future time." };
    const text = str(fd, "text");
    // Link to a pending plan recommendation for the same message, so the plan sees it as handled.
    const [match] = (await listInbox(user.id, 200)).filter((e) => e.interaction.id === i.id);
    const action = await createApprovedAction({
      userId: user.id,
      accountId: a.id,
      payload: {
        kind: "reply",
        text,
        target: { externalId: i.externalId, url: i.url, author: i.authorHandle, excerpt: i.text.slice(0, 280), data: i.replyTarget },
      },
      scheduledFor: when,
      recommendationId: match?.planRec?.id ?? null,
    });
    await db.update(interactions).set({ draftText: text }).where(eq(interactions.id, i.id));
    await log(user.id, mode === "now" ? "approved" : "scheduled", `${mode === "now" ? "Replied" : "Scheduled a reply"} to ${i.authorHandle ?? "a message"} from the Inbox`, {
      accountId: a.id,
      data: { interactionId: i.id, actionId: action.id },
    });
    if (mode === "now") {
      const r = await executeAction(action.id);
      if (r?.status === "failed") {
        revalidatePath("/", "layout");
        return { error: `Publishing failed: ${r.error}` };
      }
      await setInteractionStatus(i.id, "replied");
      revalidatePath("/", "layout");
      return { ok: "Replied!" };
    }
    await setInteractionStatus(i.id, "scheduled");
    revalidatePath("/", "layout");
    return { ok: "Reply scheduled." };
  } catch (e) {
    return fail(e);
  }
}

export async function dismissInboxItem(interactionId: string): Promise<ActionState> {
  const user = await requireUser();
  const entry = await getOwnedInteraction(user.id, interactionId);
  if (!entry) return { error: "Message not found" };
  await setInteractionStatus(entry.interaction.id, "dismissed");
  revalidatePath("/", "layout");
  return { ok: "Dismissed." };
}

/** Check all of the user's accounts for new replies right now (no model calls). */
export async function checkInboxNow(): Promise<ActionState> {
  const user = await requireUser();
  const accts = await db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id));
  let found = 0;
  const errors: string[] = [];
  for (const a of accts) {
    const r = await syncInbound(a);
    found += r.newInteractions;
    if (!r.ok) errors.push(`${getConnector(a.platform).name} ${a.handle}: ${r.error}`);
  }
  revalidatePath("/", "layout");
  if (errors.length) return { error: errors.join("; ") };
  return { ok: found ? `${found} new item${found === 1 ? "" : "s"}.` : "No new replies." };
}

/* -------------------------------- Compose -------------------------------- */

export async function composePost(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const accountId = str(fd, "accountId");
    const acct = await getOwnedAccount(user.id, accountId);
    if (!acct) return { error: "Choose an account." };
    const gameId = str(fd, "gameId") || null;
    if (gameId && !(await getOwnedGame(user.id, gameId))) return { error: "Game not found" };
    const payload: PublishPayload = {
      kind: "post",
      text: str(fd, "text"),
      title: str(fd, "title") || null,
      community: str(fd, "community") || null,
      link: str(fd, "link") || null,
    };
    const settings = await getUserSettings(user.id);
    const mode = str(fd, "mode");
    if (mode !== "now" && mode !== "schedule") return { error: "Choose Post now or Schedule." };
    const when = mode === "schedule" ? parseLocalInput(str(fd, "when"), settings.timezone) : new Date();
    if (!when || (mode === "schedule" && when.getTime() < Date.now())) return { error: "Pick a future time." };
    const action = await createApprovedAction({ userId: user.id, accountId: acct.id, payload, scheduledFor: when, gameId });
    await log(user.id, mode === "schedule" ? "scheduled" : "approved", `${mode === "schedule" ? "Scheduled" : "Posted"} a ${getConnector(acct.platform).name} post from Compose`, {
      accountId: acct.id,
      gameId,
    });
    if (mode !== "schedule") {
      const r = await executeAction(action.id);
      revalidatePath("/", "layout");
      if (r?.status === "failed") return { error: `Publishing failed: ${r.error}` };
      return { ok: "Posted!" };
    }
    revalidatePath("/", "layout");
    return { ok: "Scheduled." };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------- Games --------------------------------- */

function gameFields(fd: FormData) {
  const steamUrl = str(fd, "steamUrl") || null;
  const itchRaw = str(fd, "itchUrl");
  const itchUrl = itchRaw ? normalizeItchUrl(itchRaw) : null;
  if (itchRaw && !itchUrl) throw new Error("itch.io URL should look like https://you.itch.io/game");
  const steamAppId = parseSteamAppId(steamUrl);
  if (steamUrl && !steamAppId) throw new Error("Steam URL should look like https://store.steampowered.com/app/12345/...");
  return {
    name: str(fd, "name"),
    pitch: str(fd, "pitch"),
    description: str(fd, "description"),
    genres: str(fd, "genres"),
    releaseStatus: str(fd, "releaseStatus") || "in_development",
    releaseDate: str(fd, "releaseDate") || null,
    steamUrl,
    steamAppId,
    itchUrl,
  };
}

export async function createGame(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string;
  try {
    const fields = gameFields(fd);
    if (!fields.name) return { error: "Name is required." };
    const [g] = await db.insert(games).values({ userId: user.id, ...fields }).returning();
    await log(user.id, "game_created", `Created game ${g.name}`, { gameId: g.id });
    await refreshStoreData(g);
    id = g.id;
  } catch (e) {
    return fail(e);
  }
  redirect(`/games/${id}`);
}

export async function updateGame(gameId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const game = await getOwnedGame(user.id, gameId);
    if (!game) return { error: "Game not found" };
    const fields = gameFields(fd);
    if (!fields.name) return { error: "Name is required." };
    const [g] = await db.update(games).set(fields).where(eq(games.id, game.id)).returning();
    if (g.steamAppId !== game.steamAppId || g.itchUrl !== game.itchUrl) await refreshStoreData(g);
    revalidatePath(`/games/${gameId}`);
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteGame(gameId: string) {
  const user = await requireUser();
  const game = await getOwnedGame(user.id, gameId);
  if (!game) return;
  await db.delete(games).where(eq(games.id, game.id));
  await log(user.id, "game_deleted", `Deleted game ${game.name}`);
  redirect("/games");
}

export async function refreshGameStores(gameId: string): Promise<ActionState> {
  const user = await requireUser();
  const game = await getOwnedGame(user.id, gameId);
  if (!game) return { error: "Game not found" };
  const errors = await refreshStoreData(game);
  revalidatePath(`/games/${gameId}`);
  return errors.length ? { error: errors.join("; ") } : { ok: "Store data refreshed." };
}

export async function setGameAccounts(gameId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const game = await getOwnedGame(user.id, gameId);
  if (!game) return { error: "Game not found" };
  const ids = fd.getAll("accountIds").map(String);
  const owned = ids.length
    ? await db
        .select({ id: socialAccounts.id })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.userId, user.id), inArray(socialAccounts.id, ids)))
    : [];
  await db.transaction(async (tx) => {
    await tx.delete(gameAccounts).where(eq(gameAccounts.gameId, game.id));
    if (owned.length) await tx.insert(gameAccounts).values(owned.map((o) => ({ gameId: game.id, accountId: o.id })));
  });
  revalidatePath(`/games/${gameId}`);
  return { ok: "Linked accounts updated." };
}

async function ownedContent(userId: string, contentItemId: string) {
  const [row] = await db
    .select({ item: contentItems })
    .from(contentItems)
    .innerJoin(socialAccounts, eq(socialAccounts.id, contentItems.accountId))
    .where(and(eq(contentItems.id, contentItemId), eq(socialAccounts.userId, userId)));
  return row?.item ?? null;
}

export async function toggleContentGame(contentItemId: string, gameId: string, link: boolean) {
  const u = await requireUser();
  const item = await ownedContent(u.id, contentItemId);
  const game = await getOwnedGame(u.id, gameId);
  if (!item || !game) return;
  if (link) {
    await db.insert(gameContent).values({ gameId, contentItemId }).onConflictDoNothing();
    await log(u.id, "content_linked", `Linked a post to ${game.name}`, { gameId, accountId: item.accountId });
  } else {
    await db.delete(gameContent).where(and(eq(gameContent.gameId, gameId), eq(gameContent.contentItemId, contentItemId)));
  }
  revalidatePath("/", "layout");
}

export async function linkPostByUrl(gameId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const u = await requireUser();
  const game = await getOwnedGame(u.id, gameId);
  if (!game) return { error: "Game not found" };
  const url = str(fd, "url");
  if (!url) return { error: "Paste a post URL." };
  const accts = await db.select().from(socialAccounts).where(eq(socialAccounts.userId, u.id));
  const candidates = accts.filter((a) => getConnector(a.platform).matchesUrl(url));
  if (!candidates.length) return { error: "That URL doesn't match any connected account's platform." };
  for (const a of candidates) {
    try {
      const own = await getConnector(a.platform).resolveOwnContentUrl(accountContext(a), url);
      if (!own) continue;
      const [item] = await upsertOwnContent(a.id, [own]);
      await db.insert(gameContent).values({ gameId, contentItemId: item.id }).onConflictDoNothing();
      await log(u.id, "content_linked", `Linked ${getConnector(a.platform).name} post to ${game.name}`, { gameId, accountId: a.id });
      revalidatePath(`/games/${gameId}`);
      return { ok: "Post linked." };
    } catch (e) {
      return fail(e);
    }
  }
  return { error: "Couldn't find that post on your connected accounts (it must be authored by one of them)." };
}

/* -------------------------------- Settings ------------------------------- */

export async function saveSettings(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const u = await requireUser();
  const timezone = str(fd, "timezone") || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { error: "Unknown time zone." };
  }
  const itch = str(fd, "itchApiKey");
  const clearItch = fd.get("clearItch") === "on";
  await getUserSettings(u.id);
  await db
    .update(userSettings)
    .set({ timezone, ...(itch ? { itchApiKey: encrypt(itch) } : clearItch ? { itchApiKey: null } : {}) })
    .where(eq(userSettings.userId, u.id));
  revalidatePath("/", "layout");
  return { ok: "Settings saved." };
}
