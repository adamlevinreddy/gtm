import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { kv } from "@/lib/kv-client";
import { buildAgentDriver, type AgentMeta } from "@/lib/agent-driver";
import { generateMcpUrl, getConnectionStatus, TOOLKITS, type ToolkitSlug } from "@/lib/composio";
import { getTokensForUser as getGranolaTokens, granolaMcpConfig } from "@/lib/granola";
import { recentMeetingIndex, formatMeetingIndex, activeMeetingsBlock } from "@/lib/recall-index";
import { createHash, randomUUID } from "node:crypto";

export const maxDuration = 800;

// One-shot agent run for the MCP server. Same agent driver as the Slack
// path, but `mcpRequestId` is set so post_slack_message buffers to KV
// instead of posting to Slack, and the run terminates by writing
// {answer, references} to `mcp:result:{requestId}`. We poll that key
// until it's set (or we time out), then return.
//
// Sandbox is persistent + per-user (not per-request) so subsequent
// MCP calls from the same teammate skip the cold-start tax (clone +
// npm install). First call: ~60-90s. Warm calls: ~10-30s.
//
// Auth: requires `x-reddy-internal: $MCP_INTERNAL_SECRET`. Only the
// /mcp endpoint (running in the same Vercel project) calls this.

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 4 * 60 * 1000; // stay under Claude Desktop's MCP timeout
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → auto-snapshot
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

function sandboxNameForEmail(email: string): string {
  const hash = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  return `reddy-gtm-mcp-${hash}`;
}

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
  const sandboxName = sandboxNameForEmail(userEmail);
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

    // Pre-fetch the recent meetings index from the kb so the agent
    // can't accidentally route to Granola for a transcript query —
    // the data is right here in the user message. Best-effort: if the
    // fetch fails, the agent still has the kb cloned locally and can
    // glob for itself.
    let kbIndex = "(meeting index fetch skipped)";
    if (process.env.PRICING_LIBRARY_GITHUB_PAT) {
      try {
        const videoSecret = process.env.RECALL_VIDEO_FETCH_SECRET;
        const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
        const meetings = await recentMeetingIndex(
          process.env.PRICING_LIBRARY_GITHUB_PAT,
          7,
          25,
          videoSecret ? { baseUrl, secret: videoSecret, ttlSeconds: 86400 } : undefined,
        );
        kbIndex = formatMeetingIndex(meetings);
      } catch (err) {
        console.warn(`[agent/oneshot] kb index fetch failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const activeBlock = await activeMeetingsBlock().catch(() => "");

    const userText = [
      customer ? `[customer scope hint: ${customer}]` : null,
      activeBlock || null,
      `[kb meeting index — last 7 days, customer/bot_id with flags]\n${kbIndex}`,
      question,
    ]
      .filter((s): s is string => !!s)
      .join("\n\n");

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
      slackFiles: [],
    };

    const turnPayload = { turnNumber: 1, receivedAt: new Date().toISOString(), userText, slackUserEmail: userEmail, connectedToolkits };

    // Reuse this teammate's persistent sandbox if one exists (warm =
    // ~10-30s per call). Cold start happens once per email per snapshot
    // expiry window.
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.get({ name: sandboxName, resume: true });
      console.log(`[agent/oneshot] resumed sandbox for ${userEmail}`);
    } catch {
      sandbox = await Sandbox.create({
        name: sandboxName,
        resources: { vcpus: 4 },
        timeout: SANDBOX_TIMEOUT_MS,
        runtime: "node22",
        persistent: true,
        snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
      });
      console.log(`[agent/oneshot] created sandbox for ${userEmail}`);
    }
    await sandbox.extendTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});

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
        MUX_TOKEN_ID: process.env.MUX_TOKEN_ID ?? "",
        MUX_TOKEN_SECRET: process.env.MUX_TOKEN_SECRET ?? "",
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

    // No sandbox.stop() — it's persistent + per-user, kept warm for
    // subsequent MCP calls. Idle 30 min → auto-snapshot.

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
