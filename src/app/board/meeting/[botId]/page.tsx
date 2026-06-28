import Link from "next/link";
import { loadMeeting } from "@/lib/meeting-viewer";
import MeetingChat from "./MeetingChat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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

// Render the "Speaker: line" transcript with speaker names emphasized.
function TranscriptBody({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-zinc-700">
      {lines.map((line, i) => {
        const m = line.match(/^([^:]{1,40}):\s?(.*)$/);
        if (m) {
          return (
            <p key={i}>
              <span className="font-semibold" style={{ color: PLUM }}>{m[1]}:</span>{" "}
              <span>{m[2]}</span>
            </p>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        return <p key={i}>{line}</p>;
      })}
    </div>
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

  const backHref = from ? `/board/${from}` : "/board";
  const subtitle = [meeting.companyName, fmtPT(meeting.startedAt), meeting.platform]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-6xl">
        {/* breadcrumb */}
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400">
          <Link href={backHref} className="no-underline hover:underline" style={{ color: "#574B59" }}>
            {from ? "← Back to task" : "← Board"}
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
            {/* left: video + transcript */}
            <div className="flex flex-col gap-5 lg:col-span-3">
              {/* recording */}
              <section className="overflow-hidden rounded-xl border bg-black" style={{ borderColor: "#E4DCE3" }}>
                {meeting.video.kind === "mux" && meeting.video.url ? (
                  <iframe
                    src={meeting.video.url}
                    className="aspect-video w-full"
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                    title="Meeting recording"
                  />
                ) : meeting.video.kind === "lfs" && meeting.video.url ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={meeting.video.url} controls preload="metadata" className="aspect-video w-full bg-black" />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center bg-zinc-900 text-sm text-zinc-400">
                    No recording available for this meeting.
                  </div>
                )}
              </section>

              {/* transcript */}
              <section className="rounded-xl border bg-white" style={{ borderColor: "#E4DCE3" }}>
                <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
                  <span>📄</span>
                  <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Transcript</h2>
                </div>
                <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
                  {meeting.transcript ? (
                    <TranscriptBody text={meeting.transcript} />
                  ) : (
                    <p className="text-sm text-zinc-400">No transcript available for this meeting.</p>
                  )}
                </div>
              </section>
            </div>

            {/* right: chat */}
            <div className="lg:col-span-2">
              <div
                className="lg:sticky lg:top-7 flex h-[78vh] flex-col overflow-hidden rounded-xl border bg-white"
                style={{ borderColor: "#E4DCE3" }}
              >
                <MeetingChat botId={meeting.botId} />
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
