"use client";

import type { ActionState } from "@/app/actions";
import type { Game } from "@/db/schema";
import { ActionForm, SubmitButton } from "./forms";
import { input, label } from "./ui";

export function GameForm({
  action,
  game,
  submitLabel,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  game?: Partial<Game>;
  submitLabel: string;
}) {
  return (
    <ActionForm action={action} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className={label}>Name</label>
        <input name="name" defaultValue={game?.name} required className={input} />
      </div>
      <div className="sm:col-span-2">
        <label className={label}>One-line pitch</label>
        <input name="pitch" defaultValue={game?.pitch} placeholder="A cozy roguelite about farming on a dying star" className={input} />
      </div>
      <div className="sm:col-span-2">
        <label className={label}>Description (what makes it special, audience, comparable games)</label>
        <textarea name="description" defaultValue={game?.description} rows={4} className={input} />
      </div>
      <div>
        <label className={label}>Genres / tags (comma-separated)</label>
        <input name="genres" defaultValue={game?.genres} placeholder="roguelite, cozy, pixel art" className={input} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Status</label>
          <select name="releaseStatus" defaultValue={game?.releaseStatus ?? "in_development"} className={input}>
            <option value="in_development">In development</option>
            <option value="demo">Demo out</option>
            <option value="early_access">Early access</option>
            <option value="released">Released</option>
          </select>
        </div>
        <div>
          <label className={label}>Release date</label>
          <input name="releaseDate" defaultValue={game?.releaseDate ?? ""} placeholder="Q2 2027" className={input} />
        </div>
      </div>
      <div>
        <label className={label}>Steam page</label>
        <input name="steamUrl" type="url" defaultValue={game?.steamUrl ?? ""} placeholder="https://store.steampowered.com/app/…" className={input} />
      </div>
      <div>
        <label className={label}>itch.io page</label>
        <input name="itchUrl" type="url" defaultValue={game?.itchUrl ?? ""} placeholder="https://you.itch.io/your-game" className={input} />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
