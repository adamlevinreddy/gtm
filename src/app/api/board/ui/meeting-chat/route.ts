import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

// Browser-facing chat proxy for the board meeting viewer. The client posts a
// question about a meeting; we resolve the viewer (board cookie), build a
// transcript-scoped prompt, and forward to /api/agent/oneshot holding
// MCP_INTERNAL_SECRET server-side (the browser never sees it). Mirrors the
// auth model of the other /api/board/ui/* routes.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

const VIEWER_COOKIE = "board_viewer";

function resolveViewer(req: NextRequest, bodyAs?: unknown): string {
  if (typeof bodyAs === "string" && bodyAs.includes("@")) return bodyAs;
  const qAs = req.nextUrl.searchParams.get("as");
  if (qAs && qAs.includes("@")) return qAs;
  const cookie = req.cookies.get(VIEWER_COOKIE)?.value;
  if (cookie && cookie.includes("@")) return cookie;
  return process.env.BOARD_DEFAULT_VIEWER || "adam@reddy.io";
}

type Body = {
  botId?: string;
  question?: string;
  history?: Array<{ role?: string; text?: string }>;
  as?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const botId = typeof body.botId === "string" ? body.botId : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!botId || !question) {
    return NextResponse.json({ ok: false, error: "missing botId or question" }, { status: 400 });
  }

  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });

  const viewer = resolveViewer(req, body.as);

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const historyBlock = history.length
    ? "\n\nCONVERSATION SO FAR (oldest first):\n" +
      history
        .map((h) => `${h.role === "user" ? "Q" : "A"}: ${(h.text ?? "").slice(0, 1500)}`)
        .join("\n") +
      "\n"
    : "";

  const prompt = [
    `You are answering a question about ONE specific meeting, inside the Reddy board's meeting viewer.`,
    `MEETING BOT ID: ${botId}`,
    `Read this meeting's transcript and metadata from the cloned KB ('_unsorted' is a real slug, so glob):`,
    `  - transcript: corpora/success/customers/*/meetings/${botId}/transcript.txt`,
    `  - metadata:   corpora/success/customers/*/meetings/${botId}/meta.json`,
    `Answer ONLY from THIS meeting's transcript/metadata. Do NOT consult Granola, the web, HubSpot, or other meetings. If the transcript doesn't cover it, say so in one line.`,
    `Be concise and conversational — this is a chat panel, not a report. Short paragraphs or tight bullets, no preamble.`,
    historyBlock,
    `USER QUESTION: ${question}`,
  ].join("\n");

  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({ question: prompt, userEmail: viewer, pollTimeoutMs: 680_000 }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    if (json?.ok && json.answer) return NextResponse.json({ ok: true, answer: json.answer });
    return NextResponse.json({ ok: false, error: "agent unavailable or timed out" }, { status: 502 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
