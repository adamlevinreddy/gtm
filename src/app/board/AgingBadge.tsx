import {
  agingDays,
  isStalled,
  STALE_WAITING_DAYS,
} from "@/lib/board-aging";
import type { WorkItem } from "@/lib/schema";

// SLA / aging chip. Surfaces:
//  - waiting cards: "Nd waiting" (amber), turning red once stalled (>= SLA)
//  - any open card past its dueAt: "Nd overdue" (red)
// Returns null when there's nothing worth flagging. Pure presentational.

const DAY_MS = 24 * 60 * 60 * 1000;

export function agingChip(
  item: WorkItem,
  now: Date = new Date()
): { text: string; fg: string; bg: string } | null {
  if (item.status === "done" || item.status === "dismissed") return null;

  // Overdue wins (red).
  if (item.dueAt) {
    const due = item.dueAt instanceof Date ? item.dueAt : new Date(item.dueAt);
    if (!Number.isNaN(due.getTime()) && due.getTime() < now.getTime()) {
      const d = Math.max(1, Math.floor((now.getTime() - due.getTime()) / DAY_MS));
      return { text: `${d}d overdue`, fg: "#A23B3B", bg: "#F8E5E5" };
    }
  }

  if (item.status === "waiting") {
    const d = agingDays(item, now);
    if (isStalled(item, now)) {
      return { text: `${d}d waiting`, fg: "#A23B3B", bg: "#F8E5E5" };
    }
    return {
      text: d >= 1 ? `${d}d waiting` : "waiting",
      fg: "#9A6510",
      bg: "#FBF1DE",
    };
  }

  // Non-waiting open card sitting a long time in its column → gentle idle hint.
  const d = agingDays(item, now);
  if (d >= STALE_WAITING_DAYS * 2) {
    return { text: `${d}d idle`, fg: "#9A6510", bg: "#FBF1DE" };
  }
  return null;
}

export function AgingBadge({ item, now }: { item: WorkItem; now?: Date }) {
  const chip = agingChip(item, now);
  if (!chip) return null;
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ color: chip.fg, background: chip.bg }}
    >
      {chip.text}
    </span>
  );
}
