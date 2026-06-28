import { NextRequest } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, resultResponse, unauthorized } from "../_lib";
import { completeWithCascade } from "@/lib/work-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/complete
 * Body: { id, expectedVersion }
 * Marks the item done and cascades open children to done (each child guarded by
 * its own CAS). No bot fire on completion.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    expectedVersion?: number;
  };
  if (!body.id || typeof body.expectedVersion !== "number") {
    return badRequest("missing id or expectedVersion");
  }

  const res = await completeWithCascade(body.id, body.expectedVersion, {
    kind: "human",
    email: actor,
  });

  return resultResponse(res);
}
