import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { unauthorized } from "../_lib";
import {
  listWorkItems,
  getBoard,
  resolveBoardId,
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
    /** Optional board key (gtm/success/operations); scopes the listing. */
    boardKey?: string | null;
  };
  const filter: BoardFilter = { ...(body.filter ?? {}) };
  // Scope to a board: explicit filter.boardId wins; else resolve boardKey
  // (which defaults to GTM). Pass boardKey === null to opt out of scoping.
  if (!filter.boardId && body.boardKey !== null) {
    const boardId = await resolveBoardId(body.boardKey);
    if (boardId) filter.boardId = boardId;
  }

  if (body.mode === "flat") {
    const items = await listWorkItems(filter);
    return NextResponse.json({ ok: true, items });
  }
  const board = await getBoard(filter);
  return NextResponse.json({ ok: true, board });
}
