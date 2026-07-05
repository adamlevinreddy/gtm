// The Standing Brief (Daybreak Phase 12) — a per-person morning prep page,
// precomputed by the 7am cron from data we already have: today's meetings
// (from the connected calendars), the last recorded meeting that looks like
// the same series/account, and open board commitments. Zero agent calls;
// reading it is one KV get. If the cron missed, the page degrades to
// yesterday's brief with a stale badge — never a spinner.

import { kv } from "@/lib/kv-client";
import { TEAM_EMAILS } from "@/lib/team";
import { listAllCalendars, listCalendarEventsByStart, type CalendarEvent } from "@/lib/recall-calendar-v2";
import { readMeetingIndex, type MeetingIndexRow } from "@/lib/meeting-index";
import { dayKeyPT, ptStartOfDayMs } from "@/lib/fmt";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { inArray, and, eq } from "drizzle-orm";
import { OPEN_STATUSES } from "@/lib/work-items";

export type BriefItem = {
  eventTitle: string;
  startTime: string;
  lastMeeting: { botId: string; title: string | null; startedAt: string | null; slug: string } | null;
  openTasks: Array<{ id: string; title: string }>;
};

export type Brief = {
  ymd: string;
  viewer: string;
  generatedAt: string;
  items: BriefItem[];
  openTaskCount: number;
};

const key = (email: string, ymd: string) => `brief:v1:${email.toLowerCase()}:${ymd}`;

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Best-effort "last time we met like this": match today's event title
 * against recent recorded meetings. Exact normalized match at any length;
 * containment only when BOTH titles are substantial (short fragments like
 * "1:1" or "sync" match everything and attach the wrong account). */
function matchLastMeeting(eventTitle: string, recent: MeetingIndexRow[]): BriefItem["lastMeeting"] {
  const t = norm(eventTitle);
  if (t.length < 4) return null;
  for (const m of recent) {
    const mt = norm(m.title ?? "");
    if (!mt) continue;
    const exact = mt === t;
    const contains = t.length >= 8 && mt.length >= 8 && (mt.includes(t) || t.includes(mt));
    if (exact || contains) {
      return { botId: m.bot_id, title: m.title, startedAt: m.started_at, slug: m.customer_slug };
    }
  }
  return null;
}

export async function buildBriefs(now = new Date()): Promise<{ written: number }> {
  const ymd = dayKeyPT(now);

  const [calendars, recent] = await Promise.all([
    listAllCalendars().catch(() => []),
    readMeetingIndex({ sinceMs: Date.now() - 45 * 24 * 3600 * 1000, limit: 300 }).catch(() => []),
  ]);
  const connected = calendars.filter((c) => c.status === "connected");
  // The WHOLE PT day, not "from whenever the cron happened to fire" — a
  // 7:59 firing must not silently drop 7:00-7:59 meetings.
  const dayStart = ptStartOfDayMs(0);
  const startGte = new Date(dayStart).toISOString();
  const startLte = new Date(dayStart + 24 * 3600 * 1000).toISOString();
  const perCal = await Promise.all(
    connected.map((c) =>
      listCalendarEventsByStart({ calendarId: c.id, startGte, startLte }).catch(() => [] as CalendarEvent[]),
    ),
  );
  // Dedupe events across calendars, keep attendee emails for per-person cuts.
  const events = new Map<string, CalendarEvent>();
  for (const list of perCal) {
    for (const e of list) {
      if (e.is_deleted || e.raw?.status === "cancelled" || !e.meeting_url || !e.start_time) continue;
      const k = `${e.ical_uid ?? e.id}|${e.start_time}`;
      if (!events.has(k)) events.set(k, e);
    }
  }

  let written = 0;
  for (const email of TEAM_EMAILS) {
    const mine = [...events.values()]
      .filter((e) => (e.raw?.attendees ?? []).some((a) => a.email?.toLowerCase() === email))
      .sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""))
      .slice(0, 8);

    const items: BriefItem[] = [];
    for (const e of mine) {
      const last = matchLastMeeting(e.raw?.summary ?? "", recent);
      let openTasks: Array<{ id: string; title: string }> = [];
      if (last && last.slug !== "_unsorted") {
        openTasks = await db
          .select({ id: workItems.id, title: workItems.title })
          .from(workItems)
          .where(and(eq(workItems.customerSlug, last.slug), inArray(workItems.status, [...OPEN_STATUSES])))
          .limit(4)
          .catch(() => []);
      }
      items.push({
        eventTitle: e.raw?.summary ?? "(untitled meeting)",
        startTime: e.start_time!,
        lastMeeting: last,
        openTasks,
      });
    }

    const openTaskCount = (
      await db
        .select({ id: workItems.id })
        .from(workItems)
        .where(and(eq(workItems.ownerEmail, email), inArray(workItems.status, [...OPEN_STATUSES])))
        .catch(() => [])
    ).length;

    const brief: Brief = { ymd, viewer: email, generatedAt: new Date().toISOString(), items, openTaskCount };
    await kv.set(key(email, ymd), brief, { ex: 3 * 24 * 3600 }).catch(() => {});
    written++;
  }
  return { written };
}

/** Today's brief, else the most recent within 3 days (marked stale — covers
 * weekends: Friday's brief is what you see Sunday night). */
export async function readBrief(viewer: string): Promise<{ brief: Brief; stale: boolean } | null> {
  const today = dayKeyPT(new Date());
  const fresh = await kv.get<Brief>(key(viewer, today)).catch(() => null);
  if (fresh) return { brief: fresh, stale: false };
  for (let daysBack = 1; daysBack <= 3; daysBack++) {
    const ymd = dayKeyPT(new Date(Date.now() - daysBack * 24 * 3600 * 1000));
    const old = await kv.get<Brief>(key(viewer, ymd)).catch(() => null);
    if (old) return { brief: old, stale: true };
  }
  return null;
}
