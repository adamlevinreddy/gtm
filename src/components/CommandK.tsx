"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, Link2, Video, Building2, Compass, Sparkles, FileText } from "lucide-react";
import { askReddy } from "@/components/ChatDock";
import { PLUM, BORDER, BORDER_SOFT } from "@/lib/tokens";

type QuickItem = {
  type: "meeting" | "account" | "nav" | "file";
  title: string;
  subtitle?: string;
  href: string;
  botId?: string;
};

// Module-level cache: fetched once per soft-navigation session; every
// keystroke filters locally (Daybreak principle: never send an agent —
// or even a network request — to do a 50ms job).
let INDEX_CACHE: { items: QuickItem[]; at: number } | null = null;

// Global ⌘K palette: jump to any meeting/account/page, ⌘↵ copies a
// meeting's share link, and free text falls through to an agent ask.
export default function CommandK() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<QuickItem[]>([]);
  const [sel, setSel] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (INDEX_CACHE && Date.now() - INDEX_CACHE.at < 2 * 60 * 1000) {
      setItems(INDEX_CACHE.items);
      return;
    }
    try {
      const r = await fetch("/api/board/ui/quick-index");
      const j = (await r.json()) as { items?: QuickItem[] };
      if (j.items) {
        INDEX_CACHE = { items: j.items, at: Date.now() };
        setItems(j.items);
      }
    } catch {
      /* palette still works for ask fall-through */
    }
  }, []);

  const openPalette = useCallback(() => {
    setQ("");
    setSel(0);
    setOpen(true);
    void load();
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          if (v) return false;
          // Opening: reset + load via the same path as the button.
          setTimeout(() => openPalette(), 0);
          return v;
        });
      } else if (e.key === "Escape") {
        // The palette advertises "esc" — honor it, and stop the event so an
        // underlying Drawer doesn't close instead of the palette.
        setOpen((v) => {
          if (v) e.stopImmediatePropagation();
          return false;
        });
      }
    };
    // Capture phase so palette-Escape wins over Drawer's window listener.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [openPalette]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items.slice(0, 9);
    const scored = items
      .map((it) => {
        const hay = `${it.title} ${it.subtitle ?? ""}`.toLowerCase();
        let score = -1;
        if (hay.startsWith(query)) score = 3;
        else if (it.title.toLowerCase().includes(query)) score = 2;
        else if (hay.includes(query)) score = 1;
        return { it, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 9).map((s) => s.it);
  }, [items, q]);

  const rows: Array<QuickItem | { type: "ask"; title: string }> = useMemo(() => {
    const base: Array<QuickItem | { type: "ask"; title: string }> = [...results];
    if (q.trim().length > 2) base.push({ type: "ask", title: q.trim() });
    return base;
  }, [results, q]);

  // Clamp at render time (no setState-in-effect): selection can never point
  // past the current result list.
  const selIdx = Math.min(sel, Math.max(0, rows.length - 1));

  const copyLink = async (item: QuickItem) => {
    if (!item.botId) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/m/${item.botId}`);
      setCopiedId(item.botId);
      setTimeout(() => setCopiedId(null), 1200);
    } catch {
      /* ignore */
    }
  };

  const activate = (row: (typeof rows)[number], withMeta: boolean) => {
    if (row.type === "ask") {
      setOpen(false);
      askReddy({ question: row.title });
      return;
    }
    if (withMeta && row.type === "meeting") {
      void copyLink(row);
      return;
    }
    if (row.type === "file") {
      // Library files are API URLs, not app routes — open, don't route.
      setOpen(false);
      window.open(row.href, "_blank", "noreferrer");
      return;
    }
    setOpen(false);
    router.push(row.href);
  };

  const icon = (t: string) =>
    t === "meeting" ? <Video size={14} /> : t === "account" ? <Building2 size={14} /> : t === "file" ? <FileText size={14} /> : t === "ask" ? <Sparkles size={14} /> : <Compass size={14} />;

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        className="hidden items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-600 sm:inline-flex"
        title="Jump to anything"
      >
        <Search size={12} />
        Search
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px]">⌘K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/30 backdrop-blur-[1px]"
          />
          <div
            className="absolute left-1/2 top-[12vh] w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border bg-white shadow-2xl"
            style={{ borderColor: BORDER }}
          >
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: BORDER_SOFT }}>
              <Search size={16} className="text-zinc-400" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSel((s) => Math.min(s + 1, rows.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel((s) => Math.max(s - 1, 0));
                  } else if (e.key === "Enter" && rows[selIdx]) {
                    e.preventDefault();
                    activate(rows[selIdx], e.metaKey || e.ctrlKey);
                  }
                }}
                placeholder="Jump to a meeting, account, or page — or ask anything…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
              />
              <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-400">esc</kbd>
            </div>

            <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
              {rows.map((row, i) => {
                const isAsk = row.type === "ask";
                const item = row as QuickItem;
                return (
                  <button
                    key={isAsk ? "__ask__" : `${item.type}:${item.href}:${item.title}`}
                    type="button"
                    onMouseEnter={() => setSel(i)}
                    onClick={(e) => activate(row, e.metaKey || e.ctrlKey)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left"
                    style={i === selIdx ? { background: "#F5EDF4" } : undefined}
                  >
                    <span className="shrink-0" style={{ color: i === selIdx ? PLUM : "#A1A1AA" }}>
                      {icon(row.type)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-900">
                        {isAsk ? (
                          <>Ask Reddy: <span className="font-medium">“{row.title}”</span></>
                        ) : (
                          item.title
                        )}
                      </span>
                      {!isAsk && item.subtitle && (
                        <span className="block truncate text-xs text-zinc-400">{item.subtitle}</span>
                      )}
                    </span>
                    {i === selIdx && !isAsk && item.type === "meeting" && (
                      <span className="flex shrink-0 items-center gap-2 text-[10px] text-zinc-400">
                        {copiedId === item.botId ? (
                          <span className="text-emerald-600">Link copied</span>
                        ) : (
                          <span className="inline-flex items-center gap-1"><Link2 size={10} />⌘↵ copy link</span>
                        )}
                        <span className="inline-flex items-center gap-1"><CornerDownLeft size={10} />open</span>
                      </span>
                    )}
                  </button>
                );
              })}
              {rows.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-zinc-400">Nothing matches.</p>
              )}
            </div>
          </div>
        </div>
      )}

    </>
  );
}
