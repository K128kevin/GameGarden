import { PLAN_TIMEZONE } from "./env";

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(date: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as unknown as Parts;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffset(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - zoneOffset(new Date(guess), timeZone);
  // Re-check once around DST transitions.
  const second = guess - zoneOffset(new Date(result), timeZone);
  if (second !== result) result = second;
  return new Date(result);
}

/** Parse the value of an <input type="datetime-local"> as wall-clock time in `timeZone`. */
export function parseLocalInput(value: string, timeZone: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], timeZone);
}

/** Format a Date for an <input type="datetime-local"> in `timeZone`. */
export function toLocalInput(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatDateTime(date: Date | null | undefined, timeZone: string): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatRelative(date: Date | null | undefined, now = new Date()): string {
  if (!date) return "never";
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff >= 0 ? "in a moment" : "just now";
}

/* -------------------------------------------------------------------------- */
/* Planning slots: 9:00 AM and 9:00 PM America/New_York                       */
/* -------------------------------------------------------------------------- */

export const PLAN_HOURS = [9, 21] as const;

export type PlanSlot = { id: string; startsAt: Date; label: string };

/** The most recent planning slot that has started at or before `now`. */
export function currentPlanSlot(now = new Date()): PlanSlot {
  const tz = PLAN_TIMEZONE;
  const p = partsInZone(now, tz);
  const candidates: PlanSlot[] = [];
  // Today's and yesterday's slots (yesterday covers 00:00–08:59).
  for (const dayOffset of [0, -1]) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset, 12));
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth() + 1;
    const d = base.getUTCDate();
    for (const h of PLAN_HOURS) {
      const startsAt = zonedToUtc(y, mo, d, h, 0, tz);
      const id = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}-${h < 12 ? "am" : "pm"}`;
      candidates.push({ id, startsAt, label: `${h < 12 ? "9:00 AM" : "9:00 PM"} ET run` });
    }
  }
  const past = candidates.filter((c) => c.startsAt.getTime() <= now.getTime());
  past.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  return past[0];
}

export function nextPlanSlot(now = new Date()): Date {
  const cur = currentPlanSlot(now);
  // Next slot is 12h later in wall-clock terms; recompute to respect DST.
  const probe = new Date(cur.startsAt.getTime() + 13 * 3_600_000);
  const next = currentPlanSlot(probe);
  return next.startsAt.getTime() > now.getTime() ? next.startsAt : new Date(cur.startsAt.getTime() + 12 * 3_600_000);
}

export function slotLabelFromId(slot: string): string {
  if (slot.startsWith("manual")) return "Manual run";
  if (slot.endsWith("-am")) return "9:00 AM ET run";
  if (slot.endsWith("-pm")) return "9:00 PM ET run";
  return slot;
}

/** Current time offset by `ms` (helper so server components stay lint-clean). */
export function msFromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}
