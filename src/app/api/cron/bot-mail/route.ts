import { NextRequest, NextResponse } from "next/server";
import { deliverPendingMail } from "@/lib/bot-mail";

// ---------------------------------------------------------------------------
// bot@reddy.io DELIVER-ON-COMPLETION cron. The inbound webhook records a pending
// reply (botmail:pending:{runId}) before kicking the agent and only waits inline
// for the snappy case. Heavy runs (e.g. building a multi-tier proposal) routinely
// outrun that wait — this sweep emails the reply once the agent's result lands at
// mcp:result:{runId}, or sends a timeout note if it never does. Idempotent: a
// delivered reply's pending key is deleted, so it's sent exactly once.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET`.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await deliverPendingMail();
  return NextResponse.json({ ok: true, ...result });
}
