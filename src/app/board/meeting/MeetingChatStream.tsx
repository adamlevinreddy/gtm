"use client";

import { useRef, useState } from "react";

const PLUM = "#773D72";

type Msg = { role: "user" | "assistant"; content: string };

export default function MeetingChatStream({
  botIds,
  title = "Ask about this meeting",
  scopeLabel,
  starters,
  placeholder = "Ask a question…",
}: {
  botIds: string[];
  title?: string;
  scopeLabel?: string;
  starters?: string[];
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollDown = () =>
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || streaming || botIds.length === 0) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    scrollDown();
    try {
      const res = await fetch("/api/board/ui/meeting-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botIds, messages: [...history, { role: "user", content: q }] }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error((j as { error?: string } | null)?.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const next = m.slice();
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
        scrollDown();
      }
    } catch (err) {
      setMessages((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: `⚠️ ${err instanceof Error ? err.message : "Something went wrong — try again."}`,
        };
        return next;
      });
    } finally {
      setStreaming(false);
      scrollDown();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
        <span>💬</span>
        <h2 className="text-sm font-semibold" style={{ color: PLUM }}>{title}</h2>
        {scopeLabel && <span className="ml-auto text-xs text-zinc-400">{scopeLabel}</span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-500">
              {botIds.length === 0
                ? "No meetings in scope — adjust the filters."
                : "Claude reads the transcript" + (botIds.length > 1 ? "s" : "") + " and answers here."}
            </p>
            {starters && botIds.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-1">
                {starters.map((s) => (
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
            )}
          </div>
        )}

        {messages.map((m, i) => {
          const isLastAssistant = i === messages.length - 1 && m.role === "assistant";
          return (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className="max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm"
                style={
                  m.role === "user"
                    ? { background: PLUM, color: "white" }
                    : { background: "#F6F2F6", color: "#27272a" }
                }
              >
                {m.content || (isLastAssistant && streaming ? "▍" : "")}
              </div>
            </div>
          );
        })}
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
          placeholder={placeholder}
          className="min-h-[40px] max-h-32 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
          style={{ borderColor: "#E4DCE3" }}
        />
        <button
          type="submit"
          disabled={streaming || !input.trim() || botIds.length === 0}
          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: PLUM }}
        >
          {streaming ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
