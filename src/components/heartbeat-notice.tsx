import { heartbeatStatus } from "@/services/heartbeat";
import { formatRelative, msFromNow } from "@/lib/time";
import { Notice } from "./ui";

/**
 * Explains why scheduled posts aren't going out when the frequent heartbeat
 * (cron-job.org or similar) isn't calling /api/cron/tick.
 */
export async function HeartbeatNotice({ overdueCount }: { overdueCount: number }) {
  const hb = await heartbeatStatus();
  const recentRejection = hb.lastRejected && hb.lastRejected.at > msFromNow(-60 * 60_000);
  if (hb.healthy && !recentRejection && overdueCount === 0) return null;

  if (recentRejection && !hb.healthy) {
    return (
      <Notice kind="error">
        <strong>Scheduled posts are paused:</strong> something called the heartbeat (<code>/api/cron/tick</code>){" "}
        {formatRelative(hb.lastRejected!.at)}, but it was rejected because{" "}
        {hb.lastRejected!.reason === "missing_secret_env" ? (
          <>
            <code>CRON_SECRET</code> isn&apos;t set in Vercel. Add it and redeploy.
          </>
        ) : (
          <>
            the secret didn&apos;t match. In cron-job.org, the header must be <code>Authorization</code> with the value{" "}
            <code>Bearer &lt;your CRON_SECRET&gt;</code>, exactly the same as in Vercel.
          </>
        )}
      </Notice>
    );
  }

  if (!hb.healthy) {
    return (
      <Notice kind="error">
        <strong>Scheduled posts only go out when the heartbeat runs.</strong>{" "}
        {hb.lastExternal
          ? `The frequent heartbeat last ran ${formatRelative(hb.lastExternal)}.`
          : "No frequent heartbeat has ever reached the app."}{" "}
        Vercel&apos;s free cron only runs around 9 AM and 9 PM ET, so set up cron-job.org to call{" "}
        <code>/api/cron/tick</code> every 5 minutes (see docs/DEPLOYMENT.md, step 7). Until then, due posts go out when you
        open GameGarden, or you can click <strong>Post now</strong>.
        {overdueCount > 0 && ` ${overdueCount} scheduled item${overdueCount === 1 ? " is" : "s are"} overdue.`}
      </Notice>
    );
  }

  return (
    <Notice kind="info">
      {overdueCount} scheduled item{overdueCount === 1 ? " is" : "s are"} past due and should go out within a few minutes.
    </Notice>
  );
}
