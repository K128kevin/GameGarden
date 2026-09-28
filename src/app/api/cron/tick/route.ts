import { after, NextResponse } from "next/server";
import { currentPlanSlot } from "@/lib/time";
import { runScheduledSlot } from "@/services/planner";
import { publishDueActions } from "@/services/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Single idempotent heartbeat. Safe to call as often as you like:
 *  1. publishes user-approved scheduled actions that are due (before responding);
 *  2. after responding, runs the current 9 AM / 9 PM ET planning slot for any
 *     plan that hasn't had it yet (so short-timeout pingers like cron-job.org
 *     get a fast response while the plan runs keep going in the background).
 *
 * Called by Vercel Cron (see vercel.json) and optionally by an external pinger
 * every few minutes so scheduled posts go out on time.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const published = await publishDueActions(started + 20_000);
  const slot = currentPlanSlot();

  after(async () => {
    const planning = await runScheduledSlot(slot, started + (maxDuration - 60) * 1000);
    // Publish anything that became due while planning ran.
    const late = await publishDueActions(Date.now() + 20_000);
    if (planning.attempted || late.length) {
      console.log(`[tick] slot=${slot.id} planning=${JSON.stringify(planning)} publishedLate=${late.length}`);
    }
  });

  return NextResponse.json({ slot: slot.id, published, planning: "checking in background", ms: Date.now() - started });
}

export const GET = handle;
export const POST = handle;
