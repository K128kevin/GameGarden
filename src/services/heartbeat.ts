import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { systemState } from "@/db/schema";

/**
 * Tracks calls to /api/cron/tick so the app can tell the user when the
 * scheduler isn't running (the usual reason a scheduled post is late).
 */

type Source = "vercel-cron" | "external";

async function put(key: string, value: Record<string, unknown>) {
  await db
    .insert(systemState)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemState.key, set: { value, updatedAt: sql`now()` } });
}

export function tickSource(req: Request): Source {
  return (req.headers.get("user-agent") ?? "").toLowerCase().includes("vercel-cron") ? "vercel-cron" : "external";
}

export async function recordTick(source: Source) {
  const at = new Date().toISOString();
  await put(source === "external" ? "tick:external" : "tick:vercel-cron", { at });
}

export async function recordRejectedTick(reason: "missing_secret_env" | "bad_secret") {
  await put("tick:rejected", { at: new Date().toISOString(), reason });
}

/**
 * The external pinger is expected every 30 minutes (hourly also works). Pinging more often keeps
 * the Neon database awake around the clock and uses up the free plan's compute hours.
 */
export const HEARTBEAT_MINUTES = 30;
/** Warn when the pinger has been silent this long (covers 30- and 60-minute pingers). */
export const HEARTBEAT_STALE_MINUTES = 75;

export type HeartbeatStatus = {
  lastExternal: Date | null;
  lastVercelCron: Date | null;
  lastRejected: { at: Date; reason: string } | null;
  /** The frequent (external) pinger has run recently (see HEARTBEAT_STALE_MINUTES). */
  healthy: boolean;
};

export async function heartbeatStatus(): Promise<HeartbeatStatus> {
  const rows = await db
    .select()
    .from(systemState)
    .where(inArray(systemState.key, ["tick:external", "tick:vercel-cron", "tick:rejected"]));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const date = (v?: Record<string, unknown>) => (typeof v?.at === "string" ? new Date(v.at) : null);
  const lastExternal = date(get("tick:external"));
  const rejected = get("tick:rejected");
  const rejectedAt = date(rejected);
  return {
    lastExternal,
    lastVercelCron: date(get("tick:vercel-cron")),
    lastRejected: rejectedAt ? { at: rejectedAt, reason: String(rejected?.reason ?? "bad_secret") } : null,
    healthy: Boolean(lastExternal && Date.now() - lastExternal.getTime() < HEARTBEAT_STALE_MINUTES * 60_000),
  };
}

export async function clearRejectedTick() {
  await db.delete(systemState).where(eq(systemState.key, "tick:rejected"));
}
