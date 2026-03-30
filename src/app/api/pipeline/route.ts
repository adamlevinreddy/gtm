import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";
import { WebClient } from "@slack/web-api";
import { extractContactData } from "@/lib/extract";
import { scoreContacts, type ScoredContact } from "@/lib/scoring";
import { enrichContactViaApollo } from "@/lib/enrichment";
import { lookupPersonByRole } from "@/lib/exa";
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
  const pipelineId = uuidv4();
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://gtm-jet.vercel.app";

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
      await slack.reactions.remove({ channel: slackChannel, name: "brain", timestamp: slackThreadTs }).catch(() => {});
      await slack.reactions.add({ channel: slackChannel, name: "warning", timestamp: slackThreadTs }).catch(() => {});
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: `No contacts could be extracted from the file (${rawData.rows.length} rows, ${rawData.headers.length} columns: ${rawData.headers.slice(0, 5).join(", ")}...). Check the format and try again.`,
      });
      return NextResponse.json({ ok: false, error: "No contacts extracted" });
    }

    // =========================================================================
    // STEP 2: HubSpot lookup — find names + check individual activity
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "mag", timestamp: slackThreadTs }).catch(() => {});

    let namesResolved = 0;
    const activeContactKeys = new Set<string>(); // "company|||title" keys for contacts with real activity

    const hubspotToken = process.env.HUBSPOT_API_KEY;
    if (hubspotToken) {
      // Dedupe: search HubSpot once per unique company
      const companiesSearched = new Set<string>();
      const hsResultsByCompany = new Map<string, Array<{
        firstname: string; lastname: string; email: string;
        jobtitle: string; lifecyclestage: string;
        notes_last_updated: string; hs_email_last_reply_date: string;
      }>>();

      for (const contact of extracted) {
        if (!contact.company) continue;
        const companyKey = contact.company.toLowerCase();
        if (companiesSearched.has(companyKey)) continue;
        companiesSearched.add(companyKey);

        try {
          const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${hubspotToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: contact.company,
              properties: ["firstname", "lastname", "email", "jobtitle", "company",
                "lifecyclestage", "notes_last_updated", "hs_email_last_reply_date"],
              limit: 50,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            hsResultsByCompany.set(companyKey, (data.results || []).map((r: { properties: Record<string, string> }) => r.properties));
          }
        } catch { /* continue */ }
      }

      // Now match each extracted contact against HubSpot results
      const normTitle = (s: string) => s.toLowerCase().replace(/[,.\-–—]/g, " ").replace(/\b(of|the|and|for|at|in|a)\b/g, "").replace(/\s+/g, " ").trim();

      for (const contact of extracted) {
        if (!contact.company) continue;
        const hsContacts = hsResultsByCompany.get(contact.company.toLowerCase()) || [];
        const titleNorm = normTitle(contact.title || "");
        const titleWords = titleNorm.split(" ").filter((w) => w.length > 2);

        for (const hsc of hsContacts) {
          const hsNorm = normTitle(hsc.jobtitle || "");
          const hsWords = hsNorm.split(" ").filter((w) => w.length > 2);
          const overlap = titleWords.filter((w) => hsWords.includes(w)).length;
          const matchRatio = titleWords.length > 0 ? overlap / titleWords.length : 0;

          if (matchRatio >= 0.5 || hsNorm === titleNorm || hsNorm.includes(titleNorm) || titleNorm.includes(hsNorm)) {
            // Found a title match — get name
            if (!contact.firstName && hsc.firstname) {
              contact.firstName = hsc.firstname;
              contact.lastName = hsc.lastname || null;
              contact.email = hsc.email || contact.email;
              namesResolved++;
            }

            // Check if this contact has real activity
            const lifecycle = hsc.lifecyclestage || "";
            const hasAdvancedLifecycle = ["opportunity", "customer", "evangelist"].includes(lifecycle);
            const hasRecentNotes = hsc.notes_last_updated && new Date(hsc.notes_last_updated).getTime() > Date.now() - 90 * 24 * 60 * 60 * 1000;
            const hasRecentEmail = hsc.hs_email_last_reply_date && new Date(hsc.hs_email_last_reply_date).getTime() > Date.now() - 90 * 24 * 60 * 60 * 1000;

            if (hasAdvancedLifecycle || hasRecentNotes || hasRecentEmail) {
              activeContactKeys.add(`${(contact.company || "").toLowerCase()}|||${(contact.title || "").toLowerCase()}`);
            }
            break;
          }
        }
      }
    }

    // Also check deals for company-level activity
    const dealCompanies = new Set<string>();
    try {
      let after: string | undefined;
      do {
        const url = `https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname${after ? `&after=${after}` : ""}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${hubspotToken}` } });
        if (!res.ok) break;
        const data = await res.json();
        for (const deal of data.results || []) {
          const name = (deal.properties?.dealname || "").split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
          if (name) dealCompanies.add(name);
        }
        after = data.paging?.next?.after;
      } while (after);
    } catch { /* continue */ }

    // Mark contacts at deal companies as active too
    for (const contact of extracted) {
      if (!contact.company) continue;
      const companyLower = contact.company.toLowerCase();
      const key = `${companyLower}|||${(contact.title || "").toLowerCase()}`;
      if (activeContactKeys.has(key)) continue; // already flagged

      // Fuzzy match against deal companies
      for (const dealCo of dealCompanies) {
        if (companyLower.includes(dealCo) || dealCo.includes(companyLower)) {
          activeContactKeys.add(key);
          break;
        }
      }
    }

    // EnrichLayer for remaining unnamed contacts (2s delay between to avoid rate limits)
    const stillUnnamed = extracted.filter((c) => !c.firstName && !c.lastName && c.company && c.title);
    console.log(`[pipeline] EnrichLayer: ${stillUnnamed.length} contacts to resolve`);
    for (let i = 0; i < stillUnnamed.length; i++) {
      const contact = stillUnnamed[i];
      try {
        if (i > 0) await new Promise((r) => setTimeout(r, 2000));
        const person = await lookupPersonByRole(contact.company, contact.title!);
        if (person && person.firstName) {
          contact.firstName = person.firstName;
          contact.lastName = person.lastName;
          if (person.linkedinUrl) {
            (contact as unknown as Record<string, unknown>).linkedinUrl = person.linkedinUrl;
          }
          namesResolved++;
        }
      } catch { /* continue */ }
    }

    // =========================================================================
    // STEP 3: Score + bucket contacts
    // =========================================================================
    await slack.reactions.add({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs }).catch(() => {});

    // Build activity sets for the scoring function
    const activeCompanies = new Set<string>();
    const activeEmails = new Set<string>();
    for (const key of activeContactKeys) {
      const company = key.split("|||")[0];
      activeCompanies.add(company);
    }

    const scored = scoreContacts(extracted, activeCompanies, activeEmails);

    const filtered = scored.filter((c) => c.bucket === "filtered");
    const existingActivity = scored.filter((c) => c.bucket === "existing_activity");
    const ranked = scored
      .filter((c) => c.bucket === "ranked")
      .sort((a, b) => b.score - a.score);

    // =========================================================================
    // STEP 4: Enrich via Apollo (top 50 ranked by score)
    // =========================================================================
    let enrichedCount = 0;
    for (const contact of ranked.slice(0, 50)) {
      try {
        // Skip Apollo if we still have no name or email — it can't match
        if (!contact.firstName && !contact.lastName && !contact.email) {
          continue;
        }

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

        // Enrich via Apollo (now with reveal_personal_emails)
        const result = await enrichContactViaApollo({
          contactId,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          companyName: contact.company,
          title: contact.title,
        });

        if (result.success) {
          enrichedCount++;
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
          { type: "mrkdwn", text: `*Names resolved:*\n${namesResolved}` },
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

    // Store results in KV for the frontend
    const pipelineResults = {
      id: pipelineId,
      fileName,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - pipelineStart,
      stats: {
        totalRows: rawData.rows.length,
        extracted: extracted.length,
        ranked: ranked.length,
        filtered: filtered.length,
        existingActivity: existingActivity.length,
        namesResolved: namesResolved,
        enriched: enrichedCount,
        hubspotCreated: hubspotResult.created,
        hubspotSkipped: hubspotResult.skipped,
        hubspotErrors: hubspotResult.errors,
      },
      ranked: ranked.map(c => ({ ...c, rawRow: undefined })),
      filtered: filtered.map(c => ({ ...c, rawRow: undefined })),
      existingActivity: existingActivity.map(c => ({ ...c, rawRow: undefined })),
    };
    await kv.set(`pipeline:${pipelineId}`, pipelineResults, { ex: 30 * 24 * 60 * 60 }); // 30 day TTL

    // Duration + view button
    const durationSec = Math.round((Date.now() - pipelineStart) / 1000);
    blocks.push(
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Pipeline completed in ${durationSec}s` }],
      },
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
