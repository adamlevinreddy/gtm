import Link from "next/link";
import { after } from "next/server";
import type { Metadata } from "next";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { Bot, CircleAlert, Link2 } from "lucide-react";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { labeledMeetings, accountRollup, type LabeledMeeting } from "@/lib/meeting-accounts";
import { warmLabels } from "@/lib/company-resolver";
import {
  listAllCalendars,
  listCalendarEventsByStart,
  type CalendarEvent,
} from "@/lib/recall-calendar-v2";
import { getBlockChecker, eventUid } from "@/lib/meeting-optout";
import { fmtTimePT, fmtDayTimePT, fmtDuration, fmtDayPT, dayKeyPT, ptStartOfDayMs } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER, BORDER_SOFT, OK, WARN } from "@/lib/tokens";
import { personName } from "./board/ui-shared";
import AppShell, { resolveViewer } from "./AppShell";
import WelcomeGate from "./WelcomeGate";
import HomeAsk from "./HomeAsk";
import CopyButton from "@/components/CopyButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// The root layout's title.template doesn't apply to its own segment's page,
// so spell the full title out here.
export const metadata: Metadata = { title: "Home · Reddy GTM" };

// ---------------------------------------------------------------------------
// The cockpit (Daybreak Phase 7): the one screen worth opening every morning.
// Today's meetings (past = recording + copy-link, upcoming = bot status),
// what needs YOU, what the bot did overnight, an ask box, and the account
// pulse. Every card renders from precomputed reads — no agent on this path.
// ---------------------------------------------------------------------------

