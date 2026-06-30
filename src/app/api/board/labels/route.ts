import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import {
  listLabels,
  createLabel,
  attachLabel,
  detachLabel,
  labelsFor,
} from "@/lib/board-world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/labels
 * Auth: board secret + actor.
 * Dispatches on `action`:
 *  - { action:'list' }                                  → { ok, labels }
 *  - { action:'create', name, color? }                  → { ok, label }
 *  - { action:'attach', workItemId, labelId }           → { ok:true }
 *  - { action:'detach', workItemId, labelId }           → { ok:true }
 *  - { action:'for', workItemIds:string[] }             → { ok, byItem: Record<id, Label[]> }
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    name?: string;
    color?: string | null;
    labelId?: string;
    workItemId?: string;
    workItemIds?: string[];
  };

  switch (body.action) {
    case "list": {
      const labels = await listLabels();
      return NextResponse.json({ ok: true, labels });
    }
    case "create": {
      if (!body.name) return badRequest("missing name");
      const label = await createLabel(body.name, body.color ?? null);
      if (!label) return badRequest("create label failed");
      return NextResponse.json({ ok: true, label });
    }
    case "attach": {
      if (!body.workItemId || !body.labelId)
        return badRequest("missing workItemId or labelId");
      await attachLabel(body.workItemId, body.labelId);
      return NextResponse.json({ ok: true });
    }
    case "detach": {
      if (!body.workItemId || !body.labelId)
        return badRequest("missing workItemId or labelId");
      await detachLabel(body.workItemId, body.labelId);
      return NextResponse.json({ ok: true });
    }
    case "for": {
      const ids = body.workItemIds ?? [];
      const map = await labelsFor(ids);
      const byItem: Record<string, unknown> = {};
      for (const [k, v] of map) byItem[k] = v;
      return NextResponse.json({ ok: true, byItem });
    }
    default:
      return badRequest("unknown action");
  }
}
