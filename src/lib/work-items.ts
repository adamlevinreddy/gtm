import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "./db";
import { workItems, type WorkItem, type NewWorkItem } from "./schema";

// ============================================================================
// Tracking board: data access + the morning-digest summary.
//
// Everything the proactive bot proposes lands here as status `suggested` and
// is NEVER auto-applied -- a human approves first. The board route renders
// these rows; the morning digest reads getDigestData() to summarize the day.
// ============================================================================

export type WorkItemType = WorkItem["type"];
export type WorkItemStatus = WorkItem["status"];

/** payload shapes, discriminated by `type` (stored in the jsonb column) */
export type FollowupPayload = {
  channel: "email" | "slack" | "call";
  to?: string;
  subject?: string;
  body: string;
  dueHint?: string;
};
export type CrmUpdatePayload = {
  object: "deal" | "contact" | "company";
  hubspotId?: string;
  field: string;
  currentValue?: unknown;
  suggestedValue: unknown;
  rationale: string;
};
export type PrepPayload = {
  meetingRef?: string;
  when?: string;
  checklist: string[];
};
export type TaskPayload = { detail: string; dueHint?: string };
export type WorkItemPayload =
  | FollowupPayload
  | CrmUpdatePayload
  | PrepPayload
  | TaskPayload;

const OPEN_STATUSES: WorkItemStatus[] = ["suggested", "approved"];

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Origin of this deployment, for self-calls (e.g. the digest → oneshot). */
export function selfBaseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * Where the tracking board lives. Defaults to this app's own /board route
 * (the stub testing target); override with TRACKING_BOARD_URL once a
 * dedicated board ships -- both capabilities import this, never inline a URL.
 */
export function boardUrl(): string {
  return process.env.TRACKING_BOARD_URL || `${selfBaseUrl()}/board`;
}

/** Forward-compatible deep link to a single item (anchor on the stub board). */
export function itemUrl(id: string): string {
  const base = boardUrl();
  return base.includes("#") ? base : `${base}#item-${id}`;
}

// ---------------------------------------------------------------------------
// PT date helpers (the digest works in America/Los_Angeles, DST-correct)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for an instant, as seen in Pacific Time. */
export function ptDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(d);
}

/** YYYY-MM-DD of the PT calendar day before `d`. */
export function ptYesterday(d: Date = new Date()): string {
  const [y, m, day] = ptDate(d).split("-").map(Number);
  // Anchor at noon UTC of today's PT date, step back one calendar day.
  const anchor = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(anchor);
}

