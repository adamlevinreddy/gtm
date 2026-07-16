"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const PLUM = "#773D72";

type BlockScope = "series" | "occurrence";

type UpcomingMeeting = {
  icalUid: string;
  startTime: string;
  endTime: string | null;
  title: string;
  organizer: string | null;
  attendees: string[];
  isRecurring: boolean;
  hasBot: boolean;
  blocked: BlockScope | null;
  cardMuted: BlockScope | null;
  calendars: string[];
};

type MeetingBlock = {
  key: string;
  scope: BlockScope;
  icalUid: string;
  startTime?: string;
  title?: string;
  addedBy?: string;
  addedAt: string;
};

function fmtTimePT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function fmtDayPT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(d);
}

function dayKeyPT(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

type Scope = "all" | "mine" | "attending";

export default function BotScheduleClient({ viewerEmail }: { viewerEmail: string }) {
  const [scope, setScope] = useState<Scope>("all");
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  const [blocks, setBlocks] = useState<MeetingBlock[]>([]);
  const [cardMutes, setCardMutes] = useState<MeetingBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // busy key currently mid-flight — disables its buttons. Bot ops key on the
  // rowKey/block key; card ops prefix with "card:" so the two clusters on a row
  // disable independently.
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/board/ui/bot-schedule", { cache: "no-store" });
      const json = (await res.json()) as {
        ok: boolean;
        meetings?: UpcomingMeeting[];
        blocks?: MeetingBlock[];
        cardMutes?: MeetingBlock[];
        error?: string;
      };
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMeetings(json.meetings ?? []);
      setBlocks(json.blocks ?? []);
      setCardMutes(json.cardMutes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (opts: {
      action: "block" | "unblock";
      scope: BlockScope;
      icalUid: string;
      startTime?: string;
      title?: string;
      intent?: "bot" | "card";
      busyKey: string;
    }) => {
      setBusy(opts.busyKey);
      try {
        const res = await fetch("/api/board/ui/bot-schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: opts.action,
            scope: opts.scope,
            icalUid: opts.icalUid,
            startTime: opts.startTime,
            title: opts.title,
            intent: opts.intent ?? "bot",
          }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // Filter to the viewer's own meetings. "mine" = they're the organizer (they
  // scheduled it). "attending" = it's on their calendar / they're invited
  // (organizer counts too). Emails are lowercased; Teams meetings with null
  // organizer/attendees fall out of the narrowed views (can't attribute).
  const filtered = useMemo(() => {
    if (scope === "all") return meetings;
    const me = viewerEmail.toLowerCase();
    return meetings.filter((m) => {
      const organizes = (m.organizer ?? "").toLowerCase() === me;
      if (scope === "mine") return organizes;
      return organizes || m.calendars.some((c) => c.toLowerCase() === me) || m.attendees.some((a) => a.toLowerCase() === me);
    });
  }, [meetings, scope, viewerEmail]);

  const byDay = useMemo(() => {
    const groups = new Map<string, UpcomingMeeting[]>();
    for (const m of filtered) {
      const k = dayKeyPT(m.startTime);
      const g = groups.get(k);
      if (g) g.push(m);
      else groups.set(k, [m]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Series blocks (and any occurrence blocks for meetings outside the
  // 14-day window) shown up top so they're removable even when no
  // upcoming instance is in view.
  const visibleUids = useMemo(() => new Set(meetings.map((m) => m.icalUid)), [meetings]);

  if (loading) {
    return (
      <p className="rounded-xl border bg-white px-4 py-6 text-center text-sm text-zinc-400" style={{ borderColor: "#E4DCE3" }}>
        Loading upcoming meetings…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {blocks.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-700">
            Skipped by the bot ({blocks.length})
          </h2>
          <div className="flex flex-col gap-1.5">
            {blocks.map((b) => (
              <div
                key={b.key}
                className="flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5"
                style={{ borderColor: "#E4DCE3" }}
              >
                <span className="text-base">🚫</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {b.title || b.icalUid.slice(0, 40) + "…"}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {b.scope === "series" ? "Entire recurring series" : `Only ${fmtDayPT(b.startTime!)} · ${fmtTimePT(b.startTime!)} PT`}
                    {b.addedBy && <> · skipped by {b.addedBy}</>}
                    {!visibleUids.has(b.icalUid) && <> · not in the next 14 days</>}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy === b.key}
                  onClick={() =>
                    toggle({
                      action: "unblock",
                      scope: b.scope,
                      icalUid: b.icalUid,
                      startTime: b.startTime,
                      busyKey: b.key,
                    })
                  }
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                  style={{ borderColor: "#E4DCE3", color: "#52525b" }}
                >
                  {busy === b.key ? "Restoring…" : "Let bot rejoin"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {cardMutes.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-700">
            Play card muted ({cardMutes.length})
          </h2>
          <div className="flex flex-col gap-1.5">
            {cardMutes.map((b) => (
              <div
                key={b.key}
                className="flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5"
                style={{ borderColor: "#E4DCE3" }}
              >
                <span className="text-base">🔕</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {b.title || b.icalUid.slice(0, 40) + "…"}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {b.scope === "series" ? "Entire recurring series" : `Only ${fmtDayPT(b.startTime!)} · ${fmtTimePT(b.startTime!)} PT`}
                    {b.addedBy && <> · muted by {b.addedBy}</>}
                    {!visibleUids.has(b.icalUid) && <> · not in the next 14 days</>}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy === `card:${b.key}`}
                  onClick={() =>
                    toggle({
                      action: "unblock",
                      scope: b.scope,
                      icalUid: b.icalUid,
                      startTime: b.startTime,
                      intent: "card",
                      busyKey: `card:${b.key}`,
                    })
                  }
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                  style={{ borderColor: "#E4DCE3", color: "#52525b" }}
                >
                  {busy === `card:${b.key}` ? "Restoring…" : "Post card again"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-700">Next 14 days</h2>
          <div className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#E4DCE3" }}>
            {([
              ["all", "Everyone"],
              ["mine", "I organize"],
              ["attending", "I'm attending"],
            ] as [Scope, string][]).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setScope(val)}
                className="border-l px-2.5 py-1 text-xs font-medium transition-colors first:border-l-0"
                style={
                  scope === val
                    ? { background: "#F0E8EF", color: PLUM, borderColor: "#E4DCE3" }
                    : { background: "white", color: "#6b7280", borderColor: "#E4DCE3" }
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {byDay.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-6 text-center text-sm text-zinc-400" style={{ borderColor: "#E4DCE3" }}>
            {scope === "mine"
              ? "No upcoming meetings you organize in the next 14 days."
              : scope === "attending"
                ? "No upcoming meetings on your calendar in the next 14 days."
                : "No upcoming meetings with a join link found."}
          </p>
        )}
        <div className="flex flex-col gap-4">
          {byDay.map(([dayKey, dayMeetings]) => (
            <div key={dayKey}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {fmtDayPT(dayMeetings[0].startTime)}
              </p>
              <div className="flex flex-col gap-1.5">
                {dayMeetings.map((m) => {
                  const rowKey = `${m.icalUid}|${m.startTime}`;
                  const cardKey = `card:${rowKey}`;
                  const skipped = m.blocked !== null;
                  const cardMuted = m.cardMuted !== null;
                  return (
                    <div
                      key={rowKey}
                      className="flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5"
                      style={{
                        borderColor: skipped ? "#FDE68A" : "#E4DCE3",
                        background: skipped ? "#FFFDF5" : "white",
                      }}
                    >
                      <span className="w-16 shrink-0 text-xs text-zinc-500">{fmtTimePT(m.startTime)} PT</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {m.title}
                          {m.isRecurring && (
                            <span
                              className="ml-1.5 rounded px-1 py-0.5 align-middle text-[10px] font-medium"
                              style={{ background: "#F0E8EF", color: PLUM }}
                              title="Recurring meeting"
                            >
                              ↻ recurring
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-zinc-500">
                          {skipped ? (
                            <span className="font-medium text-amber-700">
                              Bot will skip {m.blocked === "series" ? "every occurrence" : "this occurrence"}
                            </span>
                          ) : m.hasBot ? (
                            <span className="text-emerald-700">● Bot joining</span>
                          ) : (
                            <span>○ No bot scheduled</span>
                          )}
                          {m.attendees.length > 0 && (
                            <> · {m.attendees.slice(0, 3).join(", ")}{m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : ""}</>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {/* Notetaker — whether the bot joins & records at all. */}
                        <div className="flex items-center gap-1.5">
                          <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Notetaker</span>
                          {skipped ? (
                            <button
                              type="button"
                              disabled={busy === rowKey}
                              onClick={() =>
                                toggle({
                                  action: "unblock",
                                  scope: m.blocked!,
                                  icalUid: m.icalUid,
                                  startTime: m.blocked === "occurrence" ? m.startTime : undefined,
                                  busyKey: rowKey,
                                })
                              }
                              className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                              style={{ borderColor: "#E4DCE3", color: "#52525b" }}
                            >
                              {busy === rowKey ? "Restoring…" : "Let bot rejoin"}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={busy === rowKey}
                                onClick={() =>
                                  toggle({
                                    action: "block",
                                    scope: "occurrence",
                                    icalUid: m.icalUid,
                                    startTime: m.startTime,
                                    title: m.title,
                                    busyKey: rowKey,
                                  })
                                }
                                className="rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                                style={{ borderColor: "#E4DCE3" }}
                              >
                                {busy === rowKey ? "…" : "Skip once"}
                              </button>
                              {m.isRecurring && (
                                <button
                                  type="button"
                                  disabled={busy === rowKey}
                                  onClick={() =>
                                    toggle({
                                      action: "block",
                                      scope: "series",
                                      icalUid: m.icalUid,
                                      title: m.title,
                                      busyKey: rowKey,
                                    })
                                  }
                                  className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-90 disabled:opacity-50"
                                  style={{ borderColor: "#F0E8EF", background: "#F0E8EF", color: PLUM }}
                                >
                                  {busy === rowKey ? "…" : "Skip series"}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        {/* Play card — the bot still records; this only mutes the
                            post-meeting Slack card of suggested plays. */}
                        <div className="flex items-center gap-1.5">
                          <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Play card</span>
                          {cardMuted ? (
                            <button
                              type="button"
                              disabled={busy === cardKey}
                              onClick={() =>
                                toggle({
                                  action: "unblock",
                                  scope: m.cardMuted!,
                                  icalUid: m.icalUid,
                                  startTime: m.cardMuted === "occurrence" ? m.startTime : undefined,
                                  intent: "card",
                                  busyKey: cardKey,
                                })
                              }
                              className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                              style={{ borderColor: "#E4DCE3", color: "#52525b" }}
                            >
                              {busy === cardKey ? "Restoring…" : "Post card again"}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={busy === cardKey}
                                onClick={() =>
                                  toggle({
                                    action: "block",
                                    scope: "occurrence",
                                    icalUid: m.icalUid,
                                    startTime: m.startTime,
                                    title: m.title,
                                    intent: "card",
                                    busyKey: cardKey,
                                  })
                                }
                                className="rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                                style={{ borderColor: "#E4DCE3" }}
                              >
                                {busy === cardKey ? "…" : "Mute once"}
                              </button>
                              {m.isRecurring && (
                                <button
                                  type="button"
                                  disabled={busy === cardKey}
                                  onClick={() =>
                                    toggle({
                                      action: "block",
                                      scope: "series",
                                      icalUid: m.icalUid,
                                      title: m.title,
                                      intent: "card",
                                      busyKey: cardKey,
                                    })
                                  }
                                  className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-zinc-50 disabled:opacity-50"
                                  style={{ borderColor: "#E4DCE3", color: "#52525b" }}
                                >
                                  {busy === cardKey ? "…" : "Mute series"}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="text-xs text-zinc-400">
        <strong className="font-medium text-zinc-500">Notetaker</strong> — skipping removes the
        already-scheduled bot immediately and keeps it away on every future calendar sync.{" "}
        <strong className="font-medium text-zinc-500">Play card</strong> — muting keeps the bot
        recording (the meeting stays searchable); it only stops the post-meeting card of suggested
        plays from posting to Slack. Times shown in Pacific. Only meetings with a join link are listed.
      </p>
    </div>
  );
}
