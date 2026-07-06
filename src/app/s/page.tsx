import Link from "next/link";
import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";
import { listSessions } from "@/lib/sessions";
import { fmtDayTimePT, dayKeyPT, fmtWeekdayPT } from "@/lib/fmt";
import { rangeSinceMs, CHANNELS } from "@/lib/view-filters";
import { TEAM_EMAILS } from "@/lib/team";
import { personName } from "@/app/board/ui-shared";
import { PLUM, PLUM_TINT, BORDER } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import FilterBar from "@/components/FilterBar";
import NewSessionButton from "./NewSessionButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Sessions" };

// /s — the team's conversations, none of them lost (Daybreak P8 + Arc VI team
// visibility). Sales is a team sport: this shows EVERYONE'S sessions by default,
// filterable by person, time range, channel, and text via the shared FilterBar.

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ who?: string; when?: string; channel?: string; q?: string }>;
}) {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;
  const sp = await searchParams;

  const owner = sp.who && sp.who !== "all" ? sp.who : undefined;
  const sinceMs = rangeSinceMs(sp.when) ?? undefined;
  const channel = sp.channel || "all";
  const q = (sp.q || "").trim().toLowerCase();

  const all = await listSessions({ owner, sinceMs }).catch(() => []);
  const sessions = all.filter((s) => {
    const scope = s.scope as { label?: string; source?: string } | null;
    const src =
      scope?.source === "slack"
        ? "slack"
        : scope?.source === "email"
          ? "email"
          : scope?.source === "play"
            ? "play"
            : "web";
    if (channel !== "all" && src !== channel) return false;
    if (q && !`${s.title} ${scope?.label ?? ""} ${personName(s.viewer)}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const byDay = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const k = dayKeyPT(s.updatedAt);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(s);
  }
  const groups = [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));

  const people = [
    { value: "all", label: "Everyone" },
    ...TEAM_EMAILS.map((e) => ({ value: e, label: personName(e) })),
  ];

  return (
    <AppShell
      active="sessions"
      viewer={viewer}
      title="Sessions"
      subtitle="Every conversation the team has had here — across the web app, Slack, and email."
      maxWidth="max-w-3xl"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <NewSessionButton />
          <FilterBar
            people={people}
            viewer={viewer}
            timeRange
            channels={[...CHANNELS]}
            search
            searchPlaceholder="Search sessions…"
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {groups.map(([day, list]) => (
          <section key={day}>
            <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {fmtWeekdayPT(list[0].updatedAt)}
            </h2>
            <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
              {list.map((s) => {
                const scope = s.scope as { label?: string; botIds?: string[]; source?: string } | null;
                const source = scope?.source === "slack" ? "Slack" : scope?.source === "email" ? "Email" : null;
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
                        <span className="font-medium text-zinc-600">{personName(s.viewer)}</span>
                        {" · "}
                        {fmtDayTimePT(s.updatedAt)}
                        {source && (
                          <>
                            {" · "}
                            <span className="rounded px-1 py-px text-[10.5px] font-medium" style={{ background: "#EAF0F5", color: "#3A6B8C" }}>
                              from {source}
                            </span>
                          </>
                        )}
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
            No sessions match these filters.
          </p>
        )}
      </div>
    </AppShell>
  );
}
