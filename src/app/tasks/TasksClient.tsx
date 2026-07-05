"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Video } from "lucide-react";
import Drawer from "@/components/Drawer";
import { TEAM_EMAILS } from "@/lib/team";
import { personName, KIND_LABEL } from "@/app/board/ui-shared";
import { fmtDayPT, dayKeyPT } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER, OK, WARN, INFO } from "@/lib/tokens";

export type TaskRow = {
  id: string;
  title: string;
  status: string;
  kind: string;
  customerSlug: string | null;
  ownerEmail: string | null;
  botAssigned: boolean;
  sourceRef: string | null;
  version: number;
  createdAt: string | null;
  dueAt: string | null;
};

// Status → display group. "Done" collapses to the last 7 days server-side
// cap; dismissed is hidden entirely (archives live on /board).
const GROUPS: Array<{ key: string; label: string; statuses: string[]; color: string }> = [
  { key: "review", label: "Needs review", statuses: ["triage", "suggested"], color: "#8A7C8A" },
  { key: "todo", label: "To do", statuses: ["approved"], color: PLUM },
  { key: "working", label: "In progress", statuses: ["in_progress", "ready_for_review"], color: INFO },
  { key: "waiting", label: "Waiting / blocked", statuses: ["waiting", "blocked"], color: WARN },
  { key: "done", label: "Done", statuses: ["done"], color: OK },
];

const STATUS_CHOICES = [
  { value: "approved", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "dismissed", label: "Dismiss" },
];

