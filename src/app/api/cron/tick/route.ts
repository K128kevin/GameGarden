import { NextResponse } from "next/server";
import { currentPlanSlot } from "@/lib/time";
import { runScheduledSlot } from "@/services/planner";
import { publishDueActions } from "@/services/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Single idempotent heartbeat. Safe to call as often as you like:
 *  1. publishes user-approved scheduled actions that are due;
 *  2. runs the current 9 AM / 9 PM ET planning slot for any plan that hasn't had it yet.
 *
 * Called by Vercel Cron (see vercel.json) and optionally by an external pinger
 * (cron-job.org / GitHub Actions) every few minutes so scheduled posts go out on time.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const publishDeadline = started + 60_000;
  const planDeadline = started + (maxDuration - 90) * 1000;

  const published = await publishDueActions(publishDeadline);
  const slot = currentPlanSlot();
  const planning = await runScheduledSlot(slot, planDeadline);
  // Publish anything that became due while planning ran.
  const publishedLate = await publishDueActions(Date.now() + 20_000);

  return NextResponse.json({
    slot: slot.id,
    published: [...published, ...publishedLate],
    planning,
    ms: Date.now() - started,
  });
}

export const GET = handle;
export const POST = handle;
