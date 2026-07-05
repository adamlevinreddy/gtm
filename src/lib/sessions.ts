// Chat sessions (Daybreak Phase 8). Every web conversation persists here —
// refresh, come back tomorrow, pick up where you left off. The agent gets
// the full turn history in its prompt on every ask (same mechanism as
// before), so resume needs no sandbox state.

import { desc, eq, and, asc, sql } from "drizzle-orm";
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

export type SessionScope = {
  botIds?: string[];
  note?: string;
  label?: string;
} | null;

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
  // Ownership check — turns only append to the viewer's own session.
  const [session] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, opts.sessionId), eq(chatSessions.viewer, opts.viewer.toLowerCase())))
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

export async function listSessions(viewer: string, limit = 50): Promise<ChatSession[]> {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.viewer, viewer.toLowerCase()))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit);
}

export async function getSession(
  id: string,
  viewer: string,
): Promise<{ session: ChatSession; turns: ChatTurn[] } | null> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.viewer, viewer.toLowerCase())))
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
