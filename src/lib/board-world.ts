import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "./db";
import {
  labels,
  workItemLabels,
  savedViews,
  notifications,
  type WorkItem,
} from "./schema";

// ============================================================================
// "World" helpers — pure DB accessors over the previously-empty satellite
// tables (labels, saved_views, notifications) that hang off the board spine.
// Server-only (imports ./db). Routes call these; the spine (work-items.ts)
// owns work_items mutations and is NOT touched here.
// ============================================================================

export type Label = typeof labels.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
type NotificationKind = Notification["kind"];

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export async function listLabels(): Promise<Label[]> {
  return db.select().from(labels).orderBy(asc(labels.name));
}

/** Create a label (idempotent on the unique name — returns the existing row). */
export async function createLabel(
  name: string,
  color?: string | null
): Promise<Label | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const inserted = await db
    .insert(labels)
    .values({ name: trimmed, color: color ?? null })
    .onConflictDoNothing({ target: labels.name })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await db
    .select()
    .from(labels)
    .where(eq(labels.name, trimmed))
    .limit(1);
  return existing[0] ?? null;
}

/** Attach a label to an item (idempotent on the m2m unique). */
export async function attachLabel(
  workItemId: string,
  labelId: string
): Promise<void> {
  await db
    .insert(workItemLabels)
    .values({ workItemId, labelId })
    .onConflictDoNothing();
}

export async function detachLabel(
  workItemId: string,
  labelId: string
): Promise<void> {
  await db
    .delete(workItemLabels)
    .where(
      and(
        eq(workItemLabels.workItemId, workItemId),
        eq(workItemLabels.labelId, labelId)
      )
    );
}

/**
 * Resolve the labels for a batch of work items in one query.
 * Returns a Map keyed by workItemId → Label[] (only items that have ≥1 label
 * appear in the map; callers should default to []).
 */
export async function labelsFor(
  workItemIds: string[]
): Promise<Map<string, Label[]>> {
  const out = new Map<string, Label[]>();
  if (workItemIds.length === 0) return out;
  const rows = await db
    .select({
      workItemId: workItemLabels.workItemId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
      createdAt: labels.createdAt,
    })
    .from(workItemLabels)
    .innerJoin(labels, eq(workItemLabels.labelId, labels.id))
    .where(inArray(workItemLabels.workItemId, workItemIds));
  for (const r of rows) {
    const label: Label = {
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.createdAt,
    };
    const list = out.get(r.workItemId);
    if (list) list.push(label);
    else out.set(r.workItemId, [label]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// saved views
// ---------------------------------------------------------------------------

/**
 * Views visible to `ownerEmail`: their own views plus any shared view. When
 * ownerEmail is omitted, returns shared views only.
 */
export async function listViews(ownerEmail?: string | null): Promise<SavedView[]> {
  const rows = await db.select().from(savedViews).orderBy(asc(savedViews.name));
  if (!ownerEmail) return rows.filter((v) => v.shared);
  return rows.filter((v) => v.shared || v.ownerEmail === ownerEmail);
}

export async function saveView(input: {
  name: string;
  ownerEmail?: string | null;
  shared?: boolean;
  spec?: unknown;
}): Promise<SavedView | null> {
  const name = input.name.trim();
  if (!name) return null;
  const inserted = await db
    .insert(savedViews)
    .values({
      name,
      ownerEmail: input.ownerEmail ?? null,
      shared: input.shared ?? false,
      spec: (input.spec as object) ?? null,
    })
    .returning();
  return inserted[0] ?? null;
}

export async function deleteView(id: string): Promise<boolean> {
  const deleted = await db
    .delete(savedViews)
    .where(eq(savedViews.id, id))
    .returning({ id: savedViews.id });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// notifications (the /board/inbox feed)
// ---------------------------------------------------------------------------

export async function listNotifications(
  recipientEmail: string,
  unreadOnly = false,
  limit = 100
): Promise<Notification[]> {
  const conds = [eq(notifications.recipientEmail, recipientEmail)];
  if (unreadOnly) conds.push(isNull(notifications.readAt));
  return db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadNotificationCount(
  recipientEmail: string
): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientEmail, recipientEmail),
        isNull(notifications.readAt)
      )
    );
  return rows.length;
}

export async function markNotificationRead(id: string): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return updated.length > 0;
}

/** Mark every unread notification for a recipient as read; returns the count. */
export async function markAllNotificationsRead(
  recipientEmail: string
): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.recipientEmail, recipientEmail),
        isNull(notifications.readAt)
      )
    )
    .returning({ id: notifications.id });
  return updated.length;
}

export async function createNotification(input: {
  recipientEmail: string;
  kind: NotificationKind;
  workItemId?: string | null;
  body?: string | null;
  slackTs?: string | null;
}): Promise<Notification | null> {
  const inserted = await db
    .insert(notifications)
    .values({
      recipientEmail: input.recipientEmail,
      kind: input.kind,
      workItemId: input.workItemId ?? null,
      body: input.body ?? null,
      slackTs: input.slackTs ?? null,
    })
    .returning();
  return inserted[0] ?? null;
}

// re-export the WorkItem type for callers that resolve labels alongside items
export type { WorkItem };
