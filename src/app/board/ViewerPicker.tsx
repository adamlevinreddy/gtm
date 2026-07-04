"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEAM_EMAILS, VIEWER_COOKIE } from "@/lib/team";
import { personName } from "./ui-shared";

// Identity selector. Until this shipped, NOTHING ever wrote the
// board_viewer cookie, so every teammate browsed as the default viewer
// (adam@) — "My work" showed Adam's tasks for everyone and chat/task
// actions were attributed to him. One pick persists for a year.
export default function ViewerPicker({ viewer }: { viewer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const setViewer = (email: string) => {
    if (!email || email === viewer) return;
    setBusy(true);
    document.cookie = `${VIEWER_COOKIE}=${encodeURIComponent(email)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
    // refresh() keeps the component mounted; drop the busy flag shortly after.
    setTimeout(() => setBusy(false), 800);
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
            if (email && email.includes("@")) setViewer(email.trim().toLowerCase());
          } else {
            setViewer(e.target.value);
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
