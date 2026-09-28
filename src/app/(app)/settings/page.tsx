import { saveSettings } from "@/app/actions";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, nextPlanSlot } from "@/lib/time";
import { SignOutButton } from "@/components/auth-buttons";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, input, label, PageHeader } from "@/components/ui";

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Stockholm",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Australia/Sydney",
  "UTC",
];

export default async function SettingsPage() {
  const user = await requireUser();
  const s = await getUserSettings(user.id);
  const zones = ZONES.includes(s.timezone) ? ZONES : [s.timezone, ...ZONES];
  return (
    <>
      <PageHeader title="Settings" subtitle={user.email} actions={<div className="md:hidden"><SignOutButton /></div>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Preferences</CardTitle>
          <ActionForm action={saveSettings} className="space-y-4">
            <div>
              <label className={label}>Your time zone (for displaying and scheduling)</label>
              <select name="timezone" defaultValue={s.timezone} className={input}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">
                Planning runs always happen at 9 AM and 9 PM US Eastern. Next: {formatDateTime(nextPlanSlot(), s.timezone)}.
              </p>
            </div>
            <div>
              <label className={label}>itch.io API key (optional)</label>
              <input name="itchApiKey" type="password" placeholder={s.itchApiKey ? "•••••••• (saved)" : "From itch.io → Settings → API keys"} className={input} autoComplete="off" />
              {s.itchApiKey && (
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                  <input type="checkbox" name="clearItch" className="accent-emerald-500" /> Remove saved key
                </label>
              )}
              <p className="mt-1 text-xs text-zinc-500">Lets GameGarden read views, downloads and purchases for your itch.io games. Stored encrypted.</p>
            </div>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>How approvals work</CardTitle>
          <ul className="list-disc space-y-2 pl-5 text-sm text-zinc-400">
            <li>The AI strategist can only create recommendations and drafts. It cannot post.</li>
            <li>Something is published only when you click <strong className="text-zinc-200">Post now</strong>, or when a time you explicitly scheduled arrives.</li>
            <li>Editing a scheduled item re-approves the new content. Cancel anything on the Schedule page.</li>
            <li>Failed posts are never retried automatically.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
