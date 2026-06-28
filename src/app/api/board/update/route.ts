import { NextRequest } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, resultResponse, unauthorized } from "../_lib";
import { maybeFire } from "@/lib/board-events";
import {
  getItem,
  applyWorkItemUpdate,
  transitionStatus,
  setDue,
  setHighPriority,
  type UpdateResult,
  type WorkItemStatus,
} from "@/lib/work-items";
import type { NewWorkItem } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Patch = Partial<NewWorkItem> & { dueAt?: string | Date | null };

/**
 * POST /api/board/update
 * Body: { id, expectedVersion, patch }
 *
 * Routing rules (all guarded by the supplied expectedVersion):
 *  - patch.status        → transitionStatus (maintains stage/start/complete +
 *                          parent counts), then maybeFire.
 *  - patch.dueAt         → setDue.
 *  - patch.highPriority  → setHighPriority.
 *  - patch.boardRank ONLY → a pure reorder: write boardRank via the CAS choke
 *                           point with NO maybeFire (reorders never start work).
 *  - any other fields    → applyWorkItemUpdate field_change, then maybeFire.
 *
 * Exactly one routing concern is handled per call; status takes precedence,
 * then due, then priority, then rank-only, then generic.
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    expectedVersion?: number;
    patch?: Patch;
  };
  if (!body.id || typeof body.expectedVersion !== "number" || !body.patch) {
    return badRequest("missing id, expectedVersion, or patch");
  }
  const { id, expectedVersion, patch } = body;
  const actorRef = { kind: "human" as const, email: actor };

  const before = await getItem(id);

  let res: UpdateResult;
  let fire = true;

  if (patch.status !== undefined) {
    res = await transitionStatus(
      id,
      expectedVersion,
      patch.status as WorkItemStatus,
      actorRef
    );
  } else if (patch.dueAt !== undefined) {
    const due = patch.dueAt === null ? null : new Date(patch.dueAt);
    res = await setDue(id, expectedVersion, due, actorRef);
  } else if (patch.highPriority !== undefined) {
    res = await setHighPriority(id, expectedVersion, !!patch.highPriority, actorRef);
  } else if (patch.boardRank !== undefined && Object.keys(patch).length === 1) {
    // Pure reorder — write only boardRank, never fire a bot pass.
    fire = false;
    res = await applyWorkItemUpdate(
      id,
      expectedVersion,
      { boardRank: patch.boardRank },
      {
        kind: "field_change",
        actorKind: "human",
        actorEmail: actor,
        meta: { field: "boardRank", after: patch.boardRank },
      }
    );
  } else {
    res = await applyWorkItemUpdate(id, expectedVersion, patch, {
      kind: "field_change",
      actorKind: "human",
      actorEmail: actor,
      meta: { fields: Object.keys(patch) },
    });
  }

  if (res.ok && fire) await maybeFire(before, res.item, "update");

  return resultResponse(res);
}
