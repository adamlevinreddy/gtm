// Chat sessions (Daybreak Phase 8). Every web conversation persists here —
// refresh, come back tomorrow, pick up where you left off. The agent gets
// the full turn history in its prompt on every ask (same mechanism as
// before), so resume needs no sandbox state.

import { desc, eq, and, or, asc, gte, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { kv } from "@/lib/kv-client";
import { chatSessions, chatTurns, type ChatSession, type ChatTurn } from "@/lib/schema";

// A run that outlived its stream: requestId pinned to the session so the
// answer (written by the agent to mcp:result:{requestId}) can complete the
// turn on the next /s/{id} load — even if the asking tab is long gone.
const pendingKey = (sessionId: string) => `session:pending:${sessionId}`;

export async function setPendingRequest(sessionId: string, requestId: string): Promise<void> {
  await kv.set(pendingKey(sessionId), requestId, { ex: 24 * 3600 });
}

export async function getPendingRequest(sessionId: string): Promise<string | null> {
  return (await kv.get<string>(pendingKey(sessionId)).catch(() => null)) ?? null;
}

export async function clearPendingRequest(sessionId: string): Promise<void> {
  await kv.del(pendingKey(sessionId)).catch(() => {});
}

// ── Cross-surface sync (Arc V) ─────────────────────────────────────────────
// A Slack/email thread maps to one session via its lane threadKey; a sync
// marker tracks how many turns the Slack sandbox has "seen" so the next
// Slack dispatch can brief the agent on web-side continuations.

export type ExtSessionRef = { id: string; viewer: string };
export const extSessionKey = (threadKey: string) => `sess:ext:${threadKey}`;
export const syncMarkerKey = (threadKey: string) => `sess:sync:${threadKey}`;

/** INTERNAL (no ownership check): full ordered turns for sync purposes. */
export async function getTurnsInternal(sessionId: string): Promise<ChatTurn[]> {
  return db
    .select()
    .from(chatTurns)
    .where(eq(chatTurns.sessionId, sessionId))
    .orderBy(asc(chatTurns.createdAt), sql`${chatTurns.role} desc`)
    .limit(500);
}

const SYNC_EX = 90 * 24 * 3600;
// Hard ceiling on catch-up turns per dispatch (each capped at 1500 chars).
// Real backlogs are tiny; this only bounds a pathological one, and the tail
// re-briefs next dispatch rather than being dropped.
const MAX_BRIEF_TURNS = 40;

/** True owner of a session (no ownership check) — used to repair legacy KV
 * refs that stored a bare id and to attribute mirrored turns correctly. */
export async function getSessionOwnerInternal(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ viewer: chatSessions.viewer })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return row?.viewer ?? null;
}

/** Turns added since the last Slack dispatch, as a catch-up block for the
 * sandbox prompt. PURE READ — does NOT advance the marker (a dispatch that
 * fails to launch must not consume the brief). Returns `upTo` = the snapshot
 * turn count; the caller advances the marker to it via
 * {@link commitSlackDispatchMarker} only AFTER the run is durably launched. */
export async function webTurnsSinceLastSlackDispatch(
  threadKey: string,
): Promise<{ block: string; upTo: number }> {
  const ref = await kv.get<ExtSessionRef | string>(extSessionKey(threadKey)).catch(() => null);
  if (!ref) return { block: "", upTo: 0 };
  const sessionId = typeof ref === "string" ? ref : ref.id;
  const marker = (await kv.get<number>(syncMarkerKey(threadKey)).catch(() => null)) ?? 0;
  const turns = await getTurnsInternal(sessionId).catch(() => [] as ChatTurn[]);
  if (turns.length <= marker) return { block: "", upTo: turns.length };
  const delta = turns.slice(marker);
  // Brief OLDEST-first (natural transcript order) and advance the marker ONLY
  // past what we actually put in the brief. A prefix-count marker can't encode
  // "newest N briefed, older unbriefed", so a newest-first cap would mark the
  // oldest un-briefed turns as seen and silently drop them. If the backlog
  // exceeds the cap, the tail re-briefs on the next dispatch (no loss).
  const briefed = delta.slice(0, MAX_BRIEF_TURNS);
  const upTo = marker + briefed.length;
  const lines = briefed.map(
    (t) => `${t.role === "user" ? "Teammate" : "You (earlier)"}: ${t.content.slice(0, 1500)}`,
  );
  return {
    block: `[MEANWHILE — recent activity on this conversation (some may be from the web app at /s/${sessionId}). Catch up before answering; the user assumes you know it:]\n\n${lines.join("\n\n")}`,
    upTo,
  };
}