function greetingPT(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(
      new Date(),
    ),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

type UpcomingRow = { key: string; title: string; startTime: string; hasBot: boolean; blocked: boolean };

async function upcomingMeetings(hours: number): Promise<UpcomingRow[]> {
  try {
    const [calendars, isBlocked] = await Promise.all([listAllCalendars(), getBlockChecker()]);
    const connected = calendars.filter((c) => c.status === "connected");
    const startGte = new Date().toISOString();
    const startLte = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const perCal = await Promise.all(
      connected.map((c) =>
        listCalendarEventsByStart({ calendarId: c.id, startGte, startLte }).catch(() => [] as CalendarEvent[]),
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
    return [...rows.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(0, 6);
  } catch {
    return [];
  }
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border bg-white" style={{ borderColor: BORDER }}>
      <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
        <h2 className="text-sm font-semibold" style={{ color: PLUM }}>{title}</h2>
        {action}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

const OPEN_FOR_VIEWER = ["triage", "suggested", "approved", "in_progress", "waiting", "blocked"] as const;

export default async function HomePage() {
  const viewer = await resolveViewer();
  // Anonymous → the gate, BEFORE any viewer-scoped reads run.
  if (!viewer) return <WelcomeGate />;
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const shareBase = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";

  const overnightCutoff = ptStartOfDayMs(0) - 7 * 3600_000; // 5pm yesterday PT
  const todayKey = dayKeyPT(new Date());

  // ONE meetings read (30d) feeds today/overnight/needs-you AND the account
  // rollup — the review caught a second serial 30d fetch that doubled the
  // page's KV work for identical data.
  const [labeled, upcoming, myTasks, overnightTasks] = await Promise.all([
    pat
      ? labeledMeetings(pat, 30, 400)
      : Promise.resolve({ meetings: [] as LabeledMeeting[], uncachedEvidence: [] }),
    upcomingMeetings(24),
    db
      .select({ id: workItems.id, title: workItems.title, status: workItems.status, customerSlug: workItems.customerSlug })
      .from(workItems)
      .where(and(eq(workItems.ownerEmail, viewer), inArray(workItems.status, [...OPEN_FOR_VIEWER])))
      .orderBy(desc(workItems.createdAt))
      .limit(5)
      .catch(() => []),
    db
      .select({ id: workItems.id, title: workItems.title, customerSlug: workItems.customerSlug })
      .from(workItems)
      .where(and(eq(workItems.source, "post_meeting"), gte(workItems.createdAt, new Date(overnightCutoff))))
      .orderBy(desc(workItems.createdAt))
      .limit(6)
      .catch(() => []),
  ]);

  if (labeled.uncachedEvidence.length > 0) {
    after(async () => {
      await warmLabels(labeled.uncachedEvidence, {
        userEmail: process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io",
      }).catch(() => {});
    });
  }

  const todayPast = labeled.meetings.filter((m) => m.started_at && dayKeyPT(m.started_at) === todayKey);
  const overnightMeetings = labeled.meetings.filter(
    (m) => m.started_at && Date.parse(m.started_at) >= overnightCutoff && dayKeyPT(m.started_at) !== todayKey,
  );
  // Meetings needing attribution: _unsorted with a transcript, where there's
  // EVIDENCE of a customer — an external attendee email or a non-internal
  // title label. (Filtering on !isInternal alone hid exactly the meetings
  // that most need fixing: unattributed ones default to the Internal label.)
  const unattributed = labeled.meetings
    .filter(
      (m) =>
        m.customer_slug === "_unsorted" &&
        m.has_transcript &&
        (!m.isInternal ||
          m.attendees.some((a) => a.email && !a.email.toLowerCase().endsWith("@reddy.io"))),
    )
    .slice(0, 4);

  const accounts = accountRollup(labeled.meetings).slice(0, 12);

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const openBySlug = new Map<string, number>();
  try {
    const open = await db
      .select({ slug: workItems.customerSlug })
      .from(workItems)
      .where(inArray(workItems.status, [...OPEN_FOR_VIEWER]));
    for (const r of open) {
      if (!r.slug) continue;
      openBySlug.set(r.slug, (openBySlug.get(r.slug) ?? 0) + 1);
    }
  } catch {
    /* table shows 0s */
  }

  const topAccount = accounts[0]?.account ?? "our latest customer";
  const starters = [
    `Catch me up on this week's customer meetings — key takeaways and anything we promised.`,
    `What did we say to ${topAccount} in our last call, and what are the open next steps?`,
    `Which accounts are going quiet — no meeting in 3+ weeks?`,
    `What's the latest pricing we presented to ${topAccount}?`,
    `Draft a follow-up email for my last customer meeting.`,
  ];

  return (
    <AppShell
      active="home"
      viewer={viewer}
      title={`${greetingPT()}, ${personName(viewer).split(" ")[0]}`}
      subtitle="Everything since you last looked — and one box that answers anything."
    >
      <div className="flex flex-col gap-5">
        <HomeAsk starters={starters} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Today */}
          <Card
            title="Today"
            action={
              <Link href="/settings" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                bot schedule →
              </Link>
            }
          >
            <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
              {todayPast.map((m) => {
                const ready = m.has_video ? "Recording ready" : m.has_transcript ? "Transcript ready" : "Processing…";
                return (
                  <div key={m.bot_id} className="flex items-center gap-2 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <Link href={`/m/${m.bot_id}`} className="block truncate text-sm font-medium text-zinc-900 no-underline hover:underline">
                        {m.title || "(untitled)"}
                      </Link>
                      <p className="text-xs" style={{ color: m.has_video || m.has_transcript ? OK : "#A1A1AA" }}>
                        {ready}
                        {fmtDuration(m.started_at, m.ended_at) ? ` · ${fmtDuration(m.started_at, m.ended_at)}` : ""}
                        <span className="text-zinc-400"> · {fmtTimePT(m.started_at)}</span>
                      </p>
                    </div>
                    {(m.has_video || m.has_transcript) && (
                      <CopyButton
                        text={`${shareBase}/m/${m.bot_id}`}
                        label="Copy link"
                        icon={<Link2 size={12} />}
                        title="Permanent share link"
                      />
                    )}
                  </div>
                );
              })}
              {upcoming.map((u) => (
                <div key={u.key} className="flex items-center gap-2 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-900">{u.title}</p>
                    <p className="text-xs text-zinc-500">{fmtDayTimePT(u.startTime)}</p>
                  </div>
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                    style={
                      u.blocked
                        ? { background: "#FEF3F2", color: "#B42318" }
                        : u.hasBot
                          ? { background: PLUM_TINT, color: PLUM }
                          : { background: "#F4F4F5", color: "#71717A" }
                    }
                  >
                    <Bot size={11} />
                    {u.blocked ? "skipping" : u.hasBot ? "joining" : "no bot"}
                  </span>
                </div>
              ))}
              {todayPast.length === 0 && upcoming.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-zinc-400">Nothing on the calendar with a join link.</p>
              )}
            </div>
          </Card>

          {/* Needs you */}
          <Card
            title="Needs you"
            action={
              <Link href="/board" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                board →
              </Link>
            }
          >
            <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
              {unattributed.map((m) => (
                <Link key={m.bot_id} href={`/m/${m.bot_id}`} className="flex items-center gap-2.5 px-4 py-2 no-underline hover:bg-zinc-50">
                  <CircleAlert size={14} className="shrink-0" style={{ color: WARN }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-900">{m.title || "(untitled meeting)"}</span>
                    <span className="block text-xs text-zinc-500">No account assigned · {fmtDayPT(m.started_at)}</span>
                  </span>
                </Link>
              ))}
              {myTasks.map((t) => (
                <Link key={t.id} href={`/board/${t.id}`} className="flex items-center gap-2.5 px-4 py-2 no-underline hover:bg-zinc-50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-900">{t.title}</span>
                    <span className="block text-xs text-zinc-500">
                      {t.status.replace(/_/g, " ")}
                      {t.customerSlug ? ` · ${t.customerSlug}` : ""}
                    </span>
                  </span>
                </Link>
              ))}
              {unattributed.length === 0 && myTasks.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-zinc-400">All clear — nothing waiting on you.</p>
              )}
            </div>
          </Card>

          {/* While you were away */}
          <Card
            title="While you were away"
            action={
              <Link href="/meetings" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                all meetings →
              </Link>
            }
          >
            <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
              {overnightMeetings.slice(0, 4).map((m) => (
                <Link key={m.bot_id} href={`/m/${m.bot_id}`} className="block px-4 py-2 no-underline hover:bg-zinc-50">
                  <p className="truncate text-sm text-zinc-900">{m.title || "(untitled)"}</p>
                  <p className="text-xs text-zinc-500">
                    {!m.isInternal && <span style={{ color: PLUM }}>{m.account} · </span>}
                    processed {fmtDayTimePT(m.started_at)}
                  </p>
                </Link>
              ))}
              {overnightTasks.map((t) => (
                <Link key={t.id} href={`/board/${t.id}`} className="flex items-center gap-2 px-4 py-2 no-underline hover:bg-zinc-50">
                  <Bot size={13} className="shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-700">{t.title}</span>
                </Link>
              ))}
              {overnightMeetings.length === 0 && overnightTasks.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-zinc-400">Quiet since yesterday evening.</p>
              )}
            </div>
          </Card>
        </div>

        {/* Accounts pulse */}
        <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
          <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
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
                          href={`/meetings?days=90&account=${encodeURIComponent(a.account)}`}
                          className="font-medium no-underline hover:underline"
                          style={{ color: PLUM }}
                        >
                          {a.account}
                        </Link>
                      </td>
                      <td className="px-4 py-2 tabular-nums text-zinc-700">{a.meetings}</td>
                      <td className="px-4 py-2 text-zinc-500">
                        {fmtDayPT(a.lastMeetingAt)}
                        {a.lastMeetingTitle && <span className="text-zinc-400"> · {a.lastMeetingTitle.slice(0, 48)}</span>}
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
      </div>
    </AppShell>
  );
}
