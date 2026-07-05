"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquareText, MessagesSquare, ListChecks } from "lucide-react";
import MeetingChatStream from "@/components/MeetingChatStream";
import { PLUM, BORDER_SOFT, PLUM_TINT } from "@/lib/tokens";

type Task = { id: string; title: string; status: string };

const STATUS_LABEL: Record<string, string> = {
  triage: "Triage", suggested: "Suggested", approved: "To Do", in_progress: "In progress",
  ready_for_review: "Review", blocked: "Blocked", waiting: "Waiting", done: "Done", dismissed: "Dismissed",
};

// Linkify bare URLs in in-meeting chat lines — links pasted mid-call are
// the whole reason this tab exists.
function ChatLine({ line }: { line: string }) {
  const parts = line.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <p className="text-[13px] leading-relaxed text-zinc-700">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2" style={{ color: PLUM }}>
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

// Right panel of the meeting Theater (Daybreak Phase 5): Ask (agent chat),
// In-meeting chat (chat.txt — recorded since day one, shown for the first
// time), and the tasks this meeting produced.
export default function TheaterPanel({
  botId,
  chatText,
  tasks,
}: {
  botId: string;
  chatText: string | null;
  tasks: Task[];
}) {
  const tabs = [
    { key: "ask", label: "Ask", icon: <MessageSquareText size={13} /> },
    ...(chatText ? [{ key: "chat", label: "In-meeting chat", icon: <MessagesSquare size={13} /> }] : []),
    ...(tasks.length ? [{ key: "tasks", label: `Tasks (${tasks.length})`, icon: <ListChecks size={13} /> }] : []),
  ];
  const [tab, setTab] = useState("ask");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabs.length > 1 && (
        <div className="flex items-center gap-1 border-b px-2 py-1.5" style={{ borderColor: BORDER_SOFT }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              style={tab === t.key ? { background: PLUM_TINT, color: PLUM } : { color: "#71717A" }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Keep the chat MOUNTED across tab switches — flipping to the chat.txt
          tab must never destroy a conversation in progress. */}
      <div className={tab === "ask" ? "min-h-0 flex-1" : "hidden"}>
        <MeetingChatStream
          botIds={[botId]}
          starters={[
            "Summarize this meeting",
            "What are the action items and who owns them?",
            "What objections or concerns came up?",
            "What did we commit to?",
          ]}
          placeholder="Ask about this meeting…"
        />
      </div>

      {tab === "chat" && chatText && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
          {chatText.split(/\r?\n/).map((l, i) => (l.trim() ? <ChatLine key={i} line={l} /> : <div key={i} className="h-1" />))}
        </div>
      )}

      {tab === "tasks" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <Link
                key={t.id}
                href={`/board/${t.id}`}
                className="rounded-lg border px-3 py-2 no-underline hover:bg-zinc-50"
                style={{ borderColor: "#E4DCE3" }}
              >
                <p className="text-sm text-zinc-900">{t.title}</p>
                <p className="mt-0.5 text-xs" style={{ color: PLUM }}>
                  {STATUS_LABEL[t.status] ?? t.status}
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
