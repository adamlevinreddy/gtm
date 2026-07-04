import { inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { after } from "next/server";
import { recentMeetingIndex, deriveAccountLabel } from "@/lib/recall-index";
import { readCachedLabels, warmLabels, type LabelEvidence, type ResolvedCompany } from "@/lib/company-resolver";
import AppShell from "@/app/AppShell";
import MeetingsHub, { type HubMeeting } from "./MeetingsHub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Render returns fast (canon = cache reads only); the background warm runs in
// after() within this budget.
export const maxDuration = 300;

export const metadata: Metadata = { title: "Meetings" };

const DAYS_LIMIT: Record<number, number> = { 30: 120, 90: 350, 365: 700 };

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; account?: string }>;
}) {
  const { days: daysRaw, account } = await searchParams;
  const days = [30, 90, 365].includes(Number(daysRaw)) ? Number(daysRaw) : 30;
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const meetings = pat ? await recentMeetingIndex(pat, days, DAYS_LIMIT[days]).catch(() => []) : [];
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

  // Canon: resolve the messy heuristic label → a canonical HubSpot company,
  // over DISTINCT labels only (cheap; KV-cached; bot for the hard tail). Falls
  // back to the raw label if resolution is unavailable, so the hub never regresses.
  // reddy.io excluded — our own domain resolving as "the customer" mislabeled
  // meetings as Reddy (see company-resolver guardOwnCompany).
  const FREE_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "reddy.io"]);
  const rawByBot = new Map<string, string>();
  const evidence = new Map<string, LabelEvidence>();
  for (const m of meetings) {
    const raw = deriveAccountLabel(m.title, m.customer_slug);
    rawByBot.set(m.bot_id, raw);
    const e = evidence.get(raw) ?? { rawLabel: raw, sampleTitles: [], emailDomains: [], slugs: [] };
    if (m.title && e.sampleTitles.length < 3 && !e.sampleTitles.includes(m.title)) e.sampleTitles.push(m.title);
    for (const a of m.attendees) {
      const d = a.email?.split("@")[1]?.toLowerCase();
      if (d && !FREE_DOMAINS.has(d) && !e.emailDomains.includes(d)) e.emailDomains.push(d);
    }
    if (!e.slugs.includes(m.customer_slug)) e.slugs.push(m.customer_slug);
    evidence.set(raw, e);
  }
  // Render: read the canon cache only (fast). Warm uncached labels in the
  // background so the NEXT render is canonical — never block the page on
  // HubSpot/bot resolution.
  const allEvidence = [...evidence.values()];
  const resolved = await readCachedLabels(allEvidence).catch(() => new Map<string, ResolvedCompany>());
  const uncached = allEvidence.filter((e) => !resolved.has(e.rawLabel));
  if (uncached.length > 0) {
    after(async () => {
      await warmLabels(uncached, {
        userEmail: process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io",
      }).catch(() => {});
    });
  }

  const data: HubMeeting[] = meetings.map((m) => {
    const raw = rawByBot.get(m.bot_id) ?? deriveAccountLabel(m.title, m.customer_slug);
    const r = resolved.get(raw);
    return {
      botId: m.bot_id,
      title: m.title,
      slug: m.customer_slug,
      account: r?.canonical ?? raw,
      hubspotCompanyId: r?.hubspotCompanyId ?? null,
      startedAt: m.started_at,
      platform: m.platform,
      attendees: m.attendees
        .map((a) => a.name || a.email || "")
        .filter((s): s is string => !!s),
      hasTranscript: m.has_transcript,
      hasVideo: m.has_video,
      tasks: tasksByBot[m.bot_id] ?? [],
    };
  });

  return (
    <AppShell
      active="meetings"
      title="Meetings"
      subtitle="Watch recordings, read transcripts, and chat across them."
    >
      <MeetingsHub meetings={data} days={days} initialAccount={account} />
    </AppShell>
  );
}
