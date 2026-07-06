// The ONE filter/sort vocabulary, shared by every list view (sessions, tasks,
// meetings, …). Views declare which dimensions they support; the <FilterBar>
// renders them and reflects state in the URL (shareable, back/forward-safe).
// Sales is a team sport — every view defaults to per-user but can widen to the
// whole team, filter by person, time range, account, channel, and status.

import { ptStartOfDayMs } from "@/lib/fmt";

export type FilterOption = { value: string; label: string };

// Time ranges are PT-anchored (the whole team is Pacific) — "today" means the
// PT calendar day, not UTC's.
export const TIME_RANGES: readonly FilterOption[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

/** Lower-bound epoch ms for a time-range value (PT-aware); null = all time. */
export function rangeSinceMs(range: string | undefined | null): number | null {
  switch (range) {
    case "today":
      return ptStartOfDayMs(0);
    case "7d":
      return ptStartOfDayMs(7);
    case "30d":
      return ptStartOfDayMs(30);
    case "90d":
      return ptStartOfDayMs(90);
    default:
      return null;
  }
}

/** True if `iso` falls within the range (used for in-memory filtering). */
export function inRange(iso: string | Date | null | undefined, range: string | undefined): boolean {
  const since = rangeSinceMs(range);
  if (since === null) return true;
  if (!iso) return false;
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return Number.isFinite(t) && t >= since;
}

// Channel/source vocabulary shared across views (sessions lanes, task sources).
export const CHANNELS: readonly FilterOption[] = [
  { value: "all", label: "All channels" },
  { value: "web", label: "Web app" },
  { value: "slack", label: "Slack" },
  { value: "email", label: "Email" },
  { value: "play", label: "Plays" },
  { value: "meeting", label: "Meeting" },
];
