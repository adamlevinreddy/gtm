import { NextRequest, NextResponse } from "next/server";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { markJobComplete } from "@/lib/completion";
import type { HubSpotCompanyMatch } from "@/lib/types";

export const maxDuration = 120;

/**
 * Look up company+title combos in HubSpot. Runs server-side (no sandbox needed).
 * Stores matches directly in the review's hubspotMatches field.
 */
export async function POST(req: NextRequest) {
  const { reviewId, companies, isJob } = (await req.json()) as {
    reviewId: string;
    companies: { name: string; titles: string[] }[];
    isJob?: boolean;
  };

  const token = process.env.HUBSPOT_API_KEY;
  if (!token) {
    if (isJob) await markJobComplete(reviewId);
    return NextResponse.json({ ok: true, matches: 0 });
  }

  const matches: HubSpotCompanyMatch[] = [];

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
        .map((c: { properties: { firstname?: string; lastname?: string; jobtitle?: string } }) => ({
          name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "Unknown",
          email: null,
          title: c.properties.jobtitle || null,
        }));

      if (matchingContacts.length > 0) {
        matches.push({ company: company.name, contacts: matchingContacts });
      }
    } catch {
      // Skip on error
    }
  }

  // Store matches in the review
  if (matches.length > 0) {
    const review = await getReview(reviewId);
    if (review) {
      review.hubspotMatches = [...(review.hubspotMatches || []), ...matches];
      await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });
    }
  }

  // Signal job completion
  if (isJob) {
    await markJobComplete(reviewId);
  }

  return NextResponse.json({ ok: true, matches: matches.length });
}
