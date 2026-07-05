"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Square } from "lucide-react";
import { PLUM, BORDER, BORDER_SOFT } from "@/lib/tokens";

type Msg = { role: "user" | "assistant"; content: string; stopped?: boolean };

// The team chat surface (Daybreak Phase 1) — one component behind the home
// hero, the meetings-hub corpus chat, and the meeting viewer.
//  - Assistant output renders as real GitHub-flavored markdown (tables!).
//  - Stop actually aborts; an elapsed timer keeps the wait honest.
//  - Every run carries a client-minted requestId: if the stream dies or the
//    server times out, we re-poll the agent's result key so the answer lands
//    LATE instead of NEVER ("you there buddy?" dies here).
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
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scoped = !unscoped;
  const ids = botIds ?? [];
  const disabled = scoped && ids.length === 0;

  const scrollDown = () =>
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));

  // Elapsed-seconds ticker while a run is live.
  useEffect(() => {
    if (!streaming) return;
    const t0 = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [streaming]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (latePollRef.current) clearInterval(latePollRef.current);
    },
    [],
  );

  const setLastAssistant = (patch: (prev: Msg) => Msg) =>
    setMessages((m) => {
      const next = m.slice();
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = patch(last);
      return next;
    });

  // The stream died or timed out — but the agent may still finish. Poll its
  // result key so the answer arrives late instead of never.
  const beginLatePoll = (requestId: string) => {
    setStatus("Still working — the answer will appear here when it's ready…");
    const startedAt = Date.now();
    const MAX_MS = 8 * 60 * 1000;
    latePollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > MAX_MS) {
        if (latePollRef.current) clearInterval(latePollRef.current);
        latePollRef.current = null;
        setLastAssistant((p) => ({
          ...p,
          content:
            p.content ||
            "⚠️ The assistant is taking unusually long. Its answer may still land in Slack — or try asking again.",
        }));
        setStreaming(false);
        setStatus(null);
        return;
      }
      try {
        const r = await fetch(`/api/board/ui/meeting-chat/result?id=${requestId}`, { cache: "no-store" });
        const j = (await r.json()) as { ready?: boolean; answer?: string };
        // Re-check AFTER the await: the user may have hit Stop while this
        // tick's fetch was in flight — a stale tick must not overwrite the
        // "Stopped." state.
        if (!latePollRef.current) return;
        if (j.ready && j.answer) {
          clearInterval(latePollRef.current);
          latePollRef.current = null;
          setLastAssistant((p) => ({ ...p, content: j.answer! }));
          setStreaming(false);
          setStatus(null);
          scrollDown();
        }
      } catch {
        /* transient — keep polling */
      }
    }, 6000);
  };

  async function ask(question: string) {
    const q = question.trim();
    if (!q || streaming || disabled) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const requestId = crypto.randomUUID();
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setStatus("Sending…");
    scrollDown();
    abortRef.current = new AbortController();
    // Set once the server accepts the run — gates whether an error is
    // recoverable (poll the result key) or terminal (show it immediately).
    let streamOpened = false;
    try {
      const res = await fetch("/api/board/ui/meeting-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          ...(scoped ? { botIds: ids, scopeNote } : {}),
          requestId,
          messages: [...history, { role: "user", content: q }],
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error((j as { error?: string } | null)?.error || `HTTP ${res.status}`);
      }
      // Past this point the server accepted the run — recovery via the
      // result key is meaningful. Before it (4xx/5xx above), the agent was
      // never invoked and polling would be an 8-minute lie.
      streamOpened = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawTimeout = false;
      let sawDone = false;
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
          setLastAssistant((p) => ({ ...p, content: p.content + evt.text }));
          scrollDown();
        } else if (evt.t === "timeout") {
          sawTimeout = true;
        } else if (evt.t === "done") {
          sawDone = true;
        }
      };
       
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) handleLine(l);
      }
      if (buf) handleLine(buf);
      if (sawTimeout || !sawDone) {
        // Server said "timed out, re-poll" — or the stream was cut before the
        // done sentinel (proxy drop): the run may still finish server-side.
        beginLatePoll(requestId);
        return; // streaming stays true; the late poll owns completion
      }
      setStreaming(false);
      setStatus(null);
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setLastAssistant((p) => ({ ...p, stopped: true }));
        setStreaming(false);
        setStatus(null);
        return;
      }
      if (streamOpened) {
        // Connection dropped mid-run — the agent may still finish; recover late.
        beginLatePoll(requestId);
        return;
      }
      // The run never started (4xx/5xx before streaming) — say so NOW.
      setLastAssistant((p) => ({
        ...p,
        content: `⚠️ ${err instanceof Error ? err.message : "Something went wrong — try again."}`,
      }));
      setStreaming(false);
      setStatus(null);
    } finally {
      scrollDown();
    }
  }

  const stop = () => {
    if (latePollRef.current) {
      clearInterval(latePollRef.current);
      latePollRef.current = null;
      setStreaming(false);
      setStatus(null);
      setLastAssistant((p) => ({ ...p, stopped: true }));
      return;
    }
    abortRef.current?.abort();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
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
                    style={{ borderColor: BORDER }}
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
          const waiting = isLastAssistant && streaming && !m.content;
          return (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              {m.role === "user" ? (
                <div
                  className="max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm"
                  style={{ background: PLUM, color: "white" }}
                >
                  {m.content}
                </div>
              ) : (
                <div className="group max-w-[92%]">
                  <div
                    className="rounded-2xl px-3.5 py-2 text-sm"
                    style={{ background: "#F6F2F6", color: "#27272a" }}
                  >
                    {waiting ? (
                      <span className="inline-flex items-center gap-1.5 text-zinc-500">
                        <span className="animate-pulse">●</span>
                        {status ?? "Working…"}
                        {elapsed >= 3 && <span className="tabular-nums text-zinc-400">{elapsed}s</span>}
                      </span>
                    ) : m.content ? (
                      <Markdown content={m.content} />
                    ) : m.stopped ? (
                      <span className="italic text-zinc-400">Stopped.</span>
                    ) : (
                      ""
                    )}
                    {m.stopped && m.content && (
                      <p className="mt-1 text-[11px] italic text-zinc-400">— stopped early</p>
                    )}
                  </div>
                  {!waiting && m.content && (
                    // Revealed on hover, keyboard focus, AND always on
                    // touch/coarse pointers (group-hover never fires there).
                    <div className="mt-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <CopyAnswer text={m.content} />
                    </div>
                  )}
                </div>
              )}
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
        style={{ borderColor: BORDER_SOFT }}
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
          style={{ borderColor: BORDER }}
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            style={{ borderColor: BORDER }}
            title="Stop this run"
          >
            <Square size={12} fill="currentColor" /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || disabled}
            className="rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: PLUM }}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-700"
      title="Copy answer"
    >
      {copied ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// react-markdown v10 passes the hast `node` into component overrides —
// spreading it onto a DOM element is an unknown-prop; strip it.
function strip<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

// GitHub-flavored markdown with chat-bubble-appropriate styling. Tables get
// their own horizontal scroll so a wide pricing sheet never breaks the panel.
// Code styling lives in globals.css under .chat-md — react-markdown v10 has
// no `inline` flag, and CSS `pre > code` classifies blocks correctly even
// for bare ``` fences with no language tag.
function Markdown({ content }: { content: string }) {
  return (
    <div className="chat-md text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-1.5" {...strip(props)} />,
          ul: (props) => <ul className="my-1.5 list-disc pl-5" {...strip(props)} />,
          ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...strip(props)} />,
          li: (props) => <li className="my-0.5" {...strip(props)} />,
          a: (props) => (
            <a
              className="underline decoration-1 underline-offset-2"
              style={{ color: PLUM }}
              target="_blank"
              rel="noreferrer"
              {...strip(props)}
            />
          ),
          h1: (props) => <p className="mb-1 mt-2 font-semibold" {...strip(props)} />,
          h2: (props) => <p className="mb-1 mt-2 font-semibold" {...strip(props)} />,
          h3: (props) => <p className="mb-1 mt-2 font-semibold" {...strip(props)} />,
          blockquote: (props) => (
            <blockquote className="my-1.5 border-l-2 pl-3 text-zinc-500" style={{ borderColor: PLUM }} {...strip(props)} />
          ),
          table: (props) => (
            <div className="my-2 overflow-x-auto rounded-lg border" style={{ borderColor: BORDER }}>
              <table className="w-full border-collapse text-[13px]" {...strip(props)} />
            </div>
          ),
          thead: (props) => <thead className="bg-zinc-50" {...strip(props)} />,
          th: (props) => (
            <th className="border-b px-2.5 py-1.5 text-left font-semibold" style={{ borderColor: BORDER }} {...strip(props)} />
          ),
          td: (props) => (
            <td className="border-b px-2.5 py-1.5 align-top" style={{ borderColor: BORDER_SOFT }} {...strip(props)} />
          ),
          hr: () => <hr className="my-2 border-zinc-200" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
