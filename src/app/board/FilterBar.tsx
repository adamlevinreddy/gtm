"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  type BoardFilters,
  activeFilterCount,
  filtersHref,
  UNASSIGNED,
  UNTAGGED,
} from "./filters";
import { KIND_OPTIONS, PLUM, personName } from "./ui-shared";

export type LabelOption = { id: string; name: string; color: string | null };
export type SavedViewOption = {
  id: string;
  name: string;
  shared: boolean;
  spec: unknown;
};

// Linear-style filter row: compact native <select> pills + toggles. Every
// change rewrites the URL (shareable), the server page re-reads & re-renders.
// No external libs — CSP-safe.
export default function FilterBar({
  filters,
  owners,
  customers,
  labels,
  views,
  viewer,
}: {
  filters: BoardFilters;
  owners: string[];
  customers: string[];
  labels: LabelOption[];
  views: SavedViewOption[];
  viewer: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = useCallback(
    (next: BoardFilters) => {
      startTransition(() => router.push(filtersHref(next)));
    },
    [router]
  );

  const patch = useCallback(
    (p: Partial<BoardFilters>) => go({ ...filters, ...p }),
    [filters, go]
  );

  const active = activeFilterCount(filters);

  // pill styling — looks like a select when it carries a value
  const pill = (on: boolean) =>
    ({
      borderColor: on ? PLUM : "#E4DCE3",
      color: on ? PLUM : "#574B59",
      background: on ? "#F7F0F6" : "#fff",
    }) as const;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2" data-pending={pending}>
      {/* Assignee */}
      <label className="relative inline-flex">
        <select
          aria-label="Filter by assignee"
          value={filters.assignee ?? ""}
          onChange={(e) =>
            patch({ assignee: e.target.value || undefined, mine: false })
          }
          className="cursor-pointer appearance-none rounded-md border py-1 pl-2.5 pr-7 text-xs font-medium"
          style={pill(!!filters.assignee)}
        >
          <option value="">Assignee: any</option>
          <option value={UNASSIGNED}>Unassigned</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {personName(o)}
            </option>
          ))}
        </select>
        <Caret />
      </label>

      {/* Company */}
      {customers.length > 0 && (
        <label className="relative inline-flex">
          <select
            aria-label="Filter by company"
            value={filters.customer ?? ""}
            onChange={(e) => patch({ customer: e.target.value || undefined })}
            className="cursor-pointer appearance-none rounded-md border py-1 pl-2.5 pr-7 text-xs font-medium"
            style={pill(!!filters.customer)}
          >
            <option value="">Company: any</option>
            <option value={UNTAGGED}>No company tag</option>
            {customers.map((c) => (
              <option key={c} value={c}>
                {prettyCompany(c)}
              </option>
            ))}
          </select>
          <Caret />
        </label>
      )}

      {/* Kind */}
      <label className="relative inline-flex">
        <select
          aria-label="Filter by type"
          value={filters.kind ?? ""}
          onChange={(e) => patch({ kind: e.target.value || undefined })}
          className="cursor-pointer appearance-none rounded-md border py-1 pl-2.5 pr-7 text-xs font-medium"
          style={pill(!!filters.kind)}
        >
          <option value="">Type: any</option>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <Caret />
      </label>

      {/* Label */}
      {labels.length > 0 && (
        <label className="relative inline-flex">
          <select
            aria-label="Filter by label"
            value={filters.label ?? ""}
            onChange={(e) => patch({ label: e.target.value || undefined })}
            className="cursor-pointer appearance-none rounded-md border py-1 pl-2.5 pr-7 text-xs font-medium"
            style={pill(!!filters.label)}
          >
            <option value="">Label: any</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <Caret />
        </label>
      )}

      {/* Priority toggle */}
      <button
        type="button"
        onClick={() => patch({ priority: !filters.priority })}
        aria-pressed={filters.priority}
        className="rounded-md border px-2.5 py-1 text-xs font-medium"
        style={pill(filters.priority)}
      >
        ⚑ High priority
      </button>

      {/* My Work toggle */}
      <button
        type="button"
        onClick={() =>
          patch({ mine: !filters.mine, assignee: undefined })
        }
        aria-pressed={filters.mine}
        className="rounded-md border px-2.5 py-1 text-xs font-medium"
        style={pill(filters.mine)}
        title={`Show only work assigned to ${personName(viewer)}`}
      >
        My work
      </button>

      {active > 0 && (
        <a
          href={filtersHref({
            board: filters.board,
            view: filters.view,
            priority: false,
            mine: false,
          })}
          className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 no-underline hover:text-zinc-800"
        >
          Clear ({active})
        </a>
      )}

      <div className="ml-auto">
        <SavedViews filters={filters} views={views} viewer={viewer} />
      </div>
    </div>
  );
}

function prettyCompany(slug: string): string {
  if (slug === "_unsorted") return "Unsorted";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function Caret() {
  return (
    <span
      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-zinc-400"
      aria-hidden="true"
    >
      ▼
    </span>
  );
}

// Saved views: a native <select> to load a view + an inline "Save current"
// control. Writes go through the /api/board/ui/views proxy (holds the secret).
function SavedViews({
  filters,
  views,
  viewer,
}: {
  filters: BoardFilters;
  views: SavedViewOption[];
  viewer: string;
}) {
  const router = useRouter();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = (id: string) => {
    if (!id) return;
    const v = views.find((x) => x.id === id);
    if (!v) return;
    const spec = v.spec as Partial<BoardFilters> | null;
    // keep the current board; saved views store the filter set only
    router.push(
      filtersHref({
        board: filters.board,
        view: (spec?.view as BoardFilters["view"]) ?? filters.view,
        assignee: spec?.assignee,
        kind: spec?.kind,
        label: spec?.label,
        priority: !!spec?.priority,
        mine: !!spec?.mine,
        customer: spec?.customer,
      })
    );
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/board/ui/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          name: trimmed,
          as: viewer,
          spec: {
            view: filters.view,
            assignee: filters.assignee,
            kind: filters.kind,
            label: filters.label,
            priority: filters.priority,
            mine: filters.mine,
            customer: filters.customer,
          },
        }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setNaming(false);
      setName("");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-2">
      {views.length > 0 && (
        <label className="relative inline-flex">
          <select
            aria-label="Load a saved view"
            defaultValue=""
            onChange={(e) => load(e.target.value)}
            className="cursor-pointer appearance-none rounded-md border border-zinc-200 bg-white py-1 pl-2.5 pr-7 text-xs font-medium text-zinc-600"
          >
            <option value="">Saved views…</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.shared ? " (shared)" : ""}
              </option>
            ))}
          </select>
          <Caret />
        </label>
      )}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="View name"
            className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-[#773D72]"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !name.trim()}
            className="rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            style={{ background: PLUM }}
          >
            {busy ? "…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setNaming(false)}
            className="rounded-md px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-700"
          >
            ✕
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-300"
          title="Save the current filters as a view"
        >
          + Save view
        </button>
      )}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}
