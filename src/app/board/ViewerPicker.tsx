"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEAM_EMAILS } from "@/lib/team";
import { personName } from "./ui-shared";

// Header identity selector. Posts to /api/viewer, which sets the SIGNED
// httpOnly cookie (Daybreak Phase 6) — client JS never writes identity.
export default function ViewerPicker({ viewer }: { viewer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const setViewer = async (email: string) => {
    if (!email || email === viewer) return;
    setBusy(true);
    try {
      await fetch("/api/viewer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      router.refresh();
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  };

  const options: string[] = TEAM_EMAILS.includes(viewer as (typeof TEAM_EMAILS)[number])
    ? [...TEAM_EMAILS]
    : [viewer, ...TEAM_EMAILS];

  return (
    <label className="relative inline-flex items-center gap-1.5" title="Who's using this browser — drives My Work, notifications, and how your questions are attributed">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ background: "#773D72" }}
        aria-hidden
      >
        {personName(viewer).charAt(0)}
      </span>
      <select
        aria-label="I am"
        value={viewer}
        disabled={busy}
        onChange={(e) => {
          if (e.target.value === "__other__") {
            const email = window.prompt("Your work email:");
            if (email && email.includes("@")) void setViewer(email.trim().toLowerCase());
          } else {
            void setViewer(e.target.value);
          }
        }}
        className="cursor-pointer appearance-none rounded-md border border-zinc-200 bg-white py-1 pl-2 pr-6 text-xs font-medium text-zinc-700"
      >
        {options.map((e) => (
          <option key={e} value={e}>
            {personName(e)}
          </option>
        ))}
        <option value="__other__">Someone else…</option>
      </select>
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-zinc-400" aria-hidden>
        ▼
      </span>
    </label>
  );
}
