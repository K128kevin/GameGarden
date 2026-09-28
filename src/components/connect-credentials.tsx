"use client";

import { useState } from "react";
import { connectWithCredentials } from "@/app/actions";
import type { CredentialField } from "@/platforms/types";
import { ActionForm, SubmitButton } from "./forms";
import { btn, input, label } from "./ui";

export function ConnectCredentials({ platform, name, fields }: { platform: string; name: string; fields: CredentialField[] }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className={btn.primary} onClick={() => setOpen(true)}>
        Connect {name}
      </button>
    );
  return (
    <ActionForm action={connectWithCredentials.bind(null, platform)} className="space-y-3">
      {fields.map((f) => (
        <div key={f.name}>
          <label className={label} htmlFor={`${platform}-${f.name}`}>
            {f.label}
          </label>
          <input
            id={`${platform}-${f.name}`}
            name={f.name}
            type={f.type}
            placeholder={f.placeholder}
            required={f.required}
            className={input}
            autoComplete="off"
          />
          {f.help && <p className="mt-1 text-xs text-zinc-500">{f.help}</p>}
        </div>
      ))}
      <div className="flex gap-2">
        <SubmitButton pendingText="Connecting…">Connect</SubmitButton>
        <button type="button" className={btn.ghost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}
