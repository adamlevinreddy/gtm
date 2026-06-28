import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

// Browser-facing chat for the meetings view. Routes through the SAME agent
// primitive as the Slack bot (/api/agent/oneshot → buildAgentDriver), so it has
// the full toolset (board create/update, HubSpot, KB) and obeys the same
// guardrails. One brain across Slack, the meetings view, and (later) Gmail —
// improving agent-driver.ts improves all of them. Non-streaming under the hood
// (the sandbox agent returns a final answer); we pseudo-stream it back so the
// panel types it out. Body: { botIds: string[], messages: [{role,content}] }.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const VIEWER_COOKIE = "board_viewer";
const MAX_BOTS = 15;

function resolveViewer(req: NextRequest, bodyAs?: unknown): string {
  if (typeof bodyAs === "string" && bodyAs.includes("@")) return bodyAs;
  const qAs = req.nextUrl.searchParams.get("as");
  if (qAs && qAs.includes("@")) return qAs;
  const cookie = req.cookies.get(VIEWER_COOKIE)?.value;
  if (cookie && cookie.includes("@")) return cookie;
  return process.env.BOARD_DEFAULT_VIEWER || "adam@reddy.io";
}

type ChatMsg = { role: "user" | "assistant"; content: string };
type Body = { botIds?: unknown; messages?: unknown; as?: string };

function buildPrompt(botIds: string[], messages: ChatMsg[]): string {
  const scope =
    botIds.length === 1
      ? `the meeting with bot id ${botIds[0]}`
      : `these ${botIds.length} meetings (bot ids: ${botIds.join(", ")})`;
  const convo = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return [
    `You are the Reddy GTM assistant — the SAME bot as in Slack — answering inside the board's meetings view. The user is focused on ${scope}.`,
    `Read the transcript(s) + metadata from the cloned KB ('_unsorted' is a real slug, so glob) for EACH bot id:`,
    `  corpora/success/customers/*/meetings/<botId>/transcript.txt  and  .../meta.json`,
    `Ground your answers in these meetings. You have your full toolset: when the user asks you to ACT — create/update a board task (board_*), log to or update HubSpot, draft a follow-up, etc. — do it, following the usual guardrails (anything customer-facing is draft/suggest-only, never auto-sent; respect task ownership; confirm-first for risky changes). When you create or change something, state exactly what you did.`,
    `Be concise and conversational — this is a chat panel, not a report. No preamble.`,
    ``,
    `CONVERSATION SO FAR (oldest first):`,
    convo,
    ``,
    `Reply to the user's latest message.`,
  ].join("\n");
}

async function runOneshot(question: string, userEmail: string): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({ question, userEmail, pollTimeoutMs: 250_000 }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    if (json?.ok && json.answer) return json.answer;
  } catch {
    /* fall through */
  }
  return null;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const botIds = Array.isArray(body.botIds)
    ? (body.botIds.filter((b) => typeof b === "string" && b) as string[]).slice(0, MAX_BOTS)
    : [];
  const messages = Array.isArray(body.messages)
    ? (body.messages
        .filter(
          (m): m is ChatMsg =>
            !!m && typeof m === "object" && typeof (m as ChatMsg).content === "string"
        )
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })) as ChatMsg[])
    : [];
  if (botIds.length === 0 || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "missing botIds or messages" }, { status: 400 });
  }

  const viewer = resolveViewer(req, body.as);
  const encoder = new TextEncoder();

  // Open the stream immediately; run the agent inside it. The panel shows a
  // thinking cursor during the wait, then the answer types out.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const answer =
        (await runOneshot(buildPrompt(botIds, messages), viewer)) ??
        "⚠️ The assistant didn't respond in time — try again.";
      const chunkSize = 24;
      for (let i = 0; i < answer.length; i += chunkSize) {
        controller.enqueue(encoder.encode(answer.slice(i, i + chunkSize)));
        if (i + chunkSize < answer.length) await new Promise((r) => setTimeout(r, 10));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
