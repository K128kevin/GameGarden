"use client";

import { useActionState, useState } from "react";
import { dismissInboxItem, draftReplyAction, postInboxReply, type DraftReplyState } from "@/app/actions";
import { DEFAULT_REPLY_MODEL, REPLY_MODELS } from "@/lib/reply-models";
import { ActionButton, ActionForm, SubmitButton } from "./forms";
import { btn, input, inputInline, Notice } from "./ui";

export type InboxItemView = {
  id: string;
  kind: string;
  author: string | null;
  text: string;
  url: string | null;
  whenLabel: string;
  isNew: boolean;
  account: { platformName: string; badgeClass: string; handle: string; maxLength?: number };
  onPost: { text: string; title: string | null } | null;
  savedDraft: string | null;
  savedDraftModel: string | null;
  planDraft: string | null;
  defaultWhen: string;
};

function ModelPicker({ defaultValue }: { defaultValue: string }) {
  return (
    <select name="model" defaultValue={defaultValue} className={inputInline} aria-label="Model">
      {REPLY_MODELS.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label} ({m.hint})
        </option>
      ))}
    </select>
  );
}

export function InboxItem({ item }: { item: InboxItemView }) {
  const [draftState, draftAction, drafting] = useActionState<DraftReplyState, FormData>(
    draftReplyAction.bind(null, item.id),
    null,
  );
  const initial = item.savedDraft ?? item.planDraft ?? "";
  const [text, setText] = useState(initial);
  const [lastDraft, setLastDraft] = useState<string | undefined>(undefined);
  // Adopt a freshly generated draft into the editor (without clobbering edits on re-render).
  if (draftState?.draft && draftState.draft !== lastDraft) {
    setLastDraft(draftState.draft);
    setText(draftState.draft);
  }
  const hasDraft = text.trim().length > 0;
  const source = draftState?.modelLabel
    ? `Drafted by ${draftState.modelLabel}`
    : item.savedDraft
      ? item.savedDraftModel
        ? `Drafted by ${item.savedDraftModel}`
        : "Your saved draft"
      : item.planDraft
        ? "Drafted by your growth plan"
        : null;
  const max = item.account.maxLength;

  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${item.account.badgeClass}`}>
          {item.account.platformName} · {item.account.handle}
        </span>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">{item.kind}</span>
        {item.isNew && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-300">new</span>}
        <span className="ml-auto text-zinc-500">{item.whenLabel}</span>
      </div>

      <div className="mt-2 text-sm">
        <span className="font-medium text-zinc-100">{item.author ?? "Someone"}</span>
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer" className="ml-2 text-xs text-emerald-300 hover:underline">
            open ↗
          </a>
        )}
        <p className="mt-1 whitespace-pre-wrap text-zinc-200">{item.text}</p>
      </div>
      {item.onPost && (
        <p className="mt-2 line-clamp-2 border-l-2 border-zinc-700 pl-2 text-xs text-zinc-500">
          on your post: {item.onPost.title ? `${item.onPost.title}: ` : ""}
          {item.onPost.text}
        </p>
      )}

      {/* Generate (or regenerate) a draft with the chosen model */}
      <form action={draftAction} className="mt-3 flex flex-wrap items-center gap-2">
        <ModelPicker defaultValue={DEFAULT_REPLY_MODEL} />
        <input name="guidance" placeholder="Optional: what you want to say" className={`${input} min-w-48 flex-1`} />
        <button type="submit" disabled={drafting} className={hasDraft ? btn.secondary : btn.primary}>
          {drafting ? "Drafting…" : hasDraft ? "Redraft" : "Draft reply"}
        </button>
      </form>
      {draftState?.error && (
        <div className="mt-2">
          <Notice kind="error">{draftState.error}</Notice>
        </div>
      )}

      {hasDraft && (
        <ActionForm action={postInboxReply.bind(null, item.id)} className="mt-3 space-y-2" blockEnterSubmit>
          {source && <div className="text-xs text-zinc-500">{source}. Edit it however you like.</div>}
          <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))} className={input} />
          {max && (
            <div className={`text-right text-xs ${text.length > max ? "text-red-400" : "text-zinc-500"}`}>
              {text.length}/{max}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton name="mode" value="now" pendingText="Posting…" confirm={`Post this reply as ${item.account.handle} now?`}>
              Post reply now
            </SubmitButton>
            <input type="datetime-local" name="when" defaultValue={item.defaultWhen} className={inputInline} />
            <SubmitButton name="mode" value="schedule" className={btn.secondary} pendingText="Scheduling…">
              Schedule
            </SubmitButton>
          </div>
          <p className="text-xs text-zinc-500">Nothing is posted until you click Post or Schedule.</p>
        </ActionForm>
      )}

      <div className="mt-3 border-t border-zinc-800 pt-2">
        <ActionButton action={dismissInboxItem.bind(null, item.id)} className={btn.ghost}>
          Dismiss (no reply needed)
        </ActionButton>
      </div>
    </li>
  );
}
