import { after, NextResponse } from "next/server";
import { currentPlanSlot } from "@/lib/time";
import { runScheduledSlot } from "@/services/planner";
import { checkInboundDue } from "@/services/accounts";
import { recordRejectedTick, recordTick, tickSource } from "@/services/heartbeat";
import { publishDueActions } from "@/services/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Single idempotent heartbeat. Safe to call as often as you like:
 *  1. publishes user-approved scheduled actions that are due (before responding);
 *  2. after responding: checks accounts for new replies/mentions (at most every
 *     ~30 min per account, no model call), then runs the current 9 AM / 9 PM ET
 *     planning slot for any plan that hasn't had it yet (so short-timeout pingers
 *     like cron-job.org get a fast response while the work continues).
 *
 * Called by Vercel Cron (see vercel.json) and optionally by an external pinger
 * every few minutes so scheduled posts go out on time.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    // Remember the rejection so the app can explain why scheduled posts aren't going out.
    await recordRejectedTick(secret ? "bad_secret" : "missing_secret_env").catch(() => {});
    return NextResponse.json(
      { error: secret ? "unauthorized: send the header 'Authorization: Bearer <CRON_SECRET>'" : "CRON_SECRET is not set on the server" },
      { status: 401 },
    );
  }
  await recordTick(tickSource(req));

  const started = Date.now();
  const published = await publishDueActions(started + 20_000);
  const slot = currentPlanSlot();

  after(async () => {
    // Light reply/mention check for accounts not checked in ~30 minutes (no model calls).
    const inbound = await checkInboundDue(Date.now() + 60_000).catch(() => ({ checked: 0, newInteractions: 0 }));
    const planning = await runScheduledSlot(slot, started + (maxDuration - 60) * 1000);
    // Publish anything that became due while planning ran.
    const late = await publishDueActions(Date.now() + 20_000);
    if (planning.attempted || late.length || inbound.newInteractions) {
      console.log(
        `[tick] slot=${slot.id} inbound=${JSON.stringify(inbound)} planning=${JSON.stringify(planning)} publishedLate=${late.length}`,
      );
    }
  });

  return NextResponse.json({ slot: slot.id, published, planning: "checking in background", ms: Date.now() - started });
}

export const GET = handle;
export const POST = handle;
