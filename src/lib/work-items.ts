import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "./db";
import {
  workItems,
  workItemActivities,
  type WorkItem,
  type NewWorkItem,
  type NewWorkItemActivity,
} from "./schema";

// ============================================================================
// The board spine. Columns are a VIEW over the lifecycle status (COLUMN_OF) —
// there is NO stored column field. Every field mutation goes through the
// version-CAS choke point applyWorkItemUpdate(); append-only activities never
// guard. Priority is derived at read. Subtasks are a self-FK with cascade.
// ============================================================================

// Pure board helpers live in ./board-shared (client-safe, no DB). Imported for
// internal use and re-exported so existing consumers keep importing them from
// "@/lib/work-items".
import {
  typeOfKind,
  columnOf,
  dropStatusOf,
  stageIndexOf,
  BOARD_COLUMNS,
  OPEN_STATUSES,
  isOpen,
  effectiveHighPriority,
  priorityClass,
  initialRank,
  rankBetween,
  type WorkItemType,
  type WorkItemKind,
  type WorkItemStatus,
  type BoardColumn,
} from "./board-shared";
export {
  typeOfKind,
  columnOf,
  dropStatusOf,
  stageIndexOf,
  BOARD_COLUMNS,
  OPEN_STATUSES,
  effectiveHighPriority,
  priorityClass,
  initialRank,
  rankBetween,
};
export type { WorkItemType, WorkItemKind, WorkItemStatus, BoardColumn };

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function selfBaseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
export function boardUrl(): string {
  return process.env.TRACKING_BOARD_URL || `${selfBaseUrl()}/board`;
}
export function itemUrl(id: string): string {
  return `${selfBaseUrl()}/board/${id}`;
}

// ---------------------------------------------------------------------------
// PT date helpers (digest)
// ---------------------------------------------------------------------------

export function ptDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}
export function ptYesterday(d: Date = new Date()): string {
  const [y, m, day] = ptDate(d).split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(anchor);
}
function humanDate(ymd: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

// (rank helpers initialRank / rankBetween live in ./board-shared, re-exported above)

// ---------------------------------------------------------------------------
// payload shapes (per kind; all extend BasePayload)
// ---------------------------------------------------------------------------

export type BasePayload = {
  detail?: string;
  dueHint?: string;
  artifactUrl?: string;
  threadRef?: string;
  rationale?: string;
};
export type WorkItemPayload = BasePayload & Record<string, unknown>;

// ---------------------------------------------------------------------------
// activity ledger (append-only; never guards — cannot conflict)
// ---------------------------------------------------------------------------

export type ActivityInput = {
  kind: NewWorkItemActivity["kind"];
  actorKind: NewWorkItemActivity["actorKind"];
  actorEmail?: string | null;
  body?: string | null;
  meta?: unknown;
  occurredAt?: Date;
  dedupeKey?: string | null;
};

export async function logActivity(workItemId: string, a: ActivityInput): Promise<void> {
  await db
    .insert(workItemActivities)
    .values({
      workItemId,
      kind: a.kind,
      actorKind: a.actorKind,
      actorEmail: a.actorEmail ?? null,
      body: a.body ?? null,
      meta: (a.meta as object) ?? null,
      occurredAt: a.occurredAt ?? new Date(),
      dedupeKey: a.dedupeKey ?? null,
    })
    .onConflictDoNothing();
}
export async function addComment(
  workItemId: string,
  body: string,
  actorEmail: string
): Promise<void> {
  await logActivity(workItemId, { kind: "comment", actorKind: "human", actorEmail, body });
}
export async function getActivities(workItemId: string, limit = 200) {
  return db
    .select()
    .from(workItemActivities)
    .where(eq(workItemActivities.workItemId, workItemId))
    .orderBy(asc(workItemActivities.occurredAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// THE choke point — every field mutation goes through here (version-CAS)
// ---------------------------------------------------------------------------

export type UpdateResult =
  | { ok: true; item: WorkItem }
  | { ok: false; reason: "conflict" | "not_found"; current: WorkItem | null };

/**
 * Compare-and-swap on `version`. On success bumps version, stamps updatedAt,
 * and (optionally) appends one activity row in the SAME transaction so the
 * ledger and the projection never diverge.
 */
export async function applyWorkItemUpdate(
  id: string,
  expectVersion: number,
  patch: Partial<NewWorkItem>,
  activity?: ActivityInput
): Promise<UpdateResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(workItems)
      .set({ ...patch, version: sql`${workItems.version} + 1`, updatedAt: new Date() })
      .where(and(eq(workItems.id, id), eq(workItems.version, expectVersion)))
      .returning();
    const item = rows[0];
    if (!item) {
      const cur = await tx.select().from(workItems).where(eq(workItems.id, id)).limit(1);
      return { ok: false, reason: cur[0] ? "conflict" : "not_found", current: cur[0] ?? null };
    }
    if (activity) {
      await tx
        .insert(workItemActivities)
        .values({
          workItemId: id,
          kind: activity.kind,
          actorKind: activity.actorKind,
          actorEmail: activity.actorEmail ?? null,
          body: activity.body ?? null,
          meta: (activity.meta as object) ?? null,
          resultingVersion: item.version,
          occurredAt: activity.occurredAt ?? new Date(),
          dedupeKey: activity.dedupeKey ?? null,
        })
        .onConflictDoNothing();
    }
    return { ok: true, item };
  });
}

/**
 * Convenience for callers that don't hold a version (re-read + retry once on a
 * conflict). Routes that DO hold the client's version should call
 * applyWorkItemUpdate directly so a stale UI surfaces a 409.
 */
export async function mutateItem(
  id: string,
  patch: Partial<NewWorkItem>,
  activity?: ActivityInput,
  retries = 1
): Promise<UpdateResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const cur = await getItem(id);
    if (!cur) return { ok: false, reason: "not_found", current: null };
    const res = await applyWorkItemUpdate(id, cur.version, patch, activity);
    if (res.ok || res.reason === "not_found") return res;
  }
  const cur = await getItem(id);
  return { ok: false, reason: "conflict", current: cur };
}

