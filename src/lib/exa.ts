/**
 * EnrichLayer integration for resolving person names from company + title.
 *
 * Two-pass approach:
 * 1. Role Lookup (4 credits) — fast, matches ~75% of contacts
 * 2. Employee Search (11 credits) — fallback when Role Lookup returns a seniority
 *    mismatch, searches full experience entries not just headlines
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
  method: "role_lookup" | "employee_search";
}

function getApiKey(): string | null {
  return process.env.ENRICHLAYER_API_KEY || null;
}

async function enrichLayerFetch(path: string, apiKey: string): Promise<Response> {
  return fetch(`https://enrichlayer.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

function profileToResult(
  linkedinUrl: string,
  profile: EnrichLayerProfile | null,
  method: "role_lookup" | "employee_search"
): RoleLookupResult {
  return {
    firstName: profile?.first_name || "",
    lastName: profile?.last_name || "",
    linkedinUrl,
    headline: profile?.headline || null,
    city: profile?.city || null,
    state: profile?.state || null,
    country: profile?.country_full_name || profile?.country || null,
    currentTitle: profile?.experiences?.[0]?.title || null,
    currentCompany: profile?.experiences?.[0]?.company || null,
    method,
  };
}

/**
 * Extract seniority keywords from a title for comparison.
 */
const SENIORITY_TIERS: [string, number][] = [
  ["chief", 6], ["ceo", 6], ["coo", 6], ["cfo", 6], ["cto", 6], ["cxo", 6],
  ["svp", 5], ["senior vice president", 5], ["evp", 5],
  ["vp", 4], ["vice president", 4],
  ["senior director", 3.5],
  ["director", 3], ["head of", 3],
  ["senior manager", 2.5],
  ["manager", 2],
  ["associate director", 2],
  ["analyst", 1], ["coordinator", 1], ["specialist", 1],
];

function getSeniority(title: string): number {
  const t = title.toLowerCase();
  for (const [keyword, level] of SENIORITY_TIERS) {
    if (t.includes(keyword)) return level;
  }
  return 0;
}

/**
 * Check if the returned person's seniority roughly matches what we searched for.
 * Returns true if the match is close enough (within 1 tier).
 */
function seniorityMatches(searchedTitle: string, returnedTitle: string): boolean {
  const searched = getSeniority(searchedTitle);
  const returned = getSeniority(returnedTitle);
  if (searched === 0 || returned === 0) return true; // can't determine, accept it
  return Math.abs(searched - returned) <= 1;
}

/**
 * Resolve the LinkedIn company URL from the company name.
 * Uses the Company Profile endpoint to look up by domain or name.
 */
async function resolveCompanyLinkedInUrl(
  companyName: string,
  apiKey: string
): Promise<string | null> {
  // Try common domain patterns
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  // Try the most likely LinkedIn company URL directly
  const guesses = [
    `https://www.linkedin.com/company/${slug}/`,
    `https://www.linkedin.com/company/${slug.replace(/-/g, "")}/`,
  ];

  // Quick validation: try Company Profile to see if the URL resolves
  for (const url of guesses) {
    try {
      const res = await enrichLayerFetch(
        `/api/v2/company?url=${encodeURIComponent(url)}&use_cache=if-present`,
        apiKey
      );
      if (res.ok) {
        const data = await res.json();
        if (data.name) return url;
      }
    } catch { /* try next */ }
  }

  return null;
}

/**
 * Look up a person by company name + role/title.
 *
 * Pass 1: Role Lookup (4 credits) — fast, headline-based matching.
 * Pass 2: If Role Lookup returns a seniority mismatch, fall back to
 *          Employee Search (11 credits) — searches full experience entries.
 */
export async function lookupPersonByRole(
  companyName: string,
  role: string
): Promise<RoleLookupResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  // =========================================================================
  // Pass 1: Role Lookup
  // =========================================================================
  try {
    const params = new URLSearchParams({
      role,
      company_name: companyName,
      enrich_profile: "enrich",
    });

    const res = await enrichLayerFetch(
      `/api/v2/find/company/role/?${params}`,
      apiKey
    );

    if (res.ok) {
      const data = await res.json();
      if (data.linkedin_profile_url && data.profile) {
        const profile: EnrichLayerProfile = data.profile;
        const currentTitle = profile.experiences?.[0]?.title || profile.headline || "";

        // Check if the seniority matches what we searched for
        if (seniorityMatches(role, currentTitle)) {
          return profileToResult(data.linkedin_profile_url, profile, "role_lookup");
        }

        // Seniority mismatch — fall through to Employee Search
        console.log(
          `[enrichlayer] Role Lookup seniority mismatch for "${role}" at ${companyName}: got "${currentTitle}" (${profile.first_name} ${profile.last_name}). Trying Employee Search...`
        );
      }
    }
  } catch {
    // Fall through to Employee Search
  }

  // =========================================================================
  // Pass 2: Employee Search (fallback)
  // =========================================================================
  try {
    // Resolve LinkedIn company URL
    const companyUrl = await resolveCompanyLinkedInUrl(companyName, apiKey);
    if (!companyUrl) {
      console.log(`[enrichlayer] Could not resolve LinkedIn URL for "${companyName}"`);
      return null;
    }

    // Build keyword boolean from the role title
    // Extract the meaningful words, join with AND
    const keywords = role
      .toLowerCase()
      .replace(/[,\-–—]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w) => !["the", "and", "for", "of", "at", "in"].includes(w))
      .slice(0, 5); // max 5 keywords to keep boolean manageable

    if (keywords.length < 2) return null;

    const keywordBoolean = keywords.join("+AND+");

    const params = new URLSearchParams({
      company_profile_url: companyUrl,
      keyword_boolean: keywordBoolean,
      page_size: "3",
      enrich_profiles: "enrich",
    });

    const res = await enrichLayerFetch(
      `/api/v2/company/employee/search/?${params}`,
      apiKey
    );

    if (!res.ok) return null;

    const data = await res.json();
    const employees = data.employees || [];

    if (employees.length === 0) return null;

    // Find the best match by seniority closeness
    const searchedSeniority = getSeniority(role);
    let bestMatch = employees[0];
    let bestDiff = Infinity;

    for (const emp of employees) {
      const profile = emp.profile as EnrichLayerProfile | undefined;
      const title = profile?.experiences?.[0]?.title || profile?.headline || "";
      const diff = Math.abs(getSeniority(title) - searchedSeniority);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = emp;
      }
    }

    const profile = bestMatch.profile as EnrichLayerProfile | null;
    const url = bestMatch.profile_url as string;

    if (!url) return null;

    console.log(
      `[enrichlayer] Employee Search found: ${profile?.first_name} ${profile?.last_name} for "${role}" at ${companyName}`
    );

    return profileToResult(url, profile, "employee_search");
  } catch {
    return null;
  }
}
