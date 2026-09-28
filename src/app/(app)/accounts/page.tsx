import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountSnapshots, plans, socialAccounts } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { formatRelative } from "@/lib/time";
import { connectors } from "@/platforms/registry";
import { ConnectCredentials } from "@/components/connect-credentials";
import { Badge, btn, Card, EmptyState, Link, Notice, PageHeader, PlatformBadge, StatusBadge } from "@/components/ui";

export default async function AccountsPage({ searchParams }: PageProps<"/accounts">) {
  const user = await requireUser();
  const { error } = await searchParams;
  const accts = await db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id)).orderBy(socialAccounts.createdAt);
  const planRows = await db.select().from(plans).where(eq(plans.userId, user.id));
  const latest = new Map<string, number | null>();
  for (const a of accts) {
    const [s] = await db
      .select({ followers: accountSnapshots.followers })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, a.id))
      .orderBy(desc(accountSnapshots.capturedAt))
      .limit(1);
    latest.set(a.id, s?.followers ?? null);
  }

  return (
    <>
      <PageHeader title="Accounts" subtitle="Connect social accounts, then opt them in to AI growth recommendations." />
      {error && (
        <div className="mb-4">
          <Notice kind="error">{String(error)}</Notice>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-zinc-100">Connected</h2>
      {accts.length ? (
        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          {accts.map((a) => {
            const plan = planRows.find((p) => p.kind === "account_growth" && p.accountId === a.id);
            return (
              <Link key={a.id} href={`/accounts/${a.id}`} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700">
                <div className="flex items-center gap-3">
                  {a.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.avatarUrl} alt="" className="h-10 w-10 rounded-full bg-zinc-800 object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-zinc-800" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium text-zinc-100">{a.displayName || a.handle}</div>
                    <div className="truncate text-xs text-zinc-500">{a.handle}</div>
                  </div>
                  <div className="ml-auto flex flex-col items-end gap-1">
                    <PlatformBadge platform={a.platform} />
                    {a.status !== "active" && <StatusBadge status={a.status} />}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs text-zinc-400">
                  <span>{latest.get(a.id) ?? "—"} followers</span>
                  <span>· synced {formatRelative(a.lastSyncedAt)}</span>
                  {plan?.enabled && <Badge color="green">growth plan on</Badge>}
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="mb-8">
          <EmptyState title="No accounts connected yet">Connect one below to start tracking activity.</EmptyState>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-zinc-100">Add an account</h2>
      <div className="grid gap-3 md:grid-cols-3">
        {connectors.map((c) => (
          <Card key={c.id}>
            <div className="mb-2 flex items-center gap-2">
              <PlatformBadge platform={c.id} />
            </div>
            <p className="mb-4 text-sm text-zinc-400">{c.description}</p>
            {!c.isConfigured() ? (
              <p className="text-xs text-amber-300">Not configured on this server. {c.configHelp}</p>
            ) : c.connect.type === "oauth" ? (
              <a href={`/api/connect/${c.id}/start`} className={btn.primary}>
                Connect {c.name}
              </a>
            ) : (
              <ConnectCredentials platform={c.id} name={c.name} fields={c.connect.fields} />
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
