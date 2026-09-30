import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { findConnector } from "@/platforms/registry";

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700/70 disabled:opacity-50 disabled:cursor-not-allowed",
  ghost:
    "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50",
  danger:
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-red-900/70 bg-red-950/40 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/50 disabled:opacity-50",
};

export const input =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

/** Same look as `input`, but sized to its content (for selects, date pickers, buttons in a row). */
export const inputInline = input.replace("w-full ", "w-auto ");

export const label = "mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 ${className}`}>{children}</div>;
}

export function CardTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-zinc-100">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const tone: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  red: "bg-red-500/15 text-red-300 ring-red-500/30",
  blue: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  violet: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  zinc: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
};

export function Badge({ children, color = "zinc", className = "" }: { children: React.ReactNode; color?: keyof typeof tone | string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone[color] ?? color} ${className}`}>
      {children}
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  const c = findConnector(platform);
  return <Badge color={c?.badgeClass ?? "zinc"}>{c?.name ?? platform}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "blue",
    scheduled: "violet",
    posted: "green",
    published: "green",
    done: "green",
    succeeded: "green",
    dismissed: "zinc",
    expired: "zinc",
    canceled: "zinc",
    failed: "red",
    error: "red",
    running: "amber",
    publishing: "amber",
    active: "green",
  };
  return <Badge color={map[status] ?? "zinc"}>{status}</Badge>;
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
      <p className="font-medium text-zinc-200">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-zinc-400">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-gg text-sm text-zinc-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function Stat({ label: l, value, delta }: { label: string; value: React.ReactNode; delta?: number | null }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{l}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold text-zinc-50">{value ?? "—"}</span>
        {delta != null && delta !== 0 && (
          <span className={`text-xs font-medium ${delta > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {delta > 0 ? "+" : ""}
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

export function ExternalLink({ href, children, className = "" }: { href?: string | null; children: React.ReactNode; className?: string }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`text-emerald-300 hover:underline ${className}`}>
      {children}
    </a>
  );
}

export function Notice({ kind, children }: { kind: "error" | "ok" | "info"; children: React.ReactNode }) {
  const cls =
    kind === "error"
      ? "border-red-900/60 bg-red-950/40 text-red-200"
      : kind === "ok"
        ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-200"
        : "border-sky-900/60 bg-sky-950/30 text-sky-200";
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export { Link };
