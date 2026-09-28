import type { Plan } from "@/db/schema";

export function planTitle(p: Plan, accountHandle?: string | null, gameName?: string | null) {
  return p.kind === "account_growth" ? `Grow ${accountHandle ?? "account"}` : `Market ${gameName ?? "game"}`;
}

export function isPlanUpdated(p: Plan) {
  return Boolean(p.lastRunAt && (!p.lastViewedAt || p.lastRunAt > p.lastViewedAt));
}
