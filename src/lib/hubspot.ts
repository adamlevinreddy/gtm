import type { ScoredContact } from "./scoring";
import { logSync } from "./sync";

const PERSONA_MAP: Record<string, string> = {
  cx_leadership: "CX Leadership",
  ld: "L&D / Training",
  qa: "QA / Quality",
  wfm: "WFM",
  km: "Knowledge Management",
  sales_marketing: "Sales & Marketing",
  it: "IT / Technology",
  excluded: "Excluded",
  unknown: "Unknown",
};

function getToken() {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) throw new Error("HUBSPOT_API_KEY not configured");
  return token;
}

async function hubspotFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res;
}

/**
 * Search for an existing contact in HubSpot by email.
 * Returns the HubSpot contact ID if found, null otherwise.
 */
export async function findHubSpotContactByEmail(email: string): Promise<string | null> {
  const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      }],
      properties: ["email"],
      limit: 1,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0]?.id ?? null;
}

/**
 * Search for an existing contact in HubSpot by name + company.
 * Fallback dedup for contacts without email.
 */
export async function findHubSpotContactByNameCompany(
  firstName: string,
  lastName: string,
  company: string
): Promise<string | null> {
  const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{
        filters: [
          { propertyName: "firstname", operator: "EQ", value: firstName },
          { propertyName: "lastname", operator: "EQ", value: lastName },
          { propertyName: "company", operator: "CONTAINS_TOKEN", value: company },
        ],
      }],
      properties: ["firstname", "lastname", "company"],
      limit: 1,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0]?.id ?? null;
}

/**
 * Search for an existing company in HubSpot by name.
 * Returns the HubSpot company ID if found, null otherwise.
 */
export async function findHubSpotCompanyByName(name: string): Promise<string | null> {
  const res = await hubspotFetch("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: "name", operator: "EQ", value: name }],
      }],
      properties: ["name"],
      limit: 1,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0]?.id ?? null;
}

/**
 * Create a contact in HubSpot with all our custom properties.
 * Returns the new HubSpot contact ID.
 */
