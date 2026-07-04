"use client";

import { useRef, useState } from "react";

const PLUM = "#773D72";

type Msg = { role: "user" | "assistant"; content: string };

// Chat panel wired to /api/board/ui/meeting-chat (NDJSON protocol:
// status lines while the agent works, then delta chunks). Scoped when
// `botIds` is set; open-ended (full cross-source brain) when omitted.
export default function MeetingChatStream({
  botIds,
  scopeNote,
  title = "Ask about this meeting",
  scopeLabel,
  starters,
  placeholder = "Ask a question…",
  unscoped = false,
}: {
  botIds?: string[];
  /** Human description of the filter behind botIds — passed to the agent. */
  scopeNote?: string;
  title?: string;
  scopeLabel?: string;
  starters?: string[];
  placeholder?: string;
  /** true → no meeting scope: the agent answers from everything it has. */
  unscoped?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scoped = !unscoped;
  const ids = botIds ?? [];
  const disabled = scoped && ids.length === 0;

  const scrollDown = () =>
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || streaming || disabled) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setStatus("Sending…");
    scrollDown();
    try {
      const res = await fetch("/api/board/ui/meeting-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(scoped ? { botIds: ids, scopeNote } : {}),
          messages: [...history, { role: "user", content: q }],
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error((j as { error?: string } | null)?.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handleLine = (raw: string) => {
        if (!raw.trim()) return;
        let evt: { t?: string; text?: string };
        try {
          evt = JSON.parse(raw) as { t?: string; text?: string };
        } catch {
          return;
        }
        if (evt.t === "status" && evt.text) {
          setStatus(evt.text);
        } else if (evt.t === "delta" && evt.text) {
          setStatus(null);
          setMessages((m) => {
            const next = m.slice();
            next[next.length - 1] = {
              role: "assistant",
              content: next[next.length - 1].content + evt.text,
            };
            return next;
          });
          scrollDown();
        }
      };
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) handleLine(l);
      }
      if (buf) handleLine(buf);
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
      setStatus(null);
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
              {disabled
                ? "No meetings in scope — adjust the filters."
                : scoped
                  ? "Claude reads the transcript" + (ids.length > 1 ? "s" : "") + " and answers here."
                  : "Ask across every meeting, HubSpot, and the library — same brain as the Slack bot."}
            </p>
            {starters && !disabled && (
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
                {m.content ||
                  (isLastAssistant && streaming ? (
                    <span className="inline-flex items-center gap-1.5 text-zinc-500">
                      <span className="animate-pulse">●</span>
                      {status ?? "Working…"}
                    </span>
                  ) : (
                    ""
                  ))}
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
          disabled={streaming || !input.trim() || disabled}
          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: PLUM }}
        >
          {streaming ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
