"use client";

import { useState } from "react";
import { cancelScheduled, retryScheduled, updateScheduled } from "@/app/actions";
import { ActionButton, ActionForm, SubmitButton } from "./forms";
import { btn, input } from "./ui";

export function ScheduledControls({
  id,
  status,
  text,
  title,
  whenLocal,
}: {
  id: string;
  status: string;
  text: string;
  title: string | null;
  whenLocal: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && status === "scheduled") {
    return (
      <ActionForm action={updateScheduled.bind(null, id)} className="mt-3 space-y-2" blockEnterSubmit>
        {title != null && <input name="title" defaultValue={title} className={input} />}
        <textarea name="text" defaultValue={text} rows={4} className={input} />
        <div className="flex flex-wrap items-center gap-2">
          <input type="datetime-local" name="when" defaultValue={whenLocal} className={`${input} w-auto`} />
          <SubmitButton pendingText="Saving…">Save &amp; approve changes</SubmitButton>
          <button type="button" className={btn.ghost} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </ActionForm>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {status === "scheduled" && (
        <button className={btn.ghost} onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      {status === "failed" && (
        <ActionButton action={retryScheduled.bind(null, id)} className={btn.secondary} pendingText="Posting…" confirm="Retry posting this now?">
          Retry now
        </ActionButton>
      )}
      {(status === "scheduled" || status === "failed") && (
        <ActionButton action={cancelScheduled.bind(null, id)} className={btn.ghost} confirm="Cancel this scheduled item?">
          Cancel
        </ActionButton>
      )}
    </div>
  );
}
