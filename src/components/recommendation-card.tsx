"use client";

import { useActionState, useState } from "react";
import {
  approveRecommendation,
  followFromRecommendation,
  regenerateRecommendationAction,
  setRecommendationStatus,
  type RegenerateState,
} from "@/app/actions";
import type { PlatformCapabilities } from "@/platforms/types";
import { ActionButton, ActionForm, SubmitButton } from "./forms";
import { btn, input, inputInline, Notice } from "./ui";

export type RecView = {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  draftText: string | null;
  draftTitle: string | null;
  community: string | null;
  link: string | null;
  priority: string;
  status: string;
  userNote: string | null;
  suggestedLabel: string | null;
  suggestedLocal: string | null;
  suggestedInPast: boolean;
  target: { url?: string | null; author?: string | null; excerpt?: string | null; community?: string | null } | null;
  account: { platform: string; platformName: string; badgeClass: string; handle: string; capabilities: PlatformCapabilities } | null;
  gameName?: string | null;
  /** The reply's target can be liked from GameGarden. */
  likeable: boolean;
  /** The target's author can be followed from GameGarden. */
  followable: boolean;
  followLabel: string;
};

const kindLabel: Record<string, string> = {
  post: "New post",
  reply: "Reply",
  follow: "Follow",
  engage: "Engage",
  content: "Create content",
  profile: "Profile",
  other: "Task",
};

const priorityClass: Record<string, string> = {
  high: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  medium: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  low: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
};

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}>{children}</span>;
}

