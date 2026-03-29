import { db } from "./db";
import { contacts, accounts, enrichmentRuns } from "./schema";
import { eq } from "drizzle-orm";

// ============================================================================
// Apollo People Enrichment
// ============================================================================

interface ApolloPersonMatch {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone_numbers: { raw_number: string }[];
  employment_history: unknown[];
  organization: {
    id: string;
    name: string;
    industry: string | null;
    estimated_num_employees: number | null;
    annual_revenue: number | null;
    total_funding: number | null;
    latest_funding_date: string | null;
    technology_names: string[];
    linkedin_url: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    keywords: string[];
  } | null;
}

/**
 * Map Apollo seniority strings to our enum values.
 */
function mapSeniority(
  apolloSeniority: string | null
): "c_suite" | "vp" | "director" | "manager" | "ic" | "unknown" {
  if (!apolloSeniority) return "unknown";
  const s = apolloSeniority.toLowerCase();
  if (s.includes("c_suite") || s.includes("founder") || s.includes("owner"))
    return "c_suite";
  if (s.includes("vp") || s.includes("vice_president")) return "vp";
  if (s.includes("director")) return "director";
  if (s.includes("manager")) return "manager";
  if (
    s.includes("individual_contributor") ||
    s.includes("entry") ||
    s.includes("senior")
  )
    return "ic";
  return "unknown";
}

// ============================================================================
// Apollo People Search (find people by company + title)
// ============================================================================

interface ApolloSearchResult {
  people: ApolloPersonMatch[];
  pagination: { total_entries: number };
}

/**
 * Search Apollo for people at a company matching a title.
 * Use this when we have company + title but no name/email.
 * Returns the best matching person or null.
 */
export async function searchApolloByCompanyTitle(
  companyName: string,
  title: string
): Promise<ApolloPersonMatch | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      organization_name: companyName,
      person_titles: [title],
      page: 1,
      per_page: 5,
    }),
  });

  if (!res.ok) return null;

  const data: ApolloSearchResult = await res.json();
  if (!data.people || data.people.length === 0) return null;

  // Return the first match — Apollo ranks by relevance
  return data.people[0];
}

// ============================================================================
// Apollo People Enrichment (with search-first strategy)
// ============================================================================

/**
 * Enrich a contact via Apollo.
 *
 * Strategy:
 * 1. If we have name + company → use People Match (enrichment) directly
 * 2. If we only have company + title → use People Search first to find the person,
 *    then use the search result data (which already includes email, name, etc.)
 * 3. Updates the contact record and optionally the linked account.
 */
export async function enrichContactViaApollo(params: {
  contactId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  companyName?: string | null;
  title?: string | null;
}): Promise<{ success: boolean; person: ApolloPersonMatch | null }> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not configured");

  // Get existing contact data for enrichment
  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, params.contactId))
    .limit(1);

  if (!contact) throw new Error(`Contact ${params.contactId} not found`);

  const firstName = params.firstName || contact.firstName;
  const lastName = params.lastName || contact.lastName;
  const email = params.email || contact.email;
  const companyName = params.companyName || contact.companyName;
  const title = params.title || contact.title;

  // Decide strategy based on available data
  const hasName = firstName && lastName;
  const hasIdentifier = hasName || email;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;

  if (hasIdentifier) {
    // Strategy: People Match with email reveal (we have name or email)
    const res = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        organization_name: companyName,
        email: email,
        reveal_personal_emails: true,
      }),
    });
    raw = await res.json();
  } else {
    // No name or email — can't use Apollo People Match effectively.
    // The People Search API is not available on this plan.
    // Caller should try to resolve the name from HubSpot first.
    raw = { person: null, reason: "no_name_or_email" };
  }

  if (!raw.person) {
    // Log failed enrichment
    await db.insert(enrichmentRuns).values({
      contactId: params.contactId,
      accountId: contact.accountId,
      source: "apollo",
      status: "failed",
      creditsUsed: 0,
      rawPayload: raw,
      errorMessage: raw.error || "No person found",
      completedAt: new Date(),
    });
    return { success: false, person: null };
  }

  const person: ApolloPersonMatch = raw.person;

  // Update contact with enrichment data
  const contactUpdates: Record<string, unknown> = {
    updatedAt: new Date(),
    lastEnrichmentDate: new Date().toISOString().split("T")[0],
    lastEnrichmentSource: "apollo",
    apolloContactId: person.id,
  };

  if (person.email) contactUpdates.email = person.email;
  if (person.first_name) contactUpdates.firstName = person.first_name;
  if (person.last_name) contactUpdates.lastName = person.last_name;
  if (person.title) contactUpdates.title = person.title;
  if (person.seniority) contactUpdates.seniority = mapSeniority(person.seniority);
  if (person.department) contactUpdates.department = person.department;
  if (person.linkedin_url) contactUpdates.linkedinUrl = person.linkedin_url;
  if (person.city) contactUpdates.city = person.city;
  if (person.state) contactUpdates.state = person.state;
  if (person.country) contactUpdates.country = person.country;
  if (person.phone_numbers?.length > 0) {
    contactUpdates.phone = person.phone_numbers[0].raw_number;
  }
  if (person.employment_history?.length > 0) {
    contactUpdates.employmentHistory = person.employment_history;
  }

  await db
    .update(contacts)
    .set(contactUpdates)
    .where(eq(contacts.id, params.contactId));

  // Update account with org data if available
  if (person.organization && contact.accountId) {
    const org = person.organization;
    const accountUpdates: Record<string, unknown> = {
      updatedAt: new Date(),
      lastEnrichmentDate: new Date().toISOString().split("T")[0],
      lastEnrichmentSource: "apollo",
      apolloOrgId: org.id,
    };

    if (org.industry) accountUpdates.industry = org.industry;
    if (org.estimated_num_employees) accountUpdates.employeeCount = org.estimated_num_employees;
    if (org.annual_revenue) accountUpdates.annualRevenue = org.annual_revenue;
    if (org.total_funding) accountUpdates.totalFunding = org.total_funding;
    if (org.latest_funding_date) accountUpdates.latestFundingDate = org.latest_funding_date;
    if (org.technology_names?.length > 0) accountUpdates.techStack = org.technology_names;
    if (org.keywords?.length > 0) accountUpdates.keywords = org.keywords;
    if (org.linkedin_url) accountUpdates.linkedinUrl = org.linkedin_url;
    if (org.phone) accountUpdates.phone = org.phone;
    if (org.city) accountUpdates.city = org.city;
    if (org.state) accountUpdates.state = org.state;
    if (org.country) accountUpdates.country = org.country;

    await db
      .update(accounts)
      .set(accountUpdates)
      .where(eq(accounts.id, contact.accountId));
  }

  // Log successful enrichment
  await db.insert(enrichmentRuns).values({
    contactId: params.contactId,
    accountId: contact.accountId,
    source: "apollo",
    status: "success",
    creditsUsed: 1,
    rawPayload: raw,
    completedAt: new Date(),
  });

  return { success: true, person };
}

