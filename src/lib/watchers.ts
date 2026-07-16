import { kv } from "@/lib/kv-client";
import { randomUUID } from "crypto";

// Conditional follow-ups — "watches" (Arc VIII). A watch is a deferred,
// condition-gated Play: it sits quietly until its date arrives, the watcher
// cron checks a signal (did the account reply? any deal activity?), and only if
// the condition trips does it act — where "act" is ALWAYS draft + notify, never
// autonomous send. Armed opt-in only: suggested on the post-meeting card when
// the transcript has conditional/temporal language, or created in chat.
//
// Storage: a hash of records (id → Watch) + a ZSET of PENDING watches scored by
// checkAfter, so the cron pulls due ones with one ZRANGEBYSCORE. A watch leaves
// the ZSET the moment it stops being pending (fired/satisfied/cancelled).

const WATCH_HASH = "watchers:v1:h";
const DUE_ZSET = "watchers:v1:due"; // score = checkAfter (epoch ms), member = id

export type WatchSignal =
  | "no_reply" // no inbound email from the account since the anchor
  | "no_activity" // no HubSpot activity / new meeting on the account since the anchor
  | "time_only"; // just reach out on the date, no condition

export type WatchStatus = "pending" | "fired" | "satisfied" | "cancelled" | "expired";

export type Watch = {
  id: string;
  owner: string; // email — the watch runs AS this user (their Gmail/HubSpot)
  account: string | null; // company/prospect name
  domain: string | null; // e.g. "nike.com" — whose inbound to watch for no_reply
  botId: string | null; // source meeting, if armed from one
  slackChannel: string | null; // where to notify (defaults to salesChannel at fire)
  slackThreadTs: string | null; // thread to notify in (the meeting card's thread)
  play: string; // PlayId to draft when it trips (usually a follow-up)
  signal: WatchSignal;
  checkAfter: number; // epoch ms — evaluate on/after this
  anchor: number; // epoch ms — "since" for the signal (meeting/creation time)
  note: string; // the human phrasing ("huddle, follow up if no reply by Mon")
  status: WatchStatus;
  createdAt: number;
  firedAt?: number;
  attempts: number;
};

export type NewWatch = Omit<Watch, "id" | "status" | "createdAt" | "attempts" | "firedAt">;

export async function addWatch(input: NewWatch): Promise<Watch> {
  const w: Watch = { id: randomUUID(), status: "pending", createdAt: Date.now(), attempts: 0, ...input };
  await kv.hset(WATCH_HASH, { [w.id]: w });
  await kv.zadd(DUE_ZSET, { score: w.checkAfter, member: w.id });
  return w;
}

export async function getWatch(id: string): Promise<Watch | null> {
  if (!id) return null;
  return (await kv.hget<Watch>(WATCH_HASH, id).catch(() => null)) ?? null;
}

export async function listWatches(filter?: {
  owner?: string;
  account?: string;
  status?: WatchStatus;
}): Promise<Watch[]> {
  const all = await kv.hgetall<Record<string, Watch>>(WATCH_HASH).catch(() => null);
  if (!all) return [];
  let rows = Object.values(all);
  if (filter?.owner) rows = rows.filter((w) => w.owner === filter.owner);
  if (filter?.account) rows = rows.filter((w) => (w.account ?? "").toLowerCase() === filter.account!.toLowerCase());
  if (filter?.status) rows = rows.filter((w) => w.status === filter.status);
  return rows.sort((a, b) => a.checkAfter - b.checkAfter);
}

/** Pending watches whose check time has arrived, soonest first. */
export async function dueWatches(nowMs: number, limit = 20): Promise<Watch[]> {
  const ids = await kv.zrange<string[]>(DUE_ZSET, 0, nowMs, { byScore: true }).catch(() => [] as string[]);
  if (!ids.length) return [];
  const rows = await Promise.all(ids.slice(0, limit).map((id) => getWatch(id)));
  return rows.filter((w): w is Watch => !!w && w.status === "pending");
}

async function save(w: Watch): Promise<void> {
  await kv.hset(WATCH_HASH, { [w.id]: w });
  // Keep the due index in sync: pending → in the ZSET at its checkAfter; any
  // terminal/holding status → out of it.
  if (w.status === "pending") await kv.zadd(DUE_ZSET, { score: w.checkAfter, member: w.id });
  else await kv.zrem(DUE_ZSET, w.id);
}

export async function markFired(id: string): Promise<void> {
  const w = await getWatch(id);
  if (!w) return;
  w.status = "fired";
  w.firedAt = Date.now();
  await save(w);
}

export async function markSatisfied(id: string): Promise<void> {
  const w = await getWatch(id);
  if (!w) return;
  w.status = "satisfied";
  await save(w);
}

export async function cancelWatch(id: string): Promise<Watch | null> {
  const w = await getWatch(id);
  if (!w) return null;
  w.status = "cancelled";
  await save(w);
  return w;
}

export async function snoozeWatch(id: string, days: number): Promise<Watch | null> {
  const w = await getWatch(id);
  if (!w) return null;
  w.checkAfter = Date.now() + days * 24 * 60 * 60 * 1000;
  w.status = "pending";
  await save(w);
  return w;
}

/** Bump the attempt counter; expire after too many failed evaluations. */
export async function noteAttempt(id: string, maxAttempts = 3): Promise<Watch | null> {
  const w = await getWatch(id);
  if (!w) return null;
  w.attempts += 1;
  if (w.attempts >= maxAttempts) w.status = "expired";
  else w.checkAfter = Date.now() + 6 * 60 * 60 * 1000; // retry in 6h
  await save(w);
  return w;
}
