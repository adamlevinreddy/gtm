import { NextRequest, NextResponse } from "next/server";
import {
  getBoard,
  resolveBoardId,
  type WorkItemKind,
} from "@/lib/work-items";
import { itemIdsForFilters } from "@/lib/board-filter-query";
import { resolveApiViewer } from "@/lib/viewer";
import { ssoEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing board re-fetch. Used by BoardClient to reconcile after a 409
// conflict (someone else moved the card). Read-only. Honors the SAME filters
// the server page applies (board, assignee/mine, kind, label, priority,
// customer) so the optimistic board converges on exactly what's on screen.
// No secret needed — this only reads the projection.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const boardKey = sp.get("board") || undefined;
  const assigneeParam = sp.get("assignee") || undefined;
  const mine = sp.get("mine") === "1";
  const kind = sp.get("kind") || undefined;
  const label = sp.get("label") || undefined;
  const priorityOnly = sp.get("priority") === "1";
  const customer = sp.get("customer") || undefined;
  // Under SSO this read is gated on a valid signed cookie (no ?as=, no default);
  // with SSO off it stays honor-system so `mine` still resolves.
  const viewer = resolveApiViewer(req) ?? undefined;
  if (ssoEnabled() && !viewer) {
    return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  }

  try {
    // "all" = cross-board view (the /tasks board tab): no board filter at all.
    const boardId = boardKey === "all" ? null : await resolveBoardId(boardKey);

    // assignee: explicit owner, "__none__" → unassigned, or "mine" → viewer
    let ownerEmail: string | undefined;
    let unassignedOnly = false;
    if (mine && viewer) ownerEmail = viewer;
    else if (assigneeParam === "__none__") unassignedOnly = true;
    else if (assigneeParam) ownerEmail = assigneeParam;

    // label filter resolves to an id allow-list (intersect post-fetch)
    const idsForLabel = label
      ? await itemIdsForFilters({ labelId: label })
      : null;

    let board = await getBoard({
      boardId: boardId ?? undefined,
      ownerEmail,
      customerSlug: customer,
      kind: kind ? [kind as WorkItemKind] : undefined,
    });

    // post-fetch refinements that getBoard doesn't model
    if (unassignedOnly || idsForLabel || priorityOnly) {
      const allow = idsForLabel ? new Set(idsForLabel) : null;
      board = filterBoard(board, (it) => {
        if (unassignedOnly && it.ownerEmail) return false;
        if (allow && !allow.has(it.id)) return false;
        if (priorityOnly && !it.highPriority && !isDueSoon(it.dueAt)) return false;
        return true;
      });
    }

    return NextResponse.json({ ok: true, board });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function isDueSoon(dueAt: Date | string | null): boolean {
  if (!dueAt) return false;
  const d = dueAt instanceof Date ? dueAt : new Date(dueAt);
  return d.getTime() - Date.now() < WEEK_MS;
}

type BoardShape = Awaited<ReturnType<typeof getBoard>>;
function filterBoard(
  board: BoardShape,
  keep: (it: BoardShape["Unsorted"][number]) => boolean
): BoardShape {
  const out = { ...board };
  for (const col of [
    "Unsorted",
    "To Do",
    "Reddy Working",
    "Reddy Waiting",
    "Completed",
  ] as const) {
    out[col] = board[col].filter(keep);
  }
  return out;
}
