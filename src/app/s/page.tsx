import Link from "next/link";
import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";
import { listSessions } from "@/lib/sessions";
import { fmtDayTimePT, dayKeyPT, fmtWeekdayPT } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import WelcomeGate from "@/app/WelcomeGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Sessions" };

// /s — your conversations, none of them lost (Daybreak Phase 8). Grouped by
// day, resumable with full history + snapshotted scope.

export default async function SessionsPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <WelcomeGate />;

  const sessions = await listSessions(viewer).catch(() => []);

  const byDay = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const k = dayKeyPT(s.updatedAt);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(s);
  }
  const groups = [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));

  return (
    <AppShell
      active="sessions"
      viewer={viewer}
      title="Sessions"
      subtitle="Every conversation you've had here — resume any of them."
      maxWidth="max-w-3xl"
    >
      <div className="flex flex-col gap-4">
        {groups.map(([day, list]) => (
          <section key={day}>
            <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {fmtWeekdayPT(list[0].updatedAt)}
            </h2>
            <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
              {list.map((s) => {
                const scope = s.scope as { label?: string; botIds?: string[] } | null;
                return (
                  <Link
                    key={s.id}
                    href={`/s/${s.id}`}
                    className="flex items-center gap-3 border-b px-4 py-2.5 no-underline last:border-b-0 hover:bg-zinc-50"
                    style={{ borderColor: "#F1EBF0" }}
                  >
                    <MessageSquareText size={14} className="shrink-0" style={{ color: PLUM }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">{s.title}</span>
                      <span className="block truncate text-xs text-zinc-500">
                        {fmtDayTimePT(s.updatedAt)}
                        {scope?.label && (
                          <>
                            {" · "}
                            <span className="rounded px-1 py-px text-[10.5px]" style={{ background: PLUM_TINT, color: PLUM }}>
                              {scope.label}
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
        {sessions.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-10 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
            No sessions yet — ask anything from the home page, ⌘K, or a meeting, and it&apos;ll be saved here.
          </p>
        )}
      </div>
    </AppShell>
  );
}
