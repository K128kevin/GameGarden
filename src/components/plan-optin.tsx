"use client";

import type { ActionState } from "@/app/actions";
import { ActionForm, SubmitButton } from "./forms";
import { input, label } from "./ui";

export function PlanOptIn({
  action,
  enabled,
  goals,
  placeholder,
  isNew,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  enabled: boolean;
  goals: string;
  placeholder: string;
  isNew: boolean;
}) {
  return (
    <ActionForm action={action} className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-zinc-200">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="h-4 w-4 accent-emerald-500" />
        Opt in to AI recommendations (updated 9 AM &amp; 9 PM ET)
      </label>
      <div>
        <label className={label}>Goals &amp; context for the strategist</label>
        <textarea name="goals" defaultValue={goals} rows={3} placeholder={placeholder} className={input} />
      </div>
      <SubmitButton pendingText={isNew ? "Saving & building your first plan (can take a minute or two)…" : "Saving…"}>Save</SubmitButton>
    </ActionForm>
  );
}
