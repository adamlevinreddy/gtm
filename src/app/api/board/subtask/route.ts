import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { maybeFire } from "@/lib/board-events";
import { createSubtask, type WorkItemKind } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/subtask
 * Body: { parentId, title, kind, ownerEmail?, dueAt?, sourceRef?, customerSlug? }
 * Creates a child item (default status 'approved' — a human-created subtask) and
 * fires a bot pass if eligible. sourceRef carries the source-meeting botId so a
 * subtask created from a post-meeting proposal links back to its recording.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    parentId?: string;
    title?: string;
    kind?: WorkItemKind;
    ownerEmail?: string | null;
    dueAt?: string | null;
    sourceRef?: string | null;
    customerSlug?: string | null;
  };
  if (!body.parentId || !body.title || !body.kind) {
    return badRequest("missing parentId, title, or kind");
  }

  const item = await createSubtask(body.parentId, {
    title: body.title,
    kind: body.kind,
    status: "approved",
    source: body.sourceRef ? "post_meeting" : "manual",
    ownerEmail: body.ownerEmail ?? actor,
    dueAt: body.dueAt ? new Date(body.dueAt) : null,
    sourceRef: body.sourceRef ?? null,
    customerSlug: body.customerSlug ?? null,
    createdBy: actor,
  });

  if (!item) return badRequest("subtask create failed");

  await maybeFire(null, item, "subtask");

  return NextResponse.json({ ok: true, item }, { status: 201 });
}
