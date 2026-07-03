import { NextRequest, NextResponse } from "next/server";
import {
  listAllCalendars,
  listCalendarEventsByStart,
  shouldRecordEvent,
  scheduleBotForEvent,
  deleteBotForEvent,
  kvClaimIcalOwner,
  kvKeyBotInvitees,
  type CalendarEvent,
} from "@/lib/recall-calendar-v2";
import {
  addBlock,
  removeBlock,
  listBlocks,
  eventUid,
  seriesBlockKey,
  occurrenceBlockKey,
  type BlockScope,
  type MeetingBlock,
} from "@/lib/meeting-optout";
import { kv } from "@/lib/kv-client";
import type { RecallParticipant } from "@/lib/recall";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Browser-facing bot-schedule surface for the board.
//
//   GET  → upcoming meetings (next 14 days) across every connected calendar,
//          deduped by (ical_uid, start), each carrying recurring/bot/blocked
//          state — plus the full active-block list.
//   POST → { action: block|unblock, scope: series|occurrence, icalUid,
//            startTime?, title? }. Persists the block AND eagerly applies it:
//          on block, deletes already-scheduled bots for every matching future
//          event on every calendar; on unblock, re-schedules them (an
//          untouched event may never re-sync, so we can't wait for the
//          calendar.sync_events webhook to do this).
//
// Like the other /api/board/ui/* islands, secrets (RECALL_API_KEY) stay
// server-side; the viewer's identity rides the board_viewer cookie.
// ---------------------------------------------------------------------------

const VIEWER_COOKIE = "board_viewer";
const UPCOMING_DAYS = 14;

function resolveViewer(req: NextRequest, bodyAs?: unknown): string {
  if (typeof bodyAs === "string" && bodyAs.includes("@")) return bodyAs;
  const qAs = req.nextUrl.searchParams.get("as");
  if (qAs && qAs.includes("@")) return qAs;
  const cookie = req.cookies.get(VIEWER_COOKIE)?.value;
  if (cookie && cookie.includes("@")) return cookie;
  return process.env.BOARD_DEFAULT_VIEWER || "adam@reddy.io";
}

function isJoinable(e: CalendarEvent): boolean {
  return !e.is_deleted && e.raw?.status !== "cancelled" && !!e.meeting_url;
}

export type UpcomingMeeting = {
  icalUid: string;
  startTime: string;
  endTime: string | null;
  title: string;
  organizer: string | null;
  attendees: string[];
  isRecurring: boolean;
  hasBot: boolean;
  blocked: BlockScope | null;
  /** Which teammates' calendars carry this event. */
  calendars: string[];
};

