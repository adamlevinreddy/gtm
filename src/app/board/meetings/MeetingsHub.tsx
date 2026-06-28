"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import MeetingChatStream from "../meeting/MeetingChatStream";

const PLUM = "#773D72";

export type HubMeeting = {
  botId: string;
  title: string | null;
  slug: string;
  account: string;
  startedAt: string | null;
  platform: string | null;
  attendees: string[];
  hasTranscript: boolean;
  hasVideo: boolean;
  tasks: Array<{ id: string; title: string; status: string }>;
};

const STATUS_LABEL: Record<string, string> = {
  triage: "Triage", suggested: "Suggested", approved: "To Do", in_progress: "In progress",
  ready_for_review: "Review", blocked: "Blocked", waiting: "Waiting", done: "Done", dismissed: "Dismissed",
};

const RANGES = [30, 90, 365];

function fmtPT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d) + " PT";
}

export default function MeetingsHub({ meetings, days }: { meetings: HubMeeting[]; days: number }) {
  const [search, setSearch] = useState("");
  const [account, setAccount] = useState<string>("all");
  const [tasksOnly, setTasksOnly] = useState(false);

  const accounts = useMemo(
    () => Array.from(new Set(meetings.map((m) => m.account))).sort((a, b) => a.localeCompare(b)),
    [meetings]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return meetings.filter((m) => {
      if (account !== "all" && m.account !== account) return false;
      if (tasksOnly && m.tasks.length === 0) return false;
      if (q) {
        const hay = `${m.title ?? ""} ${m.account} ${m.slug} ${m.attendees.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [meetings, search, account, tasksOnly]);

  // Only meetings with a transcript can be chatted about.
  const chatBotIds = useMemo(
    () => filtered.filter((m) => m.hasTranscript).map((m) => m.botId),
    [filtered]
  );
  const scopeLabel =
    `${chatBotIds.length} meeting${chatBotIds.length === 1 ? "" : "s"}` +
    (account !== "all" ? ` · ${account}` : "");

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
      {/* left: filters + list */}
      <div className="lg:col-span-3">
        {/* range tabs */}
        <div className="mb-3 flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5 w-fit">
          {RANGES.map((d) => (
            <Link
              key={d}
              href={`/board/meetings?days=${d}`}
              scroll={false}
              className="rounded-md px-2.5 py-1 text-sm font-medium no-underline"
              style={
                d === days
                  ? { background: PLUM, color: "white" }
                  : { color: "#52525b" }
              }
            >
              {d === 365 ? "1 year" : `${d} days`}
            </Link>
          ))}
        </div>

        {/* filter bar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, attendee, account…"
            className="min-w-[200px] flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none focus:ring-2"
            style={{ borderColor: "#E4DCE3" }}
          />
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="max-w-[180px] rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
            style={{ borderColor: "#E4DCE3" }}
          >
            <option value="all">All accounts</option>
            {accounts.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setTasksOnly((v) => !v)}
            className="rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
            style={
              tasksOnly
                ? { borderColor: PLUM, background: "#F0E8EF", color: PLUM }
                : { borderColor: "#E4DCE3", color: "#52525b" }
            }
          >
            Has tasks
          </button>
        </div>

        <p className="mb-2 text-xs text-zinc-400">
          {filtered.length} of {meetings.length} meetings · last {days === 365 ? "year" : `${days} days`}
        </p>

        <div className="flex flex-col gap-2">
          {filtered.map((m) => (
            <Link
              key={m.botId}
              href={`/board/meeting/${m.botId}?customer=${encodeURIComponent(m.slug)}`}
              className="block rounded-xl border bg-white px-4 py-3 no-underline transition-colors hover:border-zinc-300"
              style={{ borderColor: "#E4DCE3" }}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-900">
                    {m.title || "(untitled meeting)"}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    <span style={{ color: PLUM }}>{m.account}</span>
                    {m.startedAt && <> · {fmtPT(m.startedAt)}</>}
                    {m.attendees.length > 0 && <> · {m.attendees.slice(0, 4).join(", ")}{m.attendees.length > 4 ? "…" : ""}</>}
                  </p>
                  {m.tasks.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.tasks.slice(0, 4).map((t) => (
                        <span
                          key={t.id}
                          className="rounded px-1.5 py-0.5 text-[11px]"
                          style={{ background: "#F0E8EF", color: PLUM }}
                          title={`${t.title} — ${STATUS_LABEL[t.status] ?? t.status}`}
                        >
                          {t.title.length > 28 ? t.title.slice(0, 28) + "…" : t.title}
                        </span>
                      ))}
                      {m.tasks.length > 4 && (
                        <span className="text-[11px] text-zinc-400">+{m.tasks.length - 4} more</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-sm">
                  {m.hasVideo && <span title="Has recording">🎥</span>}
                  {m.hasTranscript && <span title="Has transcript">📄</span>}
                </div>
              </div>
            </Link>
          ))}
          {filtered.length === 0 && (
            <p className="rounded-xl border bg-white px-4 py-6 text-center text-sm text-zinc-400" style={{ borderColor: "#E4DCE3" }}>
              No meetings match these filters.
            </p>
          )}
        </div>
      </div>

      {/* right: corpus chat */}
      <div className="lg:col-span-2">
        <div
          className="lg:sticky lg:top-7 flex h-[80vh] flex-col overflow-hidden rounded-xl border bg-white"
          style={{ borderColor: "#E4DCE3" }}
        >
          <MeetingChatStream
            key={account + ":" + tasksOnly + ":" + days}
            botIds={chatBotIds}
            title="Chat across these meetings"
            scopeLabel={scopeLabel}
            placeholder={chatBotIds.length ? "Ask across the meetings in view…" : "No transcripts in view"}
            starters={[
              "What are the main themes across these meetings?",
              "Which deals or accounts need follow-up?",
              "Summarize the key commitments we made.",
            ]}
          />
        </div>
      </div>
    </div>
  );
}
