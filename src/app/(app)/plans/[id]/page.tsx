import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { activityLog, gameAccounts, games, planRuns, plans, recommendations, socialAccounts } from "@/db/schema";
import { clearPlanHistoryAction, runPlanNow, updatePlanSettings } from "@/app/actions";
import { getUserSettings, requireUser } from "@/lib/session";
import { isPlanUpdated, planTitle } from "@/lib/plan-names";
import { formatDateTime, formatRelative, nextPlanSlot, slotLabelFromId } from "@/lib/time";
import { toRecView } from "@/lib/views";
import { ActionButton, ActionForm, SubmitButton } from "@/components/forms";
import { MarkViewed } from "@/components/mark-viewed";
import { RecommendationCard } from "@/components/recommendation-card";
import { Badge, btn, Card, CardTitle, EmptyState, input, label, Link, Markdown, Notice, PageHeader, PlatformBadge, StatusBadge } from "@/components/ui";

export const maxDuration = 300;

export default async function PlanPage({ params }: PageProps<"/plans/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const [plan] = await db.select().from(plans).where(and(eq(plans.id, id), eq(plans.userId, user.id)));
  if (!plan) notFound();
  const { timezone: tz } = await getUserSettings(user.id);

  const accountIds = plan.accountId
    ? [plan.accountId]
    : (await db.select().from(gameAccounts).where(eq(gameAccounts.gameId, plan.gameId!))).map((l) => l.accountId);
  const [accts, [game], runs, recs, log] = await Promise.all([
    db.select().from(socialAccounts).where(eq(socialAccounts.userId, user.id)),
    plan.gameId ? db.select().from(games).where(eq(games.id, plan.gameId)) : Promise.resolve([]),
    db.select().from(planRuns).where(eq(planRuns.planId, plan.id)).orderBy(desc(planRuns.startedAt)).limit(30),
    db.select().from(recommendations).where(eq(recommendations.planId, plan.id)).orderBy(desc(recommendations.createdAt)).limit(200),
    db.select().from(activityLog).where(eq(activityLog.planId, plan.id)).orderBy(desc(activityLog.createdAt)).limit(40),
  ]);
  const acctMap = new Map(accts.map((a) => [a.id, a]));
  const gameNames = new Map(game ? [[game.id, game.name]] : []);
  const acct = plan.accountId ? acctMap.get(plan.accountId) : undefined;
  const title = planTitle(plan, acct?.handle, game?.name);

  const latestOk = runs.find((r) => r.status === "succeeded");
  const latestAny = runs[0];
  const updated = isPlanUpdated(plan);
  const pending = recs.filter((r) => r.status === "pending").sort((a, b) => (a.suggestedFor?.getTime() ?? 0) - (b.suggestedFor?.getTime() ?? 0));
  const inFlight = recs.filter((r) => r.runId === latestOk?.id && r.status !== "pending");
  const recsByRun = new Map<string, typeof recs>();
  for (const r of recs) recsByRun.set(r.runId, [...(recsByRun.get(r.runId) ?? []), r]);
  const newCount = latestOk ? (recsByRun.get(latestOk.id)?.length ?? 0) : 0;

  return (
    <>
      <MarkViewed planId={plan.id} needed={updated} />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {acct && <PlatformBadge platform={acct.platform} />}
            {!plan.enabled && <Badge>paused</Badge>}
          </span>
        }
        subtitle={
          <>
            {plan.kind === "account_growth" ? (
              <Link href={`/accounts/${plan.accountId}`} className="hover:text-zinc-200">
                Account growth plan
              </Link>
            ) : (
              <Link href={`/games/${plan.gameId}`} className="hover:text-zinc-200">
                Game marketing plan · {accountIds.length} linked account{accountIds.length === 1 ? "" : "s"}
              </Link>
            )}
            {" · "}
            {plan.lastRunAt ? `Last updated ${formatDateTime(plan.lastRunAt, tz)}` : "Not run yet"}
            {plan.enabled && ` · Next run ${formatDateTime(nextPlanSlot(), tz)}`}
          </>
        }
        actions={
          plan.enabled && (
            <ActionButton action={runPlanNow.bind(null, plan.id)} pendingText="Analyzing… (1–3 min)">
              Run analysis now
            </ActionButton>
          )
        }
      />

      {updated && latestOk && (
        <div className="mb-6 rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-4">
          <div className="flex flex-wrap items-center gap-2 font-medium text-emerald-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Plan updated in the {slotLabelFromId(latestOk.slot)} · {formatRelative(latestOk.finishedAt ?? latestOk.startedAt)}
          </div>
          <p className="mt-1 text-sm text-emerald-100/80">
            {newCount} new recommendation{newCount === 1 ? "" : "s"}.{" "}
            {latestOk.strategyChanged ? `Strategy revised: ${latestOk.strategyChangeSummary ?? "see below"}` : "Long-term strategy unchanged."}
          </p>
        </div>
      )}
      {latestAny?.status === "failed" && (
        <div className="mb-6">
          <Notice kind="error">
            The {slotLabelFromId(latestAny.slot)} at {formatDateTime(latestAny.startedAt, tz)} failed: {latestAny.error}
          </Notice>
        </div>
      )}
      {latestAny?.status === "running" && (
        <div className="mb-6">
          <Notice kind="info">A run is in progress (started {formatRelative(latestAny.startedAt)}). Refresh in a minute.</Notice>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {latestOk?.assessment && (
            <Card>
              <CardTitle>What happened since the last run</CardTitle>
              <Markdown>{latestOk.assessment}</Markdown>
            </Card>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-100">Recommended actions ({pending.length} pending)</h2>
            {pending.length === 0 && inFlight.length === 0 && (
              <EmptyState title={plan.lastRunAt ? "All caught up" : "No recommendations yet"}>
                {plan.enabled
                  ? plan.lastRunAt
                    ? "New recommendations arrive with the next run."
                    : "Click “Run analysis now” to generate the first plan."
                  : "This plan is paused."}
              </EmptyState>
            )}
            {pending.map((r) => (
              <RecommendationCard key={r.id} rec={toRecView(r, acctMap, tz, gameNames)} />
            ))}
            {inFlight.length > 0 && (
              <>
                <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Handled from the latest run</h3>
                {inFlight.map((r) => (
                  <RecommendationCard key={r.id} rec={toRecView(r, acctMap, tz, gameNames)} />
                ))}
              </>
            )}
          </section>

          <Card>
            <CardTitle>
              Long-term strategy
              {plan.strategyUpdatedAt && <span className="ml-2 text-xs font-normal text-zinc-500">revised {formatRelative(plan.strategyUpdatedAt)}</span>}
            </CardTitle>
            {plan.strategy ? <Markdown>{plan.strategy}</Markdown> : <p className="text-sm text-zinc-500">Written on the first run.</p>}
            {(plan.focusKeywords.length > 0 || plan.focusCommunities.length > 0) && (
              <div className="mt-4 flex flex-wrap gap-1.5 border-t border-zinc-800 pt-3">
                <span className="text-xs text-zinc-500">Watching:</span>
                {plan.focusKeywords.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
                {plan.focusCommunities.map((c) => (
                  <Badge key={c} color="amber">
                    r/{c}
                  </Badge>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Run history</CardTitle>
            {!runs.length && <p className="text-sm text-zinc-500">No runs yet.</p>}
            <ol className="space-y-2">
              {runs.map((r) => {
                const rr = recsByRun.get(r.id) ?? [];
                return (
                  <li key={r.id}>
                    <details className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                        <StatusBadge status={r.status} />
                        <span className="text-zinc-200">{slotLabelFromId(r.slot)}</span>
                        <span className="text-zinc-500">{formatDateTime(r.startedAt, tz)}</span>
                        {r.strategyChanged && <Badge color="violet">strategy revised</Badge>}
                        <span className="ml-auto text-xs text-zinc-500">{rr.length} recs</span>
                      </summary>
                      <div className="mt-3 space-y-3 pb-1">
                        {r.error && <Notice kind="error">{r.error}</Notice>}
                        {r.strategyChangeSummary && <p className="text-sm text-violet-200">Strategy change: {r.strategyChangeSummary}</p>}
                        {r.assessment && <Markdown>{r.assessment}</Markdown>}
                        {rr.length > 0 && (
                          <ul className="space-y-1 text-sm">
                            {rr.map((x) => (
                              <li key={x.id} className="flex items-center gap-2">
                                <StatusBadge status={x.status} />
                                <span className="text-zinc-300">{x.title}</span>
                                {x.userNote && <span className="text-xs text-zinc-500">— {x.userNote}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.model && (
                          <p className="text-xs text-zinc-600">
                            {r.model} · {r.inputTokens?.toLocaleString()} in / {r.outputTokens?.toLocaleString()} out tokens
                          </p>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle>Plan settings</CardTitle>
            <ActionForm action={updatePlanSettings.bind(null, plan.id)} className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input type="checkbox" name="enabled" defaultChecked={plan.enabled} className="h-4 w-4 accent-emerald-500" />
                Recommendations enabled
              </label>
              <div>
                <label className={label}>Goals &amp; context</label>
                <textarea name="goals" defaultValue={plan.goals} rows={4} className={input} />
              </div>
              <SubmitButton className={btn.secondary}>Save</SubmitButton>
            </ActionForm>
          </Card>

          <Card>
            <CardTitle>Activity</CardTitle>
            {!log.length && <p className="text-sm text-zinc-500">Nothing yet.</p>}
            <ul className="space-y-2.5">
              {log.map((l) => (
                <li key={l.id} className="text-sm">
                  <div className="text-zinc-300">{l.message}</div>
                  <div className="text-xs text-zinc-500">{formatDateTime(l.createdAt, tz)}</div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="border-red-950">
            <CardTitle>Clear history</CardTitle>
            <p className="mb-3 text-sm text-zinc-400">
              Deletes this plan&apos;s runs, recommendations, strategy and activity so the next run starts fresh. Posts you already
              scheduled stay scheduled (cancel them on the Schedule page).
            </p>
            <ActionForm action={clearPlanHistoryAction.bind(null, plan.id)} className="space-y-2">
              <input name="confirm" placeholder='Type "clear" to confirm' className={input} autoComplete="off" />
              <SubmitButton className={btn.danger} pendingText="Clearing…">
                Clear plan history
              </SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
