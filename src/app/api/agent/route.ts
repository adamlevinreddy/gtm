import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { WebClient } from "@slack/web-api";
import { kv } from "@/lib/kv-client";
import { buildAgentDriver, type AgentMeta } from "@/lib/agent-driver";
import { generateMcpUrl, getConnectionStatus, TOOLKITS, type ToolkitSlug } from "@/lib/composio";
import { getTokensForUser as getGranolaTokens, granolaMcpConfig } from "@/lib/granola";
import { randomUUID } from "node:crypto";

export const maxDuration = 800;

type AgentThreadState = {
  sandboxName: string;
  sessionId: string;       // Agent SDK session UUID
  turnCount: number;
  createdAt: string;
  lastActivity: string;
};

const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;    // 30 min idle → stop + auto-snapshot
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

function sandboxNameFor(threadTs: string) {
  return `reddy-gtm-${threadTs.replace(/\./g, "_")}`;
}

// Slack user ID → email (Composio user_id). Cached indefinitely — emails don't churn.
async function resolveSlackEmail(slackUserId: string, slack: WebClient): Promise<string | null> {
  const key = `slack:user:${slackUserId}:email`;
  const cached = await kv.get<string>(key).catch(() => null);
  if (cached) return cached;
  try {
    const res = await slack.users.info({ user: slackUserId });
    const email = res.user?.profile?.email ?? null;
    if (email) await kv.set(key, email, { ex: 30 * 24 * 60 * 60 }).catch(() => {});
    return email;
  } catch (err) {
    console.warn(`[agent] users.info failed for ${slackUserId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function agentThreadKey(threadTs: string) {
  return `reddy-gtm:thread:${threadTs}`;
}

export async function POST(req: NextRequest) {
  const { userText, slackChannel, slackThreadTs, slackUser } =
    (await req.json()) as {
      userText: string;
      slackChannel: string;
      slackThreadTs: string;
      slackUser?: string;
    };

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const sandboxName = sandboxNameFor(slackThreadTs);
  const threadKey = agentThreadKey(slackThreadTs);

  try {
    // Load or initialize thread state (includes Agent SDK sessionId for resume)
    let state: AgentThreadState | null = null;
    try {
      state = await kv.get<AgentThreadState>(threadKey);
    } catch (kvErr) {
      throw new Error(`KV get failed: ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`);
    }
    const isFirstTurn = !state;
    if (!state) {
      state = {
        sandboxName,
        sessionId: randomUUID(),
        turnCount: 0,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
    }
    state.turnCount += 1;
    state.lastActivity = new Date().toISOString();

    // Get-or-create the persistent sandbox. Sandbox.get auto-resumes stopped
    // sandboxes from their last auto-snapshot (filesystem restored); new
    // sandboxes get created and the library + node_modules bootstrap once.
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.get({ name: sandboxName, resume: true });
      console.log(`[agent] Resumed ${sandboxName} (turn ${state.turnCount})`);
    } catch (getErr) {
      console.log(`[agent] Sandbox.get miss (${getErr instanceof Error ? getErr.message : String(getErr)}) — creating`);
      sandbox = await Sandbox.create({
        name: sandboxName,
        resources: { vcpus: 4 },
        timeout: SANDBOX_TIMEOUT_MS,
        runtime: "node22",
        persistent: true,
        snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
      });
      console.log(`[agent] Created persistent sandbox ${sandbox.name}`);
    }

    // Reset the idle timer on every turn — sandbox stays alive as long as
    // thread activity continues within 30 min.
    try {
      await sandbox.extendTimeout(SANDBOX_TIMEOUT_MS);
    } catch (extendErr) {
      console.warn(`[agent] extendTimeout failed: ${extendErr instanceof Error ? extendErr.message : String(extendErr)}`);
    }

    // Resolve Slack user → email for Composio (per-user tool auth).
    // Everything downstream is optional: if any step fails, we still dispatch
    // the turn without Composio tools so non-integrated asks keep working.
    let slackUserEmail: string | null = null;
    let connectedToolkits: ToolkitSlug[] = [];
    let composioMcp: { url: string; headers: Record<string, string> } | null = null;
    let granolaMcp: { url: string; headers: Record<string, string> } | null = null;
    if (slackUser) {
      slackUserEmail = await resolveSlackEmail(slackUser, slack);
      if (slackUserEmail && process.env.COMPOSIO_API_KEY) {
        const status = await getConnectionStatus(slackUserEmail).catch((err) => {
          console.warn(`[agent] composio status check failed: ${err instanceof Error ? err.message : err}`);
          return null;
        });
        if (status) {
          connectedToolkits = TOOLKITS.map((t) => t.slug).filter((s) => status[s]);
        }
        if (connectedToolkits.length > 0) {
          composioMcp = await generateMcpUrl(slackUserEmail, connectedToolkits);
        }
      }
      // Granola is a separate per-user MCP (Composio doesn't have the
      // toolkit). Fetch the user's stored OAuth tokens, refresh if near
      // expiry, and pass a registration config through to the driver.
      if (slackUserEmail) {
        const origin = req.nextUrl.origin;
        const tokens = await getGranolaTokens(slackUserEmail, origin).catch((err) => {
          console.warn(`[agent] granola token fetch failed: ${err instanceof Error ? err.message : err}`);
          return null;
        });
        if (tokens) {
          granolaMcp = granolaMcpConfig(tokens.accessToken);
        }
      }
    }

    // Channel ID D... = 1:1 DM (private to the mentioning user only).
    // C... = public channel, G... = private channel or multi-party DM — both
    // shared across >1 person, so we need to warn about per-user tool access
    // being reachable by others who mention in the same thread.
    const isSharedChannel = !slackChannel.startsWith("D");

    const meta: AgentMeta = {
      sandboxName,
      slackChannel,
      slackThreadTs,
      slackUser: slackUser ?? null,
      slackUserEmail,
      threadKey,
      sessionId: state.sessionId,
      libraryRepoUrl: "github.com/ReddySolutions/reddy-gtm.git",
      isFirstTurn,
      turnCount: state.turnCount,
      connectedToolkits,
      composioMcp,
      granolaMcp,
      isSharedChannel,
      mcpRequestId: null,
    };

    const turnPayload = {
      turnNumber: state.turnCount,
      receivedAt: new Date().toISOString(),
      userText,
      slackUser: slackUser ?? null,
      slackUserEmail,
      connectedToolkits,
    };

    // Write the latest turn into inbox/ and the generated driver into /vercel/sandbox
    const files = [
      {
        path: `inbox/turn-${state.turnCount}.json`,
        content: Buffer.from(JSON.stringify(turnPayload, null, 2)),
      },
      {
        path: "agent-driver.mjs",
        content: Buffer.from(buildAgentDriver(meta)),
      },
    ];

    try {
      await sandbox.writeFiles(files);
    } catch (wfErr) {
      throw new Error(`writeFiles failed: ${wfErr instanceof Error ? wfErr.message : String(wfErr)}`);
    }

    // Fire the driver in detached mode so the serverless function returns fast.
    const cmd = await sandbox.runCommand({
      cmd: "node",
      args: ["agent-driver.mjs", String(state.turnCount)],
      cwd: "/vercel/sandbox",
      detached: true,
      env: {
        // Anthropic + agent infra
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY ?? "",
        // Slack thread context
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
        SLACK_CHANNEL: slackChannel,
        SLACK_THREAD_TS: slackThreadTs,
        // KV (for trace + history)
        KV_REST_API_URL: process.env.REDDY_KV_REST_API_URL ?? "",
        KV_REST_API_TOKEN: process.env.REDDY_KV_REST_API_TOKEN ?? "",
        // Library repo
        PRICING_LIBRARY_GITHUB_PAT: process.env.PRICING_LIBRARY_GITHUB_PAT ?? "",
        AGENT_THREAD_KEY: threadKey,
        AGENT_SESSION_ID: state.sessionId,
        // GTM data + enrichment APIs (for the gtm-tools skill: enrichment,
        // check, campaign, hubspot lookup, list processing — agent uses Bash + curl)
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
        // Reddy Postgres (for company-list lookups, contact persistence)
        POSTGRES_URL: process.env.POSTGRES_URL ?? "",
        POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING ?? "",
        // For falling back to legacy /api/* routes if the agent prefers them
        REDDY_GTM_BASE_URL: "https://gtm-jet.vercel.app",
        // GTM (read + write via /api/gtm/*). Agent curls those endpoints;
        // service account + IDs live on the API route side, not the sandbox.
      },
    });

    // Persist state (increments turnCount, captures sessionId for next resume)
    await kv.set(threadKey, state, { ex: THREAD_TTL_SECONDS });

    console.log(`[agent] Driver started cmd=${cmd.cmdId} turn=${state.turnCount} session=${state.sessionId}`);

    return NextResponse.json({
      ok: true,
      sandboxName,
      sessionId: state.sessionId,
      turn: state.turnCount,
      cmdId: cmd.cmdId,
    });
  } catch (err) {
    console.error(`[agent] Setup error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    await slack.reactions.remove({ channel: slackChannel, name: "speech_balloon", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `Reddy-GTM setup error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
