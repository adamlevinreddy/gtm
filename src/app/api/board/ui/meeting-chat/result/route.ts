import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Late-answer recovery (Daybreak Phase 1). The chat client mints a requestId
// per run; when the NDJSON stream dies or times out it polls here. The agent
// writes its final answer to mcp:result:{id} regardless of who's listening —
// so the answer lands late instead of never. Ids are client-minted UUIDs
// (unguessable); the key expires on its own TTL.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type McpResult = { ok?: boolean; answer?: string; error?: string };

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  const result = await kv.get<McpResult>(`mcp:result:${id}`).catch(() => null);
  if (!result) return NextResponse.json({ ok: true, ready: false });
  // `||` not `??`: the driver legitimately writes answer:"" on tool-only
  // runs — an empty string must resolve the poll with the fallback text,
  // not strand the client polling a "ready" result it treats as not-ready.
  return NextResponse.json({
    ok: true,
    ready: true,
    answer: result.answer || (result.error ? `⚠️ ${result.error}` : "⚠️ The run finished without an answer."),
  });
}
