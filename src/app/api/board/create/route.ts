import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { maybeFire } from "@/lib/board-events";
import {
  createWorkItem,
  type CreateInput,
  type WorkItemKind,
  type WorkItemStatus,
} from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/create
 * Body: CreateInput-ish { title, kind, ... }.
 * Default status: 'approved' (a human created it → it skips triage) unless an
 * explicit status is supplied. createdBy/ownerEmail default to the actor.
 * Fires a bot first pass if the created item lands in a bot-fire state.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as Omit<
    Partial<CreateInput>,
    "dueAt"
  > & {
    title?: string;
    kind?: WorkItemKind;
    dueAt?: string | null;
  };
  if (!body.title || !body.kind) return badRequest("missing title or kind");

  const status: WorkItemStatus = body.status ?? "approved";

  const item = await createWorkItem({
    title: body.title,
    kind: body.kind,
    status,
    source: body.source ?? "manual",
    ownerEmail: body.ownerEmail ?? actor,
    botAssigned: body.botAssigned ?? false,
    customerSlug: body.customerSlug ?? null,
    sourceRef: body.sourceRef ?? null,
    accountId: body.accountId ?? null,
    opportunityId: body.opportunityId ?? null,
    meetingId: body.meetingId ?? null,
    parentId: body.parentId ?? null,
    dueAt: body.dueAt ? new Date(body.dueAt) : null,
    highPriority: body.highPriority ?? false,
    payload: body.payload,
    createdBy: actor,
    boardRank: body.boardRank ?? null,
  });

  if (!item) return badRequest("create failed");

  await maybeFire(null, item, "create");

  return NextResponse.json({ ok: true, item }, { status: 201 });
}
