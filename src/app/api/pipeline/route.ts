import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";
import { Sandbox } from "@vercel/sandbox";
import { WebClient } from "@slack/web-api";
import { buildPipelineFiles } from "@/lib/pipeline-agent";
import { findOrCreateContact, findOrCreateAccount } from "@/lib/contacts";
import { recordAgentRun } from "@/lib/sync";
import type { RawUploadData } from "@/lib/parse-upload";

export const maxDuration = 900; // 15 min (Vercel Pro)

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Full GTM pipeline running inside a Vercel Sandbox.
 *
 * The serverless function is a thin orchestrator:
 * 1. Creates sandbox (30 min timeout)
 * 2. Installs Claude Code CLI + Anthropic SDK
 * 3. Writes pipeline script + data files
 * 4. Runs the script (Claude agent with API tools)
 * 5. Reads structured JSON results
 * 6. Handles post-sandbox: KV storage, Slack report, Supabase persistence
 */
export async function POST(req: NextRequest) {
  const {
    rawData,
    fileName,
    slackChannel,
    slackThreadTs,
  } = (await req.json()) as {
    rawData: RawUploadData;
    fileName: string;
    slackChannel: string;
    slackThreadTs: string;
  };

  const slack = getSlackClient();
  const pipelineId = uuidv4();
  const pipelineStart = Date.now();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://gtm-jet.vercel.app";

  // Brain emoji — pipeline is working
  await slack.reactions.add({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});

  // Return 200 immediately — do all heavy work in after() callback
  // This prevents the Slack handler's fetch from timing out
  after(async () => {
    await runPipeline(rawData, fileName, slackChannel, slackThreadTs, pipelineId, slack, pipelineStart, baseUrl);
  });

  return NextResponse.json({ ok: true, pipelineId });
}

