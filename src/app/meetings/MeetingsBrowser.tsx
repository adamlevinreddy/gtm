"use client";

import { useMemo, useState, useCallback, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronRight, MessageSquareText, X } from "lucide-react";
import MeetingRow, { type MeetingRowData } from "@/components/MeetingRow";
import MeetingChatStream from "@/components/MeetingChatStream";
import Drawer from "@/components/Drawer";
import { dayKeyPT, fmtWeekdayPT, fmtDayPT } from "@/lib/fmt";
import { PLUM, BORDER } from "@/lib/tokens";

// Daybreak Phase 4 — the meetings browser.
//  - Filters live in the URL (shareable, reload-safe, back/forward works).
//  - Rows group by PT day; weeks older than the current one collapse to a
//    header with a count and expand lazily — the DOM never holds 700 cards.
//  - Chat is a slide-over whose scope is SNAPSHOTTED when opened (shown as
//    removable chips) — page filters can never mutate a live conversation.

const DAYS_CHOICES = [7, 30, 90, 365];
const INTERNAL_LABELS = new Set(["Internal", "Reddy"]);

type ChatScope = { botIds: string[]; note: string; label: string };

function weekKeyPT(iso: string): string {
  // Monday-anchored week key for the PT calendar day.
  const day = dayKeyPT(iso); // YYYY-MM-DD in PT
  const d = new Date(`${day}T12:00:00Z`); // noon dodges DST edges
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Module-level (not in render): groups meetings into current-week days and
// older collapsed weeks.
function groupByRecency(filtered: MeetingRowData[]): {
  dayGroups: Array<{ key: string; label: string; meetings: MeetingRowData[] }>;
  weekGroups: Array<{ key: string; label: string; meetings: MeetingRowData[] }>;
} {
  const nowWeek = weekKeyPT(new Date().toISOString());
  const todayKey = dayKeyPT(new Date());
  const yesterdayKey = dayKeyPT(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const byDay = new Map<string, MeetingRowData[]>();
  const byWeek = new Map<string, MeetingRowData[]>();
  for (const m of filtered) {
    if (!m.startedAt) continue;
    if (weekKeyPT(m.startedAt) === nowWeek) {
      const k = dayKeyPT(m.startedAt);
      (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(m);
    } else {
      const k = weekKeyPT(m.startedAt);
      (byWeek.get(k) ?? byWeek.set(k, []).get(k)!).push(m);
    }
  }
  const dayGroups = [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([k, ms]) => ({
      key: k,
      label: k === todayKey ? "Today" : k === yesterdayKey ? "Yesterday" : fmtWeekdayPT(ms[0].startedAt!),
      meetings: ms,
    }));
  const weekGroups = [...byWeek.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([k, ms]) => ({
      key: k,
      label: `Week of ${fmtDayPT(`${k}T12:00:00Z`)}`,
      meetings: ms,
    }));
  return { dayGroups, weekGroups };
}

export default function MeetingsBrowser({
  rows,
  days,
  initialAccount,
  initialQ,
  initialVideoOnly,
  initialShowInternal,
  shareBase,
}: {
  rows: MeetingRowData[];
  days: number;
  initialAccount?: string;
  initialQ?: string;
  initialVideoOnly?: boolean;
  initialShowInternal?: boolean;
  shareBase: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [account, setAccount] = useState(initialAccount || "all");
  const [q, setQ] = useState(initialQ || "");
  const [videoOnly, setVideoOnly] = useState(!!initialVideoOnly);
  const [showInternal, setShowInternal] = useState(
    initialShowInternal || (initialAccount ? INTERNAL_LABELS.has(initialAccount) : false),
  );
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  const [chatScope, setChatScope] = useState<ChatScope | null>(null);
  const [chatStarted, setChatStarted] = useState(false);

  // The last URL WE wrote — distinguishes our own router.replace echoes
  // from external navigations (⌘K, home links) that must adopt into state.
  // State (not a ref) because the adoption check below runs during render.
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildQs = useCallback(
    (next: { account?: string; q?: string; videoOnly?: boolean; showInternal?: boolean }) => {
      const p = new URLSearchParams();
      if (days !== 30) p.set("days", String(days));
      const acc = next.account ?? account;
      const query = next.q ?? q;
      const vid = next.videoOnly ?? videoOnly;
      const internal = next.showInternal ?? showInternal;
      if (acc !== "all") p.set("account", acc);
      if (query.trim()) p.set("q", query.trim());
      if (vid) p.set("video", "1");
      if (internal) p.set("internal", "1");
      return p.toString();
    },
    [days, account, q, videoOnly, showInternal],
  );

  // Reflect filters into the URL. Toggles sync immediately; SEARCH is
  // debounced — the page is force-dynamic, so an un-debounced replace
  // would run a full server render (and re-mint every thumbnail) per
  // keystroke. Filtering itself is local state and stays instant.
  const syncUrl = useCallback(
    (next: { account?: string; q?: string; videoOnly?: boolean; showInternal?: boolean }, debounce = false) => {
      const write = () => {
        const qs = buildQs(next);
        setLastSynced(qs);
        router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
      };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (debounce) debounceRef.current = setTimeout(write, 500);
      else write();
    },
    [router, pathname, buildQs],
  );

  // External navigation to /meetings with different params (⌘K, account
  // links) → adopt the URL into state. Render-time derived-state pattern
  // (React's sanctioned "adjust state when props change") — not an effect.
  const currentQs = searchParams.toString();
  const [adoptedQs, setAdoptedQs] = useState(currentQs);
  if (currentQs !== adoptedQs) {
    setAdoptedQs(currentQs);
    if (currentQs !== lastSynced) {
      const sp = new URLSearchParams(currentQs);
      setAccount(sp.get("account") || "all");
      setQ(sp.get("q") || "");
      setVideoOnly(sp.get("video") === "1");
      setShowInternal(sp.get("internal") === "1" || INTERNAL_LABELS.has(sp.get("account") || ""));
      setLastSynced(currentQs);
    }
  }

  const accounts = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.account)))
        .filter((a) => !INTERNAL_LABELS.has(a))
        .sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    // Tolerant account matching: ⌘K/home links carry prettified SLUGS while
    // rows carry canonical resolver labels ("NTG Freight" vs "Ntg Freight",
    // "Teleperformance" vs "TP") — compare slugified forms and the raw slug.
    const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const wanted = account === "all" ? null : canon(account);
    return rows.filter((m) => {
      if (!showInternal && account === "all" && !query && m.isInternal) return false;
      if (wanted && canon(m.account) !== wanted && canon(m.slug) !== wanted) return false;
      if (videoOnly && !m.hasVideo) return false;
      if (query) {
        const hay = `${m.title ?? ""} ${m.account} ${m.slug} ${m.attendees.join(" ")}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [rows, account, q, videoOnly, showInternal]);

  // Group: current week by day, older weeks collapsed.
  const { dayGroups, weekGroups } = useMemo(() => groupByRecency(filtered), [filtered]);

  const openChat = (scope: ChatScope) => {
    setChatStarted(false);
    setChatScope(scope);
  };

  const askAboutView = () => {
    const ids = filtered.filter((m) => m.hasTranscript).map((m) => m.botId);
    openChat({
      botIds: ids,
      note:
        `last ${days} days` +
        (account !== "all" ? `, account ${account}` : "") +
        (q.trim() ? `, matching "${q.trim()}"` : "") +
        (videoOnly ? ", with video" : ""),
      label: `${ids.length} meeting${ids.length === 1 ? "" : "s"} in view`,
    });
  };

  const filterPill = (on: boolean) =>
    ({
      borderColor: on ? PLUM : BORDER,
      background: on ? "#F5EDF4" : "#fff",
      color: on ? PLUM : "#52525b",
    }) as const;

  return (
    <div>
      {/* filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
          {DAYS_CHOICES.map((d) => {
            const p = new URLSearchParams();
            if (d !== 30) p.set("days", String(d));
            if (account !== "all") p.set("account", account);
            if (q.trim()) p.set("q", q.trim());
            if (videoOnly) p.set("video", "1");
            if (showInternal) p.set("internal", "1");
            return (
              <Link
                key={d}
                href={`/meetings${p.toString() ? `?${p}` : ""}`}
                scroll={false}
                className="rounded-md px-2.5 py-1 text-sm font-medium no-underline"
                style={d === days ? { background: PLUM, color: "white" } : { color: "#52525b" }}
              >
                {d === 365 ? "1y" : `${d}d`}
              </Link>
            );
          })}
        </div>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            syncUrl({ q: e.target.value }, true);
          }}
          placeholder="Search title, attendee, account…"
          className="min-w-[220px] flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none focus:ring-2"
          style={{ borderColor: BORDER }}
        />
        <select
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            syncUrl({ account: e.target.value });
          }}
          className="max-w-[190px] rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
          style={{ borderColor: BORDER }}
        >
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setVideoOnly(!videoOnly);
            syncUrl({ videoOnly: !videoOnly });
          }}
          className="rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
          style={filterPill(videoOnly)}
        >
          Has video
        </button>
        <button
          type="button"
          onClick={() => {
            setShowInternal(!showInternal);
            syncUrl({ showInternal: !showInternal });
          }}
          className="rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
          style={filterPill(showInternal)}
          title="Internal Reddy meetings are hidden by default"
        >
          Internal
        </button>
        <button
          type="button"
          onClick={askAboutView}
          disabled={filtered.filter((m) => m.hasTranscript).length === 0}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: PLUM }}
        >
          <MessageSquareText size={14} /> Ask about these meetings
        </button>
      </div>

      <p className="mb-3 text-xs text-zinc-400">
        {filtered.length} of {rows.length} meetings · last {days === 365 ? "year" : `${days} days`} · filters live in the URL — copy it to share this exact view
      </p>

      {/* current week, by day */}
      <div className="flex flex-col gap-4">
        {dayGroups.map((g) => (
          <section key={g.key}>
            <h2 className="sticky z-10 mb-1 bg-zinc-50/95 px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400 backdrop-blur" style={{ top: "var(--header-h)" }}>
              {g.label} <span className="font-normal">· {g.meetings.length}</span>
            </h2>
            <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
              {g.meetings.map((m) => (
                <MeetingRow
                  key={m.botId}
                  m={m}
                  shareBase={shareBase}
                  onAsk={(mm) =>
                    openChat({ botIds: [mm.botId], note: `the meeting "${mm.title ?? mm.botId}"`, label: mm.title ?? "1 meeting" })
                  }
                />
              ))}
            </div>
          </section>
        ))}

        {/* older weeks, collapsed */}
        {weekGroups.map((g) => {
          const open = expandedWeeks.has(g.key);
          return (
            <section key={g.key}>
              <button
                type="button"
                onClick={() =>
                  setExpandedWeeks((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
                className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-600"
                aria-expanded={open}
              >
                <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
                {g.label} <span className="font-normal">· {g.meetings.length} meeting{g.meetings.length === 1 ? "" : "s"}</span>
              </button>
              {open && (
                <div className="mt-1 overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
                  {g.meetings.map((m) => (
                    <MeetingRow
                      key={m.botId}
                      m={m}
                      shareBase={shareBase}
                      onAsk={(mm) =>
                        openChat({ botIds: [mm.botId], note: `the meeting "${mm.title ?? mm.botId}"`, label: mm.title ?? "1 meeting" })
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {filtered.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-8 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
            No meetings match these filters.
          </p>
        )}
      </div>

      {/* slide-over chat — scope snapshotted at open */}
      <Drawer
        open={!!chatScope}
        onClose={() => setChatScope(null)}
        title={
          chatScope && (
            <span className="flex flex-wrap items-center gap-1.5">
              Ask about
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium"
                style={{ background: "#F5EDF4", color: PLUM }}
              >
                {chatScope.label}
                {!chatStarted && chatScope.botIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setChatScope(null)}
                    className="rounded-full p-px hover:bg-white/60"
                    aria-label="Clear scope"
                    title="Clear scope and close"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            </span>
          )
        }
      >
        {chatScope && (
          <div onClickCapture={() => setChatStarted(true)} className="h-full">
            <MeetingChatStream
              key={chatScope.botIds.join(",")}
              botIds={chatScope.botIds}
              scopeNote={chatScope.note}
              title="Meetings chat"
              scopeLabel={`${chatScope.botIds.length} transcript${chatScope.botIds.length === 1 ? "" : "s"}`}
              placeholder="Ask across the scoped meetings…"
              starters={[
                "What are the main themes across these meetings?",
                "Which deals or accounts need follow-up?",
                "Summarize the key commitments we made.",
              ]}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}
