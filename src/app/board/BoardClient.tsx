"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  BOARD_COLUMNS,
  effectiveHighPriority,
  type BoardColumn,
} from "@/lib/board-shared";
import type { WorkItem } from "@/lib/schema";
import { Avatar } from "./Avatar";
import { AgingBadge } from "./AgingBadge";
import { KIND_LABEL, PLUM, dueLabel, relTime } from "./ui-shared";

type LabelChip = { id: string; name: string; color: string | null };

const COLUMN_ACCENT: Record<BoardColumn, string> = {
  Unsorted: "#8A7C8A",
  "To Do": PLUM,
  "Reddy Working": "#3A6B8C",
  "Reddy Waiting": "#B07D2E",
  Completed: "#3F7D5B",
};

function LabelChips({ labels }: { labels: LabelChip[] | undefined }) {
  if (!labels || labels.length === 0) return null;
  return (
    <>
      {labels.map((l) => (
        <span
          key={l.id}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: l.color ? `${l.color}22` : "#EEE",
            color: l.color ?? "#555",
            border: `1px solid ${l.color ?? "#DDD"}55`,
          }}
        >
          {l.name}
        </span>
      ))}
    </>
  );
}

// Serialized board crosses the server→client boundary: timestamps arrive as
// strings. Coerce the few Date fields the card reads back into Date objects.
type WireItem = Omit<WorkItem, "createdAt" | "dueAt"> & {
  createdAt: string | Date;
  dueAt: string | Date | null;
};
type WireBoard = Record<BoardColumn, WireItem[]> & { dismissedCount: number };

function hydrate(it: WireItem): WorkItem {
  return {
    ...it,
    createdAt: new Date(it.createdAt),
    dueAt: it.dueAt ? new Date(it.dueAt) : null,
  } as WorkItem;
}

type Toast = { kind: "info" | "error"; text: string } | null;

