import { NextRequest, NextResponse } from "next/server";
import { addTurn, getSession } from "@/lib/sessions";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function viewer(req: NextRequest): string | null {
  return verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const v = viewer(req);
  if (!v) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  const found = await getSession(id, v).catch(() => null);
  if (!found) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...found });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const v = viewer(req);
  if (!v) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { role?: string; content?: string } | null;
  const role = body?.role === "assistant" ? "assistant" : body?.role === "user" ? "user" : null;
  if (!role || typeof body?.content !== "string" || !body.content) {
    return NextResponse.json({ ok: false, error: "need role + content" }, { status: 400 });
  }
  // Cap matches the route's validation posture elsewhere — an unbounded turn
  // would re-enter every subsequent prompt for the life of the session.
  const turn = await addTurn({ sessionId: id, viewer: v, role, content: body.content.slice(0, 200_000) }).catch(() => null);
  if (!turn) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, turn });
}
