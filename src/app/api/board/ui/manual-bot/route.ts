import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Browser-facing proxy for "add the notetaker to a meeting NOW" (Daybreak
// Phase 6 — replaces the orphaned /recall-bot page that made users paste a
// shared secret into a form). The secret stays server-side, and because
// this SPENDS it (dispatches a real bot into any meeting), the caller must
// carry a verified identity cookie — this is not an open endpoint.
export async function POST(req: NextRequest) {
  const viewer = verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
  if (!viewer) {
    return NextResponse.json({ ok: false, error: "pick who you are first (Settings)" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { meetingUrl?: string } | null;
  const meetingUrl = body?.meetingUrl?.trim() ?? "";
  if (!/^https?:\/\//i.test(meetingUrl)) {
    return NextResponse.json({ ok: false, error: "paste a meeting join URL" }, { status: 400 });
  }
  const secret = process.env.RECALL_VIDEO_FETCH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  const res = await fetch(`${selfBaseUrl()}/api/recall/manual-bot`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reddy-secret": secret },
    body: JSON.stringify({ meetingUrl }),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  if (!res || !res.ok) {
    return NextResponse.json(
      { ok: false, error: (json as { error?: string } | null)?.error ?? "couldn't dispatch the bot" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
