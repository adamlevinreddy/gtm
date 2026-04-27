import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { kv } from "@/lib/kv-client";
import { buildAgentDriver, type AgentMeta } from "@/lib/agent-driver";
import { generateMcpUrl, getConnectionStatus, TOOLKITS, type ToolkitSlug } from "@/lib/composio";
import { getTokensForUser as getGranolaTokens, granolaMcpConfig } from "@/lib/granola";
import { randomUUID } from "node:crypto";

export const maxDuration = 800;

// One-shot agent run for the MCP server. Same agent driver as the Slack
// path, but `mcpRequestId` is set so post_slack_message buffers to KV
// instead of posting to Slack, and the run terminates by writing
// {answer, references} to `mcp:result:{requestId}`. We poll that key
// until it's set (or we time out), then return.
//
// Auth: requires `x-reddy-internal: $MCP_INTERNAL_SECRET`. Only the
// /mcp endpoint (running in the same Vercel project) calls this.

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min, matches sandbox limits
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;

type OneshotRequest = {
  question: string;
  userEmail: string;
  customer?: string;
};

type McpResult = {
  ok: boolean;
  answer?: string;
  references?: Array<{ label: string; url: string; type: string }>;
  error?: string;
  finishedAt?: string;
};

export async function POST(req: NextRequest) {
  const internalSecret = process.env.MCP_INTERNAL_SECRET;
  if (!internalSecret || req.headers.get("x-reddy-internal") !== internalSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: OneshotRequest;
  try {
    body = (await req.json()) as OneshotRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const { question, userEmail, customer } = body;
  if (!question || !userEmail) {
    return NextResponse.json({ ok: false, error: "missing question or userEmail" }, { status: 400 });
  }

  const requestId = randomUUID();
  const sandboxName = `reddy-gtm-mcp-${requestId.slice(0, 8)}`;
  const resultKey = `mcp:result:${requestId}`;

  try {
    // Resolve per-user toolkits exactly the same way /api/agent does.
    let connectedToolkits: ToolkitSlug[] = [];
    let composioMcp: { url: string; headers: Record<string, string> } | null = null;
    let granolaMcp: { url: string; headers: Record<string, string> } | null = null;
    if (process.env.COMPOSIO_API_KEY) {
      const status = await getConnectionStatus(userEmail).catch(() => null);
      if (status) {
        connectedToolkits = TOOLKITS.map((t) => t.slug).filter((s) => status[s]);
      }
      if (connectedToolkits.length > 0) {
        composioMcp = await generateMcpUrl(userEmail, connectedToolkits);
      }
    }
    const origin = req.nextUrl.origin;
    const granolaTokens = await getGranolaTokens(userEmail, origin).catch(() => null);
    if (granolaTokens) granolaMcp = granolaMcpConfig(granolaTokens.accessToken);

    // Inject a customer hint so the agent doesn't have to guess.
    const userText = customer
      ? `[customer scope hint: ${customer}]\n\n${question}`
      : question;

    const meta: AgentMeta = {
      sandboxName,
      slackChannel: "MCP_NO_CHANNEL",
      slackThreadTs: requestId,
      slackUser: null,
      slackUserEmail: userEmail,
      threadKey: `mcp:thread:${requestId}`,
      sessionId: randomUUID(),
      libraryRepoUrl: "github.com/ReddySolutions/reddy-gtm.git",
      isFirstTurn: true,
      turnCount: 1,
      connectedToolkits,
      composioMcp,
      granolaMcp,
      isSharedChannel: false,
      mcpRequestId: requestId,
    };

    const turnPayload = { turnNumber: 1, receivedAt: new Date().toISOString(), userText, slackUserEmail: userEmail, connectedToolkits };

    const sandbox = await Sandbox.create({
      name: sandboxName,
      resources: { vcpus: 4 },
      timeout: SANDBOX_TIMEOUT_MS,
      runtime: "node22",
      persistent: false, // one-shot — no need to keep around
    });

    await sandbox.writeFiles([
      { path: "inbox/turn-1.json", content: Buffer.from(JSON.stringify(turnPayload, null, 2)) },
      { path: "agent-driver.mjs", content: Buffer.from(buildAgentDriver(meta)) },
    ]);

    await sandbox.runCommand({
      cmd: "node",
      args: ["agent-driver.mjs", "1"],
      cwd: "/vercel/sandbox",
      detached: true,
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY ?? "",
        SLACK_BOT_TOKEN: "",
        SLACK_CHANNEL: "",
        SLACK_THREAD_TS: "",
        KV_REST_API_URL: process.env.REDDY_KV_REST_API_URL ?? "",
        KV_REST_API_TOKEN: process.env.REDDY_KV_REST_API_TOKEN ?? "",
        PRICING_LIBRARY_GITHUB_PAT: process.env.PRICING_LIBRARY_GITHUB_PAT ?? "",
        AGENT_THREAD_KEY: meta.threadKey,
        AGENT_SESSION_ID: meta.sessionId,
        APOLLO_API_KEY: process.env.APOLLO_API_KEY ?? "",
        ENRICHLAYER_API_KEY: process.env.ENRICHLAYER_API_KEY ?? "",
        HUBSPOT_API_KEY: process.env.HUBSPOT_API_KEY ?? "",
        SUPERMETRICS_API_KEY: process.env.SUPERMETRICS_API_KEY ?? "",
        EXA_API_KEY: process.env.EXA_API_KEY ?? "",
        HEYREACH_API_KEY: process.env.HEYREACH_API_KEY ?? "",
        GRANOLA_API_KEY: process.env.GRANOLA_API_KEY ?? "",
        RECALL_API_KEY: process.env.RECALL_API_KEY ?? "",
        RECALL_REGION: process.env.RECALL_REGION ?? "us-west-2",
        RECALL_VIDEO_FETCH_SECRET: process.env.RECALL_VIDEO_FETCH_SECRET ?? "",
        POSTGRES_URL: process.env.POSTGRES_URL ?? "",
        POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING ?? "",
        REDDY_GTM_BASE_URL: process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app",
      },
    });

    // Poll the result key until the driver writes it (or timeout).
    const startedAt = Date.now();
    let result: McpResult | null = null;
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      result = await kv.get<McpResult>(resultKey).catch(() => null);
      if (result) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Best-effort cleanup: stop the sandbox so we don't leak compute.
    sandbox.stop().catch(() => {});

    if (!result) {
      return NextResponse.json(
        { ok: false, error: "timed out waiting for agent response" },
        { status: 504 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error(
      `[agent/oneshot] failed for ${userEmail}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
