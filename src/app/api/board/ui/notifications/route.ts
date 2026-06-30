import { NextRequest, NextResponse } from "next/server";
import {
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/board-world";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing notifications proxy for the /board/inbox page. Marking your
// own notifications read is low-risk and viewer-scoped, so this resolves the
// viewer the same way the other ui proxies do and acts directly on board-world
// (no agent route needed). Reads happen server-side in the inbox page.
//   - { action:'read', id }   → mark one read
//   - { action:'readAll' }    → mark all the viewer's unread read
// ---------------------------------------------------------------------------

const VIEWER_COOKIE = "board_viewer";

function resolveViewer(req: NextRequest, bodyAs?: unknown): string {
  if (typeof bodyAs === "string" && bodyAs.includes("@")) return bodyAs;
  const qAs = req.nextUrl.searchParams.get("as");
  if (qAs && qAs.includes("@")) return qAs;
  const cookie = req.cookies.get(VIEWER_COOKIE)?.value;
  if (cookie && cookie.includes("@")) return cookie;
  return process.env.BOARD_DEFAULT_VIEWER || "adam@reddy.io";
}

export async function POST(req: NextRequest) {
  let body: { action?: string; id?: string; as?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const viewer = resolveViewer(req, body.as);

  try {
    if (body.action === "read") {
      if (!body.id)
        return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
      const ok = await markNotificationRead(body.id);
      return NextResponse.json({ ok });
    }
    if (body.action === "readAll") {
      const n = await markAllNotificationsRead(viewer);
      return NextResponse.json({ ok: true, marked: n });
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
