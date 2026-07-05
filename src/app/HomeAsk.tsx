"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import Drawer from "@/components/Drawer";
import MeetingChatStream from "@/components/MeetingChatStream";
import { PLUM, BORDER } from "@/lib/tokens";

// The cockpit's ask surface (Daybreak Phase 7): a calm input + real-usage
// starter chips. Conversations live in a slide-over so the cockpit never
// scrolls away underneath one.
export default function HomeAsk({ starters }: { starters: string[] }) {
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState<string | null>(null);

  const fire = (q: string) => {
    if (!q.trim()) return;
    setQuestion(q.trim());
    setDraft("");
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fire(draft);
        }}
        className="rounded-xl border bg-white p-4"
        style={{ borderColor: BORDER }}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={16} style={{ color: PLUM }} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask across every meeting, HubSpot, and the library — same brain as the Slack bot…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: PLUM }}
          >
            Ask
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {starters.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => fire(s)}
              className="rounded-full border px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50"
              style={{ borderColor: BORDER }}
            >
              {s}
            </button>
          ))}
        </div>
      </form>

      <Drawer open={question !== null} onClose={() => setQuestion(null)} title="Ask Reddy GTM">
        {question !== null && (
          <MeetingChatStream
            key={question}
            unscoped
            persist
            title="Ask Reddy GTM"
            scopeLabel="meetings · HubSpot · documents · board"
            placeholder="Follow up…"
            initialQuestion={question}
          />
        )}
      </Drawer>
    </>
  );
}
