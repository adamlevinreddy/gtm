import type { WorkItem } from "./schema";

// ============================================================================
// Pure aging / SLA helpers — NO database/runtime deps (only `import type`), so
// this module is safe to import from client components AND server code. Keep it
// dependency-light: it must stay importable from the /board client island.
//
// "Reddy Waiting" carries an SLA: an item that sits in `waiting` for too many
// BUSINESS days is "stalled" and the cron pings about it. The threshold lives
// here as STALE_WAITING_DAYS so the UI badge and the server sweep agree.
// ============================================================================

/** Business days an item may sit in `waiting` before it counts as stalled. */
export const STALE_WAITING_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Calendar days since the item entered its current stage (stageEnteredAt).
 * Falls back to createdAt when stageEnteredAt is unset. Returns 0 when neither
 * is available. Never negative.
 */
export function agingDays(item: WorkItem, now: Date = new Date()): number {
  const anchor = toDate(item.stageEnteredAt) ?? toDate(item.createdAt);
  if (!anchor) return 0;
  const diff = now.getTime() - anchor.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / DAY_MS);
}

/**
 * Count of business days (Mon–Fri) elapsed from `date` up to `now`, counting
 * each weekday boundary crossed. Weekends contribute nothing. The start day
 * itself is not counted (a same-day item is 0 business days old). Returns 0 for
 * a null/future date.
 */
export function businessDaysSince(
  date: Date | string | null | undefined,
  now: Date = new Date()
): number {
  const start = toDate(date);
  if (!start) return 0;
  if (start.getTime() >= now.getTime()) return 0;

  // Walk day-by-day from the day AFTER `start` through `now`, counting weekdays.
  let count = 0;
  const cursor = new Date(start.getTime());
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime());
  end.setHours(0, 0, 0, 0);

  while (cursor.getTime() < end.getTime()) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * An item is "stalled" when it has been parked in `waiting` for at least
 * STALE_WAITING_DAYS business days (the Reddy-Waiting SLA breach).
 */
export function isStalled(item: WorkItem, now: Date = new Date()): boolean {
  if (item.status !== "waiting") return false;
  return businessDaysSince(item.stageEnteredAt, now) >= STALE_WAITING_DAYS;
}
