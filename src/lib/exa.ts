/**
 * EnrichLayer (Proxycurl/NinjaPear) Role Lookup integration.
 * Finds a person's LinkedIn profile and full name from company + title.
 * 4 credits per lookup (3 role lookup + 1 enriched profile).
 */

interface EnrichLayerProfile {
  first_name: string;
  last_name: string;
  full_name: string;
  headline: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  country_full_name: string | null;
  summary: string | null;
  occupation: string | null;
  experiences: {
    title: string;
    company: string;
    company_linkedin_profile_url: string | null;
    starts_at: { year: number; month: number } | null;
    ends_at: { year: number; month: number } | null;
  }[];
}

export interface RoleLookupResult {
  firstName: string;
  lastName: string;
  linkedinUrl: string;
  headline: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
}

/**
 * Look up a person by company name + role/title.
 * Uses EnrichLayer's Role Lookup API with profile enrichment.
 * Returns the best-matching person's name, LinkedIn URL, and profile data.
 */
export async function lookupPersonByRole(
  companyName: string,
  role: string
): Promise<RoleLookupResult | null> {
  const apiKey = process.env.ENRICHLAYER_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      role,
      company_name: companyName,
      enrich_profile: "enrich",
    });

    const res = await fetch(
      `https://enrichlayer.com/api/v2/find/company/role/?${params}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.linkedin_profile_url) return null;

    const profile: EnrichLayerProfile | null = data.profile;

    return {
      firstName: profile?.first_name || "",
      lastName: profile?.last_name || "",
      linkedinUrl: data.linkedin_profile_url,
      headline: profile?.headline || null,
      city: profile?.city || null,
      state: profile?.state || null,
      country: profile?.country_full_name || profile?.country || null,
      currentTitle: profile?.experiences?.[0]?.title || null,
      currentCompany: profile?.experiences?.[0]?.company || null,
    };
  } catch {
    return null;
  }
}
