"use client";

import { useState } from "react";
import Link from "next/link";
import { PLUM, PLUM_TINT, BORDER } from "@/lib/tokens";

// Post-sign-in nudge (Arc V): if the signed-in teammate hasn't connected all
// their tools, prompt them to finish — one click each, from /settings. The
// server only passes a non-empty `missing` list when tools are unconnected, so
// this naturally shows on sign-in and disappears for good once everything's
// linked; dismiss hides it for the current view.
export default function ConnectBanner({ missing }: { missing: string[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || missing.length === 0) return null;

  const shown = missing.slice(0, 4).join(", ");
  const extra = missing.length > 4 ? `, +${missing.length - 4} more` : "";

  return (
    <div
      className="flex items-center gap-3 rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: PLUM_TINT }}
    >
      <span aria-hidden className="text-lg leading-none">🔌</span>
      <p className="min-w-0 flex-1 text-sm text-zinc-700">
        <span className="font-semibold" style={{ color: PLUM }}>Connect your tools.</span>{" "}
        Reddy can work your Gmail, Calendar, HubSpot and more on your behalf once you link them — you
        haven&apos;t connected {shown}{extra} yet. It&apos;s one click each.
      </p>
      <Link
        href="/settings"
        className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white no-underline"
        style={{ background: PLUM }}
      >
        Set up →
      </Link>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded-md px-1.5 py-1 text-sm text-zinc-400 hover:text-zinc-600"
      >
        ✕
      </button>
    </div>
  );
}
