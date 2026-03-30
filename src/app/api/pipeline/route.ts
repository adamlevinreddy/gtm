import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { Sandbox } from "@vercel/sandbox";
import { WebClient } from "@slack/web-api";
import { buildPipelineFiles } from "@/lib/pipeline-agent";
import { findOrCreateContact, findOrCreateAccount } from "@/lib/contacts";
import { recordAgentRun } from "@/lib/sync";
import type { RawUploadData } from "@/lib/parse-upload";

export const maxDuration = 900;

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
    });
    console.log(`[pipeline] Sandbox created: ${sandbox.sandboxId}`);

    // Install deps
    await sandbox.runCommand({ cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"], sudo: true });
    await sandbox.runCommand({ cmd: "npm", args: ["install", "@anthropic-ai/sdk"] });

    // Write pipeline script + data
    const files = buildPipelineFiles(rawData, {
      pipelineId, fileName, slackChannel, slackThreadTs, baseUrl,
    });
    await sandbox.writeFiles(files);
    console.log(`[pipeline] Wrote ${files.length} files. Starting agent...`);

    // Fire the script — DO NOT await runCommand.
    // The sandbox runs independently. It handles Slack + KV internally.
    // When the script finishes, the sandbox auto-stops.
    sandbox.runCommand({
      cmd: "node",
      args: ["pipeline.mjs"],
      cwd: "/vercel/sandbox",
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        HUBSPOT_API_KEY: process.env.HUBSPOT_API_KEY || "",
        ENRICHLAYER_API_KEY: process.env.ENRICHLAYER_API_KEY || "",
        APOLLO_API_KEY: process.env.APOLLO_API_KEY || "",
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "",
        KV_REST_API_URL: process.env.KV_REST_API_URL || "",
        KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN || "",
      },
    }).then(async (run) => {
      // This runs when the sandbox finishes — but only if the function is still alive
      const stderr = await run.stderr();
      if (stderr) console.log(`[pipeline] stderr: ${stderr.slice(0, 1000)}`);
      console.log(`[pipeline] Sandbox finished. Exit: ${run.exitCode}`);
    }).catch((err) => {
      console.error(`[pipeline] Sandbox error: ${err}`);
    });

    // Small delay to ensure the sandbox command starts executing
    await new Promise((r) => setTimeout(r, 2000));

    console.log(`[pipeline] Sandbox running. Returning 200.`);
    return NextResponse.json({ ok: true, pipelineId, sandboxId: sandbox.sandboxId });

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
