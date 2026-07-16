import { resolveApiViewer } from "@/lib/viewer";
import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing saved-views proxy. Holds BOARD_API_SECRET server-side and
// forwards to the agent-protected /api/board/views. The viewer is resolved the
// same way the move proxy does it (body `as` / ?as= / cookie / default) and
// becomes the x-board-actor — the downstream route stamps that as the owner.
//
//   downstream: POST ${selfBaseUrl()}/api/board/views
//     header: x-board-secret, x-board-actor
//     body:   { action:'list' | 'save' | 'delete', ... }
// ---------------------------------------------------------------------------



export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 }
    );
  }

  const secret = process.env.BOARD_API_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "BOARD_API_SECRET not set" },
      { status: 500 }
    );
  }

  const actor = resolveApiViewer(req, body.as);
  if (!actor) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  // strip `as` before forwarding — identity travels in the header
  const forward = { ...body };
  delete forward.as;

  let upstream: Response;
  try {
    upstream = await fetch(`${selfBaseUrl()}/api/board/views`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-board-secret": secret,
        "x-board-actor": actor,
      },
      body: JSON.stringify(forward),
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    payload = { ok: false, error: `upstream ${upstream.status}` };
  }
  return NextResponse.json(payload, { status: upstream.status });
}
