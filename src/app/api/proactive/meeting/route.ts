// POST /api/proactive/meeting — fired (fire-and-forget) by the lead's
// reconcile() when a Recall bot finishes a meeting. Internal-auth only.
//
// The triage itself runs Claude in a sandbox (~3 min), which would exceed the
// HTTP timeout, so we kick it off inside after() and return 202 immediately.
// We AWAIT proposeFromMeeting *inside* after() — a plain fire-and-forget gets
// dropped on Vercel.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
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

  after(async () => {
    const result = await proposeFromMeeting(botId);
    console.log(`[proactive/meeting] ${botId}: ${JSON.stringify(result)}`);
  });

  return NextResponse.json({ ok: true, accepted: true, botId }, { status: 202 });
}
