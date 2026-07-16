// Meeting opt-out store — which calendar meetings the notetaker bot must
// never join. Managed from the board's Bot Schedule page; enforced in two
// places: the calendar.sync_events webhook (skip + tear down on every sync)
// and the bot-schedule API's eager apply (delete/re-schedule immediately on
// toggle, since an untouched event may never re-sync).
//
// Identity model: Google gives every occurrence of a recurring event the SAME
// ical_uid (instances differ only by id/start_time), and the ical_uid is
// stable across every teammate's connected calendar. So:
//   - series block      → keyed by ical_uid alone (covers all occurrences,
//                          all calendars — one-off meetings too)
//   - occurrence block  → keyed by ical_uid + start_time (a reschedule of
//                          that occurrence clears the block, which is the
//                          behavior we want)
// Events with no ical_uid (rare) fall back to the Recall event id.
//
// Storage: one KV hash so the whole block list is a single HGETALL — the
// webhook loads it once per sync and checks events in memory.

import { kv } from "@/lib/kv-client";
import type { CalendarEvent } from "@/lib/recall-calendar-v2";

const BLOCKS_HASH = "recall:optout:blocks:v1";

export type BlockScope = "series" | "occurrence";

export type MeetingBlock = {
  key: string;
  scope: BlockScope;
  icalUid: string;
  /** Occurrence blocks only — ISO start of the one occurrence to skip. */
  startTime?: string;
  /** Meeting title at block time, for display in the board UI. */
  title?: string;
  addedBy?: string;
  addedAt: string;
};

export function eventUid(event: Pick<CalendarEvent, "id" | "ical_uid">): string {
  return event.ical_uid || event.id;
}

export function seriesBlockKey(icalUid: string): string {
  return `series:${icalUid}`;
}

// Normalize the start to epoch ms so "2026-07-08T16:00:00Z" and an offset
// spelling of the same instant produce the same key.
export function occurrenceBlockKey(icalUid: string, startTime: string): string {
  const t = new Date(startTime).getTime();
  return `occ:${icalUid}:${Number.isNaN(t) ? startTime : t}`;
}

export async function listBlocks(): Promise<MeetingBlock[]> {
  const all = await kv.hgetall<Record<string, MeetingBlock>>(BLOCKS_HASH).catch(() => null);
  if (!all) return [];
  return Object.values(all).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

export async function addBlock(opts: {
  scope: BlockScope;
  icalUid: string;
  startTime?: string;
  title?: string;
  addedBy?: string;
}): Promise<MeetingBlock> {
  if (opts.scope === "occurrence" && !opts.startTime) {
    throw new Error("occurrence block requires startTime");
  }
  const key =
    opts.scope === "series"
      ? seriesBlockKey(opts.icalUid)
      : occurrenceBlockKey(opts.icalUid, opts.startTime!);
  const block: MeetingBlock = {
    key,
    scope: opts.scope,
    icalUid: opts.icalUid,
    startTime: opts.scope === "occurrence" ? opts.startTime : undefined,
    title: opts.title,
    addedBy: opts.addedBy,
    addedAt: new Date().toISOString(),
  };
  await kv.hset(BLOCKS_HASH, { [key]: block });
  return block;
}

export async function removeBlock(key: string): Promise<void> {
  await kv.hdel(BLOCKS_HASH, key);
}

/**
 * Load the block list once and return a synchronous matcher. The webhook
 * calls this at the top of a sync and checks every event in memory.
 * Returns the matching block (series blocks win over occurrence blocks)
 * or null when the event is allowed.
 */
export async function getBlockChecker(): Promise<(event: CalendarEvent) => MeetingBlock | null> {
  const all = (await kv.hgetall<Record<string, MeetingBlock>>(BLOCKS_HASH).catch(() => null)) ?? {};
  return (event: CalendarEvent) => {
    const uid = eventUid(event);
    const series = all[seriesBlockKey(uid)];
    if (series) return series;
    if (event.start_time) {
      const occ = all[occurrenceBlockKey(uid, event.start_time)];
      if (occ) return occ;
    }
    return null;
  };
}
