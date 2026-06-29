// POST /api/proactive/meeting/replay — testing endpoint. Internal-auth only.
//
// Unlike /api/proactive/meeting, this AWAITS proposeFromMeeting (with force:true
// so it bypasses the idempotency claim) and returns the full result, so a tester
// can replay each June 26 meeting on demand and see the outcome inline.

import { NextRequest, NextResponse } from "next/server";
import { proposeFromMeeting } from "@/lib/post-meeting";
import { proposeCrmFromMeeting } from "@/lib/post-meeting-crm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-reddy-internal") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { botId?: string; mode?: "tasks" | "crm" | "both" };
  try {
    body = (await req.json()) as { botId?: string; mode?: "tasks" | "crm" | "both" };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const botId = body?.botId;
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }
  const mode = body.mode ?? "both";

  const tasks = mode === "crm" ? null : await proposeFromMeeting(botId, { force: true });
  const crm = mode === "tasks" ? null : await proposeCrmFromMeeting(botId);
  const ok = (tasks?.ok ?? true) && (crm?.ok ?? true);
  return NextResponse.json({ ok, tasks, crm }, { status: ok ? 200 : 502 });
}
