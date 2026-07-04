import Link from "next/link";
import { loadMeeting } from "@/lib/meeting-viewer";
import AppShell from "@/app/AppShell";
import MeetingChatStream from "../MeetingChatStream";
import MeetingPlayerAndTranscript from "./MeetingPlayerAndTranscript";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const metadata = { title: "Meeting" };

const PLUM = "#773D72";

function fmtPT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(d) + " PT"
  );
}

export default async function MeetingViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ botId: string }>;
  searchParams: Promise<{ from?: string; customer?: string }>;
}) {
  const { botId } = await params;
  const { from, customer } = await searchParams;
  const meeting = await loadMeeting(botId, { customerHint: customer ?? null });

  const backHref = from ? `/board/${from}` : "/board/meetings";
  const subtitle = [meeting.companyName, fmtPT(meeting.startedAt), meeting.platform]
    .filter(Boolean)
    .join(" · ");

  return (
    <AppShell active="meetings" maxWidth="max-w-6xl">
        {/* breadcrumb */}
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400">
          <Link href={backHref} className="no-underline hover:underline" style={{ color: "#574B59" }}>
            {from ? "← Back to task" : "← All meetings"}
          </Link>
        </nav>

        {/* header */}
        <header className="rounded-xl border bg-white p-5" style={{ borderColor: "#E4DCE3" }}>
          <div className="flex items-center gap-2">
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: "#F0E8EF", color: PLUM }}>
              🎥 Meeting
            </span>
            {meeting.slug && meeting.slug !== "_unsorted" && (
              <span className="text-xs text-zinc-500">{meeting.slug}</span>
            )}
          </div>
          <h1 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-zinc-900">{meeting.title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
          {meeting.attendees.length > 0 && (
            <p className="mt-1 text-sm text-zinc-500">
              {meeting.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ")}
            </p>
          )}
        </header>

        {!meeting.found && (
          <div className="mt-5 rounded-xl border bg-white p-6 text-sm text-zinc-500" style={{ borderColor: "#E4DCE3" }}>
            Couldn&apos;t find this meeting in the knowledge base yet. It may still be processing — try again shortly.
          </div>
        )}

        {meeting.found && (
          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-5">
            {/* left: video + clickable transcript (shared player ref → seek) */}
            <div className="flex flex-col gap-5 lg:col-span-3">
              <MeetingPlayerAndTranscript
                video={meeting.video}
                timed={meeting.timedTranscript}
                fallback={meeting.transcript}
              />
            </div>

            {/* right: chat */}
            <div className="lg:col-span-2">
              <div
                className="lg:sticky lg:top-7 flex h-[78vh] flex-col overflow-hidden rounded-xl border bg-white"
                style={{ borderColor: "#E4DCE3" }}
              >
                <MeetingChatStream
                  botIds={[meeting.botId]}
                  starters={[
                    "Summarize this meeting",
                    "What are the action items and who owns them?",
                    "What objections or concerns came up?",
                    "What did we commit to?",
                  ]}
                  placeholder="Ask about this meeting…"
                />
              </div>
            </div>
          </div>
        )}
    </AppShell>
  );
}
