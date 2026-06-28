import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { unauthorized } from "../_lib";
import { listBoards, getBoardSummary, type BoardColumn } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/boards
 * Auth: board secret + actor.
 * Returns every top-level board (GTM / Success / Operations) with its
 * per-board open counts so the UI switcher can render a count badge.
 *
 * Response: { ok:true, boards: Array<{
 *   id, key, name, description, sortOrder,
 *   counts: { open, done, dismissed, byColumn: Record<BoardColumn,number> }
 * }> }
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const boards = await listBoards();
  const summaries = await Promise.all(
    boards.map((b) => getBoardSummary(b.id))
  );

  const out = boards.map((b, i) => {
    const s = summaries[i];
    return {
      id: b.id,
      key: b.key,
      name: b.name,
      description: b.description,
      sortOrder: b.sortOrder,
      counts: {
        open: s.open,
        done: s.done,
        dismissed: s.dismissed,
        byColumn: s.byColumn as Record<BoardColumn, number>,
      },
    };
  });

  return NextResponse.json({ ok: true, boards: out });
}