export function RecommendationCard({ rec }: { rec: RecView }) {
  const publishable = (rec.kind === "post" || rec.kind === "reply") && rec.account != null;
  const open = rec.status === "pending" || rec.status === "failed" || rec.status === "expired";
  const [text, setText] = useState(rec.draftText ?? "");
  const [title, setTitle] = useState(rec.draftTitle ?? "");
  const [regen, regenAction, regenerating] = useActionState<RegenerateState, FormData>(
    regenerateRecommendationAction.bind(null, rec.id),
    null,
  );
  const [adopted, setAdopted] = useState<RegenerateState>(null);
  // Adopt a freshly regenerated draft into the editor (once per result).
  if (regen?.draft && regen !== adopted) {
    setAdopted(regen);
    setText(regen.draft);
    if (regen.title) setTitle(regen.title);
  }
  const canRegenerate = open && rec.kind !== "follow" && (Boolean(rec.draftText) || publishable);
  const [showTime, setShowTime] = useState(false);
  const [showDismiss, setShowDismiss] = useState(false);
  const [copied, setCopied] = useState(false);
  const max = rec.account?.capabilities.maxLength;
  const needsTitle = rec.kind === "post" && rec.account?.capabilities.requiresTitle;
  const needsCommunity = rec.kind === "post" && rec.account?.capabilities.requiresCommunity;

  return (
    <div className={`rounded-xl border bg-zinc-900/60 p-4 ${open ? "border-zinc-800" : "border-zinc-800/60 opacity-75"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={priorityClass[rec.priority] ?? priorityClass.low}>{rec.priority}</Pill>
        <Pill className="bg-zinc-800 text-zinc-200 ring-zinc-700">{kindLabel[rec.kind] ?? rec.kind}</Pill>
        {rec.account && (
          <Pill className={rec.account.badgeClass}>
            {rec.account.platformName} · {rec.account.handle}
          </Pill>
        )}
        {rec.gameName && <Pill className="bg-violet-500/15 text-violet-300 ring-violet-500/30">{rec.gameName}</Pill>}
        {!open && <Pill className="bg-zinc-800 text-zinc-300 ring-zinc-700">{rec.status}</Pill>}
        {rec.suggestedLabel && (
          <span className={`ml-auto text-xs ${rec.suggestedInPast ? "text-zinc-500" : "text-zinc-400"}`}>
            Suggested: <span className="text-zinc-200">{rec.suggestedLabel}</span>
          </span>
        )}
      </div>

      <h3 className="mt-2 font-medium text-zinc-50">{rec.title}</h3>
      {rec.rationale && <p className="mt-1 text-sm text-zinc-400">{rec.rationale}</p>}

      {rec.target && (
        <div className="mt-3 rounded-md border-l-2 border-zinc-600 bg-zinc-950/50 px-3 py-2 text-sm">
          <div className="text-xs text-zinc-500">
            {rec.kind === "follow" ? "From a post by " : "Replying to "}
            {rec.target.author ? `@${rec.target.author}` : "post"}
            {rec.target.community ? ` in r/${rec.target.community}` : ""} ·{" "}
            {rec.target.url && (
              <a href={rec.target.url} target="_blank" rel="noreferrer" className="text-emerald-300 hover:underline">
                open
              </a>
            )}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-zinc-300">{rec.target.excerpt}</p>
        </div>
      )}

      {rec.kind === "follow" && open && rec.followable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ActionButton
            action={followFromRecommendation.bind(null, rec.id)}
            className={btn.primary}
            pendingText={`${rec.followLabel === "Subscribe" ? "Subscribing" : "Following"}…`}
          >
            {rec.followLabel} {rec.target?.author ? `@${rec.target.author}` : ""}
          </ActionButton>
          <span className="text-xs text-zinc-500">One click follows them from {rec.account?.handle}.</span>
        </div>
      )}

      {canRegenerate && (
        <form action={regenAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="current" value={text} />
          <input
            name="note"
            placeholder="Optional note, e.g. shorter, mention the demo, less formal"
            className={`${input} min-w-48 flex-1`}
          />
          <button type="submit" disabled={regenerating} className={btn.secondary}>
            {regenerating ? "Regenerating…" : "Regenerate with Haiku"}
          </button>
        </form>
      )}
      {regen?.error && (
        <div className="mt-2">
          <Notice kind="error">{regen.error}</Notice>
        </div>
      )}

      {publishable && open ? (
        <ActionForm action={approveRecommendation.bind(null, rec.id)} className="mt-3 space-y-2" blockEnterSubmit>
          {needsCommunity && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-500">r/</span>
              <input name="community" defaultValue={rec.community ?? ""} placeholder="subreddit" className={input} required />
            </div>
          )}
          {(needsTitle || rec.draftTitle) && (
            <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={input} required={needsTitle} />
          )}
          <textarea
            name="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(12, Math.max(3, Math.ceil(text.length / 70)))}
            className={`${input} font-[450] leading-relaxed`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {rec.link && (
                <>
                  Link appended: <span className="text-zinc-300">{rec.link}</span>
                </>
              )}
            </span>
            {max && (
              <span className={text.length > max ? "text-red-400" : ""}>
                {text.length}/{max}
              </span>
            )}
          </div>
          {rec.kind === "reply" && (rec.likeable || rec.followable) && (
            <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
              {rec.likeable && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="alsoLike" className="h-4 w-4 accent-emerald-500" /> Also like their post
                </label>
              )}
              {rec.followable && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="alsoFollow" className="h-4 w-4 accent-emerald-500" /> Also {rec.followLabel.toLowerCase()}{" "}
                  {rec.target?.author ? `@${rec.target.author}` : "them"}
                </label>
              )}
              <span className="text-xs text-zinc-500">Done together with the reply, when it posts.</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {rec.suggestedLabel && !rec.suggestedInPast && (
              <SubmitButton name="mode" value="schedule" pendingText="Scheduling…">
                Schedule for {rec.suggestedLabel}
              </SubmitButton>
            )}
            <SubmitButton
              name="mode"
              value="now"
              className={rec.suggestedLabel && !rec.suggestedInPast ? btn.secondary : btn.primary}
              pendingText="Posting…"
              confirm={`Post this to ${rec.account!.platformName} as ${rec.account!.handle} right now?`}
            >
              Post now
            </SubmitButton>
            <button type="button" className={btn.ghost} onClick={() => setShowTime((v) => !v)}>
              Pick another time
            </button>
          </div>
          {showTime && (
            <div className="flex flex-wrap items-center gap-2">
              <input type="datetime-local" name="when" defaultValue={rec.suggestedLocal ?? ""} className={inputInline} />
              <SubmitButton name="mode" value="schedule_custom" className={btn.secondary} pendingText="Scheduling…">
                Schedule at this time
              </SubmitButton>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            Clicking Schedule or Post now is your approval. Nothing is published otherwise.
          </p>
        </ActionForm>
      ) : (
        rec.draftText && (
          <div className="mt-3">
            {(title || rec.draftTitle) && <div className="mb-1 text-sm font-medium text-zinc-200">{title || rec.draftTitle}</div>}
            <div className="whitespace-pre-wrap rounded-md bg-zinc-950/60 p-3 text-sm text-zinc-300">{text || rec.draftText}</div>
            <button
              type="button"
              className={`${btn.ghost} mt-1 text-xs`}
              onClick={async () => {
                await navigator.clipboard.writeText([title || rec.draftTitle, text || rec.draftText].filter(Boolean).join("\n\n"));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied!" : "Copy text"}
            </button>
          </div>
        )
      )}

      {rec.userNote && <p className="mt-2 text-xs text-zinc-500">Note: {rec.userNote}</p>}

      <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-zinc-800 pt-3">
        <ActionForm action={setRecommendationStatus.bind(null, rec.id)}>
          {open ? (
            <SubmitButton name="status" value="done" className={btn.ghost} pendingText="…">
              ✓ I did this
            </SubmitButton>
          ) : rec.status === "dismissed" || rec.status === "done" ? (
            <SubmitButton name="status" value="pending" className={btn.ghost} pendingText="…">
              Restore
            </SubmitButton>
          ) : null}
        </ActionForm>
        {open && !showDismiss && (
          <button type="button" className={btn.ghost} onClick={() => setShowDismiss(true)}>
            Dismiss
          </button>
        )}
        {open && showDismiss && (
          <ActionForm action={setRecommendationStatus.bind(null, rec.id)} className="flex flex-1 flex-wrap items-center gap-2">
            <input type="hidden" name="status" value="dismissed" />
            <input name="note" placeholder="Why? (optional, the planner learns from this)" className={`${input} flex-1`} autoFocus />
            <SubmitButton className={btn.secondary} pendingText="…">
              Dismiss
            </SubmitButton>
          </ActionForm>
        )}
      </div>
    </div>
  );
}
