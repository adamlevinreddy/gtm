import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { listViews, saveView, deleteView } from "@/lib/board-world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/views
 * Auth: board secret + actor. The owner of a saved view is ALWAYS the
 * authenticated actor (never trusted from the body).
 * Dispatches on `action`:
 *  - { action:'list' }                          → { ok, views }  (own + shared)
 *  - { action:'save', name, shared?, spec? }    → { ok, view }
 *  - { action:'delete', id }                    → { ok, deleted }
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    name?: string;
    shared?: boolean;
    spec?: unknown;
  };

  switch (body.action) {
    case "list": {
      const views = await listViews(actor);
      return NextResponse.json({ ok: true, views });
    }
    case "save": {
      if (!body.name) return badRequest("missing name");
      const view = await saveView({
        name: body.name,
        ownerEmail: actor,
        shared: body.shared ?? false,
        spec: body.spec,
      });
      if (!view) return badRequest("save view failed");
      return NextResponse.json({ ok: true, view });
    }
    case "delete": {
      if (!body.id) return badRequest("missing id");
      const deleted = await deleteView(body.id);
      return NextResponse.json({ ok: true, deleted });
    }
    default:
      return badRequest("unknown action");
  }
}
