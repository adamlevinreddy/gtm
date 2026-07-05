import Link from "next/link";
import { Link2, Video } from "lucide-react";
import { loadMeeting } from "@/lib/meeting-viewer";
import { fmtDayTimePT, fmtDuration } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER } from "@/lib/tokens";
import AppShell from "@/app/AppShell";
import MeetingChatStream from "@/components/MeetingChatStream";
import CopyButton from "@/components/CopyButton";
import MeetingPlayerAndTranscript from "./MeetingPlayerAndTranscript";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const metadata = { title: "Meeting" };

// /m/{botId} — the canonical meeting permalink (Daybreak Phase 2).
// The URL carries only {botId, t}; Mux playback tokens are minted fresh on
// every view, so a copied link can never expire. ?t=SECONDS auto-seeks.

export default async function MeetingViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ botId: string }>;
  searchParams: Promise<{ from?: string; customer?: string; t?: string }>;
}) {
  const { botId } = await params;
  const { from, customer, t } = await searchParams;
  const meeting = await loadMeeting(botId, { customerHint: customer ?? null });

  const initialT = t && Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : null;
  const backHref = from ? `/board/${from}` : "/board/meetings";
  const duration = fmtDuration(meeting.startedAt, meeting.endedAt);
  const subtitle = [meeting.companyName, fmtDayTimePT(meeting.startedAt), duration, meeting.platform]
    .filter(Boolean)
    .join(" · ");
  const base = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const shareUrl = `${base}/m/${botId}`;

  return (
    <AppShell active="meetings" maxWidth="max-w-6xl">
        {/* breadcrumb */}
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400">
          <Link href={backHref} className="no-underline hover:underline" style={{ color: "#574B59" }}>
            {from ? "← Back to task" : "← All meetings"}
          </Link>
        </nav>

        {/* header */}
        <header className="rounded-xl border bg-white p-5" style={{ borderColor: BORDER }}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: PLUM_TINT, color: PLUM }}
            >
              <Video size={11} /> Meeting
            </span>
            {meeting.slug && meeting.slug !== "_unsorted" && (
              <span className="text-xs text-zinc-500">{meeting.slug}</span>
            )}
            <div className="ml-auto">
              <CopyButton
                text={shareUrl}
                label="Copy share link"
                icon={<Link2 size={13} />}
                title="Anyone on the team can open this — playback tokens are minted per view, so the link never expires"
              />
            </div>
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
          <div className="mt-5 rounded-xl border bg-white p-6 text-sm text-zinc-500" style={{ borderColor: BORDER }}>
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
                initialT={initialT}
                shareUrl={shareUrl}
              />
            </div>

            {/* right: chat */}
            <div className="lg:col-span-2">
              <div
                className="flex h-[78vh] flex-col overflow-hidden rounded-xl border bg-white lg:sticky lg:top-[calc(var(--header-h)+16px)]"
                style={{ borderColor: BORDER }}
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
