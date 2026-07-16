import Link from "next/link";
import type { Metadata } from "next";
import { Video, ListChecks } from "lucide-react";
import { readBrief } from "@/lib/brief";
import { fmtTimePT, fmtDayPT, fmtWeekdayPT } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER, BORDER_SOFT, WARN } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import { personName } from "@/app/board/ui-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Your brief" };

// /brief — the Standing Brief (Daybreak P12): your morning prep, precomputed
// at 7am PT. One prep card per meeting on YOUR calendar today: last time we
// met like this (with the recording), and the open commitments for that
// account. One KV read; a missed cron degrades to yesterday's with a badge.

export default async function BriefPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;

  const found = await readBrief(viewer);

  return (
    <AppShell
      active="home"
      viewer={viewer}
      title={`${personName(viewer).split(" ")[0]}'s brief`}
      subtitle={
        found
          ? `Prepared ${fmtWeekdayPT(found.brief.generatedAt)} at ${fmtTimePT(found.brief.generatedAt)} PT · ${found.brief.openTaskCount} open task${found.brief.openTaskCount === 1 ? "" : "s"} on you`
          : "Prepared every weekday at 7am PT."
      }
      maxWidth="max-w-3xl"
      actions={
        found?.stale ? (
          <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ background: "#FCF3E7", color: WARN }}>
            YESTERDAY&apos;S — today&apos;s hasn&apos;t generated yet
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {found?.brief.items.map((item, i) => (
          <section key={i} className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
            <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
              <span className="text-sm font-semibold text-zinc-900">{item.eventTitle}</span>
              <span className="ml-auto text-xs tabular-nums text-zinc-500">{fmtTimePT(item.startTime)} PT</span>
            </div>
            <div className="flex flex-col gap-2 px-4 py-3">
              {item.lastMeeting ? (
                <Link
                  href={`/m/${item.lastMeeting.botId}`}
                  className="flex items-center gap-2 text-sm no-underline hover:underline"
                  style={{ color: PLUM }}
                >
                  <Video size={13} />
                  Last time: {item.lastMeeting.title ?? "recorded meeting"} · {fmtDayPT(item.lastMeeting.startedAt)}
                </Link>
              ) : (
                <p className="text-sm text-zinc-400">First recorded meeting of this kind.</p>
              )}
              {item.openTasks.length > 0 && (
                <div className="flex flex-col gap-1">
                  {item.openTasks.map((t) => (
                    <Link key={t.id} href={`/board/${t.id}`} className="flex items-center gap-2 text-sm text-zinc-700 no-underline hover:underline">
                      <ListChecks size={13} className="text-zinc-400" />
                      {t.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        ))}

        {found && found.brief.items.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-10 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
            Nothing with a join link on your calendar today. Enjoy the focus time.
          </p>
        )}

        {!found && (
          <div className="rounded-xl border bg-white px-4 py-10 text-center" style={{ borderColor: BORDER }}>
            <p className="text-sm text-zinc-500">No brief yet — the first one generates tomorrow at 7am PT.</p>
            <p className="mt-1 text-xs text-zinc-400">
              Briefs cover meetings on your calendar where you&apos;re an invitee ({viewer}).
            </p>
          </div>
        )}

        <p className="px-1 text-xs text-zinc-400">
          <span className="rounded px-1 py-px" style={{ background: PLUM_TINT, color: PLUM }}>How it works</span>{" "}
          Built every weekday at 7am PT from your calendar, the meeting archive, and the board — no waiting on the assistant.
        </p>
      </div>
    </AppShell>
  );
}
