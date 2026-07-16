import { resolveApiViewer } from "@/lib/viewer";
import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl, BOARD_COLUMNS, type BoardColumn } from "@/lib/work-items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing move proxy. The BoardClient island POSTs here with the
// viewer's identity carried implicitly (cookie / ?as=). This route holds the
// BOARD_API_SECRET server-side and forwards to the agent-protected
// /api/board/move (built by the board-API module) so the browser never sees
// the secret.
//
//   downstream contract — POST ${selfBaseUrl()}/api/board/move
//     header: x-board-secret: $BOARD_API_SECRET
//     body:   { id, expectedVersion, column, actorEmail }
//     200:    { ok: true,  item }
//     409:    { ok: false, reason: "conflict",  current }
//     404:    { ok: false, reason: "not_found", current: null }
//
// We pass the status through verbatim so the client can branch on 409.
// ---------------------------------------------------------------------------


function isBoardColumn(v: unknown): v is BoardColumn {
  return typeof v === "string" && (BOARD_COLUMNS as string[]).includes(v);
}


type MoveBody = {
  id?: unknown;
  expectedVersion?: unknown;
  column?: unknown;
  as?: unknown;
};

export async function POST(req: NextRequest) {
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_request", error: "invalid json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : null;
  const expectedVersion =
    typeof body.expectedVersion === "number" ? body.expectedVersion : null;
  const column = body.column;

  if (!id || expectedVersion === null || !isBoardColumn(column)) {
    return NextResponse.json(
      { ok: false, reason: "bad_request", error: "id, expectedVersion(number), column(BoardColumn) required" },
      { status: 400 }
    );
  }

  const secret = process.env.BOARD_API_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: "misconfigured", error: "BOARD_API_SECRET not set" },
      { status: 500 }
    );
  }

  const actorEmail = resolveApiViewer(req, body.as);
  if (!actorEmail) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${selfBaseUrl()}/api/board/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-board-secret": secret, "x-board-actor": actorEmail },
      body: JSON.stringify({ id, expectedVersion, column }),
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: "upstream_unreachable", error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  // Pass the JSON + status straight through (incl. 409 conflict w/ `current`).
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    payload = { ok: false, reason: "upstream_error", error: `upstream ${upstream.status}` };
  }
  return NextResponse.json(payload, { status: upstream.status });
}