/** "Thursday, Jun 26" from a YYYY-MM-DD date string. */
function humanDate(ymd: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

/** SQL: the PT calendar date of a UTC timestamp column. */
function ptDateOf(col: AnyPgColumn) {
  return sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date`;
}

// ---------------------------------------------------------------------------
// Writes (suggestions are always status='suggested')
// ---------------------------------------------------------------------------

export type SuggestionInput = {
  type: WorkItemType;
  title: string;
  payload: WorkItemPayload;
  ownerEmail?: string;
};

export type SuggestionContext = {
  source: WorkItem["source"];
  sourceRef?: string;
  customerSlug?: string;
  accountId?: string;
  opportunityId?: string;
  meetingId?: string;
  createdBy?: string;
};

/**
 * Persist a batch of bot suggestions. Idempotent on (sourceRef, type, title)
 * so repeated webhook deliveries don't duplicate. Returns the rows that were
 * actually inserted (so callers can deep-link each).
 */
export async function createSuggestions(
  items: SuggestionInput[],
  ctx: SuggestionContext
): Promise<WorkItem[]> {
  if (items.length === 0) return [];
  const rows: NewWorkItem[] = items.map((it) => ({
    type: it.type,
    title: it.title,
    status: "suggested" as const,
    source: ctx.source,
    ownerKind: "human" as const,
    ownerEmail: it.ownerEmail ?? null,
    accountId: ctx.accountId ?? null,
    opportunityId: ctx.opportunityId ?? null,
    meetingId: ctx.meetingId ?? null,
    customerSlug: ctx.customerSlug ?? null,
    sourceRef: ctx.sourceRef ?? null,
    payload: it.payload,
    createdBy: ctx.createdBy ?? "bot",
  }));
  return db.insert(workItems).values(rows).onConflictDoNothing().returning();
}

export async function setStatus(
  id: string,
  status: WorkItemStatus,
  by?: string
): Promise<void> {
  const patch: Partial<NewWorkItem> = { status, updatedAt: new Date() };
  if (status === "approved") {
    patch.approvedBy = by ?? null;
    patch.approvedAt = new Date();
  }
  if (status === "done") patch.completedAt = new Date();
  await db.update(workItems).set(patch).where(eq(workItems.id, id));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type BoardColumns = {
  suggested: WorkItem[];
  approved: WorkItem[];
  done: WorkItem[];
  dismissed: WorkItem[];
};

/** Recent items grouped by status, for the board UI. */
export async function getBoard(limitPerColumn = 50): Promise<BoardColumns> {
  const rows = await db
    .select()
    .from(workItems)
    .orderBy(desc(workItems.createdAt))
    .limit(400);
  const cols: BoardColumns = {
    suggested: [],
    approved: [],
    done: [],
    dismissed: [],
  };
  for (const r of rows) {
    const bucket = cols[r.status];
    if (bucket && bucket.length < limitPerColumn) bucket.push(r);
  }
  return cols;
}

export type BoardSummary = {
  suggested: number;
  approved: number;
  done: number;
  dismissed: number;
  open: number;
};

export async function getBoardSummary(): Promise<BoardSummary> {
  const rows = await db
    .select({ status: workItems.status, n: sql<number>`count(*)::int` })
    .from(workItems)
    .groupBy(workItems.status);
  const by = { suggested: 0, approved: 0, done: 0, dismissed: 0 };
  for (const r of rows) by[r.status] = r.n;
  return { ...by, open: by.suggested + by.approved };
}

// ---------------------------------------------------------------------------
// Morning digest data: "added yesterday / done yesterday / focus today"
// ---------------------------------------------------------------------------

export type DigestItem = {
  id: string;
  type: WorkItemType;
  title: string;
  ownerEmail: string | null;
  customerSlug: string | null;
};

export type DigestData = {
  url: string;
  yesterdayLabel: string; // "Thursday, Jun 26"
  addedYesterday: DigestItem[];
  doneYesterday: DigestItem[];
  /** All open items — the candidate set the sandbox agent reasons over for focus. */
  openItems: DigestItem[];
  /** Deterministic top-priority open item. Fallback when the agent can't run. */
  focusToday: DigestItem | null;
  summary: BoardSummary;
};

function toDigestItem(r: WorkItem): DigestItem {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    ownerEmail: r.ownerEmail,
    customerSlug: r.customerSlug,
  };
}

/** Priority for "the one thing to focus on today" — higher wins. */
function focusScore(r: WorkItem): number {
  const byStatus = r.status === "approved" ? 100 : 0; // approved > merely suggested
  const byType =
    r.type === "crm_update" ? 30 : r.type === "followup" ? 20 : r.type === "prep" ? 25 : 10;
  return byStatus + byType;
}

export async function getDigestData(now: Date = new Date()): Promise<DigestData> {
  const yPt = ptYesterday(now);

  const [added, completed, openItems, summary] = await Promise.all([
    db
      .select()
      .from(workItems)
      .where(sql`${ptDateOf(workItems.createdAt)} = ${yPt}::date`)
      .orderBy(desc(workItems.createdAt))
      .limit(25),
    db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.status, "done"),
          sql`${workItems.completedAt} IS NOT NULL`,
          sql`${ptDateOf(workItems.completedAt)} = ${yPt}::date`
        )
      )
      .orderBy(desc(workItems.completedAt))
      .limit(25),
    db
      .select()
      .from(workItems)
      .where(inArray(workItems.status, OPEN_STATUSES))
      .orderBy(asc(workItems.createdAt))
      .limit(100),
    getBoardSummary(),
  ]);

  const ranked = [...openItems].sort(
    (a, b) =>
      focusScore(b) - focusScore(a) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );

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