/** Advance the sync marker to `upTo` (monotonic). Call ONLY after the Slack
 * dispatch is durably launched. Never lowers the marker. */
export async function commitSlackDispatchMarker(threadKey: string, upTo: number): Promise<void> {
  const cur = (await kv.get<number>(syncMarkerKey(threadKey)).catch(() => null)) ?? 0;
  if (upTo > cur) await kv.set(syncMarkerKey(threadKey), upTo, { ex: SYNC_EX }).catch(() => {});
}

/** After the Slack lane appends its OWN turn, advance the marker past it — but
 * ONLY when contiguous (idx === marker). This never jumps over an interleaved
 * web turn sitting below it (that would silently drop it from the next brief);
 * the dispatch-side commit closes any resulting gap once the web turn has been
 * briefed. Bias: re-brief (harmless) over skip (lossy). */
export async function advanceMarkerForSlackTurn(
  threadKey: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const cur = (await kv.get<number>(syncMarkerKey(threadKey)).catch(() => null)) ?? 0;
  const turns = await getTurnsInternal(sessionId).catch(() => [] as ChatTurn[]);
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx === cur) await kv.set(syncMarkerKey(threadKey), idx + 1, { ex: SYNC_EX }).catch(() => {});
}

/** Best-effort cleanup of a session that never got a turn (loser of a
 * first-turn creation race). */
export async function deleteSessionIfEmpty(sessionId: string): Promise<void> {
  const [turn] = await db
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(eq(chatTurns.sessionId, sessionId))
    .limit(1);
  if (!turn) await db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).catch(() => {});
}

export type SessionScope = {
  botIds?: string[];
  note?: string;
  label?: string;
  /** Origin channel — "slack" | "email" | "play"; drives the /s channel filter
   *  and pill. Absent for a plain web chat. */
  source?: string;
  /** Slack/email lane cross-surface keys (written by the turns route + the
   *  Slack backfill; read by the reverse-mirror). */
  threadKey?: string;
  slackChannel?: string;
  slackThreadTs?: string;
} | null;

/** Durable dedup for Slack-origin sessions: the KV `sess:ext:` map expires
 * (90d) but the Postgres row persists, so a backfill must check here too. */
export async function findSessionByThreadKey(threadKey: string): Promise<string | null> {
  const [row] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(sql`${chatSessions.scope}->>'threadKey' = ${threadKey}`)
    .limit(1);
  return row?.id ?? null;
}

export async function createSession(opts: {
  viewer: string;
  title: string;
  scope: SessionScope;
}): Promise<ChatSession> {
  const [row] = await db
    .insert(chatSessions)
    .values({
      viewer: opts.viewer.toLowerCase(),
      title: opts.title.slice(0, 120) || "Untitled session",
      scope: opts.scope ?? null,
    })
    .returning();
  return row;
}

export async function addTurn(opts: {
  sessionId: string;
  viewer: string;
  role: "user" | "assistant";
  content: string;
}): Promise<ChatTurn | null> {
  // Team-writable: sales is a team sport, so any teammate can continue any
  // session (viewer is kept for attribution in the reverse-mirror, not as a
  // gate). We only require the session to exist.
  const [session] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.id, opts.sessionId))
    .limit(1);
  if (!session) return null;
  const [turn] = await db
    .insert(chatTurns)
    .values({ sessionId: opts.sessionId, role: opts.role, content: opts.content })
    .returning();
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, opts.sessionId));
  return turn;
}