export async function createHubSpotContact(contact: ScoredContact): Promise<string | null> {
  const properties: Record<string, string | number> = {};

  if (contact.firstName) properties.firstname = contact.firstName;
  if (contact.lastName) properties.lastname = contact.lastName;
  if (contact.email) properties.email = contact.email;
  if (contact.title) properties.jobtitle = contact.title;
  if (contact.company) properties.company = contact.company;

  // Custom properties
  if (contact.agentCount) {
    properties.agent_count__if_given_by_contact_ = contact.agentCount;
  }
  if (contact.agentLevelGuess) {
    properties.agent_level_guess = contact.agentLevelGuess;
  }
  if (contact.brandBpoType) {
    properties.bpo_or_brand = contact.brandBpoType;
  }
  if (contact.projectPriorities) {
    properties.project_priorities = contact.projectPriorities;
  }
  if (contact.persona && PERSONA_MAP[contact.persona]) {
    properties.hs_persona = PERSONA_MAP[contact.persona];
  }
  if (contact.background) {
    properties.current_role_and_responsibilities = contact.background;
  }

  const startTime = Date.now();
  const res = await hubspotFetch("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });

  const body = await res.json();

  if (!res.ok) {
    await logSync({
      system: "hubspot",
      direction: "outbound",
      entityType: "contact",
      entityId: contact.email || `${contact.firstName} ${contact.lastName}`,
      operation: "create",
      success: false,
      errorMessage: body.message || `HTTP ${res.status}`,
      durationMs: Date.now() - startTime,
    }).catch(() => {});
    return null;
  }

  await logSync({
    system: "hubspot",
    direction: "outbound",
    entityType: "contact",
    entityId: contact.email || `${contact.firstName} ${contact.lastName}`,
    externalId: body.id,
    operation: "create",
    success: true,
    changeset: properties,
    durationMs: Date.now() - startTime,
  }).catch(() => {});

  return body.id;
}

/**
 * Create or update a company in HubSpot with our custom properties.
 * Returns the HubSpot company ID.
 */
export async function upsertHubSpotCompany(contact: ScoredContact): Promise<string | null> {
  // Check if company already exists
  const existingId = await findHubSpotCompanyByName(contact.company);

  const properties: Record<string, string | number> = {
    name: contact.company,
  };

  if (contact.agentCount) {
    properties.total_number_of_agents = contact.agentCount;
  }
  if (contact.agentLevelGuess) {
    properties.agent_level_guess = contact.agentLevelGuess;
  }
  if (contact.brandBpoType) {
    properties.brand_or_bpo = contact.brandBpoType;
  }
  if (contact.numberOfBpoVendors) {
    properties.number_of_bpo_vendors = contact.numberOfBpoVendors;
  }

  if (existingId) {
    // Update existing company
    const res = await hubspotFetch(`/crm/v3/objects/companies/${existingId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    if (res.ok) {
      await logSync({
        system: "hubspot",
        direction: "outbound",
        entityType: "company",
        entityId: contact.company,
        externalId: existingId,
        operation: "update",
        success: true,
        changeset: properties,
      }).catch(() => {});
    }
    return existingId;
  }

  // Create new company
  const res = await hubspotFetch("/crm/v3/objects/companies", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });

  const body = await res.json();
  if (!res.ok) return null;

  await logSync({
    system: "hubspot",
    direction: "outbound",
    entityType: "company",
    entityId: contact.company,
    externalId: body.id,
    operation: "create",
    success: true,
    changeset: properties,
  }).catch(() => {});

  return body.id;
}

/**
 * Associate a contact with a company in HubSpot.
 */
export async function associateContactToCompany(
  contactId: string,
  companyId: string
): Promise<void> {
  await hubspotFetch(
    `/crm/v3/objects/contacts/${contactId}/associations/companies/${companyId}/contact_to_company`,
    { method: "PUT" }
  );
}

/**
 * Check which companies have deep existing activity in HubSpot.
 * Returns company names where we have deals or contacts with significant engagement.
 */
export async function getActiveHubSpotCompanies(): Promise<Set<string>> {
  const active = new Set<string>();

  // 1. Companies with deals
  try {
    const res = await hubspotFetch("/crm/v3/objects/deals?limit=100&properties=dealname");
    if (res.ok) {
      const data = await res.json();
      for (const deal of data.results || []) {
        try {
          const assocRes = await hubspotFetch(
            `/crm/v3/objects/deals/${deal.id}/associations/companies`
          );
          if (assocRes.ok) {
            const assocData = await assocRes.json();
            for (const assoc of assocData.results || []) {
              const companyRes = await hubspotFetch(`/crm/v3/objects/companies/${assoc.id}?properties=name`);
              if (companyRes.ok) {
                const companyData = await companyRes.json();
                if (companyData.properties?.name) {
                  active.add(companyData.properties.name.toLowerCase());
                }
              }
            }
          }
        } catch { /* continue */ }
      }
    }
  } catch { /* continue without deals */ }

  // 2. Contacts with recent activity (notes, meetings, emails in last 90 days)
  try {
    const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: "notes_last_updated",
            operator: "GTE",
            value: String(Date.now() - 90 * 24 * 60 * 60 * 1000),
          }],
        }],
        properties: ["company"],
        limit: 100,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      for (const contact of data.results || []) {
        const company = contact.properties?.company;
        if (company) active.add(company.toLowerCase());
      }
    }
  } catch { /* continue without activity data */ }

  // 3. Contacts with lifecycle stage beyond lead
  try {
    const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: "lifecyclestage",
            operator: "IN",
            values: ["opportunity", "customer", "evangelist"],
          }],
        }],
        properties: ["company"],
        limit: 100,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      for (const contact of data.results || []) {
        const company = contact.properties?.company;
        if (company) active.add(company.toLowerCase());
      }
    }
  } catch { /* continue */ }

  return active;
}

/**
 * Push a batch of scored contacts to HubSpot.
 * Creates contacts, upserts companies, and associates them.
 */
export async function pushContactsToHubSpot(
  contacts: ScoredContact[]
): Promise<{
  created: number;
  skipped: number;
  errors: number;
}> {
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const contact of contacts) {
    try {
      // Need at least a name or email to create a contact
      if (!contact.email && !contact.firstName && !contact.lastName) {
        skipped++;
        continue;
      }

      // Check if contact already exists (by email or name+company)
      let existingContactId: string | null = null;
      if (contact.email) {
        existingContactId = await findHubSpotContactByEmail(contact.email);
      } else if (contact.firstName && contact.lastName && contact.company) {
        existingContactId = await findHubSpotContactByNameCompany(
          contact.firstName, contact.lastName, contact.company
        );
      }
      if (existingContactId) {
        skipped++;
        continue;
      }

      // Upsert company first
      const companyId = await upsertHubSpotCompany(contact);

      // Create contact
      const contactId = await createHubSpotContact(contact);
      if (!contactId) {
        errors++;
        continue;
      }

      // Associate contact to company
      if (companyId) {
        await associateContactToCompany(contactId, companyId).catch(() => {});
      }

      created++;
    } catch {
      errors++;
    }
  }

  return { created, skipped, errors };
}
