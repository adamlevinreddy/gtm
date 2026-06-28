import Link from "next/link";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { recentMeetingIndex } from "@/lib/recall-index";
import MeetingsHub, { type HubMeeting } from "./MeetingsHub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PLUM = "#773D72";

export default async function MeetingsPage() {
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const meetings = pat ? await recentMeetingIndex(pat, 30, 60).catch(() => []) : [];
  const botIds = meetings.map((m) => m.bot_id).filter(Boolean);

  // Tasks linked to these meetings (work_items.sourceRef = botId).
  const tasksByBot: Record<string, Array<{ id: string; title: string; status: string }>> = {};
  if (botIds.length) {
    const rows = await db
      .select({
        id: workItems.id,
        title: workItems.title,
        status: workItems.status,
        sourceRef: workItems.sourceRef,
      })
      .from(workItems)
      .where(inArray(workItems.sourceRef, botIds))
      .catch(() => [] as Array<{ id: string; title: string; status: string; sourceRef: string | null }>);
    for (const r of rows) {
      if (!r.sourceRef) continue;
      (tasksByBot[r.sourceRef] ??= []).push({ id: r.id, title: r.title, status: r.status });
    }
  }

  const data: HubMeeting[] = meetings.map((m) => ({
    botId: m.bot_id,
    title: m.title,
    slug: m.customer_slug,
    startedAt: m.started_at,
    platform: m.platform,
    attendees: m.attendees
      .map((a) => a.name || a.email || "")
      .filter((s): s is string => !!s),
    hasTranscript: m.has_transcript,
    hasVideo: m.has_video,
    tasks: tasksByBot[m.bot_id] ?? [],
  }));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-7xl">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg text-lg" style={{ background: "#F0E8EF" }}>
            🎥
          </div>
          <div className="mr-2">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Meetings</h1>
            <p className="text-sm text-zinc-500">
              Watch recordings, read transcripts, and chat across them. Last 30 days.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
            <Link
              href="/board"
              className="rounded-md px-2.5 py-1 text-sm font-medium text-zinc-600 no-underline hover:bg-zinc-50"
            >
              Boards
            </Link>
            <span
              className="rounded-md px-2.5 py-1 text-sm font-medium text-white"
              style={{ background: PLUM }}
            >
              Meetings
            </span>
          </div>
        </header>

        {data.length === 0 ? (
          <div className="rounded-xl border bg-white p-6 text-sm text-zinc-500" style={{ borderColor: "#E4DCE3" }}>
            No meetings found in the last 30 days.
          </div>
        ) : (
          <MeetingsHub meetings={data} />
        )}
      </div>
    </main>
  );
}
