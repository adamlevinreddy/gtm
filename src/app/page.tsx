import Link from "next/link";
import { after } from "next/server";
import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { OPEN_STATUSES } from "@/lib/work-items";
import { labeledMeetings, accountRollup, type LabeledMeeting } from "@/lib/meeting-accounts";
import { warmLabels } from "@/lib/company-resolver";
import {
  listAllCalendars,
  listCalendarEventsByStart,
  type CalendarEvent,
} from "@/lib/recall-calendar-v2";
import { getBlockChecker, eventUid } from "@/lib/meeting-optout";
import { personName } from "./board/ui-shared";
import AppShell, { resolveViewer } from "./AppShell";
import MeetingChatStream from "./board/meeting/MeetingChatStream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// The root layout's title.template doesn't apply to its own segment's page,
// so spell the full title out here.
export const metadata: Metadata = { title: "Home · Reddy GTM" };

const PLUM = "#773D72";

function greetingPT(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// ---------------------------------------------------------------------------
// Home — the single place to start. Built from a week of real Slack usage:
// 42% of asks are meeting recall/assets, 31% drafting, 17% docs, 8% CRM —
// task tracking is essentially one person. So the home view leads with the
// cross-source chat (same brain as the Slack bot) and recent/upcoming
// meeting context; the board is one click away, not the front door.
// ---------------------------------------------------------------------------

function fmtDayTimePT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d) + " PT"
  );
}

function fmtDayPT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  }).format(d);
}

function recentCustomerMeetings(meetings: LabeledMeeting[]): LabeledMeeting[] {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return meetings
    .filter((m) => !m.isInternal && m.started_at && Date.parse(m.started_at) >= weekAgo)
    .slice(0, 8);
}

type UpcomingRow = {
  key: string;
  title: string;
  startTime: string;
  hasBot: boolean;
  blocked: boolean;
};

