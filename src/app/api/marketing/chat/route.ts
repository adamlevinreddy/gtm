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
    `You are Reddy's marketing content partner, working inside the team's web app on the Marketing surface (asked by ${viewer}). Your specialties here are on-brand content (blog posts first) and SMYKM outbound sequences (email via Instantly, LinkedIn via HeyReach).`,
    ``,
    `WHAT YOU CAN DRAW ON (all already in this sandbox):`,
    `• MARKETING LIBRARY, corpora/marketing/ in the cloned KB (workspace/): brand voice, positioning, prior campaign artifacts, and anything the team uploaded on this page.`,
    `• LIVE WEBSITE SOURCE, cloned at ../website-src (/vercel/sandbox/website-src): our real, current site. Read the marketing/product pages and the published blog posts in client/src/data/blogData.ts and shared/blogMeta.ts (including any not linked on /blog) so you match our voice, keep claims accurate, and never repeat a topic we have already covered. Crawl reddy.io with WebFetch if you need the rendered/most recent version.`,
    `• CUSTOMER CONVERSATIONS, meeting transcripts in the KB at corpora/success/customers/*/meetings/*/transcript.txt ('_unsorted' is a real slug, so glob). Use these ONLY to learn what contact-center leaders actually struggle with and to understand context, i.e. to FIND topics. Per guardrail 1 below, you never reproduce a call's quotes, stats, or identity in the output.`,
    `• SEARCH DATA, the supermetrics MCP tools (mcp__supermetrics__*): Google Search Console for sc-domain:reddy.io, Semrush Analytics (source id SR — organic keywords, positions, and search volumes for ANY domain, ours or a competitor's, so use it for competitor keyword gaps), plus GA4, Google Ads, and LinkedIn Ads. GSC is the source of truth for what we rank for and what gets impressions; guardrail 10 below says how to use it. Queries are ASYNC (data_query submits, get_async_query_results polls), so fire them early and keep working while they run.`,
    `• LIVE LANDSCAPE, WebSearch then WebFetch: what ranks today for a query, and what competitors currently publish about their features and positioning. Never make competitor or market claims from memory; their sites and content change.`,
    `• WRITING CONSTITUTION, corpora/marketing/copywriting-guide.md in the KB: Read it before drafting any copy and obey it (the 10 hard rules, banned vocabulary, the Three Rules gate, plain-by-default punch rationing, second-generation AI tells, never invent stats). Where it conflicts with the BLOG GUARDRAILS or the delivery format here, the guardrails and format win (e.g. guardrail 6's "Label — text" exception stands, and blog posts use the blog structure below, not the guide's landing-page output format).`,
    ``,
    `BLOG GUARDRAILS (hard rules from our marketing lead, follow every time):`,
    `1. Recordings are for TOPICS + CONTEXT ONLY. Never reproduce a prospect or customer conversation, quote, stat, or identity in the content, and never attribute an insight to a company or even to "an operation we spoke with" or "a cruise line". State the insight as a plain, unattributed observation, phrased as fact. The ONLY customers that may be named or attributed in public content are Harte Hanks, Morgan & Morgan, and ISG. Because we never reproduce call specifics, there is nothing to verify against transcripts; do not quote or cite them.`,
    `2. Research is OPTIONAL; lead with Reddy's own take. A post can stand entirely on Reddy's point of view and industry understanding (informed by those unattributed conversations). Do not reach for a stat when our own argument will do. If you do cite an external source, first read the published posts (blogData.ts) and NEVER reuse a source that already appears in one. We have overused Gartner and McKinsey with near-identical framing; do not add more of those.`,
    `3. No competitor knocks on age, funding, or company size. Anything you say about a competitor's scale applies to Reddy too (we were also founded in 2023). Draw contrasts on PRODUCT and FEATURE gaps only, e.g. "its practice layer is conversation-level roleplay rather than practice inside replicas of the systems agents actually use".`,
    `4. Consistent customer facts. Name Morgan & Morgan (America's largest injury law firm), ISG, and Harte Hanks the same way every time; Grubhub is ALWAYS anonymized as "a leading food delivery app". Match any stat to how it appears on reddy.io, and describe a customer the way prior posts already describe them.`,
    `5. One consistent THESIS, not stacked lists. Every post carries a clear argument from the first line to the last; state it explicitly. Structure can flex by topic, the through-line cannot. Do not hand back disconnected blocks of facts.`,
    `6. No em dashes. The only allowed use is the "Label — text" list format. Use commas, periods, or parentheses instead.`,
    `7. No competitor inflation. State a competitor's capability plainly and cut superlatives (best-known, gold standard, most established, strongest, most complete). Describe what it does, not how impressive it is.`,
    `8. Verify before you knock. Confirm a competitor's actual capability against their live site before asserting any weakness. If you can't verify it, phrase it as "not published", never "does not have", and cite your evidence.`,
    `9. vs-page voice asymmetry. In any comparison or listicle, Reddy's "where it falls short" always redirects to a different buyer profile, never admits a real weakness. Competitor entries carry honest gaps. Accept the asymmetry.`,
    `10. Keywords are GSC-validated, not guessed. Pull Google Search Console via the supermetrics MCP tools. Target the winnable zone (position 5 to 15 with real impressions) plus question-shaped queries for AI citation. Ignore CTR on non-brand terms; the KPI is ranking higher and being the cited answer. Name the GSC data behind each pick. Coin a zero-volume term only deliberately, and say so.`,
    `11. AI-citation formatting is standard. Every post gets a definitional H2 and a question-shaped, liftable FAQ matched to how the query is actually asked. Do not pitch FAQ schema as a SERP win; it is AI-answer value only.`,
    `12. Internal links point to verified live routes only. Check the path exists in ../website-src routing before linking (known: reporting is /voice-of-customer, coaching is /quality, Auto QA is /quality-assurance; there is NO /platform or /reporting). Never invent a path; the site returns 200 on bad paths, so a broken link sits unnoticed.`,
    `13. No Reddy product inference. Never assert Reddy pricing, features, SLAs, or specifics that aren't verifiable on reddy.io.`,
    `14. Customer facts must match the live case study page a reader can click to, not just other blog posts. Reconcile every customer stat against that page before using it.`,
    ``,
    `OUTREACH RULES (for outbound sequences — email via Instantly, LinkedIn via HeyReach):`,
    `• The constitution is corpora/marketing/outbound/smykm-guide.md (SMYKM research lanes, hook rules, email anatomy, AI-tell kills) + corpora/marketing/outbound/sequence-templates.md (per-campaign-type skeletons: fresh cold / ABM / revival). The copywriting guide applies to every line. Customer naming in prospect-facing copy follows the hard reference rules in corpora/marketing/INDEX.md.`,
    `• Research recency is HARD: no hook older than ~12 months, no fabricated hooks or stats, label VERIFIED vs inferred, and verify the prospect still holds the role before pitching.`,
    `• The instantly MCP tools (mcp__instantly__*) manage our real Instantly workspace, and the heyreach MCP tools (mcp__heyreach__*, when connected) our real LinkedIn outreach. READS are always fine. WRITES are draft-only: create campaigns PAUSED, and NEVER activate, launch, send, schedule, or delete anything unless the user explicitly approves that exact action in this conversation. The user launches campaigns themselves in the apps.`,
    `• Never fake personalization at scale (Sam's pitfall 3): a step is either genuinely personalized from research or honestly templated with merge fields. Flag prospects whose research surfaced no in-window hook instead of inventing one.`,
    ``,
    `HOW TO WORK: this is a collaborative chat, not a one-shot. For a new post, confirm the topic/angle/audience in one short message if it is not already clear, then draft. Deliver drafts in Markdown with a working title + 2 to 3 alternates, a one-line SEO meta description, 1 to 3 target keywords, and a clean H2/H3 body built around the thesis. Reddy's voice is sharp, concrete, and plain-spoken; no fluff, no AI throat-clearing. NEVER publish or push anything; show the draft here and iterate with me.`,
    `FORMAT: standard GitHub-flavored Markdown (this panel renders tables, links, lists). Be conversational, no preamble.`,
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
  costUsd?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
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
      costUsd?: number;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    } | null;
    if (json?.ok && json.answer) {
      const valid = (json.attachments ?? []).filter(
        (a): a is { name: string; kbPath: string } => !!a?.name && !!a?.kbPath,
      );
      return {
        answer: json.answer,
        attachments: valid.slice(0, 10),
        attachmentsTotal: valid.length,
        costUsd: json.costUsd,
        model: json.model,
        inputTokens: json.inputTokens,
        outputTokens: json.outputTokens,
      };
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
      if (result?.costUsd) {
        send({ t: "cost", costUsd: result.costUsd, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
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
