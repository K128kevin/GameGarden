"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions";
import { btn, Notice } from "./ui";

type FormAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** A form wired to a server action that returns {error|ok}, showing the result inline. */
export function ActionForm({
  action,
  children,
  className = "",
  resetOnSuccess = false,
  blockEnterSubmit = false,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Prevent Enter in a text input from implicitly submitting (for approval forms). */
  blockEnterSubmit?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onKeyDown={(e) => {
        if (blockEnterSubmit && e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
    >
      {children}
      {state?.error && (
        <div className="mt-3">
          <Notice kind="error">{state.error}</Notice>
        </div>
      )}
      {state?.ok && (
        <div className="mt-3">
          <Notice kind="ok">{state.ok}</Notice>
        </div>
      )}
    </form>
  );
}

export function SubmitButton({
  children,
  pendingText,
  className = btn.primary,
  name,
  value,
  confirm: confirmText,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  name?: string;
  value?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}

/** Button that invokes a no-arg server action (already bound) and shows the result. */
export function ActionButton({
  action,
  children,
  pendingText,
  className = btn.secondary,
  confirm: confirmText,
}: {
  action: () => Promise<ActionState | void>;
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={className}
        onClick={() => {
          if (confirmText && !window.confirm(confirmText)) return;
          start(async () => setState((await action()) ?? null));
        }}
      >
        {pending ? (pendingText ?? "Working…") : children}
      </button>
      {state?.error && <span className="max-w-md text-xs text-red-300">{state.error}</span>}
      {state?.ok && <span className="text-xs text-emerald-300">{state.ok}</span>}
    </span>
  );
}
