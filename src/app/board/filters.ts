// Pure URL <-> filter-spec helpers shared by the server page and the client
// FilterBar. No db / work-items. The filter set is fully reflected in the query
// string so every filtered view is shareable and back/forward works.

export type BoardFilters = {
  board: string; // board key: gtm | success | operations
  view: "kanban" | "list";
  assignee?: string; // owner email, or "__none__" for unassigned
  kind?: string; // work_item kind
  label?: string; // label id
  priority: boolean; // high-priority only
  mine: boolean; // owner == viewer
  customer?: string;
};

export const PARAM_KEYS = [
  "board",
  "view",
  "assignee",
  "kind",
  "label",
  "priority",
  "mine",
  "customer",
] as const;

export const UNASSIGNED = "__none__";
// Company filter value meaning "items with NO customer tag". Without this,
// untagged items (a large share — triage doesn't always set a slug) were
// invisible to every Company-filtered view with no way to find them.
export const UNTAGGED = "__untagged__";

type SP = Record<string, string | string[] | undefined>;
function str(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v === undefined || v === "" ? undefined : v;
}

export function parseFilters(sp: SP): BoardFilters {
  return {
    board: str(sp.board) ?? "gtm",
    view: str(sp.view) === "list" ? "list" : "kanban",
    assignee: str(sp.assignee),
    kind: str(sp.kind),
    label: str(sp.label),
    priority: str(sp.priority) === "1",
    mine: str(sp.mine) === "1",
    customer: str(sp.customer),
  };
}

/** Serialize filters → URLSearchParams (omitting defaults to keep URLs clean). */
export function toSearchParams(f: BoardFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.board && f.board !== "gtm") p.set("board", f.board);
  if (f.view === "list") p.set("view", "list");
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.kind) p.set("kind", f.kind);
  if (f.label) p.set("label", f.label);
  if (f.priority) p.set("priority", "1");
  if (f.mine) p.set("mine", "1");
  if (f.customer) p.set("customer", f.customer);
  return p;
}

export function filtersHref(f: BoardFilters): string {
  const p = toSearchParams(f);
  const qs = p.toString();
  return `/board${qs ? `?${qs}` : ""}`;
}

/** How many *active* filters (used for the "clear" affordance + count). */
export function activeFilterCount(f: BoardFilters): number {
  let n = 0;
  if (f.assignee) n++;
  if (f.kind) n++;
  if (f.label) n++;
  if (f.priority) n++;
  if (f.mine) n++;
  if (f.customer) n++;
  return n;
}
