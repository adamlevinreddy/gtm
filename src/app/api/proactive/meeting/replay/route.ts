// POST /api/proactive/meeting/replay — testing endpoint. Internal-auth only.
//
// Unlike /api/proactive/meeting, this AWAITS proposeFromMeeting (with force:true
// so it bypasses the idempotency claim) and returns the full result, so a tester
// can replay each June 26 meeting on demand and see the outcome inline.

import { NextRequest, NextResponse } from "next/server";
import { proposeFromMeeting } from "@/lib/post-meeting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-reddy-internal") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { botId?: string };
  try {
    body = (await req.json()) as { botId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const botId = body?.botId;
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }

  const result = await proposeFromMeeting(botId, { force: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
