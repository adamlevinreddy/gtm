import { resolveApiViewer } from "@/lib/viewer";
import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

// Browser-facing chat for the board surfaces (home hero, meetings hub, single
// meeting). Routes through the SAME agent primitive as the Slack bot
// (/api/agent/oneshot → buildAgentDriver), so it has the full toolset (board
// create/update, HubSpot, KB, Granola) and obeys the same guardrails. One
// brain across Slack, the web app, and email.
//
// Body: { messages: [{role,content}], botIds?: string[], scopeNote?: string }
//   - botIds present  → scoped meeting chat (the meetings hub / viewer)
//   - botIds absent   → open-ended: the agent's normal cross-source brain
//                       (KB transcripts + docs, HubSpot, board) — home view.
//
// Response: NDJSON stream, one JSON object per line:
//   {"t":"status","text":"…"}  progress while the agent works
//   {"t":"delta","text":"…"}   answer chunks (typed out)
//   {"t":"done"}               end of turn
// The old plain-text protocol silently showed NOTHING for up to 250s; status
// lines keep the wait honest.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Hard ceiling on scoped ids (365-day view can hold ~400 transcripts; beyond
// this we tell BOTH the agent and the user the scope was trimmed — never
// silently). Prompt cost is ~50 bytes/id.
const MAX_BOTS = 200;

type ChatMsg = { role: "user" | "assistant"; content: string };

function buildPrompt(opts: {
  botIds: string[];
  truncatedFrom: number | null;
  scopeNote: string | null;
  messages: ChatMsg[];
  viewer: string;
}): string {
  const { botIds, truncatedFrom, scopeNote, messages, viewer } = opts;
  const convo = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const lines: string[] = [
    `You are the Reddy GTM assistant — the SAME bot as in Slack — answering inside the team's web app (asked by ${viewer}).`,
  ];

  if (botIds.length > 0) {
    lines.push(
      scopeNote
        ? `The user is looking at a filtered set of ${botIds.length} meetings (${scopeNote}).`
        : `The user is focused on ${botIds.length === 1 ? "one meeting" : `${botIds.length} meetings`}.`,
      truncatedFrom
        ? `NOTE: their view actually contains ${truncatedFrom} meetings; only the ${botIds.length} most recent are scoped here. Mention this if it could affect the answer.`
        : ``,
      `Transcripts + metadata live in the cloned KB ('_unsorted' is a real slug, so glob) at:`,
      `  corpora/success/customers/*/meetings/<botId>/transcript.txt  and  .../meta.json`,
      `Scoped bot ids (newest first):`,
      botIds.join(", "),
      ``,
      `Work ONLY from these meetings for content questions. Strategy: for a broad question, don't read every transcript end-to-end — grep across the scoped transcript paths for relevant terms first, then read the hits. For questions that genuinely need every meeting (counts, per-meeting lists), process all scoped ids and say so.`,
    );
  } else {
    lines.push(
      `Answer from EVERYTHING you have: the KB (meeting transcripts, pricing, contracts, playbooks), HubSpot, the board, and any connected tools — exactly as you would in Slack.`,
    );
  }

  lines.push(
    `You have your full toolset: when the user asks you to ACT — create/update a board task (board_*), log to or update HubSpot, draft a follow-up, etc. — do it, following the usual guardrails (anything customer-facing is draft/suggest-only, never auto-sent; respect task ownership; confirm-first for risky changes). When you create or change something, state exactly what you did.`,
    `FORMAT: standard GitHub-flavored Markdown (this panel renders it — tables, links, lists all work). NOT Slack mrkdwn: use **bold**, [link](url), and | tables |.`,
    `MOMENT CITATIONS (receipts): when you quote or paraphrase something said in a meeting, cite the moment as a markdown link to /m/{botId}?t={seconds} — e.g. "[Nike QBR · 14:32](/m/abc-123?t=872)". Compute seconds from the transcript.json timestamps when available (corpora/.../meetings/{botId}/transcript.json has per-line start times); if only transcript.txt exists, link without ?t=. Every factual claim about what someone said should carry one — the link opens the video seeked to that second.`,
    `Be concise and conversational — this is a chat panel, not a report. No preamble.`,
    ``,
    `CONVERSATION SO FAR (oldest first):`,
    convo,
    ``,
    `Reply to the user's latest message.`,
  );

  return lines.filter((l, i) => l !== `` || lines[i - 1] !== ``).join("\n");
}

