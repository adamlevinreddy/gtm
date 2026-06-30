import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { addComment, logActivity, getItem } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/activity
 * Body: { id, kind:'comment'|'logged_activity', body, occurredAt? }
 * Append-only ledger write (no version guard). 'comment' → addComment;
 * 'logged_activity' → logActivity (backdatable via occurredAt).
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    kind?: "comment" | "logged_activity";
    body?: string;
    occurredAt?: string;
  };
  if (!body.id || !body.kind || !body.body) {
    return badRequest("missing id, kind, or body");
  }
  if (body.kind !== "comment" && body.kind !== "logged_activity") {
    return badRequest("kind must be 'comment' or 'logged_activity'");
  }

  const item = await getItem(body.id);
  if (!item) {
    return NextResponse.json(
      { ok: false, reason: "not_found", current: null },
      { status: 404 }
    );
  }

  if (body.kind === "comment") {
    await addComment(body.id, body.body, actor);
  } else {
    await logActivity(body.id, {
      kind: "logged_activity",
      actorKind: "human",
      actorEmail: actor,
      body: body.body,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });
  }

  return NextResponse.json({ ok: true });
}