async function runPipeline(
  rawData: RawUploadData,
  fileName: string,
  slackChannel: string,
  slackThreadTs: string,
  pipelineId: string,
  slack: WebClient,
  pipelineStart: number,
  baseUrl: string,
) {
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;

  try {
    // =========================================================================
    // CREATE SANDBOX
    // =========================================================================
    sandbox = await Sandbox.create({
      resources: { vcpus: 4 },
      timeout: 1_800_000, // 30 minutes (Pro plan supports up to 5 hours)
      runtime: "node22",
    });

    console.log(`[pipeline] Sandbox created: ${sandbox.sandboxId}`);

    // =========================================================================
    // INSTALL DEPENDENCIES (proven pattern from agent.ts / Vercel docs)
    // =========================================================================
    const installCLI = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      sudo: true,
    });
    if (installCLI.exitCode !== 0) {
      console.error(`[pipeline] CLI install failed: ${await installCLI.stderr()}`);
    }

    const installSDK = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/sdk"],
    });
    if (installSDK.exitCode !== 0) {
      console.error(`[pipeline] SDK install failed: ${await installSDK.stderr()}`);
    }

    // =========================================================================
    // WRITE PIPELINE SCRIPT + DATA FILES
    // =========================================================================
    const files = buildPipelineFiles(rawData);
    await sandbox.writeFiles(files);

    console.log(`[pipeline] Wrote ${files.length} files. Running agent pipeline...`);

    // =========================================================================
    // RUN THE AGENT PIPELINE
    // =========================================================================
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
      },
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (stderr) {
      console.log(`[pipeline] Sandbox stderr:\n${stderr.slice(0, 3000)}`);
    }
    if (run.exitCode !== 0) {
      console.error(`[pipeline] Sandbox exit code: ${run.exitCode}`);
    }

    console.log(`[pipeline] Sandbox done. stdout: ${stdout?.length || 0} bytes`);

    if (!stdout || stdout.trim() === "") {
      throw new Error("Sandbox returned empty output");
    }

    const results = JSON.parse(stdout);

    if (results.error) {
      console.error(`[pipeline] Agent error: ${results.error}`);
    }

    // =========================================================================
    // POST-SANDBOX: SUPABASE PERSISTENCE
    // =========================================================================
    const ranked = results.ranked || [];
    const filtered = results.filtered || [];
    const existingActivity = results.existingActivity || [];
    const stats = results.stats || {};

    // Persist contacts to Supabase (limit to top 20 to avoid timeout)
    const toPersist = [...ranked.slice(0, 20)];
    for (const contact of toPersist) {
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
          hubspotContactId: contact.hubspotContactId,
        });
        if (contact.company) {
          await findOrCreateAccount(contact.company);
        }
      } catch { /* continue */ }
    }

    // Log agent run
    await recordAgentRun({
      agentType: "pipeline",
      status: results.error ? "failed" : "success",
      model: "anthropic/claude-opus-4.6",
      inputSummary: { rows: rawData.rows.length, headers: rawData.headers },
      outputSummary: stats,
      durationMs: Date.now() - pipelineStart,
      errorMessage: results.error,
    }).catch(() => {});

    // =========================================================================
    // POST-SANDBOX: KV STORAGE
    // =========================================================================
    const pipelineResults = {
      id: pipelineId,
      fileName,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - pipelineStart,
      stats: {
        totalRows: rawData.rows.length,
        extracted: stats.extracted || 0,
        namesResolved: stats.namesResolved || 0,
        ranked: ranked.length,
        filtered: filtered.length,
        existingActivity: existingActivity.length,
        enriched: stats.apolloEnriched || 0,
        hubspotCreated: stats.hubspotCreated || 0,
        hubspotSkipped: stats.hubspotSkipped || 0,
        hubspotErrors: stats.hubspotErrors || 0,
      },
      ranked: ranked.map((c: Record<string, unknown>) => ({ ...c, rawRow: undefined })),
      filtered: filtered.map((c: Record<string, unknown>) => ({ ...c, rawRow: undefined })),
      existingActivity: existingActivity.map((c: Record<string, unknown>) => ({ ...c, rawRow: undefined })),
    };

    await kv.set(`pipeline:${pipelineId}`, pipelineResults, { ex: 30 * 24 * 60 * 60 });

    // =========================================================================
    // POST-SANDBOX: SLACK REPORT
    // =========================================================================
    await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackThreadTs }).catch(() => {});

    const PERSONA_LABELS: Record<string, string> = {
      cx_leadership: "CX Leadership", ld: "L&D / Training", qa: "QA / Quality",
      wfm: "WFM", km: "Knowledge Management", sales_marketing: "Sales & Marketing",
      it: "IT", excluded: "Excluded", unknown: "Unknown",
    };

    // Group ranked by persona
    const byPersona = new Map<string, typeof ranked>();
    for (const contact of ranked) {
      const p = contact.persona || "unknown";
      if (!byPersona.has(p)) byPersona.set(p, []);
      byPersona.get(p)!.push(contact);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `Pipeline complete: ${fileName}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total extracted:*\n${stats.extracted || 0}` },
          { type: "mrkdwn", text: `*Ranked:*\n${ranked.length}` },
          { type: "mrkdwn", text: `*Filtered out:*\n${filtered.length}` },
          { type: "mrkdwn", text: `*Existing activity:*\n${existingActivity.length}` },
          { type: "mrkdwn", text: `*Names resolved:*\n${stats.namesResolved || 0}` },
          { type: "mrkdwn", text: `*Apollo enriched:*\n${stats.apolloEnriched || 0}` },
          { type: "mrkdwn", text: `*HubSpot created:*\n${stats.hubspotCreated || 0}` },
        ],
      },
      { type: "divider" },
    ];

    // Top ranked contacts by persona
    const personaOrder = ["cx_leadership", "ld", "qa", "wfm", "km", "it", "sales_marketing", "unknown"];
    for (const persona of personaOrder) {
      const contacts = byPersona.get(persona);
      if (!contacts || contacts.length === 0) continue;

      const topContacts = contacts.slice(0, 5);
      const lines = topContacts.map((c: Record<string, unknown>) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
        const agents = c.agentCount ? `${c.agentCount} agents` : (c.agentLevelGuess ? `${c.agentLevelGuess} est.` : "—");
        return `• *${name}* (${c.score}) — ${c.title || "—"} @ ${c.company} | ${agents}`;
      });
      if (contacts.length > 5) lines.push(`_...and ${contacts.length - 5} more_`);

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${PERSONA_LABELS[persona] || persona}* (${contacts.length})\n${lines.join("\n")}` },
      });
    }

    // Filtered summary
    if (filtered.length > 0) {
      const reasons = new Map<string, number>();
      for (const c of filtered) {
        const r = (c.filterReason as string) || "Unknown";
        reasons.set(r, (reasons.get(r) || 0) + 1);
      }
      const filterLines = Array.from(reasons.entries()).map(([r, n]) => `• ${r}: ${n}`);
      blocks.push({ type: "divider" }, {
        type: "section",
        text: { type: "mrkdwn", text: `*Filtered out (${filtered.length}):*\n${filterLines.join("\n")}` },
      });
    }

    // Existing activity summary
    if (existingActivity.length > 0) {
      const activityLines = existingActivity.slice(0, 5).map((c: Record<string, unknown>) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
        return `• ${name} — ${c.title || "—"} @ ${c.company}`;
      });
      if (existingActivity.length > 5) activityLines.push(`_...and ${existingActivity.length - 5} more_`);
      blocks.push({ type: "divider" }, {
        type: "section",
        text: { type: "mrkdwn", text: `*Already in active discussions (${existingActivity.length}):*\n${activityLines.join("\n")}` },
      });
    }

    // Duration + View Results button
    const durationSec = Math.round((Date.now() - pipelineStart) / 1000);
    blocks.push(
      { type: "context", elements: [{ type: "mrkdwn", text: `Pipeline completed in ${durationSec}s` }] },
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "View Full Results" },
          url: `${baseUrl}/pipeline/${pipelineId}`,
          style: "primary",
        }],
      }
    );

    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      blocks,
      text: `Pipeline complete: ${ranked.length} ranked, ${stats.hubspotCreated || 0} added to HubSpot`,
    });

    console.log(`[pipeline] Complete. Stats:`, pipelineResults.stats);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Error: ${errMsg}`);

    await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `Pipeline error: ${errMsg}`,
    });
  } finally {
    if (sandbox) {
      await sandbox.stop();
      console.log(`[pipeline] Sandbox stopped`);
    }
  }
}
