import { NextRequest, NextResponse } from "next/server";
import { assertInternalNoOrigin } from "@/lib/board-auth";
import { kv } from "@/lib/kv-client";
import {
  createSession,
  addTurn,
  getSessionOwnerInternal,
  advanceMarkerForSlackTurn,
  deleteSessionIfEmpty,
  extSessionKey,
  type ExtSessionRef,
} from "@/lib/sessions";

const SESS_EX = 90 * 24 * 3600;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Session sync intake (Daybreak Arc V): the sandbox driver mirrors Slack-
// and email-lane turns here so every conversation shows up in /s alongside
// web sessions. Keyed by the lane's threadKey; the mapping lives in KV.
// Auth: x-board-secret with no browser Origin — same posture as bot-run.
//
// Ownership: the session belongs to whoever STARTED the thread; later turns
// from other participants still append (turns are written with the stored
// owner so a second Slack user in the thread doesn't get dropped).

type Body = {
  threadKey?: string;
  lane?: string;
  channel?: string;
  threadTs?: string;
  userEmail?: string;
  role?: string;
  content?: string;
};

export async function POST(req: NextRequest) {
  if (!assertInternalNoOrigin(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const threadKey = body?.threadKey?.slice(0, 200);
  const role = body?.role === "assistant" ? "assistant" : body?.role === "user" ? "user" : null;
  const content = typeof body?.content === "string" ? body.content.slice(0, 200_000) : "";
  const lane = body?.lane === "email" ? "email" : "slack";
  if (!threadKey || !role || !content) {
    return NextResponse.json({ ok: false, error: "need threadKey, role, content" }, { status: 400 });
  }
  const sender = (body?.userEmail && body.userEmail.includes("@") ? body.userEmail : "team@reddy.io").toLowerCase();

  const rawRef = await kv.get<ExtSessionRef | string>(extSessionKey(threadKey)).catch(() => null);
  let ref: ExtSessionRef | null = null;
  if (rawRef && typeof rawRef === "object") {
    ref = rawRef;
  } else if (typeof rawRef === "string") {
    // Legacy value shape: bare session-id string. Resolve the REAL owner from
    // the DB (guessing the current sender breaks the ownership check for any
    // second participant), and repair the KV shape so we don't relookup.
    const owner = await getSessionOwnerInternal(rawRef).catch(() => null);
    if (owner) {
      ref = { id: rawRef, viewer: owner };
      await kv.set(extSessionKey(threadKey), ref, { ex: SESS_EX }).catch(() => {});
    } else {
      // Legacy ref points at a deleted session. CLEAR the stale key before
      // recreating — otherwise the nx set below collides with this dead string,
      // re-reads the same dead id, and 500s every turn, wedging the thread
      // until the KV TTL expires.
      await kv.del(extSessionKey(threadKey)).catch(() => {});
    }
  }

  if (!ref) {
    const session = await createSession({
      viewer: sender,
      title: content.slice(0, 100),
      scope: {
        note: undefined,
        label: lane === "email" ? "Email thread" : "Slack thread",
        // Slack context enables the reverse mirror: web replies on this
        // session post back into the original thread.
        ...({ source: lane, threadKey, slackChannel: body?.channel, slackThreadTs: body?.threadTs } as object),
      } as never,
    }).catch(() => null);
    if (!session) return NextResponse.json({ ok: false, error: "session create failed" }, { status: 500 });
    const candidate: ExtSessionRef = { id: session.id, viewer: session.viewer };
    // First-turn race: two participants in a brand-new thread both create a
    // session. `nx` lets exactly one mapping win; the loser adopts the winner's
    // ref and drops its empty stub so the thread never splits across two
    // sessions (which would also desync the marker).
    const won = await kv.set(extSessionKey(threadKey), candidate, { ex: SESS_EX, nx: true }).catch(() => null);
    if (won) {
      ref = candidate;
    } else {
      // Lost the nx race (or a stale key we couldn't clear). Adopt the winner
      // ONLY if it resolves to a LIVE session; a dead legacy string is NOT
      // adopted (that's the wedge) — we keep our fresh session and force the
      // mapping to it instead.
      const winner = await kv.get<ExtSessionRef | string>(extSessionKey(threadKey)).catch(() => null);
      let adopted: ExtSessionRef | null = null;
      if (winner && typeof winner === "object") {
        adopted = winner;
      } else if (typeof winner === "string") {
        const owner = await getSessionOwnerInternal(winner).catch(() => null);
        if (owner) adopted = { id: winner, viewer: owner };
      }
      if (adopted) {
        ref = adopted;
        if (adopted.id !== candidate.id) await deleteSessionIfEmpty(candidate.id).catch(() => {});
      } else {
        ref = candidate;
        await kv.set(extSessionKey(threadKey), candidate, { ex: SESS_EX }).catch(() => {});
      }
    }
  }

  // Multi-participant threads: append AS THE OWNER (ownership check would
  // silently drop the second participant's turns); name the actual sender
  // inline when they differ.
  const attributed =
    role === "user" && sender !== ref.viewer ? `**${sender}:** ${content}` : content;
  const turn = await addTurn({ sessionId: ref.id, viewer: ref.viewer, role, content: attributed }).catch(() => null);
  if (!turn) return NextResponse.json({ ok: false, error: "turn append failed" }, { status: 500 });

  // Advance the sync marker PAST this Slack-lane turn — but only if it's the
  // immediate next unseen turn (contiguous). Jumping to the full turn count
  // (the old behavior) silently skipped web turns that interleaved during the
  // multi-minute agent run. The dispatch-side commit closes any gap once those
  // web turns have actually been briefed.
  if (lane === "slack") {
    await advanceMarkerForSlackTurn(threadKey, ref.id, turn.id).catch(() => {});
  }

  return NextResponse.json({ ok: true, sessionId: ref.id });
}
