"use client";

import { useCallback, useEffect, useState } from "react";
import { Minus, X, SquarePen, MessageSquareText, ChevronUp } from "lucide-react";
import MeetingChatStream from "@/components/MeetingChatStream";
import { PLUM, BORDER, BORDER_SOFT } from "@/lib/tokens";

// The global Ask Reddy dock. Lives in the ROOT LAYOUT so a running chat
// survives navigating anywhere in the app: minimize it to a bottom-right
// pill (with a live "still working" dot), keep browsing, expand it back.
// "New chat" starts a fresh session; the old one is already saved in /s.
//
// Any component opens it via askReddy({...}) — no prop drilling, no
// per-page drawers that die with their page.

export type AskPayload = {
  question?: string;
  botIds?: string[];
  scopeNote?: string;
  title?: string;
  scopeLabel?: string;
  // Persisted onto the created session's scope (label + source), so an
  // unscoped chat started from e.g. a Play is tagged + filterable in /s. Unlike
  // scopeLabel (a live header-only hint), this survives to the record.
  sessionScope?: { label?: string; source?: string };
};

const ASK_EVENT = "reddy:ask";

export function askReddy(payload: AskPayload = {}) {
  window.dispatchEvent(new CustomEvent<AskPayload>(ASK_EVENT, { detail: payload }));
}

type DockChat = AskPayload & { key: number };

export default function ChatDock() {
  const [chat, setChat] = useState<DockChat | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<AskPayload>).detail ?? {};
      setChat((prev) => {
        // Same guard as Close: a NEW ask must not silently kill a run that's
        // still streaming — the user chooses.
        if (
          prev &&
          streaming &&
          !window.confirm("The assistant is still working on your last question — replace it? (It's saved in Sessions.)")
        ) {
          return prev;
        }
        return { ...detail, key: Date.now() };
      });
      setMinimized(false);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [streaming]);

  // Esc minimizes (never closes) — protects a running chat. Bubble phase, so
  // ⌘K's capture-phase Escape still wins while the palette is open.
  useEffect(() => {
    if (!chat || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMinimized(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat, minimized]);

  const newChat = useCallback(() => {
    if (streaming && !window.confirm("The assistant is still working — start a new chat anyway? (This one is saved in Sessions.)")) {
      return;
    }
    setChat({ key: Date.now() });
    setMinimized(false);
    setStreaming(false);
  }, [streaming]);

  const close = useCallback(() => {
    // The conversation is already persisted to /s turn-by-turn — closing
    // loses nothing except a still-running answer, so warn only then.
    if (streaming && !window.confirm("The assistant is still working — close anyway? (Minimize keeps it running.)")) {
      return;
    }
    setChat(null);
    setStreaming(false);
  }, [streaming]);

  if (!chat) return null;

  const scoped = (chat.botIds?.length ?? 0) > 0;
  const title = chat.title ?? "Ask Reddy GTM";

  return (
    <>
      {/* Expanded panel — kept MOUNTED (hidden) while minimized so the
          stream, late-poll, and persistence keep running untouched. */}
      <div className={minimized ? "hidden" : "fixed inset-0 z-50"} role="dialog" aria-modal="true">
        <button
          type="button"
          aria-label="Minimize chat"
          onClick={() => setMinimized(true)}
          className="absolute inset-0 h-full w-full cursor-default bg-black/25 backdrop-blur-[1px]"
        />
        <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl">
          <div className="flex items-center gap-1.5 border-b px-4 py-3" style={{ borderColor: BORDER_SOFT }}>
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900">{title}</div>
            <button
              type="button"
              onClick={newChat}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              style={{ borderColor: BORDER }}
              title="Start a new chat (this one is saved in Sessions)"
            >
              <SquarePen size={12} /> New chat
            </button>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Minimize — keeps the assistant working"
              title="Minimize — keeps the assistant working"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <MeetingChatStream
              key={chat.key}
              {...(scoped
                ? { botIds: chat.botIds, scopeNote: chat.scopeNote }
                : { unscoped: true })}
              persist
              title={title}
              scopeLabel={chat.scopeLabel ?? (scoped ? undefined : "meetings · HubSpot · documents · board")}
              sessionScope={chat.sessionScope}
              placeholder="Ask anything…"
              initialQuestion={chat.question}
              onStreamingChange={setStreaming}
            />
          </div>
        </div>
      </div>

      {/* Minimized pill */}
      {minimized && (
        <div className="fixed bottom-4 right-4 z-50">
          <div
            className="flex items-center gap-2 rounded-full border bg-white py-2 pl-3 pr-2 shadow-lg"
            style={{ borderColor: BORDER }}
          >
            <button
              type="button"
              onClick={() => setMinimized(false)}
              className="flex min-w-0 items-center gap-2 text-left"
              title="Expand chat"
            >
              <span className="relative shrink-0" style={{ color: PLUM }}>
                <MessageSquareText size={16} />
                {streaming && (
                  <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full" style={{ background: PLUM }} />
                )}
              </span>
              <span className="max-w-[200px] truncate text-xs font-medium text-zinc-800">
                {streaming ? "Reddy is working…" : title}
              </span>
              <ChevronUp size={13} className="shrink-0 text-zinc-400" />
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-full p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600"
              aria-label="Close chat"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
