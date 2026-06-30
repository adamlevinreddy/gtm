import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import { getItem, getChildren, getActivities } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/get
 * Body: { id: string }
 * Returns the item (+ its current version), its children, and its activity feed.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return badRequest("missing id");

  const item = await getItem(id);
  if (!item) {
    return NextResponse.json(
      { ok: false, reason: "not_found", current: null },
      { status: 404 }
    );
  }
  const [children, activities] = await Promise.all([
    getChildren(id),
    getActivities(id),
  ]);
  return NextResponse.json({ ok: true, item, children, activities });
}
