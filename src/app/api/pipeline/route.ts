import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { Sandbox } from "@vercel/sandbox";
import { WebClient } from "@slack/web-api";
import { buildPipelineFiles } from "@/lib/pipeline-agent";
import type { RawUploadData } from "@/lib/parse-upload";

export const maxDuration = 800; // Max for Vercel Pro plan

/**
 * GTM pipeline — thin serverless function that fires a sandbox and walks away.
 *
 * The sandbox handles EVERYTHING: extraction, agent pipeline, Slack reporting, KV storage.
 * This function just creates the sandbox, writes files, starts it, and returns immediately.
 * Post-sandbox Supabase persistence runs in after() when the sandbox completes.
 */
export async function POST(req: NextRequest) {
  const { rawData, fileName, slackChannel, slackThreadTs } = (await req.json()) as {
    rawData: RawUploadData;
    fileName: string;
    slackChannel: string;
    slackThreadTs: string;
  };

  const pipelineId = uuidv4();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://gtm-jet.vercel.app";

  // Brain emoji
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  await slack.reactions.add({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});

  try {
    // Create sandbox — it runs independently of this function
    const sandbox = await Sandbox.create({
      resources: { vcpus: 4 },
      timeout: 1_800_000, // 30 minutes
      runtime: "node22",
      persistent: false,
    });
    // Ensure timeout is extended in case create() ignores the param
    await sandbox.extendTimeout(1_800_000);
    console.log(`[pipeline] Sandbox created: ${sandbox.name}, timeout: ${sandbox.timeout}ms`);

    // Install deps
    await sandbox.runCommand({ cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"], sudo: true });
    await sandbox.runCommand({ cmd: "npm", args: ["install", "@anthropic-ai/sdk"] });

    // Write pipeline script + data
    const files = buildPipelineFiles(rawData, {
      pipelineId, fileName, slackChannel, slackThreadTs, baseUrl,
    });
    await sandbox.writeFiles(files);
    console.log(`[pipeline] Wrote ${files.length} files. Starting agent...`);

    // Fire the script in DETACHED mode — the command runs independently
    // even after this function exits. The sandbox stays alive until the
    // script finishes or the timeout expires.
    const cmd = await sandbox.runCommand({
      cmd: "node",
      args: ["pipeline.mjs"],
      cwd: "/vercel/sandbox",
      detached: true,
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        HUBSPOT_API_KEY: process.env.HUBSPOT_API_KEY || "",
        ENRICHLAYER_API_KEY: process.env.ENRICHLAYER_API_KEY || "",
        APOLLO_API_KEY: process.env.APOLLO_API_KEY || "",
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "",
        KV_REST_API_URL: process.env.REDDY_KV_REST_API_URL || "",
        KV_REST_API_TOKEN: process.env.REDDY_KV_REST_API_TOKEN || "",
      },
    });

    console.log(`[pipeline] Command detached: ${cmd.cmdId}. Sandbox: ${sandbox.name}. Returning 200.`);

    // DO NOT call sandbox.stop() — the sandbox stays alive until:
    // 1. The script calls process.exit() (which it does in submit_results and error handlers)
    // 2. Or the timeout expires (60 min)
    // The sandbox script handles its own Slack reporting and KV storage.
    // Supabase persistence will be handled by a separate mechanism later.

    return NextResponse.json({ ok: true, pipelineId, sandboxName: sandbox.name, cmdId: cmd.cmdId });

  } catch (err) {
    console.error(`[pipeline] Setup error: ${err}`);
    await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
