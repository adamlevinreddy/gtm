import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import { extractContactData } from "@/lib/extract";
import { scoreContacts, type ScoredContact } from "@/lib/scoring";
import { enrichContactViaApollo } from "@/lib/enrichment";
import { findOrCreateContact, findOrCreateAccount } from "@/lib/contacts";
import { pushContactsToHubSpot, getActiveHubSpotCompanies } from "@/lib/hubspot";
import { recordAgentRun } from "@/lib/sync";
import type { RawUploadData } from "@/lib/parse-upload";

export const maxDuration = 300;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Full pipeline: extract → score → enrich → push to HubSpot → Slack report.
 * Triggered by the Slack handler after file upload with "pipeline" or "process" command.
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
  const pipelineStart = Date.now();

  try {
    // =========================================================================
    // STEP 1: Claude extraction
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});

    const extractStart = Date.now();
    const extracted = await extractContactData(rawData.headers, rawData.rows);

    await recordAgentRun({
      agentType: "extraction",
      status: "success",
      model: "anthropic/claude-opus-4.6",
      inputSummary: { rows: rawData.rows.length, headers: rawData.headers },
      outputSummary: { extracted: extracted.length },
      durationMs: Date.now() - extractStart,
    }).catch(() => {});

    if (extracted.length === 0) {
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: "No contacts could be extracted from the file. Check the format and try again.",
      });
      return NextResponse.json({ ok: false, error: "No contacts extracted" });
    }

    // =========================================================================
    // STEP 2: Score + bucket contacts
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs }).catch(() => {});

    // Get companies with deep HubSpot activity
    let activeCompanies = new Set<string>();
    try {
      activeCompanies = await getActiveHubSpotCompanies();
    } catch { /* continue without activity data */ }

    // Get existing HubSpot contact emails (from the HubSpot search during extraction)
    const activeEmails = new Set<string>();

    const scored = scoreContacts(extracted, activeCompanies, activeEmails);

    const filtered = scored.filter((c) => c.bucket === "filtered");
    const existingActivity = scored.filter((c) => c.bucket === "existing_activity");
    const ranked = scored
      .filter((c) => c.bucket === "ranked")
      .sort((a, b) => b.score - a.score);

    // =========================================================================
    // STEP 3: Enrich non-HubSpot contacts via Apollo
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "mag", timestamp: slackThreadTs }).catch(() => {});

    let enrichedCount = 0;
    for (const contact of ranked.slice(0, 50)) { // Top 50 by score
      try {
        // Persist to Supabase first
        const contactId = await findOrCreateContact({
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          title: contact.title,
          companyName: contact.company,
          persona: contact.persona as import("@/lib/types").Persona | null,
          leadSource: "conference_pre",
          conferenceName: fileName,
        });

        if (contact.company) {
          await findOrCreateAccount(contact.company);
        }

        // Enrich via Apollo
        const result = await enrichContactViaApollo({
          contactId,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          companyName: contact.company,
        });

        if (result.success) {
          enrichedCount++;
          // Update the scored contact with enriched data for HubSpot push
          if (result.person?.email && !contact.email) {
            contact.email = result.person.email;
          }
          if (result.person?.first_name && !contact.firstName) {
            contact.firstName = result.person.first_name;
          }
          if (result.person?.last_name && !contact.lastName) {
            contact.lastName = result.person.last_name;
          }
        }
      } catch { /* continue with next contact */ }
    }

    // Also persist remaining ranked contacts (not enriched)
    for (const contact of ranked.slice(50)) {
      try {
        await findOrCreateContact({
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          title: contact.title,
          companyName: contact.company,
          persona: contact.persona as import("@/lib/types").Persona | null,
          leadSource: "conference_pre",
          conferenceName: fileName,
        });
      } catch { /* continue */ }
    }

    // =========================================================================
    // STEP 4: Push new contacts to HubSpot
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "outbox_tray", timestamp: slackThreadTs }).catch(() => {});

    const hubspotResult = await pushContactsToHubSpot(ranked);

    // =========================================================================
    // STEP 5: Slack report
    // =========================================================================
    await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.remove({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.remove({ channel: slackChannel, name: "mag", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.remove({ channel: slackChannel, name: "outbox_tray", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackThreadTs }).catch(() => {});

    // Group ranked by persona for the report
    const byPersona = new Map<string, ScoredContact[]>();
    for (const contact of ranked) {
      const p = contact.persona || "unknown";
      if (!byPersona.has(p)) byPersona.set(p, []);
      byPersona.get(p)!.push(contact);
    }

    const personaLabels: Record<string, string> = {
      cx_leadership: "CX Leadership",
      ld: "L&D / Training",
      qa: "QA / Quality",
      wfm: "WFM",
      km: "Knowledge Management",
      sales_marketing: "Sales & Marketing",
      it: "IT",
      excluded: "Excluded",
      unknown: "Unknown",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `Pipeline complete: ${fileName}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total extracted:*\n${extracted.length}` },
          { type: "mrkdwn", text: `*Ranked:*\n${ranked.length}` },
          { type: "mrkdwn", text: `*Filtered out:*\n${filtered.length}` },
          { type: "mrkdwn", text: `*Existing activity:*\n${existingActivity.length}` },
          { type: "mrkdwn", text: `*Apollo enriched:*\n${enrichedCount}` },
          { type: "mrkdwn", text: `*HubSpot created:*\n${hubspotResult.created}` },
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
      const lines = topContacts.map((c) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
        const agents = c.agentCount ? `${c.agentCount} agents` : (c.agentLevelGuess ? `${c.agentLevelGuess} est.` : "—");
        return `• *${name}* (${c.score}) — ${c.title || "—"} @ ${c.company} | ${agents}`;
      });

      if (contacts.length > 5) {
        lines.push(`_...and ${contacts.length - 5} more_`);
      }

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${personaLabels[persona] || persona}* (${contacts.length})\n${lines.join("\n")}` },
      });
    }

    // Filtered summary
    if (filtered.length > 0) {
      const reasons = new Map<string, number>();
      for (const c of filtered) {
        const r = c.filterReason || "Unknown";
        reasons.set(r, (reasons.get(r) || 0) + 1);
      }
      const filterLines = Array.from(reasons.entries()).map(([r, n]) => `• ${r}: ${n}`);
      blocks.push(
        { type: "divider" },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Filtered out (${filtered.length}):*\n${filterLines.join("\n")}` },
        }
      );
    }

    // Existing activity summary
    if (existingActivity.length > 0) {
      const activityLines = existingActivity.slice(0, 5).map((c) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
        return `• ${name} — ${c.title || "—"} @ ${c.company}`;
      });
      if (existingActivity.length > 5) activityLines.push(`_...and ${existingActivity.length - 5} more_`);
      blocks.push(
        { type: "divider" },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Already in active discussions (${existingActivity.length}):*\n${activityLines.join("\n")}` },
        }
      );
    }

    // Duration
    const durationSec = Math.round((Date.now() - pipelineStart) / 1000);
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Pipeline completed in ${durationSec}s` }],
    });

    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      blocks,
      text: `Pipeline complete: ${ranked.length} ranked, ${hubspotResult.created} added to HubSpot`,
    });

    return NextResponse.json({
      ok: true,
      extracted: extracted.length,
      ranked: ranked.length,
      filtered: filtered.length,
      existingActivity: existingActivity.length,
      enriched: enrichedCount,
      hubspotCreated: hubspotResult.created,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `Pipeline error: ${errMsg}`,
    });

    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
