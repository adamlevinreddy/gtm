"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, X } from "lucide-react";
import { PLUM, PLUM_TINT, BORDER, INK_2 } from "@/lib/tokens";

// "Active follow-ups" — the management view for conditional watches (Arc VIII
// P3). Owner-scoped: lists the viewer's pending watches with snooze/cancel.
// Arming happens elsewhere (a meeting card or chat); this is where you see and
// tend what's running.

type Watch = {
  id: string;
  account: string | null;
  note: string;
  signal: "no_reply" | "no_activity" | "time_only";
  checkAfter: number;
};

const SIGNAL_LABEL: Record<Watch["signal"], string> = {
  no_reply: "if no reply",
  no_activity: "if no activity",
  time_only: "reminder",
};

function fmtDayPT(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

export default function WatchesPanel() {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/watchers?status=pending", { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; watches?: Watch[] };
      setWatches(j.watches ?? []);
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, method: "PATCH" | "DELETE", qs: string) => {
      setBusy(id);
      try {
        await fetch(`/api/watchers?id=${encodeURIComponent(id)}${qs}`, { method });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-zinc-700">
        Your active follow-ups{watches.length ? ` (${watches.length})` : ""}
      </h2>
      {loading ? (
        <p className="rounded-xl border bg-white px-4 py-4 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
          Loading…
        </p>
      ) : watches.length === 0 ? (
        <p className="rounded-xl border bg-white px-4 py-4 text-sm text-zinc-400" style={{ borderColor: BORDER }}>
          Nothing armed. Set one up from a meeting card (&ldquo;⏰ Arm follow-up watch&rdquo;) or ask in chat — e.g. &ldquo;if I don&rsquo;t hear back from Nike by Monday, draft a follow-up and remind me.&rdquo;
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {watches.map((w) => (
            <div
              key={w.id}
              className="flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5"
              style={{ borderColor: BORDER }}
            >
              <Clock size={15} className="shrink-0" style={{ color: PLUM }} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">
                  {w.account || "—"}
                  <span
                    className="ml-1.5 rounded px-1 py-0.5 align-middle text-[10.5px] font-medium"
                    style={{ background: PLUM_TINT, color: PLUM }}
                  >
                    {SIGNAL_LABEL[w.signal]}
                  </span>
                </p>
                <p className="truncate text-xs" style={{ color: INK_2 }}>
                  {w.note ? `${w.note} · ` : ""}checks {fmtDayPT(w.checkAfter)}
                </p>
              </div>
              <button
                type="button"
                disabled={busy === w.id}
                onClick={() => act(w.id, "PATCH", "&days=3")}
                className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                style={{ borderColor: BORDER }}
              >
                {busy === w.id ? "…" : "🕒 Snooze 3d"}
              </button>
              <button
                type="button"
                disabled={busy === w.id}
                onClick={() => act(w.id, "DELETE", "")}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                style={{ borderColor: BORDER }}
                aria-label="Cancel this follow-up"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
