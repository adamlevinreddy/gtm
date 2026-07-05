"use client";

import Link from "next/link";
import { Video, FileText, Link2, MessageSquareText } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import { fmtTimePT, fmtDuration } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER } from "@/lib/tokens";

export type MeetingRowData = {
  botId: string;
  title: string | null;
  slug: string;
  account: string;
  isInternal: boolean;
  startedAt: string | null;
  endedAt: string | null;
  attendees: string[];
  hasTranscript: boolean;
  hasVideo: boolean;
  /** Signed Mux poster URL (server-minted) — null when no mux asset. */
  thumbUrl: string | null;
  tasks: Array<{ id: string; title: string; status: string }>;
};

// THE meeting row — shared by /meetings, account pages, and the cockpit.
// Dense, scannable: poster thumb, title, account chip, time · duration,
// attendees; hover (or touch) reveals Copy-link and Ask.
export default function MeetingRow({
  m,
  shareBase,
  onAsk,
}: {
  m: MeetingRowData;
  shareBase: string;
  onAsk?: (m: MeetingRowData) => void;
}) {
  const duration = fmtDuration(m.startedAt, m.endedAt);
  return (
    <div
      className="group flex items-center gap-3 border-b px-3 py-2 transition-colors last:border-b-0 hover:bg-zinc-50"
      style={{ borderColor: "#F1EBF0" }}
    >
      {/* poster */}
      <Link
        href={`/m/${m.botId}?customer=${encodeURIComponent(m.slug)}`}
        className="relative block h-9 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-100"
        tabIndex={-1}
        aria-hidden
      >
        {m.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-zinc-300">
            <Video size={14} />
          </span>
        )}
        {duration && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] font-medium tabular-nums text-white">
            {duration}
          </span>
        )}
      </Link>

      {/* title + meta */}
      <Link
        href={`/m/${m.botId}?customer=${encodeURIComponent(m.slug)}`}
        className="min-w-0 flex-1 no-underline"
      >
        <p className="truncate text-sm font-medium text-zinc-900">
          {m.title || "(untitled meeting)"}
        </p>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {!m.isInternal && (
            <span
              className="mr-1.5 rounded px-1 py-px text-[10.5px] font-medium"
              style={{ background: PLUM_TINT, color: PLUM }}
            >
              {m.account}
            </span>
          )}
          {m.startedAt && <span className="tabular-nums">{fmtTimePT(m.startedAt)}</span>}
          {m.attendees.length > 0 && (
            <> · {m.attendees.slice(0, 3).join(", ")}{m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : ""}</>
          )}
          {m.tasks.length > 0 && <> · {m.tasks.length} task{m.tasks.length > 1 ? "s" : ""}</>}
        </p>
      </Link>

      {/* actions + flags */}
      <div className="flex shrink-0 items-center gap-1.5 text-zinc-400">
        <span className="flex items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton
            text={() => `${shareBase || window.location.origin}/m/${m.botId}`}
            label="Copy link"
            icon={<Link2 size={12} />}
            title="Permanent share link — never expires"
          />
          {onAsk && m.hasTranscript && (
            <button
              type="button"
              onClick={() => onAsk(m)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
              style={{ borderColor: BORDER }}
              title="Ask about this meeting"
            >
              <MessageSquareText size={12} /> Ask
            </button>
          )}
        </span>
        {m.hasTranscript && <FileText size={13} aria-label="Has transcript" />}
      </div>
    </div>
  );
}