// ---------------------------------------------------------------------------
// status transitions (maintain stageEnteredAt / startedAt / completedAt /
// parent child-counts) — wraps applyWorkItemUpdate
// ---------------------------------------------------------------------------

export async function transitionStatus(
  id: string,
  expectVersion: number,
  next: WorkItemStatus,
  actor: { kind: "human" | "bot" | "system"; email?: string },
  extra?: { dismissedReason?: string }
): Promise<UpdateResult> {
  const before = await getItem(id);
  if (!before) return { ok: false, reason: "not_found", current: null };
  if (before.status === next) return { ok: true, item: before };

  const now = new Date();
  const patch: Partial<NewWorkItem> = { status: next, stageEnteredAt: now };
  if (next === "in_progress" && !before.startedAt) patch.startedAt = now;
  if (next === "done") patch.completedAt = now;
  if (next === "approved" && actor.email) {
    patch.approvedBy = actor.email;
    patch.approvedAt = now;
  }
  if (next === "dismissed" && extra?.dismissedReason) patch.dismissedReason = extra.dismissedReason;

  const res = await applyWorkItemUpdate(id, expectVersion, patch, {
    kind: "status_change",
    actorKind: actor.kind,
    actorEmail: actor.email ?? null,
    body: `${before.status} → ${next}`,
    meta: { from: before.status, to: next },
  });

  // Maintain the parent's open-child counter when a child crosses open↔closed.
  if (res.ok && before.parentId) {
    const wasOpen = isOpen(before.status);
    const nowOpen = isOpen(next);
    if (wasOpen && !nowOpen) await bumpChildOpen(before.parentId, -1);
    else if (!wasOpen && nowOpen) await bumpChildOpen(before.parentId, +1);
  }
  return res;
}

async function bumpChildOpen(parentId: string, delta: number): Promise<void> {
  await db
    .update(workItems)
    .set({ childOpenCount: sql`GREATEST(0, ${workItems.childOpenCount} + ${delta})` })
    .where(eq(workItems.id, parentId));
}

// ---------------------------------------------------------------------------
// creates
// ---------------------------------------------------------------------------