// ============================================================================
// Apollo Organization Enrichment
// ============================================================================

/**
 * Enrich an account via the Apollo Organization Enrichment API.
 */
export async function enrichAccountViaApollo(params: {
  accountId: string;
  domain?: string | null;
  name?: string | null;
}): Promise<{ success: boolean }> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not configured");

  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, params.accountId))
    .limit(1);

  if (!account) throw new Error(`Account ${params.accountId} not found`);

  const domain = params.domain || account.domain;
  const name = params.name || account.name;

  // Apollo org enrichment uses query params
  const url = new URL("https://api.apollo.io/api/v1/organizations/enrich");
  if (domain) url.searchParams.set("domain", domain);
  else if (name) url.searchParams.set("name", name);

  const enrichRes = await fetch(url.toString(), {
    headers: { "X-Api-Key": apiKey },
  });

  const raw = await enrichRes.json();

  if (!enrichRes.ok || !raw.organization) {
    await db.insert(enrichmentRuns).values({
      accountId: params.accountId,
      source: "apollo",
      status: "failed",
      creditsUsed: 0,
      rawPayload: raw,
      errorMessage: raw.error || `HTTP ${enrichRes.status}`,
      completedAt: new Date(),
    });
    return { success: false };
  }

  const org = raw.organization;
  const accountUpdates: Record<string, unknown> = {
    updatedAt: new Date(),
    lastEnrichmentDate: new Date().toISOString().split("T")[0],
    lastEnrichmentSource: "apollo",
    apolloOrgId: org.id,
  };

  if (org.industry) accountUpdates.industry = org.industry;
  if (org.estimated_num_employees) accountUpdates.employeeCount = org.estimated_num_employees;
  if (org.annual_revenue) accountUpdates.annualRevenue = org.annual_revenue;
  if (org.total_funding) accountUpdates.totalFunding = org.total_funding;
  if (org.latest_funding_date) accountUpdates.latestFundingDate = org.latest_funding_date;
  if (org.technology_names?.length > 0) accountUpdates.techStack = org.technology_names;
  if (org.keywords?.length > 0) accountUpdates.keywords = org.keywords;
  if (org.linkedin_url) accountUpdates.linkedinUrl = org.linkedin_url;
  if (org.phone) accountUpdates.phone = org.phone;
  if (org.primary_domain) accountUpdates.domain = org.primary_domain;
  if (org.city) accountUpdates.city = org.city;
  if (org.state) accountUpdates.state = org.state;
  if (org.country) accountUpdates.country = org.country;

  await db
    .update(accounts)
    .set(accountUpdates)
    .where(eq(accounts.id, params.accountId));

  await db.insert(enrichmentRuns).values({
    accountId: params.accountId,
    source: "apollo",
    status: "success",
    creditsUsed: 1,
    rawPayload: raw,
    completedAt: new Date(),
  });

  return { success: true };
}

// ============================================================================
// Enrichment History
// ============================================================================

/**
 * Get enrichment run history for a contact or account.
 */
export async function getEnrichmentHistory(params: {
  contactId?: string;
  accountId?: string;
}) {
  if (params.contactId) {
    return db
      .select()
      .from(enrichmentRuns)
      .where(eq(enrichmentRuns.contactId, params.contactId));
  }
  if (params.accountId) {
    return db
      .select()
      .from(enrichmentRuns)
      .where(eq(enrichmentRuns.accountId, params.accountId));
  }
  return [];
}