async function upcomingMeetings(): Promise<UpcomingRow[]> {
  try {
    const [calendars, isBlocked] = await Promise.all([listAllCalendars(), getBlockChecker()]);
    const connected = calendars.filter((c) => c.status === "connected");
    const startGte = new Date().toISOString();
    const startLte = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const perCal = await Promise.all(
      connected.map((c) =>
        listCalendarEventsByStart({ calendarId: c.id, startGte, startLte }).catch(
          () => [] as CalendarEvent[],
        ),
      ),
    );
    const rows = new Map<string, UpcomingRow>();
    for (const events of perCal) {
      for (const e of events) {
        if (e.is_deleted || e.raw?.status === "cancelled" || !e.meeting_url || !e.start_time) continue;
        const key = `${eventUid(e)}|${new Date(e.start_time).getTime()}`;
        const existing = rows.get(key);
        if (existing) {
          existing.hasBot = existing.hasBot || (e.bots?.length ?? 0) > 0;
          continue;
        }
        rows.set(key, {
          key,
          title: e.raw?.summary || "(untitled meeting)",
          startTime: e.start_time,
          hasBot: (e.bots?.length ?? 0) > 0,
          blocked: isBlocked(e) !== null,
        });
      }
    }
    return [...rows.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(0, 8);
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const viewer = await resolveViewer();

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;

  const [labeled, upcoming] = await Promise.all([
    pat
      ? labeledMeetings(pat, 30, 400)
      : Promise.resolve({ meetings: [] as LabeledMeeting[], uncachedEvidence: [] }),
    upcomingMeetings(),
  ]);

  // Canon labels for anything uncached warm in the background — the next
  // render is canonical without blocking this one.
  if (labeled.uncachedEvidence.length > 0) {
    after(async () => {
      await warmLabels(labeled.uncachedEvidence, {
        userEmail: process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io",
      }).catch(() => {});
    });
  }

  const accounts = accountRollup(labeled.meetings).slice(0, 12);

  // Open tasks per customer slug for the accounts table (matched by
  // slugified account name — same kebab convention the board uses).
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const openBySlug = new Map<string, number>();
  try {
    const open = await db
      .select({ slug: workItems.customerSlug })
      .from(workItems)
      .where(inArray(workItems.status, [...OPEN_STATUSES]));
    for (const r of open) {
      if (!r.slug) continue;
      openBySlug.set(r.slug, (openBySlug.get(r.slug) ?? 0) + 1);
    }
  } catch {
    /* accounts table just shows 0s */
  }

  const recentCustomer = recentCustomerMeetings(labeled.meetings);

  // Suggested prompts mirroring the week's REAL Slack asks (meeting recall,
  // pipeline sweep, assets, drafting) — personalized with live account names.
  const topAccount = accounts[0]?.account ?? "our latest customer";
  const secondAccount = accounts[1]?.account ?? "an account";
  const starters = [
    `Catch me up on this week's customer meetings — key takeaways and anything we promised.`,
    `What did we say to ${topAccount} in our last call, and what are the open next steps?`,
    `Which accounts are going quiet — no meeting in 3+ weeks — and might be slipping?`,
    `Get me a shareable recording link for our most recent ${secondAccount} meeting.`,
    `What's the latest pricing we presented to ${topAccount}?`,
    `Draft a follow-up email for my last customer meeting.`,
  ];

  return (
    <AppShell
      active="home"
      viewer={viewer}
      title={`${greetingPT()}, ${personName(viewer).split(" ")[0]}`}
      subtitle="Ask anything across meetings, HubSpot, and the library — same brain as the Slack bot."
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
          {/* Chat hero */}
          <div className="lg:col-span-3">
            <div
              className="flex h-[74vh] flex-col overflow-hidden rounded-xl border bg-white"
              style={{ borderColor: "#E4DCE3" }}
            >
              <MeetingChatStream
                unscoped
                title="Ask Reddy GTM"
                scopeLabel="meetings · HubSpot · documents · board"
                placeholder="e.g. what did we promise NDR last week?"
                starters={starters}
              />
            </div>
          </div>

          {/* Right rail */}
          <div className="flex flex-col gap-5 lg:col-span-2">
            {/* This week's customer meetings */}
            <section className="rounded-xl border bg-white" style={{ borderColor: "#E4DCE3" }}>
              <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
                <h2 className="text-sm font-semibold" style={{ color: PLUM }}>This week&apos;s customer meetings</h2>
                <Link href="/board/meetings" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                  all meetings →
                </Link>
              </div>
              <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
                {recentCustomer.map((m) => (
                  <Link
                    key={m.bot_id}
                    href={`/board/meeting/${m.bot_id}?customer=${encodeURIComponent(m.customer_slug)}`}
                    className="block px-4 py-2 no-underline hover:bg-zinc-50"
                  >
                    <p className="truncate text-sm font-medium text-zinc-900">{m.title || "(untitled)"}</p>
                    <p className="text-xs text-zinc-500">
                      <span style={{ color: PLUM }}>{m.account}</span> · {fmtDayTimePT(m.started_at)}
                      {m.has_transcript ? " · 📄" : ""}
                      {m.has_video ? " 🎥" : ""}
                    </p>
                  </Link>
                ))}
                {recentCustomer.length === 0 && (
                  <p className="px-4 py-4 text-center text-sm text-zinc-400">No customer meetings in the last 7 days.</p>
                )}
              </div>
            </section>

            {/* Next 48h */}
            <section className="rounded-xl border bg-white" style={{ borderColor: "#E4DCE3" }}>
              <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
                <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Coming up</h2>
                <Link href="/board/meetings/schedule" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                  bot schedule →
                </Link>
              </div>
              <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
                {upcoming.map((u) => (
                  <div key={u.key} className="flex items-center gap-2 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-900">{u.title}</p>
                      <p className="text-xs text-zinc-500">{fmtDayTimePT(u.startTime)}</p>
                    </div>
                    <span className="shrink-0 text-xs" title={u.blocked ? "Bot will skip" : u.hasBot ? "Notetaker joining" : "No notetaker"}>
                      {u.blocked ? "🚫" : u.hasBot ? "🤖" : "—"}
                    </span>
                  </div>
                ))}
                {upcoming.length === 0 && (
                  <p className="px-4 py-4 text-center text-sm text-zinc-400">Nothing with a join link in the next 48h.</p>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Accounts — recent activity, click to dive in */}
        <section className="mt-5 rounded-xl border bg-white" style={{ borderColor: "#E4DCE3" }}>
          <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
            <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Active accounts — last 30 days</h2>
            <span className="text-xs text-zinc-400">click an account for its meetings + chat</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Meetings</th>
                  <th className="px-4 py-2 font-medium">Last meeting</th>
                  <th className="px-4 py-2 font-medium">Open tasks</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const openTasks = openBySlug.get(slugify(a.account)) ?? 0;
                  return (
                    <tr key={a.account} className="border-t border-zinc-100 hover:bg-zinc-50">
                      <td className="px-4 py-2">
                        <Link
                          href={`/board/meetings?days=90&account=${encodeURIComponent(a.account)}`}
                          className="font-medium no-underline hover:underline"
                          style={{ color: PLUM }}
                        >
                          {a.account}
                        </Link>
                      </td>
                      <td className="px-4 py-2 tabular-nums text-zinc-700">{a.meetings}</td>
                      <td className="px-4 py-2 text-zinc-500">
                        {fmtDayPT(a.lastMeetingAt)}
                        {a.lastMeetingTitle && (
                          <span className="text-zinc-400"> · {a.lastMeetingTitle.slice(0, 48)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {openTasks > 0 ? (
                          <Link
                            href={`/board?customer=${encodeURIComponent(slugify(a.account))}`}
                            className="no-underline hover:underline"
                            style={{ color: PLUM }}
                          >
                            {openTasks}
                          </Link>
                        ) : (
                          <span className="text-zinc-300">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {accounts.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-zinc-400">
                      No customer meetings indexed in the last 30 days.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
    </AppShell>
  );
}