type OneshotResult = {
  answer: string;
  attachments: Array<{ name: string; kbPath: string }>;
  attachmentsTotal: number;
};

async function runOneshot(
  question: string,
  userEmail: string,
  requestId?: string,
): Promise<OneshotResult | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      // requestId: the client minted it and re-polls mcp:result:{id} if this
      // stream dies — the answer lands late instead of never (Daybreak P1).
      // lane "web" arms the driver's artifact path: files the agent builds
      // persist to corpora/deliverables/ and surface as download cards.
      body: JSON.stringify({ question, userEmail, pollTimeoutMs: 250_000, requestId, lane: "web" }),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      answer?: string;
      attachments?: Array<{ name?: string; kbPath?: string }>;
    } | null;
    if (json?.ok && json.answer) {
      const valid = (json.attachments ?? []).filter(
        (a): a is { name: string; kbPath: string } => !!a?.name && !!a?.kbPath,
      );
      return {
        answer: json.answer,
        attachments: valid.slice(0, 10),
        attachmentsTotal: valid.length,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { botIds?: unknown; messages?: unknown; scopeNote?: unknown; requestId?: unknown; as?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const allBotIds = Array.isArray(body.botIds)
    ? (body.botIds.filter((b) => typeof b === "string" && b) as string[])
    : [];
  const truncatedFrom = allBotIds.length > MAX_BOTS ? allBotIds.length : null;
  const botIds = allBotIds.slice(0, MAX_BOTS);
  const scopeNote = typeof body.scopeNote === "string" && body.scopeNote ? body.scopeNote.slice(0, 300) : null;
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
  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: "missing messages" }, { status: 400 });
  }

  const requestId =
    typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : undefined;
  const viewer = resolveApiViewer(req, body.as);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  const encoder = new TextEncoder();
  const line = (obj: Record<string, unknown>) => encoder.encode(JSON.stringify(obj) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(line(obj));
        } catch {
          /* client went away */
        }
      };

      if (truncatedFrom) {
        send({ t: "status", text: `Scope trimmed to the ${MAX_BOTS} most recent of ${truncatedFrom} meetings.` });
      }
      send({ t: "status", text: botIds.length > 0 ? "Reading the meeting transcripts…" : "Looking across meetings, HubSpot, and the library…" });

      // Heartbeats while the agent works — a warm sandbox answers in
      // ~10-30s, a cold one in ~60-90s; without these the panel used to sit
      // on a bare cursor for minutes.
      const started = Date.now();
      const STAGES: Array<[number, string]> = [
        [20, "Still working — the assistant is digging through sources…"],
        [60, "Still working — first question after a quiet spell takes ~1 min to warm up…"],
        [150, "Still working — this is a big one…"],
      ];
      let stage = 0;
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (stage < STAGES.length && elapsed >= STAGES[stage][0]) {
          send({ t: "status", text: STAGES[stage][1] });
          stage += 1;
        }
      }, 5_000);

      const result = await runOneshot(
        buildPrompt({ botIds, truncatedFrom, scopeNote, messages, viewer }),
        viewer,
        requestId,
      );
      clearInterval(ticker);
      const answer = result?.answer ?? null;

      if (answer === null) {
        // Agent outran the poll window (or errored). The run may still finish
        // and write mcp:result:{requestId} — tell the client to re-poll
        // instead of pretending the answer is gone.
        send(requestId ? { t: "timeout", requestId } : { t: "delta", text: "⚠️ The assistant didn't respond in time — try again." });
        send({ t: "done" });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      // Type the answer out in chunks.
      const chunkSize = 48;
      for (let i = 0; i < answer.length; i += chunkSize) {
        send({ t: "delta", text: answer.slice(i, i + chunkSize) });
        if (i + chunkSize < answer.length) await new Promise((r) => setTimeout(r, 8));
      }
      const atts = result?.attachments ?? [];
      for (const a of atts) {
        send({ t: "attachment", name: a.name, kbPath: a.kbPath });
      }
      if (result && result.attachmentsTotal > atts.length) {
        send({ t: "status", text: `${result.attachmentsTotal - atts.length} more file${result.attachmentsTotal - atts.length === 1 ? "" : "s"} were produced — find them in the Library.` });
      }
      send({ t: "done" });
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
