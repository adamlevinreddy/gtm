import { NextRequest, NextResponse } from "next/server";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { markJobComplete } from "@/lib/completion";
import { classifyPersonas } from "@/lib/persona";
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

  // Track which company+title combos matched HubSpot (and the contact name)
  const hubspotHits = new Map<string, string>(); // "company|||title" -> contact name
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
            properties: ["firstname", "lastname", "jobtitle", "company"],
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
          .map((c: { properties: { firstname?: string; lastname?: string; jobtitle?: string } }) => {
            const name = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "Unknown";
            const title = c.properties.jobtitle || "";
            hubspotHits.set(`${company.name}|||${title.toLowerCase().trim()}`, name);
            return { name, email: null, title: title || null };
          });

        if (matchingContacts.length > 0) {
          matches.push({ company: company.name, contacts: matchingContacts });
        }
      } catch {
        // Skip on error
      }
    }
  }

  // Persona-classify ALL titles from the input (not just HubSpot matches)
  const allTitles = companies.flatMap((c) => c.titles);
  let personaMap: Record<string, Persona> = {};
  try {
    personaMap = await classifyPersonas(allTitles);
  } catch {
    // Persona classification failed — continue without it
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
  }[] = [];

  for (const company of companies) {
    for (const title of company.titles) {
      const key = `${company.name}|||${title.toLowerCase().trim()}`;
      const hsName = hubspotHits.get(key);
      const persona = personaMap[title.toLowerCase().trim()] || "unknown";
      attendees.push({
        company: company.name,
        title,
        persona,
        inHubspot: !!hsName,
        hubspotName: hsName,
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
