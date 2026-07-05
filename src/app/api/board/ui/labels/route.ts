import { resolveApiViewer } from "@/lib/viewer";
import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing labels proxy. Holds BOARD_API_SECRET server-side and forwards
// to the agent-protected /api/board/labels. Same viewer-resolution as the move
// proxy. Supports list / create / attach / detach / for (see that route).
// ---------------------------------------------------------------------------



export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
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
  const forward = { ...body };
  delete forward.as;

  let upstream: Response;
  try {
    upstream = await fetch(`${selfBaseUrl()}/api/board/labels`, {
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
