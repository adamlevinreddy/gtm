import { NextRequest } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, resultResponse, unauthorized } from "../_lib";
import { maybeFire } from "@/lib/board-events";
import { getItem, assignItem } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/assign
 * Body: { id, expectedVersion, ownerEmail?, botAssigned? }
 * Reassigns owner / toggles bot. Assigning the bot while a card is already
 * in_progress is itself a fire-worthy edge, so maybeFire runs after.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    expectedVersion?: number;
    ownerEmail?: string | null;
    botAssigned?: boolean;
  };
  if (!body.id || typeof body.expectedVersion !== "number") {
    return badRequest("missing id or expectedVersion");
  }
  if (body.ownerEmail === undefined && body.botAssigned === undefined) {
    return badRequest("nothing to assign");
  }

  const before = await getItem(body.id);
  const res = await assignItem(
    body.id,
    body.expectedVersion,
    {
      ...(body.ownerEmail !== undefined ? { ownerEmail: body.ownerEmail } : {}),
      ...(body.botAssigned !== undefined ? { botAssigned: body.botAssigned } : {}),
    },
    { kind: "human", email: actor }
  );

  if (res.ok) await maybeFire(before, res.item, "assign");

  return resultResponse(res);
}
