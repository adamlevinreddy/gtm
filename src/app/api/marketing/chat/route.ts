import { resolveApiViewer } from "@/lib/viewer";
import { NextRequest, NextResponse } from "next/server";
import { selfBaseUrl } from "@/lib/work-items";

// The Marketing surface's chat (/marketing). Same agent primitive as everything
// else (/api/agent/oneshot → buildAgentDriver), but with two deliberate
// differences from the sales/board chat:
//   1. It runs on FABLE (claude-fable-5) — the model override rides through the
//      oneshot body into the driver's queryOptions.model.
//   2. The live WEBSITE SOURCE is cloned into the sandbox (extraRepos) so the
//      blog writer works from our real code, not a guess — plus the marketing
//      corpus and every meeting transcript the KB already carries.
// Streaming protocol + late-poll recovery are identical to the board chat, so
// the shared MeetingChatStream component drives it (endpoint prop).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Fable — the model this surface is built around. The user explicitly wants the
// marketing/blog sandbox on Fable while the rest of the app stays on Opus.
const MARKETING_MODEL = "claude-fable-5";
// The live website, cloned as a sibling of workspace/ at ../website-src.
const WEBSITE_REPO = { url: "github.com/ReddySolutions/web.git", dir: "website-src" };

type ChatMsg = { role: "user" | "assistant"; content: string };

function buildPrompt(opts: { messages: ChatMsg[]; viewer: string }): string {
  const { messages, viewer } = opts;
  const convo = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  return [
    `You are Reddy's marketing content partner, working inside the team's web app on the Marketing surface (asked by ${viewer}). Your specialty here is writing on-brand content — blog posts first.`,
    ``,
    `WHAT YOU CAN DRAW ON (all already available in this sandbox):`,
    `• The MARKETING LIBRARY — corpora/marketing/ in the cloned KB (workspace/): brand voice, positioning, prior campaign artifacts, and anything the team has uploaded on this page.`,
    `• The LIVE WEBSITE SOURCE — cloned at ../website-src (i.e. /vercel/sandbox/website-src). This is our real, current site code: read the marketing/product pages and existing blog posts for tone, accurate claims, and to avoid repeating what we've already published. If the clone is missing or you need the rendered version, crawl the live site (reddy.io) with WebFetch.`,
    `• CUSTOMER CONVERSATIONS — every meeting transcript in the KB at corpora/success/customers/*/meetings/*/transcript.txt ('_unsorted' is a real slug, so glob). Grep these for real stories, quotes, objections, and outcomes worth citing; anonymize customer names unless they're clearly public references.`,
    ``,
    `HOW TO WORK: this is a collaborative chat, not a one-shot. For a new post, confirm the topic/angle/audience in one short message if it isn't already clear, then draft. Deliver drafts in Markdown with a working title + 2–3 alternates, a one-line SEO meta description, 1–3 target keywords, and a clean H2/H3 body. Reddy's voice is sharp, concrete, and specific — no fluff, no AI throat-clearing. NEVER publish or push anything; show the draft here and iterate with me.`,
    `FORMAT: standard GitHub-flavored Markdown (this panel renders tables, links, lists). Be conversational — no preamble.`,
    ``,
    `CONVERSATION SO FAR (oldest first):`,
    convo,
    ``,
    `Reply to the user's latest message.`,
  ].join("\n");
}

type OneshotResult = {
  answer: string;
  attachments: Array<{ name: string; kbPath: string }>;
  attachmentsTotal: number;
};

type UploadRef = { id?: string; name?: string; mimetype?: string; size?: number; url?: string };

async function runOneshot(
  question: string,
  userEmail: string,
  requestId?: string,
  files?: UploadRef[],
): Promise<OneshotResult | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({
        question,
        userEmail,
        pollTimeoutMs: 285_000,
        requestId,
        lane: "web",
        model: MARKETING_MODEL,
        extraRepos: [WEBSITE_REPO],
        files,
      }),
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
      return { answer: json.answer, attachments: valid.slice(0, 10), attachmentsTotal: valid.length };
    }
  } catch {
    /* fall through */
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { messages?: unknown; requestId?: unknown; files?: unknown; as?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages)
    ? (body.messages
        .filter(
          (m): m is ChatMsg => !!m && typeof m === "object" && typeof (m as ChatMsg).content === "string",
        )
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })) as ChatMsg[])
    : [];
  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: "missing messages" }, { status: 400 });
  }

  const requestId =
    typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : undefined;
  const uploadBase = `${selfBaseUrl()}/api/board/ui/upload?id=`;
  const files: UploadRef[] = Array.isArray(body.files)
    ? (body.files as UploadRef[])
        .filter((f) => !!f && typeof f.url === "string" && f.url.startsWith(uploadBase))
        .slice(0, 10)
        .map((f) => ({
          id: typeof f.id === "string" ? f.id : "",
          name: typeof f.name === "string" ? f.name.slice(0, 200) : "upload",
          mimetype: typeof f.mimetype === "string" ? f.mimetype : "application/octet-stream",
          size: typeof f.size === "number" ? f.size : 0,
          url: f.url,
        }))
    : [];

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

      send({ t: "status", text: "Reading the site, our marketing library, and relevant calls…" });

      const started = Date.now();
      const STAGES: Array<[number, string]> = [
        [25, "Still working — pulling voice from the site and material from customer calls…"],
        [70, "Still working — first request after a quiet spell warms the sandbox (~1 min)…"],
        [160, "Still working — drafting…"],
      ];
      let stage = 0;
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (stage < STAGES.length && elapsed >= STAGES[stage][0]) {
          send({ t: "status", text: STAGES[stage][1] });
          stage += 1;
        }
      }, 5_000);

      const result = await runOneshot(buildPrompt({ messages, viewer }), viewer, requestId, files);
      clearInterval(ticker);
      const answer = result?.answer ?? null;

      if (answer === null) {
        send(requestId ? { t: "timeout", requestId } : { t: "delta", text: "⚠️ The assistant didn't respond in time — try again." });
        send({ t: "done" });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      const chunkSize = 48;
      for (let i = 0; i < answer.length; i += chunkSize) {
        send({ t: "delta", text: answer.slice(i, i + chunkSize) });
        if (i + chunkSize < answer.length) await new Promise((r) => setTimeout(r, 8));
      }
      const atts = result?.attachments ?? [];
      for (const a of atts) send({ t: "attachment", name: a.name, kbPath: a.kbPath });
      if (result && result.attachmentsTotal > atts.length) {
        send({ t: "status", text: `${result.attachmentsTotal - atts.length} more file(s) were produced — find them in the Library.` });
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
