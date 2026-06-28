import { NextRequest } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, resultResponse, unauthorized } from "../_lib";
import { maybeFire } from "@/lib/board-events";
import {
  getItem,
  transitionStatus,
  dropStatusOf,
  BOARD_COLUMNS,
  type BoardColumn,
} from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/move
 * Body: { id, expectedVersion, column }
 * Drops a card into a column → transitions to that column's landing status via
 * the CAS choke point, then fires a bot first pass if it just became eligible.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    expectedVersion?: number;
    column?: BoardColumn;
  };
  if (!body.id || typeof body.expectedVersion !== "number" || !body.column) {
    return badRequest("missing id, expectedVersion, or column");
  }
  if (!BOARD_COLUMNS.includes(body.column)) {
    return badRequest(`invalid column: ${body.column}`);
  }

  const before = await getItem(body.id);
  const res = await transitionStatus(
    body.id,
    body.expectedVersion,
    dropStatusOf(body.column),
    { kind: "human", email: actor }
  );

  if (res.ok) await maybeFire(before, res.item, "move");

  return resultResponse(res);
}
