import { eq } from "drizzle-orm";
import { db } from "@/db";
import { games, socialAccounts } from "@/db/schema";
import { getUserSettings, requireUser } from "@/lib/session";
import { msFromNow, toLocalInput } from "@/lib/time";
import { getConnector } from "@/platforms/registry";
import { Composer } from "@/components/composer";
import { Card, PageHeader } from "@/components/ui";

export const maxDuration = 60;

export default async function ComposePage() {
  const user = await requireUser();
  const { timezone: tz } = await getUserSettings(user.id);
  const accts = await db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id));
  const gameRows = await db.select({ id: games.id, name: games.name }).from(games).where(eq(games.userId, user.id));
  const inAnHour = new Date(Math.ceil(msFromNow(3_600_000).getTime() / 900_000) * 900_000);
  return (
    <>
      <PageHeader title="Compose" subtitle="Write a post and publish it now or schedule it." />
      <Card>
        <Composer
          accounts={accts.map((a) => {
            const c = getConnector(a.platform);
            return { id: a.id, label: `${c.name} · ${a.handle}`, capabilities: c.capabilities };
          })}
          games={gameRows}
          defaultWhen={toLocalInput(inAnHour, tz)}
        />
      </Card>
    </>
  );
}