export type CreateInput = {
  title: string;
  kind: WorkItemKind;
  status?: WorkItemStatus;
  source: WorkItem["source"];
  ownerEmail?: string | null;
  botAssigned?: boolean;
  customerSlug?: string | null;
  sourceRef?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  meetingId?: string | null;
  parentId?: string | null;
  dueAt?: Date | null;
  highPriority?: boolean;
  payload?: WorkItemPayload;
  createdBy?: string;
  boardRank?: string | null;
};

export async function createWorkItem(input: CreateInput): Promise<WorkItem | null> {
  const now = new Date();
  const row: NewWorkItem = {
    type: typeOfKind(input.kind),
    kind: input.kind,
    title: input.title,
    status: input.status ?? "triage",
    source: input.source,
    ownerKind: "human",
    ownerEmail: input.ownerEmail ?? null,
    botAssigned: input.botAssigned ?? false,
    customerSlug: input.customerSlug ?? null,
    sourceRef: input.sourceRef ?? null,
    accountId: input.accountId ?? null,
    opportunityId: input.opportunityId ?? null,
    meetingId: input.meetingId ?? null,
    parentId: input.parentId ?? null,
    dueAt: input.dueAt ?? null,
    highPriority: input.highPriority ?? false,
    payload: (input.payload as object) ?? {},
    createdBy: input.createdBy ?? "bot",
    boardRank: input.boardRank ?? initialRank(Math.floor(now.getTime() / 1000) % 100000),
    stageEnteredAt: now,
  };
  const inserted = await db.insert(workItems).values(row).onConflictDoNothing().returning();
  const item = inserted[0];
  if (!item) return null;
  await logActivity(item.id, {
    kind: "created",
    actorKind: input.createdBy === "bot" || !input.createdBy ? "bot" : "human",
    actorEmail: input.ownerEmail ?? null,
    body: `Created: ${item.title}`,
    meta: { kind: item.kind, source: item.source },
  });
  if (item.parentId) {
    await db
      .update(workItems)
      .set({
        childTotalCount: sql`${workItems.childTotalCount} + 1`,
        childOpenCount: sql`${workItems.childOpenCount} + 1`,
      })
      .where(eq(workItems.id, item.parentId));
  }
  return item;
}

/** Bot suggestion batch (post-meeting etc.) — always status 'triage'/'suggested'. */
export async function createSuggestions(
  items: Array<{ kind: WorkItemKind; title: string; payload?: WorkItemPayload; ownerEmail?: string; parentId?: string }>,
  ctx: { source: WorkItem["source"]; sourceRef?: string; customerSlug?: string; accountId?: string; meetingId?: string; status?: WorkItemStatus; createdBy?: string }
): Promise<WorkItem[]> {
  const out: WorkItem[] = [];
  for (const it of items) {
    const created = await createWorkItem({
      title: it.title,
      kind: it.kind,
      status: ctx.status ?? "triage",
      source: ctx.source,
      sourceRef: ctx.sourceRef ?? null,
      customerSlug: ctx.customerSlug ?? null,
      accountId: ctx.accountId ?? null,
      meetingId: ctx.meetingId ?? null,
      ownerEmail: it.ownerEmail ?? null,
      parentId: it.parentId ?? null,
      payload: it.payload ?? {},
      createdBy: ctx.createdBy ?? "bot",
    });
    if (created) out.push(created);
  }
  return out;
}

export async function createSubtask(
  parentId: string,
  input: Omit<CreateInput, "parentId">
): Promise<WorkItem | null> {
  return createWorkItem({ ...input, parentId });
}

// ---------------------------------------------------------------------------
// cascade-complete (parent → done completes open children, per-child guarded)
// ---------------------------------------------------------------------------

const MAX_SUBTASK_DEPTH = 2;

export async function completeWithCascade(
  parentId: string,
  expectVersion: number,
  actor: { kind: "human" | "bot" | "system"; email?: string }
): Promise<UpdateResult> {
  const res = await transitionStatus(parentId, expectVersion, "done", actor);
  if (!res.ok) return res;
  await cascadeChildren(parentId, actor, parentId, 0);
  return res;
}

