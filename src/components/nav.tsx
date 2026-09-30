"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Dashboard", icon: "◎" },
  { href: "/inbox", label: "Inbox", icon: "✉", count: "inbox" as const },
  { href: "/plans", label: "Growth plans", icon: "✦", count: "plans" as const },
  { href: "/accounts", label: "Accounts", icon: "◉" },
  { href: "/games", label: "Games", icon: "▣" },
  { href: "/schedule", label: "Schedule", icon: "◷", count: "schedule" as const },
  { href: "/compose", label: "Compose", icon: "✎" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function NavLinks({ counts }: { counts: { plans: number; recommendations: number; schedule: number; inbox: number } }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
      {items.map((it) => {
        const active = path === it.href || path.startsWith(`${it.href}/`);
        const n = it.count ? counts[it.count] : 0;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
              active ? "bg-emerald-500/10 text-emerald-300" : "text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100"
            }`}
          >
            <span className="w-4 text-center text-zinc-500">{it.icon}</span>
            {it.label}
            {n > 0 && (
              <span
                className={`ml-auto rounded-full px-1.5 text-xs font-semibold ${
                  it.count === "plans" || it.count === "inbox" ? "bg-emerald-500 text-emerald-950" : "bg-zinc-700 text-zinc-200"
                }`}
                title={it.count === "plans" ? "Plans updated since you last looked" : it.count === "inbox" ? "Replies waiting on you" : undefined}
              >
                {it.count === "plans" ? `${n} new` : n}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
