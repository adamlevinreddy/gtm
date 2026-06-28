import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { unauthorized } from "../_lib";
import {
  listWorkItems,
  getBoard,
  type BoardFilter,
} from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/list
 * Body: { filter?: BoardFilter, mode?: 'flat' | 'board' }
 *  - mode 'board' (default) → grouped columns via getBoard()
 *  - mode 'flat'            → listWorkItems()
 * Items carry their current `version`.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    filter?: BoardFilter;
    mode?: "flat" | "board";
  };
  const filter = body.filter ?? {};

  if (body.mode === "flat") {
    const items = await listWorkItems(filter);
    return NextResponse.json({ ok: true, items });
  }
  const board = await getBoard(filter);
  return NextResponse.json({ ok: true, board });
}
