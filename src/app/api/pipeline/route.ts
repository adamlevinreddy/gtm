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

  // Fire sandbox in after() — returns 200 immediately
  after(async () => {
    let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;
    const pipelineStart = Date.now();

    try {
      sandbox = await Sandbox.create({
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
        pipelineId,
        fileName,
        slackChannel,
        slackThreadTs,
        baseUrl,
      });
      await sandbox.writeFiles(files);
      console.log(`[pipeline] Wrote ${files.length} files. Starting agent...`);

      // Run — sandbox handles Slack + KV internally
      const run = await sandbox.runCommand({
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
      });

      const stdout = await run.stdout();
      const stderr = await run.stderr();

      if (stderr) console.log(`[pipeline] stderr:\n${stderr.slice(0, 3000)}`);
      if (run.exitCode !== 0) console.error(`[pipeline] exit code: ${run.exitCode}`);
      console.log(`[pipeline] Done. stdout: ${stdout?.length || 0} bytes`);

      // Post-sandbox: persist top contacts to Supabase
      if (stdout) {
        try {
          const results = JSON.parse(stdout);
          const ranked = results.ranked || [];
          for (const contact of ranked.slice(0, 30)) {
            try {
              await findOrCreateContact({
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                title: contact.title,
                companyName: contact.company,
                persona: contact.persona,
                leadSource: "conference_pre",
                conferenceName: fileName,
              });
              if (contact.company) await findOrCreateAccount(contact.company);
            } catch { /* continue */ }
          }
        } catch { /* JSON parse failed — sandbox already reported to Slack */ }
      }

      await recordAgentRun({
        agentType: "pipeline",
        status: run.exitCode === 0 ? "success" : "failed",
        model: "anthropic/claude-opus-4.6",
        inputSummary: { rows: rawData.rows.length },
        durationMs: Date.now() - pipelineStart,
      }).catch(() => {});

    } catch (err) {
      console.error(`[pipeline] Error: ${err}`);
      // Try to report error to Slack
      await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
      await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => {});
    } finally {
      if (sandbox) {
        await sandbox.stop();
        console.log(`[pipeline] Sandbox stopped`);
      }
    }
  });

  return NextResponse.json({ ok: true, pipelineId });
}
