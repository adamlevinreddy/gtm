import { NextRequest, NextResponse } from "next/server";
import { getSession, setPendingRequest } from "@/lib/sessions";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pin an in-flight agent requestId to a session (Daybreak P8): if the asking
// tab dies before the answer lands, the next /s/{id} load completes the turn
// from mcp:result:{requestId}.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const v = verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
  if (!v) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { requestId?: string } | null;
  if (!UUID_RE.test(id) || !body?.requestId || !UUID_RE.test(body.requestId)) {
    return NextResponse.json({ ok: false, error: "bad ids" }, { status: 400 });
  }
  // Ownership check — only the session's viewer can pin to it.
  const found = await getSession(id, v).catch(() => null);
  if (!found) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  await setPendingRequest(id, body.requestId);
  return NextResponse.json({ ok: true });
}