const UNTAGGED = "__untagged__";
const SORTS = [
  { value: "recent", label: "Newest" },
  { value: "due", label: "Due date" },
  { value: "title", label: "Title" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

export default function TasksClient({
  tasks,
  viewer,
  focusId,
}: {
  tasks: TaskRow[];
  viewer: string;
  focusId?: string;
}) {
  const router = useRouter();
  const [owner, setOwner] = useState<string>("all");
  const [kindF, setKindF] = useState<string>("all");
  const [custF, setCustF] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");
  // Deep-link from ⌘K search (/tasks?focus=<id>): open that task's drawer on
  // load. Lazy initializer (not an effect) so it's set during first render.
  const [selected, setSelected] = useState<TaskRow | null>(
    () => (focusId ? tasks.find((t) => t.id === focusId) ?? null : null),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const owners = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.ownerEmail).filter((o): o is string => !!o))).sort(),
    [tasks],
  );
  const kinds = useMemo(() => Array.from(new Set(tasks.map((t) => t.kind))).sort(), [tasks]);
  const customers = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.customerSlug).filter((c): c is string => !!c))).sort(),
    [tasks],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tasks.filter((t) => {
      if (t.status === "dismissed") return false;
      if (owner !== "all" && t.ownerEmail !== owner) return false;
      if (kindF !== "all" && t.kind !== kindF) return false;
      if (custF === UNTAGGED ? !!t.customerSlug : custF !== "all" && t.customerSlug !== custF) return false;
      if (q) {
        const hay = `${t.title} ${t.customerSlug ?? ""} ${t.ownerEmail ? personName(t.ownerEmail) : ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const by: Record<Sort, (a: TaskRow, b: TaskRow) => number> = {
      recent: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      // Nulls (no due date) sort last.
      due: (a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...filtered].sort(by[sort]);
  }, [tasks, owner, kindF, custF, sort, query]);

  const mutate = async (action: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/board/ui/task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; reason?: string };
      if (!j.ok) {
        if (j.reason === "conflict") {
          // The drawer holds a stale version — retrying would 409 forever.
          // Close it and reload; the user reopens on fresh data.
          setSelected(null);
          router.refresh();
          window.alert("Someone else changed this task — the list has been refreshed. Please reopen it.");
          return;
        }
        throw new Error(j.error || j.reason || `HTTP ${r.status}`);
      }
      setSelected(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks…"
          className="min-w-[9rem] flex-1 rounded-lg border bg-white px-3 py-1.5 text-sm text-zinc-700 outline-none"
          style={{ borderColor: BORDER }}
        />
        <button
          type="button"
          onClick={() => setOwner(owner === viewer ? "all" : viewer)}
          className="rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
          style={
            owner === viewer
              ? { borderColor: PLUM, background: PLUM_TINT, color: PLUM }
              : { borderColor: BORDER, color: "#52525b" }
          }
        >
          My tasks
        </button>
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
          style={{ borderColor: BORDER }}
        >
          <option value="all">Everyone</option>
          {owners.map((o) => (
            <option key={o} value={o}>{personName(o)}</option>
          ))}
        </select>
        <select
          value={kindF}
          onChange={(e) => setKindF(e.target.value)}
          className="rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
          style={{ borderColor: BORDER }}
        >
          <option value="all">All types</option>
          {kinds.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k] ?? k.replace(/_/g, " ")}</option>
          ))}
        </select>
        {customers.length > 0 && (
          <select
            value={custF}
            onChange={(e) => setCustF(e.target.value)}
            className="rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
            style={{ borderColor: BORDER }}
          >
            <option value="all">All customers</option>
            <option value={UNTAGGED}>Untagged</option>
            {customers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none"
          style={{ borderColor: BORDER }}
          aria-label="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>Sort: {s.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-4">
        {GROUPS.map((g) => {
          const rows = visible.filter((t) => g.statuses.includes(t.status));
          if (rows.length === 0) return null;
          return (
            <section key={g.key} className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
              <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide" style={{ borderColor: "#F1EBF0", color: g.color }}>
                {g.label} · {rows.length}
              </div>
              {rows.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setSelected(t);
                    setComment("");
                    setError(null);
                  }}
                  className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-zinc-50"
                  style={{ borderColor: "#F4EEF3" }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-900">{t.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {t.customerSlug && (
                        <span className="mr-1.5 rounded px-1 py-px text-[10.5px] font-medium" style={{ background: PLUM_TINT, color: PLUM }}>
                          {t.customerSlug}
                        </span>
                      )}
                      {t.ownerEmail ? personName(t.ownerEmail) : "unassigned"}
                      {t.botAssigned && (
                        <span className="ml-1 inline-flex items-center gap-0.5"><Bot size={10} /> bot</span>
                      )}
                      {t.dueAt && <> · due {fmtDayPT(t.dueAt)}</>}
                    </span>
                  </span>
                  {t.sourceRef && <Video size={13} className="shrink-0 text-zinc-300" aria-label="Has a source meeting" />}
                </button>
              ))}
            </section>
          );
        })}
        {visible.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-10 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
            No tasks match.
          </p>
        )}
      </div>

      {/* slide-over: the mutations the old detail page never had */}
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.title} width="max-w-md">
        {selected && (
          <div className="flex flex-col gap-4 overflow-y-auto p-4">
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
              Status
              <select
                defaultValue={selected.status}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value === "dismissed" && !window.confirm("Dismiss this task? It disappears from this list (recoverable from the Board archives).")) {
                    e.target.value = selected.status;
                    return;
                  }
                  void mutate("update", { id: selected.id, expectedVersion: selected.version, patch: { status: e.target.value } });
                }}
                className="rounded-lg border bg-white px-2.5 py-2 text-sm text-zinc-800 outline-none"
                style={{ borderColor: BORDER }}
              >
                {[...new Set([selected.status, ...STATUS_CHOICES.map((s) => s.value)])].map((v) => (
                  <option key={v} value={v}>
                    {STATUS_CHOICES.find((s) => s.value === v)?.label ?? v.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
              Owner
              <select
                defaultValue={selected.ownerEmail ?? ""}
                disabled={busy}
                onChange={(e) =>
                  void mutate("assign", { id: selected.id, expectedVersion: selected.version, ownerEmail: e.target.value || null })
                }
                className="rounded-lg border bg-white px-2.5 py-2 text-sm text-zinc-800 outline-none"
                style={{ borderColor: BORDER }}
              >
                <option value="">Unassigned</option>
                {[...new Set([...(selected.ownerEmail ? [selected.ownerEmail] : []), ...TEAM_EMAILS])].map((o) => (
                  <option key={o} value={o}>{personName(o)}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
              Due date
              <input
                type="date"
                // PT calendar day both ways: display via dayKeyPT and store
                // as 8pm UTC (noon-ish PT) so the row's PT date matches.
                defaultValue={selected.dueAt ? dayKeyPT(selected.dueAt) : ""}
                disabled={busy}
                onChange={(e) =>
                  void mutate("update", {
                    id: selected.id,
                    expectedVersion: selected.version,
                    patch: { dueAt: e.target.value ? new Date(`${e.target.value}T20:00:00Z`).toISOString() : null },
                  })
                }
                className="rounded-lg border bg-white px-2.5 py-2 text-sm text-zinc-800 outline-none"
                style={{ borderColor: BORDER }}
              />
            </label>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) void mutate("comment", { id: selected.id, body: comment.trim() });
              }}
              className="flex flex-col gap-1.5"
            >
              <label className="text-xs font-medium text-zinc-500">Comment</label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Add a note — the bot and Slack threads see these too…"
                className="rounded-lg border px-2.5 py-2 text-sm outline-none"
                style={{ borderColor: BORDER }}
              />
              <button
                type="submit"
                disabled={busy || !comment.trim()}
                className="self-end rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: PLUM }}
              >
                {busy ? "…" : "Post comment"}
              </button>
            </form>

            <div className="flex items-center gap-3 border-t pt-3 text-sm" style={{ borderColor: "#F1EBF0" }}>
              <Link href={`/board/${selected.id}`} className="no-underline hover:underline" style={{ color: PLUM }}>
                Full history →
              </Link>
              {selected.sourceRef && (
                <Link href={`/m/${selected.sourceRef}?from=${selected.id}`} className="no-underline hover:underline" style={{ color: PLUM }}>
                  Source meeting →
                </Link>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
