"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { btn } from "./ui";

export function SignInButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      className={`${btn.primary} px-5 py-2.5 text-base`}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signIn.social({ provider: "google", callbackURL: "/dashboard", errorCallbackURL: "/?error=signin" });
      }}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
        <path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.64 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95S8.78 6.28 12 6.28c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.7 3.75 14.56 2.8 12 2.8 6.92 2.8 2.8 6.92 2.8 12s4.12 9.2 9.2 9.2c5.31 0 8.83-3.73 8.83-8.99 0-.6-.07-1.06-.15-1.51z" />
      </svg>
      {pending ? "Redirecting…" : "Sign in with Google"}
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className={`${btn.ghost} w-full justify-start`}
      onClick={async () => {
        await authClient.signOut();
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
