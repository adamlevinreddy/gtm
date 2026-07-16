import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// Browser-facing task-mutation proxy (Daybreak P14 — /tasks slide-over).
// Verified viewers only; holds BOARD_API_SECRET server-side and forwards to
// the agent-grade board routes (update / assign / activity / move), passing
// 409 conflicts through verbatim so the client can refetch.

const ACTIONS: Record<string, string> = {
  update: "/api/board/update",
  assign: "/api/board/assign",
  comment: "/api/board/activity",
  move: "/api/board/move",
};

export async function POST(req: NextRequest) {
  const viewer = verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
  if (!viewer) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const secret = process.env.BOARD_API_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as { action?: string; payload?: Record<string, unknown> } | null;
  const path = body?.action ? ACTIONS[body.action] : undefined;
  if (!path || !body?.payload || typeof body.payload !== "object") {
    return NextResponse.json({ ok: false, error: "need action + payload" }, { status: 400 });
  }

  const payload: Record<string, unknown> = { ...body.payload };
  if (body.action === "comment") payload.kind = "comment";
  if (body.action === "move") payload.actorEmail = viewer;
  if (body.action === "comment") payload.actorEmail = viewer;

  const res = await fetch(`${selfBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-board-secret": secret,
      "x-board-actor": viewer,
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!res) return NextResponse.json({ ok: false, error: "upstream unreachable" }, { status: 502 });
  const json = await res.json().catch(() => ({ ok: false, error: "bad upstream response" }));
  return NextResponse.json(json, { status: res.status });
}
