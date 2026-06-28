import { NextRequest, NextResponse } from "next/server";
import { assertInternalNoOrigin } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { runBotPass } from "@/lib/bot-worker/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/board/bot-run  (INTERNAL ONLY)
 * Body: { itemId, taskRevision }
 * Auth: x-board-secret only (no actor), and any browser Origin is rejected.
 * Returns 202 IMMEDIATELY and runs runBotPass detached — we do NOT await it, so
 * the worker keeps running after the response is sent. The KV NX lock + the
 * unique-where-not-failed attempts index make it safe to fire more than once.
 */
export async function POST(req: NextRequest) {
  if (!assertInternalNoOrigin(req)) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    itemId?: string;
    taskRevision?: number;
  };
  if (!body.itemId || typeof body.taskRevision !== "number") {
    return badRequest("missing itemId or taskRevision");
  }

  // Detached — do NOT await. Worker is self-locking and never throws.
  void runBotPass(body.itemId, body.taskRevision);

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}
