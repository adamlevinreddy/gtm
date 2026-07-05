"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEAM_EMAILS } from "@/lib/team";
import { personName } from "./board/ui-shared";
import { PLUM, BORDER } from "@/lib/tokens";

// Blocking identity gate (Daybreak Phase 6 → Arc V). Until someone proves
// who they are, the app renders THIS instead of any page. With WorkOS SSO
// configured (`sso` prop) the only way in is a reddy.io Google sign-in;
// otherwise the honor-system picker applies.
export default function WelcomeGate({ sso = false }: { sso?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (email: string) => {
    setBusy(email);
    setError(null);
    try {
      const res = await fetch("/api/viewer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setError("Couldn't save that — try again.");
      setBusy(null);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white"
            style={{ background: PLUM }}
          >
            R
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Who&apos;s using Reddy?</h1>
            <p className="text-sm text-zinc-500">
              Your pick drives “my work”, notifications, and how your questions are attributed.
            </p>
          </div>
        </div>

        {sso ? (
          <div>
            <a
              href="/api/auth/login"
              className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white no-underline"
              style={{ background: PLUM }}
            >
              Continue with your Reddy Google account
            </a>
            <p className="mt-3 text-xs text-zinc-400">
              Sign-in is required — only @reddy.io accounts are allowed in.
            </p>
          </div>
        ) : (
        <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TEAM_EMAILS.map((email) => (
            <button
              key={email}
              type="button"
              disabled={!!busy}
              onClick={() => choose(email)}
              className="flex flex-col items-center gap-2 rounded-xl border bg-white px-4 py-5 transition-colors hover:border-zinc-300 disabled:opacity-50"
              style={{ borderColor: BORDER }}
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full text-base font-semibold text-white"
                style={{ background: busy === email ? "#9C6B97" : PLUM }}
              >
                {personName(email).charAt(0)}
              </span>
              <span className="text-sm font-medium text-zinc-800">
                {busy === email ? "…" : personName(email)}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!!busy}
          onClick={() => {
            const email = window.prompt("Your work email:");
            if (email && email.includes("@")) void choose(email.trim().toLowerCase());
          }}
          className="mt-3 w-full rounded-xl border border-dashed px-4 py-2.5 text-sm text-zinc-500 hover:text-zinc-700"
          style={{ borderColor: BORDER }}
        >
          Someone else…
        </button>
        </>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <p className="mt-8 text-xs text-zinc-400">
          New here? Once you&apos;re in, try asking the home page things like
          “what did we promise in our last customer call?” or “get me a shareable
          recording link for yesterday&apos;s meeting.”
        </p>
      </div>
    </main>
  );
}
