import { NextRequest, NextResponse } from "next/server";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { markJobComplete } from "@/lib/completion";
import { classifyPersonas } from "@/lib/persona";
import { logSync, recordAgentRun } from "@/lib/sync";
import type { HubSpotCompanyMatch, Persona } from "@/lib/types";

export const maxDuration = 300;

/**
 * Look up company+title combos in HubSpot (server-side API calls),
 * then classify ALL titles into personas (sandbox + Claude).
 * Builds a full attendees list with persona + HubSpot match status.
 */
export async function POST(req: NextRequest) {
  const { reviewId, companies, isJob } = (await req.json()) as {
    reviewId: string;
    companies: { name: string; titles: string[] }[];
    isJob?: boolean;
  };

  const token = process.env.HUBSPOT_API_KEY;

  // Track which company+title combos matched HubSpot (with full contact data)
  const hubspotHits = new Map<string, {
    name: string;
    hubspotContactId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  }>(); // "company|||title" -> contact data
  const matches: HubSpotCompanyMatch[] = [];

  if (token) {
    for (const company of companies) {
      try {
        const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: company.name,
            properties: ["firstname", "lastname", "jobtitle", "company", "email", "lifecyclestage", "hs_lead_status"],
            limit: 20,
          }),
        });

        if (!res.ok) continue;
        const data = await res.json();
        if (!data.results?.length) continue;

        const conferenceTitles = company.titles.map((t: string) => t.toLowerCase().trim());

        const matchingContacts = data.results
          .filter((c: { properties: { jobtitle?: string } }) => {
            const hsTitle = (c.properties.jobtitle || "").toLowerCase().trim();
            if (!hsTitle) return false;
            return conferenceTitles.some((ct: string) => ct === hsTitle);
          })
          .map((c: { id: string; properties: { firstname?: string; lastname?: string; jobtitle?: string; email?: string } }) => {
            const name = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "Unknown";
            const title = c.properties.jobtitle || "";
            hubspotHits.set(`${company.name}|||${title.toLowerCase().trim()}`, {
              name,
              hubspotContactId: c.id,
              email: c.properties.email || null,
              firstName: c.properties.firstname || null,
              lastName: c.properties.lastname || null,
            });
            return { name, email: c.properties.email || null, title: title || null };
          });

        if (matchingContacts.length > 0) {
          matches.push({ company: company.name, contacts: matchingContacts });
        }

        // Log sync for each HubSpot search
        await logSync({
          system: "hubspot",
          direction: "inbound",
          entityType: "contact",
          entityId: company.name,
          operation: "search",
          success: true,
          changeset: { resultsCount: data.results.length, matchesCount: matchingContacts.length },
        }).catch(() => { /* non-critical */ });
      } catch {
        // Skip on error
      }
    }
  }

  // Persona-classify ALL titles from the input (not just HubSpot matches)
  const allTitles = companies.flatMap((c) => c.titles);
  let personaMap: Record<string, Persona> = {};
  const personaStartTime = Date.now();
  try {
    personaMap = await classifyPersonas(allTitles);
    await recordAgentRun({
      agentType: "persona",
      status: "success",
      model: "anthropic/claude-sonnet-4.6",
      inputSummary: { titleCount: allTitles.length },
      outputSummary: { classifiedCount: Object.keys(personaMap).length },
      durationMs: Date.now() - personaStartTime,
      reviewId,
    }).catch(() => { /* non-critical */ });
  } catch {
    // Persona classification failed — continue without it
    await recordAgentRun({
      agentType: "persona",
      status: "failed",
      model: "anthropic/claude-sonnet-4.6",
      inputSummary: { titleCount: allTitles.length },
      durationMs: Date.now() - personaStartTime,
      reviewId,
    }).catch(() => { /* non-critical */ });
  }

  // Attach personas to HubSpot matches
  for (const match of matches) {
    for (const contact of match.contacts) {
      if (contact.title) {
        contact.persona = personaMap[contact.title.toLowerCase().trim()] || "unknown";
      }
    }
  }

  // Build full attendees list: every company+title combo with persona + HubSpot status
  const attendees: {
    company: string;
    title: string;
    persona: Persona;
    inHubspot: boolean;
    hubspotName?: string;
    hubspotContactId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  }[] = [];

  for (const company of companies) {
    for (const title of company.titles) {
      const key = `${company.name}|||${title.toLowerCase().trim()}`;
      const hsData = hubspotHits.get(key);
      const persona = personaMap[title.toLowerCase().trim()] || "unknown";
      attendees.push({
        company: company.name,
        title,
        persona,
        inHubspot: !!hsData,
        hubspotName: hsData?.name,
        hubspotContactId: hsData?.hubspotContactId,
        email: hsData?.email ?? undefined,
        firstName: hsData?.firstName ?? undefined,
        lastName: hsData?.lastName ?? undefined,
      });
    }
  }

  // Store in review
  const review = await getReview(reviewId);
  if (review) {
    if (matches.length > 0) {
      review.hubspotMatches = [...(review.hubspotMatches || []), ...matches];
    }
    review.attendees = [...(review.attendees || []), ...attendees];
    await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });
  }

  if (isJob) {
    await markJobComplete(reviewId);
  }

  return NextResponse.json({ ok: true, matches: matches.length, attendees: attendees.length });
}