async function cascadeChildren(
  parentId: string,
  actor: { kind: "human" | "bot" | "system"; email?: string },
  root: string,
  depth: number
): Promise<void> {
  if (depth >= MAX_SUBTASK_DEPTH) return;
  const children = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.parentId, parentId), inArray(workItems.status, OPEN_STATUSES)));
  for (const child of children) {
    const r = await applyWorkItemUpdate(
      child.id,
      child.version,
      { status: "done", completedAt: new Date(), stageEnteredAt: new Date() },
      {
        kind: "status_change",
        actorKind: "system",
        body: `${child.status} → done (cascade)`,
        meta: { from: child.status, to: "done", cascadeRoot: root, completedBy: "cascade" },
      }
    );
    if (r.ok) {
      await bumpChildOpen(parentId, -1);
      await cascadeChildren(child.id, actor, root, depth + 1);
    } else {
      await logActivity(child.id, {
        kind: "cascade_skipped",
        actorKind: "system",
        body: "Could not auto-complete on parent cascade (will reconcile).",
        meta: { cascadeRoot: root },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// small mutators
// ---------------------------------------------------------------------------

export async function assignItem(
  id: string,
  expectVersion: number,
  patch: { ownerEmail?: string | null; botAssigned?: boolean },
  actor: { kind: "human" | "bot" | "system"; email?: string }
): Promise<UpdateResult> {
  return applyWorkItemUpdate(id, expectVersion, patch, {
    kind: "assignment",
    actorKind: actor.kind,
    actorEmail: actor.email ?? null,
    body: `assigned${patch.ownerEmail ? ` → ${patch.ownerEmail}` : ""}${patch.botAssigned !== undefined ? ` · bot ${patch.botAssigned}` : ""}`,
    meta: patch,
  });
}
export async function setDue(
  id: string,
  expectVersion: number,
  dueAt: Date | null,
  actor: { kind: "human" | "bot" | "system"; email?: string }
): Promise<UpdateResult> {
  const before = await getItem(id);
  return applyWorkItemUpdate(id, expectVersion, { dueAt }, {
    kind: "due_change",
    actorKind: actor.kind,
    actorEmail: actor.email ?? null,
    meta: { from: before?.dueAt ?? null, to: dueAt },
  });
}
export async function setHighPriority(
  id: string,
  expectVersion: number,
  highPriority: boolean,
  actor: { kind: "human" | "bot" | "system"; email?: string }
): Promise<UpdateResult> {
  return applyWorkItemUpdate(
    id,
    expectVersion,
    { highPriority, priorityLockedBy: actor.email ?? "system" },
    { kind: "field_change", actorKind: actor.kind, actorEmail: actor.email ?? null, meta: { field: "highPriority", after: highPriority } }
  );
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function getItem(id: string): Promise<WorkItem | null> {
  const rows = await db.select().from(workItems).where(eq(workItems.id, id)).limit(1);
  return rows[0] ?? null;
}
export async function getChildren(parentId: string): Promise<WorkItem[]> {
  return db
    .select()
    .from(workItems)
    .where(eq(workItems.parentId, parentId))
    .orderBy(asc(workItems.boardRank), asc(workItems.createdAt));
}

export type BoardFilter = {
  ownerEmail?: string;
  customerSlug?: string;
  kind?: WorkItemKind[];
  status?: WorkItemStatus[];
  includeDismissed?: boolean;
  topLevelOnly?: boolean;
};

export async function listWorkItems(filter: BoardFilter = {}, limit = 500): Promise<WorkItem[]> {
  const conds = [] as ReturnType<typeof eq>[];
  if (filter.ownerEmail) conds.push(eq(workItems.ownerEmail, filter.ownerEmail));
  if (filter.customerSlug) conds.push(eq(workItems.customerSlug, filter.customerSlug));
  if (filter.kind?.length) conds.push(inArray(workItems.kind, filter.kind));
  if (filter.status?.length) conds.push(inArray(workItems.status, filter.status));
  else if (!filter.includeDismissed) conds.push(sql`${workItems.status} <> 'dismissed'`);
  if (filter.topLevelOnly) conds.push(isNull(workItems.parentId));
  return db
    .select()
    .from(workItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(workItems.boardRank), desc(workItems.createdAt))
    .limit(limit);
}

export type BoardColumns = Record<BoardColumn, WorkItem[]> & { dismissedCount: number };

/** Recent items grouped into the 5 board columns. */
export async function getBoard(filter: BoardFilter = {}): Promise<BoardColumns> {
  const rows = await listWorkItems({ ...filter, includeDismissed: true }, 800);
  const cols = {
    Unsorted: [],
    "To Do": [],
    "Reddy Working": [],
    "Reddy Waiting": [],
    Completed: [],
    dismissedCount: 0,
  } as BoardColumns;
  for (const r of rows) {
    const c = columnOf(r.status);
    if (!c) {
      cols.dismissedCount++;
      continue;
    }
    cols[c].push(r);
  }
  return cols;
}

export type BoardSummary = {
  open: number;
  byColumn: Record<BoardColumn, number>;
  done: number;
  dismissed: number;
};
export async function getBoardSummary(): Promise<BoardSummary> {
  const rows = await db
    .select({ status: workItems.status, n: sql<number>`count(*)::int` })
    .from(workItems)
    .groupBy(workItems.status);
  const byColumn = {
    Unsorted: 0,
    "To Do": 0,
    "Reddy Working": 0,
    "Reddy Waiting": 0,
    Completed: 0,
  } as Record<BoardColumn, number>;
  let dismissed = 0;
  for (const r of rows) {
    const c = columnOf(r.status);
    if (!c) dismissed += r.n;
    else byColumn[c] += r.n;
  }
  const open = byColumn.Unsorted + byColumn["To Do"] + byColumn["Reddy Working"] + byColumn["Reddy Waiting"];
  return { open, byColumn, done: byColumn.Completed, dismissed };
}

// ---------------------------------------------------------------------------
// morning digest data (added / completed yesterday + focus candidates)
// ---------------------------------------------------------------------------

export type DigestItem = {
  id: string;
  kind: WorkItemKind;
  title: string;
  ownerEmail: string | null;
  customerSlug: string | null;
};
export type DigestData = {
  url: string;
  yesterdayLabel: string;
  addedYesterday: DigestItem[];
  doneYesterday: DigestItem[];
  openItems: DigestItem[];
  focusToday: DigestItem | null;
  summary: BoardSummary;
};
function toDigestItem(r: WorkItem): DigestItem {
  return { id: r.id, kind: r.kind, title: r.title, ownerEmail: r.ownerEmail, customerSlug: r.customerSlug };
}
function ptDateOf(col: AnyPgColumn) {
  return sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date`;
}
function focusScore(r: WorkItem): number {
  const byStatus = r.status === "in_progress" ? 120 : r.status === "approved" ? 100 : r.status === "waiting" ? 40 : 0;
  const byPriority = effectiveHighPriority(r) ? 50 : 0;
  return byStatus + byPriority;
}
export async function getDigestData(now: Date = new Date()): Promise<DigestData> {
  const yPt = ptYesterday(now);
  const [added, completed, openItems, summary] = await Promise.all([
    db.select().from(workItems).where(sql`${ptDateOf(workItems.createdAt)} = ${yPt}::date`).orderBy(desc(workItems.createdAt)).limit(25),
    db.select().from(workItems).where(and(eq(workItems.status, "done"), sql`${workItems.completedAt} IS NOT NULL`, sql`${ptDateOf(workItems.completedAt)} = ${yPt}::date`)).orderBy(desc(workItems.completedAt)).limit(25),
    db.select().from(workItems).where(inArray(workItems.status, OPEN_STATUSES)).orderBy(asc(workItems.createdAt)).limit(100),
    getBoardSummary(),
  ]);
  const ranked = [...openItems].sort((a, b) => focusScore(b) - focusScore(a) || a.createdAt.getTime() - b.createdAt.getTime());
  return {
    url: boardUrl(),
    yesterdayLabel: humanDate(yPt),
    addedYesterday: added.map(toDigestItem),
    doneYesterday: completed.map(toDigestItem),
    openItems: ranked.map(toDigestItem),
    focusToday: ranked[0] ? toDigestItem(ranked[0]) : null,
    summary,
  };
}
