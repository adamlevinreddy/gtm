"use client";

import { useCallback, useEffect, useState } from "react";
import { Minus, X, SquarePen, MessageSquareText } from "lucide-react";
import MeetingChatStream from "@/components/MeetingChatStream";
import { PLUM, BORDER, BORDER_SOFT } from "@/lib/tokens";

// The global Ask Reddy dock. Lives in the ROOT LAYOUT so running chats survive
// navigating anywhere. MULTI-SESSION (like Slack): several chats open at once,
// each streaming independently — switch between them via the tab bar, close
// them individually, minimize the whole dock to a pill. A new ask (or "New
// chat") ADDS a tab; it never interrupts one that's running.
//
// Any component opens one via askReddy({...}) — no prop drilling.

export type AskPayload = {
  question?: string;
  botIds?: string[];
  scopeNote?: string;
  title?: string;
  scopeLabel?: string;
  // Persisted onto the created session's scope (label + source) even when
  // unscoped — e.g. tagging a session started from a Play.
  sessionScope?: { label?: string; source?: string };
  // Surface this play first in the launcher's play buttons (opened from the
  // Plays catalog) — the chat starts scoped-visible, you press to run.
  playId?: string;
};

const ASK_EVENT = "reddy:ask";

export function askReddy(payload: AskPayload = {}) {
  window.dispatchEvent(new CustomEvent<AskPayload>(ASK_EVENT, { detail: payload }));
}

type DockChat = AskPayload & { id: string };
let seq = 0; // monotonic id source (Date.now can collide on rapid opens)

function startersFor(c: DockChat): string[] {
  const scoped = (c.botIds?.length ?? 0) > 0;
  return scoped
    ? ["Summarize these meetings and the next steps we owe", "What did we commit to?", "Any risks or blockers to flag?"]
    : ["What have we been working on this week?", "Catch me up on an account", "Draft a follow-up email"];
}

export default function ChatDock() {
  const [chats, setChats] = useState<DockChat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [streamingById, setStreamingById] = useState<Record<string, boolean>>({});

  const anyStreaming = Object.values(streamingById).some(Boolean);

  const addChat = useCallback((payload: AskPayload) => {
    const id = `c${++seq}`;
    setChats((prev) => [...prev, { ...payload, id }]);
    setActiveId(id);
    setMinimized(false);
  }, []);

  useEffect(() => {
    const onAsk = (e: Event) => addChat((e as CustomEvent<AskPayload>).detail ?? {});
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [addChat]);

  // Esc minimizes (never closes) — protects running chats. Bubble phase, so
  // ⌘K's capture-phase Escape still wins while the palette is open.
  useEffect(() => {
    if (chats.length === 0 || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMinimized(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats.length, minimized]);

  const setStreaming = useCallback((id: string, s: boolean) => {
    setStreamingById((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }));
  }, []);

  if (chats.length === 0) return null;
  const active = chats.find((c) => c.id === activeId) ?? chats[chats.length - 1];

  // Defined in render scope so it reads fresh chats/activeId (no setState nested
  // inside another setter's updater).
  const closeChat = (id: string) => {
    if (streamingById[id] && !window.confirm("This chat is still working — close it anyway? (It's saved in Sessions.)")) {
      return;
    }
    const remaining = chats.filter((c) => c.id !== id);
    setChats(remaining);
    if (activeId === id) setActiveId(remaining[remaining.length - 1]?.id ?? null);
    setStreamingById((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
  };

  return (
    <>
      {/* Expanded panel — kept MOUNTED (hidden) while minimized so every chat's
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
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900">
              {active.title ?? "Ask Reddy GTM"}
            </div>
            <button
              type="button"
              onClick={() => addChat({})}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              style={{ borderColor: BORDER }}
              title="Start a new chat — this one keeps running"
            >
              <SquarePen size={12} /> New chat
            </button>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Minimize — keeps every chat working"
              title="Minimize — keeps every chat working"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              onClick={() => closeChat(active.id)}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Close this chat"
              title="Close this chat"
            >
              <X size={16} />
            </button>
          </div>

          {/* Tab bar — one tab per open chat (only when there's more than one). */}
          {chats.length > 1 && (
            <div className="flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5" style={{ borderColor: BORDER_SOFT }}>
              {chats.map((c) => {
                const isActive = c.id === active.id;
                return (
                  <span
                    key={c.id}
                    className="inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs"
                    style={{
                      borderColor: isActive ? PLUM : BORDER,
                      background: isActive ? "#F5EDF4" : "white",
                      color: isActive ? PLUM : "#52525b",
                    }}
                  >
                    <button type="button" onClick={() => setActiveId(c.id)} className="flex min-w-0 items-center gap-1">
                      {streamingById[c.id] && (
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: PLUM }} />
                      )}
                      <span className="truncate font-medium">{c.title ?? "Chat"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => closeChat(c.id)}
                      className="shrink-0 text-zinc-400 hover:text-zinc-700"
                      aria-label="Close this chat"
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* All chats mounted; only the active one is visible (others keep running). */}
          <div className="min-h-0 flex-1">
            {chats.map((c) => {
              const scoped = (c.botIds?.length ?? 0) > 0;
              return (
                <div key={c.id} className={c.id === active.id ? "h-full" : "hidden"}>
                  <MeetingChatStream
                    {...(scoped ? { botIds: c.botIds, scopeNote: c.scopeNote } : { unscoped: true })}
                    persist
                    title={c.title ?? "Ask Reddy GTM"}
                    scopeLabel={c.scopeLabel ?? (scoped ? undefined : "meetings · HubSpot · documents · board")}
                    sessionScope={c.sessionScope}
                    starters={startersFor(c)}
                    suggestPlay={c.playId}
                    placeholder="Ask anything…"
                    initialQuestion={c.question}
                    onStreamingChange={(s) => setStreaming(c.id, s)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Minimized pill — shows how many chats are open + a live "working" dot. */}
      {minimized && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className="flex items-center gap-2 rounded-full border bg-white py-2 pl-3 pr-2 shadow-lg" style={{ borderColor: BORDER }}>
            <button type="button" onClick={() => setMinimized(false)} className="flex min-w-0 items-center gap-2 text-left" title="Expand chats">
              <span className="relative shrink-0" style={{ color: PLUM }}>
                <MessageSquareText size={16} />
                {anyStreaming && <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full" style={{ background: PLUM }} />}
              </span>
              <span className="max-w-[200px] truncate text-xs font-medium text-zinc-800">
                {anyStreaming ? "Reddy is working…" : `${chats.length} chat${chats.length > 1 ? "s" : ""}`}
              </span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