/** Team-visible session list. No `owner` → everyone's sessions; pass `owner`
 * to scope to one person. `sinceMs` bounds by last activity (PT-aware ranges
 * come from view-filters). */
export async function listSessions(
  opts: { owner?: string; sinceMs?: number; limit?: number } = {},
): Promise<ChatSession[]> {
  const conds = [];
  if (opts.owner) conds.push(eq(chatSessions.viewer, opts.owner.toLowerCase()));
  if (opts.sinceMs) conds.push(gte(chatSessions.updatedAt, new Date(opts.sinceMs)));
  return db
    .select()
    .from(chatSessions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(chatSessions.updatedAt))
    .limit(opts.limit ?? 200);
}

export type SessionSearchHit = ChatSession & { snippet: string | null };

/** Show ~160 chars of `content` centered on the first match of `term`. */
function excerpt(content: string, term: string): string {
  const i = content.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return content.slice(0, 160).trim() + (content.length > 160 ? "…" : "");
  const start = Math.max(0, i - 70);
  const end = Math.min(content.length, i + term.length + 90);
  return (start > 0 ? "…" : "") + content.slice(start, end).trim() + (end < content.length ? "…" : "");
}

/** Team-wide session search across TITLE + message CONTENT (not just titles).
 * Everyone's sessions by default (sales is a team sport); pass `owner` to scope
 * to one person, `sinceMs` to bound by last activity. Returns each matching
 * session with a snippet from the matching message (null when only the title
 * matched). Content match is bounded to the most-recent matching turns. */
export async function searchSessions(
  q: string,
  opts: { owner?: string; sinceMs?: number; limit?: number } = {},
): Promise<SessionSearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`; // escape LIKE metacharacters

  // Matching messages (newest first) → snippet + candidate session ids.
  const turnHits = await db
    .select({ sessionId: chatTurns.sessionId, content: chatTurns.content })
    .from(chatTurns)
    .where(ilike(chatTurns.content, like))
    .orderBy(desc(chatTurns.createdAt))
    .limit(600);
  const snippetBy = new Map<string, string>();
  for (const t of turnHits) if (!snippetBy.has(t.sessionId)) snippetBy.set(t.sessionId, t.content);
  const turnIds = [...snippetBy.keys()];

  const match = turnIds.length
    ? or(ilike(chatSessions.title, like), inArray(chatSessions.id, turnIds))
    : ilike(chatSessions.title, like);
  const conds = [match];
  if (opts.owner) conds.push(eq(chatSessions.viewer, opts.owner.toLowerCase()));
  if (opts.sinceMs) conds.push(gte(chatSessions.updatedAt, new Date(opts.sinceMs)));

  const rows = await db
    .select()
    .from(chatSessions)
    .where(and(...conds))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(opts.limit ?? 60);
  return rows.map((s) => {
    const hit = snippetBy.get(s.id);
    return { ...s, snippet: hit ? excerpt(hit, term) : null };
  });
}

/** Team-readable: any signed-in teammate can view any session (the `viewer`
 * arg is ignored for filtering — kept for call-site compatibility). */
export async function getSession(
  id: string,
  _viewer?: string,
): Promise<{ session: ChatSession; turns: ChatTurn[] } | null> {
  void _viewer;
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);
  if (!session) return null;
  // Secondary sort puts 'user' before 'assistant' on createdAt ties (racing
  // fire-and-forget writes land in the same millisecond surprisingly often).
  const turns = await db
    .select()
    .from(chatTurns)
    .where(eq(chatTurns.sessionId, id))
    .orderBy(asc(chatTurns.createdAt), sql`${chatTurns.role} desc`)
    .limit(500);
  return { session, turns };
}
