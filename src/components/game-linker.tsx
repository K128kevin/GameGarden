"use client";

import { useOptimistic, useTransition } from "react";
import { toggleContentGame } from "@/app/actions";

export function GameLinker({ contentId, games, linked }: { contentId: string; games: { id: string; name: string }[]; linked: string[] }) {
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(linked);
  if (!games.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {games.map((g) => {
        const on = optimistic.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            disabled={pending}
            title={on ? `Unlink from ${g.name}` : `Link to ${g.name}`}
            onClick={() =>
              start(async () => {
                setOptimistic(on ? optimistic.filter((x) => x !== g.id) : [...optimistic, g.id]);
                await toggleContentGame(contentId, g.id, !on);
              })
            }
            className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
              on ? "bg-violet-500/20 text-violet-200 ring-violet-500/40" : "text-zinc-500 ring-zinc-700 hover:text-zinc-300"
            }`}
          >
            {on ? "✓ " : "+ "}
            {g.name}
          </button>
        );
      })}
    </div>
  );
}
