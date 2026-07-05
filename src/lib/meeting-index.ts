// The webhook-pushed meeting index — Daybreak Phase 3.
//
// Every meeting-list read used to rebuild itself from the GitHub KB: ref →
// commit → recursive tree, then N blob fetches (10-30s cold). The webhook
// already KNOWS every meeting the moment it lands — so it writes this index
// and pages read it in one round-trip.
//
// Storage (Upstash):
//   mtg:index:z   ZSET  score = started_at epoch-ms, member = botId
//   mtg:index:h   HASH  botId → MeetingIndexRow (JSON via @vercel/kv)
//
// Writers: the Recall webhook's reconcile() on every event, and
// scripts/backfill-meeting-index.ts (one-shot walk of the KB).
// Readers: recentMeetingIndex() fast path (which feeds the meetings hub,
// home, and the agent's kb-index preamble).

import { kv } from "@/lib/kv-client";

const ZKEY = "mtg:index:z";
const HKEY = "mtg:index:h";

export type MeetingIndexRow = {
  bot_id: string;
  customer_slug: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  platform: string | null;
  attendees: Array<{ name: string | null; email: string | null }>;
  has_transcript: boolean;
  has_video: boolean;
  has_chat: boolean;
  mux_playback_id: string | null;
  attribution_confidence: string | null;
  /** epoch-ms of the last index write — staleness debugging. */
  indexed_at: number;
};

/** Upsert one meeting. Idempotent; safe to call on every reconcile pass. */
export async function upsertMeetingIndex(row: Omit<MeetingIndexRow, "indexed_at">): Promise<void> {
  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  if (!row.bot_id || !Number.isFinite(startedMs)) return; // unscoreable → skip
  const full: MeetingIndexRow = { ...row, indexed_at: Date.now() };
  await Promise.all([
    kv.zadd(ZKEY, { score: startedMs, member: row.bot_id }),
    kv.hset(HKEY, { [row.bot_id]: full }),
  ]);
}

/** Remove a meeting (cone-of-silence purge). */
export async function removeFromMeetingIndex(botId: string): Promise<void> {
  await Promise.all([
    kv.zrem(ZKEY, botId).catch(() => {}),
    kv.hdel(HKEY, botId).catch(() => {}),
  ]);
}

/**
 * Newest-first rows since the cutoff. One ZRANGE + one HMGET.
 * Returns [] when the index is empty (caller falls back to the KB walk).
 */
export async function readMeetingIndex(opts: {
  sinceMs: number;
  limit: number;
}): Promise<MeetingIndexRow[]> {
  const ids = await kv
    .zrange<string[]>(ZKEY, "+inf", opts.sinceMs, {
      byScore: true,
      rev: true,
      offset: 0,
      count: opts.limit,
    })
    .catch(() => [] as string[]);
  if (!ids || ids.length === 0) return [];
  const rows = await kv.hmget<Record<string, MeetingIndexRow>>(HKEY, ...ids).catch(() => null);
  if (!rows) return [];
  return ids.map((id) => rows[id]).filter((r): r is MeetingIndexRow => !!r);
}

export async function meetingIndexSize(): Promise<number> {
  return (await kv.zcard(ZKEY).catch(() => 0)) ?? 0;
}
