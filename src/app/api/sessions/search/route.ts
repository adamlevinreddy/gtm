import { NextRequest, NextResponse } from "next/server";
import { searchSessions } from "@/lib/sessions";
import { selfBaseUrl } from "@/lib/work-items";

// Team-wide session search for the sandbox agent (x-board-secret) — so "ask AI"
// can recall what anyone did on something, the same way the /s search bar does.
// Everyone's sessions, by title + message content. Server-to-server only; the
// /s page calls searchSessions() directly (no need for this route in the UI).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const secret = process.env.BOARD_API_SECRET;
  if (!secret || req.headers.get("x-board-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ ok: true, sessions: [] });
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20, 1), 50);
  const hits = await searchSessions(q, { limit }).catch(() => []);
  const base = selfBaseUrl();
  return NextResponse.json({
    ok: true,
    sessions: hits.map((s) => ({
      id: s.id,
      title: s.title,
      viewer: s.viewer,
      updatedAt: s.updatedAt,
      snippet: s.snippet,
      url: `${base}/s/${s.id}`,
    })),
  });
}
