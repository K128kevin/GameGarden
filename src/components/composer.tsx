"use client";

import { useState } from "react";
import { composePost } from "@/app/actions";
import type { PlatformCapabilities } from "@/platforms/types";
import { ActionForm, SubmitButton } from "./forms";
import { btn, input, label } from "./ui";

type AcctOpt = { id: string; label: string; capabilities: PlatformCapabilities };

export function Composer({ accounts, games, defaultWhen }: { accounts: AcctOpt[]; games: { id: string; name: string }[]; defaultWhen: string }) {
  const postable = accounts.filter((a) => a.capabilities.post);
  const [accountId, setAccountId] = useState(postable[0]?.id ?? "");
  const [text, setText] = useState("");
  const acct = postable.find((a) => a.id === accountId);
  const caps = acct?.capabilities;
  if (!postable.length) return <p className="text-sm text-zinc-400">Connect an account that supports posting (Bluesky or Reddit) first.</p>;
  return (
    <ActionForm action={composePost} className="space-y-4" blockEnterSubmit resetOnSuccess>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label}>Account</label>
          <select name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={input}>
            {postable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Game (optional — links the post)</label>
          <select name="gameId" defaultValue="" className={input}>
            <option value="">—</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {caps?.requiresCommunity && (
        <div>
          <label className={label}>{caps.communityLabel ?? "Community"}</label>
          <input name="community" placeholder="IndieDev" className={input} required />
        </div>
      )}
      {caps?.requiresTitle && (
        <div>
          <label className={label}>Title</label>
          <input name="title" className={input} required />
        </div>
      )}
      <div>
        <label className={label}>Text</label>
        <textarea name="text" rows={6} value={text} onChange={(e) => setText(e.target.value)} className={input} />
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>{caps?.notes}</span>
          {caps?.maxLength && <span className={text.length > caps.maxLength ? "text-red-400" : ""}>{text.length}/{caps.maxLength}</span>}
        </div>
      </div>
      <div>
        <label className={label}>Link (optional)</label>
        <input name="link" type="url" placeholder="https://store.steampowered.com/app/…" className={input} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className={label}>Schedule for</label>
          <input type="datetime-local" name="when" defaultValue={defaultWhen} className={`${input} w-auto`} />
        </div>
        <SubmitButton name="mode" value="schedule" pendingText="Scheduling…">
          Schedule
        </SubmitButton>
        <SubmitButton name="mode" value="now" className={btn.secondary} pendingText="Posting…" confirm="Post this right now?">
          Post now
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