export default function BoardClient({
  initial,
  viewerEmail,
  labelsByItem = {},
}: {
  initial: WireBoard;
  viewerEmail?: string;
  labelsByItem?: Record<string, LabelChip[]>;
}) {
  const [cols, setCols] = useState<Record<BoardColumn, WorkItem[]>>(() => {
    const out = {} as Record<BoardColumn, WorkItem[]>;
    for (const c of BOARD_COLUMNS) out[c] = (initial[c] ?? []).map(hydrate);
    return out;
  });
  const dismissedCount = initial.dismissedCount ?? 0;
  const now = useMemo(() => new Date(), []);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<BoardColumn | null>(null);
  const [overCol, setOverCol] = useState<BoardColumn | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((t: Exclude<Toast, null>, ms = 3200) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const colOf = useCallback(
    (id: string): BoardColumn | null => {
      for (const c of BOARD_COLUMNS) if (cols[c].some((i) => i.id === id)) return c;
      return null;
    },
    [cols]
  );

  // Full re-fetch (used after a conflict so we converge on the truth).
  const refetch = useCallback(async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const res = await fetch(`/api/board/ui/board?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; board?: WireBoard };
      if (data.ok && data.board) {
        const next = {} as Record<BoardColumn, WorkItem[]>;
        for (const c of BOARD_COLUMNS) next[c] = (data.board[c] ?? []).map(hydrate);
        setCols(next);
      }
    } catch {
      /* leave optimistic state; user can hard-reload */
    }
  }, []);

  const onDrop = useCallback(
    async (target: BoardColumn) => {
      const id = dragId;
      const from = dragFrom;
      setOverCol(null);
      setDragId(null);
      setDragFrom(null);
      if (!id || !from || from === target) return;

      const moving = cols[from].find((i) => i.id === id);
      if (!moving) return;
      const expectedVersion = moving.version;

      // optimistic: pop from source, push to head of target
      const prev = cols;
      setCols((c) => {
        const next = { ...c };
        next[from] = c[from].filter((i) => i.id !== id);
        next[target] = [moving, ...c[target]];
        return next;
      });

      try {
        const res = await fetch("/api/board/ui/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, expectedVersion, column: target, as: viewerEmail }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
          item?: WireItem;
          current?: WireItem | null;
        };

        if (res.ok && data.ok && data.item) {
          // reconcile to the authoritative row (new version/status)
          const fresh = hydrate(data.item);
          setCols((c) => {
            const next = { ...c };
            for (const col of BOARD_COLUMNS) next[col] = next[col].filter((i) => i.id !== id);
            next[target] = next[target].map((i) => (i.id === id ? fresh : i));
            if (!next[target].some((i) => i.id === id)) next[target] = [fresh, ...next[target]];
            return next;
          });
          return;
        }

        if (res.status === 409 || data.reason === "conflict") {
          flash({ kind: "error", text: "Someone changed this — reloading…" });
          setCols(prev); // revert before reconcile
          await refetch();
          return;
        }

        // not_found / other: revert + inform
        setCols(prev);
        flash({ kind: "error", text: data.reason === "not_found" ? "That card no longer exists." : "Move failed — reverted." });
      } catch {
        setCols(prev);
        flash({ kind: "error", text: "Network error — move reverted." });
      }
    },
    [cols, dragId, dragFrom, flash, refetch, viewerEmail]
  );

  return (
    <div className="mt-5">
      <div className="flex gap-3 overflow-x-auto pb-3">
        {BOARD_COLUMNS.map((col) => {
          const isOver = overCol === col;
          const canDrop = dragFrom !== null && dragFrom !== col;
          return (
            <section
              key={col}
              className="flex w-72 shrink-0 flex-col gap-2"
              onDragOver={(e) => {
                if (dragId) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overCol !== col) setOverCol(col);
                }
              }}
              onDragLeave={(e) => {
                // only clear if leaving the column subtree
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  if (overCol === col) setOverCol(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                void onDrop(col);
              }}
            >
              <div className="flex items-baseline gap-2 border-b-2 pb-1.5" style={{ borderColor: COLUMN_ACCENT[col] }}>
                <h2 className="text-sm font-semibold text-zinc-900">{col}</h2>
                <span className="text-xs text-zinc-400">{cols[col].length}</span>
              </div>
              <div
                className="flex min-h-16 flex-col gap-2 rounded-lg transition-colors"
                style={
                  isOver && canDrop
                    ? { outline: `2px dashed ${COLUMN_ACCENT[col]}`, outlineOffset: 2, background: "#FBF8FB" }
                    : undefined
                }
              >
                {cols[col].length === 0 ? (
                  <p className="rounded-lg border border-dashed border-zinc-200 p-2.5 text-center text-xs text-zinc-300">
                    {isOver && canDrop ? "drop here" : "empty"}
                  </p>
                ) : (
                  cols[col].map((it) => (
                    <DraggableCard
                      key={it.id}
                      item={it}
                      now={now}
                      labels={labelsByItem[it.id]}
                      dragging={dragId === it.id}
                      onDragStart={() => {
                        setDragId(it.id);
                        setDragFrom(colOf(it.id));
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragFrom(null);
                        setOverCol(null);
                      }}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      {dismissedCount > 0 && (
        <p className="mt-3 text-xs text-zinc-400">+ {dismissedCount} archived (dismissed)</p>
      )}

      {toast && (
        <div
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
          style={
            toast.kind === "error"
              ? { background: "#7A2E2E", color: "#fff" }
              : { background: PLUM, color: "#fff" }
          }
          role="status"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function DraggableCard({
  item,
  now,
  labels,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItem;
  now: Date;
  labels?: LabelChip[];
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const high = effectiveHighPriority(item, now);
  return (
    <div
      id={`item-${item.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="cursor-grab rounded-lg border p-2.5 shadow-sm active:cursor-grabbing"
      style={{
        opacity: dragging ? 0.4 : 1,
        ...(high
          ? { background: "#FCF3E7", borderColor: "#E8C99A", borderLeft: "3px solid #B07D2E" }
          : { background: "#fff", borderColor: "#E4DCE3" }),
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: "#F0E8EF", color: PLUM }}
        >
          {KIND_LABEL[item.kind] ?? item.kind}
        </span>
        {item.customerSlug && <span className="truncate text-xs text-zinc-500">{item.customerSlug}</span>}
        {item.status === "blocked" && (
          <span className="rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: "#F3E3E3", color: "#A84A4A" }}>BLOCKED</span>
        )}
        {item.status === "ready_for_review" && (
          <span className="rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: "#E5EEF4", color: "#3A6B8C" }}>REVIEW</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{relTime(item.createdAt)}</span>
      </div>
      <a
        href={`/board/${item.id}`}
        draggable={false}
        className="mt-1.5 block text-sm font-medium leading-snug text-zinc-900 no-underline hover:underline"
      >
        {item.title}
      </a>
      {labels && labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <LabelChips labels={labels} />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
        <span className="flex min-w-0 items-center gap-1">
          <Avatar email={item.ownerEmail} size={16} />
          <span className={item.ownerEmail ? "truncate text-zinc-500" : "italic text-zinc-400"}>
            {item.ownerEmail ? item.ownerEmail.split("@")[0] : "unassigned"}
          </span>
          {item.botAssigned && <span title="Reddy bot co-assigned">🤖</span>}
        </span>
        {item.childTotalCount > 0 && (
          <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">▦ {item.childTotalCount - item.childOpenCount}/{item.childTotalCount}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <AgingBadge item={item} now={now} />
          {item.dueAt && <span className={dueLabel(item.dueAt).cls}>{dueLabel(item.dueAt).text}</span>}
        </span>
      </div>
    </div>
  );
}