export async function GET() {
  try {
    const [calendars, blocks] = await Promise.all([listAllCalendars(), listBlocks()]);
    const connected = calendars.filter((c) => c.status === "connected");
    const startGte = new Date().toISOString();
    const startLte = new Date(Date.now() + UPCOMING_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const perCalendar = await Promise.all(
      connected.map(async (c) => ({
        email: c.platform_email ?? c.id,
        events: await listCalendarEventsByStart({ calendarId: c.id, startGte, startLte }).catch(
          () => [] as CalendarEvent[],
        ),
      })),
    );

    const blockByKey = new Map(blocks.map((b) => [b.key, b]));
    const rows = new Map<string, UpcomingMeeting>();
    for (const { email, events } of perCalendar) {
      for (const e of events) {
        if (!isJoinable(e) || !e.start_time) continue;
        const uid = eventUid(e);
        const rowKey = `${uid}|${new Date(e.start_time).getTime()}`;
        const existing = rows.get(rowKey);
        if (existing) {
          existing.hasBot = existing.hasBot || (e.bots?.length ?? 0) > 0;
          existing.isRecurring = existing.isRecurring || !!e.raw?.recurringEventId;
          if (!existing.calendars.includes(email)) existing.calendars.push(email);
          continue;
        }
        const blocked = blockByKey.has(seriesBlockKey(uid))
          ? ("series" as const)
          : blockByKey.has(occurrenceBlockKey(uid, e.start_time))
            ? ("occurrence" as const)
            : null;
        rows.set(rowKey, {
          icalUid: uid,
          startTime: e.start_time,
          endTime: e.end_time ?? null,
          title: e.raw?.summary || "(untitled meeting)",
          organizer: e.raw?.organizer?.email ?? null,
          attendees: (e.raw?.attendees ?? [])
            .map((a) => a.email)
            .filter((s): s is string => !!s),
          isRecurring: !!e.raw?.recurringEventId,
          hasBot: (e.bots?.length ?? 0) > 0,
          blocked,
          calendars: [email],
        });
      }
    }

    const meetings = [...rows.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
    return NextResponse.json({ ok: true, meetings, blocks });
  } catch (err) {
    console.error(`[bot-schedule] GET failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

type PostBody = {
  action?: unknown;
  scope?: unknown;
  icalUid?: unknown;
  startTime?: unknown;
  title?: unknown;
  as?: unknown;
};

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const action = body.action === "block" || body.action === "unblock" ? body.action : null;
  const scope: BlockScope | null =
    body.scope === "series" || body.scope === "occurrence" ? body.scope : null;
  const icalUid = typeof body.icalUid === "string" && body.icalUid.length > 0 ? body.icalUid : null;
  const startTime = typeof body.startTime === "string" ? body.startTime : undefined;
  const title = typeof body.title === "string" ? body.title : undefined;
  if (!action || !scope || !icalUid || (scope === "occurrence" && !startTime)) {
    return NextResponse.json(
      { ok: false, error: "need action=block|unblock, scope=series|occurrence, icalUid (+ startTime for occurrence)" },
      { status: 400 },
    );
  }
  const viewer = resolveViewer(req, body.as);

  try {
    let block: MeetingBlock | null = null;
    if (action === "block") {
      block = await addBlock({ scope, icalUid, startTime, title, addedBy: viewer });
    } else {
      const key = scope === "series" ? seriesBlockKey(icalUid) : occurrenceBlockKey(icalUid, startTime!);
      await removeBlock(key);
    }

    // Eager apply across every connected calendar. The ical_uid filter keeps
    // this to one small query per calendar.
    const calendars = (await listAllCalendars()).filter((c) => c.status === "connected");
    const startGte = new Date().toISOString();
    let botsRemoved = 0;
    let botsScheduled = 0;
    // Occurrence toggles must ignore blocks that no longer exist / still
    // exist at the other scope — re-read once after the mutation.
    const remainingBlocks = await listBlocks();
    const remainingKeys = new Set(remainingBlocks.map((b) => b.key));

    for (const cal of calendars) {
      const events = await listCalendarEventsByStart({
        calendarId: cal.id,
        startGte,
        icalUid,
      }).catch(() => [] as CalendarEvent[]);
      for (const e of events) {
        if (!e.start_time) continue;
        if (scope === "occurrence" && startTime) {
          if (new Date(e.start_time).getTime() !== new Date(startTime).getTime()) continue;
        }
        const uid = eventUid(e);
        const stillBlocked =
          remainingKeys.has(seriesBlockKey(uid)) ||
          remainingKeys.has(occurrenceBlockKey(uid, e.start_time));

        if (action === "block" || stillBlocked) {
          if ((e.bots?.length ?? 0) > 0) {
            try {
              await deleteBotForEvent(e.id);
              botsRemoved += 1;
              await kv.del(`recall:cal:event:${cal.id}:${e.id}:bot`).catch(() => {});
            } catch (err) {
              console.warn(`[bot-schedule] delete bot for ${e.id} failed: ${err instanceof Error ? err.message : err}`);
            }
          }
          continue;
        }

        // Unblock path — mirror the webhook's scheduling rules: joinable,
        // owner hasn't declined, and only the calendar that owns the
        // cross-calendar claim schedules.
        if (!isJoinable(e)) continue;
        if ((e.bots?.length ?? 0) > 0) continue; // already scheduled
        const ownerEmail = cal.platform_email ?? "";
        if (ownerEmail && !shouldRecordEvent(e, ownerEmail)) continue;
        if (e.ical_uid) {
          const claim = await kvClaimIcalOwner(e.ical_uid, cal.id);
          if (claim.owner !== cal.id) continue;
        }
        try {
          const joinAt = new Date(new Date(e.start_time).getTime() - 2 * 60 * 1000).toISOString();
          const { botId } = await scheduleBotForEvent({
            eventId: e.id,
            deduplicationKey: `cal_${cal.id}_evt_${e.id}`,
            joinAt,
          });
          botsScheduled += 1;
          if (botId) {
            await kv.set(`recall:cal:event:${cal.id}:${e.id}:bot`, botId).catch(() => {});
            const invitees: RecallParticipant[] = (e.raw?.attendees ?? [])
              .filter((a) => !!a.email)
              .map((a) => ({ name: undefined, email: a.email, is_host: a.organizer ?? false }));
            if (invitees.length) {
              await kv.set(kvKeyBotInvitees(botId), invitees, { ex: 30 * 24 * 60 * 60 }).catch(() => {});
            }
          }
        } catch (err) {
          console.warn(`[bot-schedule] schedule bot for ${e.id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    console.log(
      `[bot-schedule] ${action} ${scope} uid=${icalUid.slice(0, 40)}… by=${viewer} removed=${botsRemoved} scheduled=${botsScheduled}`,
    );
    return NextResponse.json({ ok: true, block, botsRemoved, botsScheduled });
  } catch (err) {
    console.error(`[bot-schedule] POST failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
