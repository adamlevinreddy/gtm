import type { WorkItem } from "./schema";

// ============================================================================
// Pure board helpers — NO database/runtime deps (only `import type`), so this
// module is safe to import from client components AND server code. work-items.ts
// re-exports everything here; the /board client island imports it directly.
// ============================================================================

export type WorkItemType = WorkItem["type"];
export type WorkItemKind = WorkItem["kind"];
export type WorkItemStatus = WorkItem["status"];
export type BoardColumn =
  | "Unsorted"
  | "To Do"
  | "Reddy Working"
  | "Reddy Waiting"
  | "Completed";

// kind → type family (type stays frozen at 4 values; callers pass kind)
const KIND_TO_TYPE: Record<WorkItemKind, WorkItemType> = {
  followup_email: "followup",
  book_meeting: "followup",
  reengage_tickler: "followup",
  crm_update: "crm_update",
  log_to_hubspot: "crm_update",
  propose_stage_move: "crm_update",
  meeting_prep: "prep",
  prep_custom_demo: "prep",
  account_research: "prep",
  pricing_proposal: "task",
  deck_qbr: "task",
  rfp_response: "task",
  contract_redline: "task",
  enablement_collateral: "task",
  recording_link: "task",
  scheduling: "task",
  action_items: "task",
  generic: "task",
};
export function typeOfKind(kind: WorkItemKind): WorkItemType {
  return KIND_TO_TYPE[kind] ?? "task";
}

// columns ⇄ status
export const BOARD_COLUMNS: BoardColumn[] = [
  "Unsorted",
  "To Do",
  "Reddy Working",
  "Reddy Waiting",
  "Completed",
];
const STAGE_INDEX: Record<BoardColumn, number> = {
  Unsorted: 0,
  "To Do": 1,
  "Reddy Working": 2,
  "Reddy Waiting": 3,
  Completed: 4,
};

export function columnOf(status: WorkItemStatus): BoardColumn | null {
  switch (status) {
    case "triage":
    case "suggested":
      return "Unsorted";
    case "approved":
      return "To Do";
    case "in_progress":
    case "ready_for_review":
    case "blocked":
      return "Reddy Working";
    case "waiting":
      return "Reddy Waiting";
    case "done":
      return "Completed";
    case "dismissed":
      return null; // Archive — no column
  }
}

/** The canonical landing status when a card is dropped into a column. */
export function dropStatusOf(column: BoardColumn): WorkItemStatus {
  switch (column) {
    case "Unsorted":
      return "triage";
    case "To Do":
      return "approved";
    case "Reddy Working":
      return "in_progress";
    case "Reddy Waiting":
      return "waiting";
    case "Completed":
      return "done";
  }
}

export function stageIndexOf(status: WorkItemStatus): number {
  const c = columnOf(status);
  return c ? STAGE_INDEX[c] : 99;
}

export const OPEN_STATUSES: WorkItemStatus[] = [
  "triage",
  "suggested",
  "approved",
  "in_progress",
  "waiting",
  "blocked",
  "ready_for_review",
];
export const CLOSED_STATUSES: WorkItemStatus[] = ["done", "dismissed"];
export function isOpen(s: WorkItemStatus): boolean {
  return OPEN_STATUSES.includes(s);
}

// priority — derived at read (manual flag OR due within 7 days, while open)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export function effectiveHighPriority(item: WorkItem, now: Date = new Date()): boolean {
  if (item.status === "done" || item.status === "dismissed") return false;
  if (item.highPriority) return true;
  if (item.dueAt && new Date(item.dueAt).getTime() - now.getTime() < WEEK_MS) return true;
  return false;
}
export function priorityClass(item: WorkItem, now: Date = new Date()): "high" | "normal" {
  return effectiveHighPriority(item, now) ? "high" : "normal";
}

// LexoRank-ish manual ordering — fixed-width zero-padded ints sort correctly
const RANK_WIDTH = 12;
const RANK_STEP = 100000;
function pad(n: number): string {
  return Math.max(0, Math.floor(n)).toString().padStart(RANK_WIDTH, "0");
}
export function initialRank(index: number): string {
  return pad((index + 1) * RANK_STEP);
}
/** A rank strictly between a and b; null if they're adjacent (caller rebalances). */
export function rankBetween(a: string | null, b: string | null): string | null {
  const lo = a ? parseInt(a, 10) : 0;
  const hi = b ? parseInt(b, 10) : lo + 2 * RANK_STEP;
  if (hi - lo <= 1) return null;
  return pad(Math.floor((lo + hi) / 2));
}
