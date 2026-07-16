import { inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { after } from "next/server";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { labeledMeetings } from "@/lib/meeting-accounts";
import { warmLabels } from "@/lib/company-resolver";
import { signedThumbUrl } from "@/lib/mux";
import AppShell from "@/app/AppShell";
import type { MeetingRowData } from "@/components/MeetingRow";
import MeetingsBrowser from "./MeetingsBrowser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const metadata: Metadata = { title: "Meetings" };

// /meetings — Daybreak Phase 4. Day-grouped, URL-filtered, thumbnailed.
// Data comes from the KV meeting index (fast path) via labeledMeetings;
// this page renders in well under a second in steady state.

const DAYS_CHOICES = [7, 30, 90, 365];
const LIMIT: Record<number, number> = { 7: 80, 30: 200, 90: 400, 365: 700 };


export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; account?: string; q?: string; video?: string; internal?: string }>;
}) {
  const sp = await searchParams;
  const days = DAYS_CHOICES.includes(Number(sp.days)) ? Number(sp.days) : 30;

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const { meetings, uncachedEvidence } = pat
    ? await labeledMeetings(pat, days, LIMIT[days])
    : { meetings: [], uncachedEvidence: [] };

  if (uncachedEvidence.length > 0) {
    after(async () => {
      await warmLabels(uncachedEvidence, {
        userEmail: process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io",
      }).catch(() => {});
    });
  }

  // Linked board tasks by meeting (sourceRef = botId).
  const botIds = meetings.map((m) => m.bot_id).filter(Boolean);
  const tasksByBot: Record<string, Array<{ id: string; title: string; status: string }>> = {};
  if (botIds.length) {
    const rows = await db
      .select({ id: workItems.id, title: workItems.title, status: workItems.status, sourceRef: workItems.sourceRef })
      .from(workItems)
      .where(inArray(workItems.sourceRef, botIds))
      .catch(() => [] as Array<{ id: string; title: string; status: string; sourceRef: string | null }>);
    for (const r of rows) {
      if (!r.sourceRef) continue;
      (tasksByBot[r.sourceRef] ??= []).push({ id: r.id, title: r.title, status: r.status });
    }
  }

  const rows: MeetingRowData[] = meetings.map((m) => ({
    botId: m.bot_id,
    title: m.title,
    slug: m.customer_slug,
    account: m.account,
    isInternal: m.isInternal,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    attendees: m.attendees.map((a) => a.name || a.email || "").filter(Boolean),
    hasTranscript: m.has_transcript,
    hasVideo: m.has_video,
    thumbUrl: signedThumbUrl(m.mux_playback_id),
    tasks: tasksByBot[m.bot_id] ?? [],
  }));

  return (
    <AppShell
      active="meetings"
      title="Meetings"
      subtitle="Every recorded meeting — filter, share, and ask across them."
    >
      <MeetingsBrowser
        rows={rows}
        days={days}
        initialAccount={sp.account}
        initialQ={sp.q}
        initialVideoOnly={sp.video === "1"}
        initialShowInternal={sp.internal === "1"}
        shareBase={process.env.PUBLIC_BASE_URL ?? "https://reddy-gtm.com"}
      />
    </AppShell>
  );
}
