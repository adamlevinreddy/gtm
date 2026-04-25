import { NextRequest, NextResponse } from "next/server";
import { freshVideoUrl } from "@/lib/recall";

// Return a fresh signed video download URL for a Recall bot. The agent
// hits this just-in-time before sharing a video — Recall's URLs expire
// in roughly an hour, so we never persist them.
//
// Auth: a shared secret (RECALL_VIDEO_FETCH_SECRET) sent as
// `x-reddy-secret`. Keeps the endpoint internal-only without going
// through Slack auth.
export async function GET(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  const expected = process.env.RECALL_VIDEO_FETCH_SECRET;
  const provided = req.headers.get("x-reddy-secret");
  if (expected && provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }

  try {
    const { url, expiresAt } = await freshVideoUrl(botId);
    return NextResponse.json({ ok: true, url, expiresAt });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
