"use client";

import { useCallback, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { TIME_RANGES, type FilterOption } from "@/lib/view-filters";
import { BORDER, PLUM, PLUM_TINT } from "@/lib/tokens";

// THE reusable filter/sort control (Daybreak Arc VI). A view passes the
// dimensions it supports; state lives entirely in the URL so every filtered
// view is shareable and reload-safe, and the same primitive drives sessions,
// tasks, and meetings. Each dimension maps to one query param:
//   who → person · when → time range · account · channel · status · sort · q
//
// "Mine" is the friendly default (pass `viewer`), but one click widens to the
// whole team — sales is a team sport.

export type FilterBarProps = {
  /** Person dimension (?who=). Include an "all"/"everyone" option yourself. */
  people?: FilterOption[];
  /** Signed-in viewer — powers the one-click "Mine" toggle on the person dim. */
  viewer?: string;
  accounts?: FilterOption[]; // ?account=
  channels?: FilterOption[]; // ?channel=
  statuses?: FilterOption[]; // ?status=
  sorts?: FilterOption[]; // ?sort=
  timeRange?: boolean; // ?when=
  search?: boolean; // ?q=
  searchPlaceholder?: string;
};

export default function FilterBar({
  people,
  viewer,
  accounts,
  channels,
  statuses,
  sorts,
  timeRange,
  search,
  searchPlaceholder = "Search…",
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setParam = useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(sp.toString());
      if (value && value !== "all") p.set(key, value);
      else p.delete(key);
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, sp],
  );

  const cur = (key: string) => sp.get(key) || "all";
  const border = { borderColor: BORDER };
  const selectCls = "rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none";

  // A plain render helper (not a nested component) so selects don't remount.
  const dropdown = (k: string, opts: FilterOption[], label?: string) => (
    <select
      key={k}
      value={cur(k)}
      onChange={(e) => setParam(k, e.target.value)}
      className={selectCls}
      style={border}
      aria-label={label ?? k}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {label ? `${label}: ${o.label}` : o.label}
        </option>
      ))}
    </select>
  );

  const mineActive = !!viewer && cur("who") === viewer;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {search && (
        <input
          type="search"
          defaultValue={sp.get("q") ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (debounce.current) clearTimeout(debounce.current);
            debounce.current = setTimeout(() => setParam("q", v), 300);
          }}
          placeholder={searchPlaceholder}
          className="min-w-[9rem] flex-1 rounded-lg border bg-white px-3 py-1.5 text-sm text-zinc-700 outline-none"
          style={border}
        />
      )}
      {viewer && (
        <button
          type="button"
          onClick={() => setParam("who", mineActive ? "all" : viewer)}
          className="rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
          style={mineActive ? { borderColor: PLUM, background: PLUM_TINT, color: PLUM } : { borderColor: BORDER, color: "#52525b" }}
        >
          Mine
        </button>
      )}
      {people && people.length > 0 && dropdown("who", people)}
      {timeRange && dropdown("when", [...TIME_RANGES])}
      {accounts && accounts.length > 0 && dropdown("account", accounts)}
      {channels && channels.length > 0 && dropdown("channel", channels)}
      {statuses && statuses.length > 0 && dropdown("status", statuses)}
      {sorts && sorts.length > 0 && dropdown("sort", sorts, "Sort")}
    </div>
  );
}
