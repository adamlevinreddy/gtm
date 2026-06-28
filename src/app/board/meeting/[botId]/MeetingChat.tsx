"use client";

import { useRef, useState } from "react";

const PLUM = "#773D72";

type Msg = { role: "user" | "assistant"; text: string };

const STARTERS = [
  "Summarize this meeting",
  "What are the action items and who owns them?",
  "What objections or concerns came up?",
  "What did we commit to?",
];

export default function MeetingChat({ botId }: { botId: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setPending(true);
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
    try {
      const res = await fetch("/api/board/ui/meeting-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId, question: q, history }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string; error?: string } | null;
      const text =
        json?.ok && json.answer
          ? json.answer
          : `⚠️ ${json?.error || "Couldn't reach the assistant. Try again in a moment."}`;
      setMessages((m) => [...m, { role: "assistant", text }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "⚠️ Network error — try again." }]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
        <span>💬</span>
        <h2 className="text-sm font-semibold" style={{ color: PLUM }}>
          Ask about this meeting
        </h2>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-500">
              Ask anything about this conversation — Claude reads the transcript and answers here.
            </p>
            <div className="flex flex-col gap-1.5 pt-1">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-lg border px-3 py-1.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50"
                  style={{ borderColor: "#E4DCE3" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className="max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm"
              style={
                m.role === "user"
                  ? { background: PLUM, color: "white" }
                  : { background: "#F6F2F6", color: "#27272a" }
              }
            >
              {m.text}
            </div>
          </div>
        ))}

        {pending && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-3.5 py-2 text-sm text-zinc-400" style={{ background: "#F6F2F6" }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: PLUM }} />
                Reading the transcript…
              </span>
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        className="flex items-end gap-2 border-t px-3 py-3"
        style={{ borderColor: "#EFE5EE" }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
          rows={1}
          placeholder="Ask about this meeting…"
          className="min-h-[40px] max-h-32 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
          style={{ borderColor: "#E4DCE3" }}
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: PLUM }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
