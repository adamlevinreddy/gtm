import type { ScoredContact } from "./scoring";
import { logSync } from "./sync";
import { assertWritableCompany } from "./hubspot-guard";

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
  const c = await canonicalizeCompany(name);
  return c?.id ?? null;
}

// ============================================================================
// READ helpers for CRM-as-system-of-record (canon + deals + pipeline + contacts)
// ============================================================================

export type CanonCompany = { id: string; name: string; domain: string | null };

/** Resolve a company name → canonical {id, name, domain} (read-only). */
export async function canonicalizeCompany(name: string): Promise<CanonCompany | null> {
  if (!name || !name.trim()) return null;
  const res = await hubspotFetch("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
      properties: ["name", "domain"],
      limit: 1,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.results?.[0];
  if (!r) return null;
  return { id: r.id, name: r.properties?.name ?? name, domain: r.properties?.domain ?? null };
}

export type HubSpotDeal = {
  id: string;
  dealname: string | null;
  dealstage: string | null;
  pipeline: string | null;
  amount: string | null;
  closedate: string | null;
};

/** Read a single deal by id (read-only). */
export async function getDeal(dealId: string): Promise<HubSpotDeal | null> {
  const res = await hubspotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,pipeline,amount,closedate`
  );
  if (!res.ok) return null;
  const d = await res.json();
  const p = d.properties ?? {};
  return {
    id: d.id,
    dealname: p.dealname ?? null,
    dealstage: p.dealstage ?? null,
    pipeline: p.pipeline ?? null,
    amount: p.amount ?? null,
    closedate: p.closedate ?? null,
  };
}

/** Deal ids associated with a company (read-only). */
export async function getCompanyDealIds(companyId: string): Promise<string[]> {
  const res = await hubspotFetch(`/crm/v3/objects/companies/${companyId}/associations/deals?limit=100`);
  if (!res.ok) return [];
  const d = await res.json();
  return (d.results ?? []).map((r: { id?: string; toObjectId?: string }) => String(r.id ?? r.toObjectId)).filter(Boolean);
}

type StageInfo = { id: string; label: string; displayOrder: number };
let _dealStagesCache: Map<string, StageInfo[]> | null = null;

/** Pipeline → ordered stages (id+label). Cached per process. Read-only. */
export async function getDealPipelines(): Promise<Map<string, StageInfo[]>> {
  if (_dealStagesCache) return _dealStagesCache;
  const res = await hubspotFetch("/crm/v3/pipelines/deals");
  const map = new Map<string, StageInfo[]>();
  if (res.ok) {
    const d = await res.json();
    for (const pl of d.results ?? []) {
      const stages: StageInfo[] = (pl.stages ?? [])
        .map((s: { id: string; label: string; displayOrder: number }) => ({
          id: s.id, label: s.label, displayOrder: s.displayOrder,
        }))
        .sort((a: StageInfo, b: StageInfo) => a.displayOrder - b.displayOrder);
      map.set(pl.id, stages);
    }
  }
  _dealStagesCache = map;
  return map;
}

export type HubSpotContactRow = { id: string; firstname: string | null; lastname: string | null; email: string | null; jobtitle: string | null };

/** Contacts associated with a company (read-only) — used to recover Teams
 * attendee emails by matching meeting attendee names against CRM contacts. */
export async function getCompanyContacts(companyId: string): Promise<HubSpotContactRow[]> {
  const assoc = await hubspotFetch(`/crm/v3/objects/companies/${companyId}/associations/contacts?limit=100`);
  if (!assoc.ok) return [];
  const ad = await assoc.json();
  const ids = (ad.results ?? []).map((r: { id?: string; toObjectId?: string }) => String(r.id ?? r.toObjectId)).filter(Boolean);
  if (ids.length === 0) return [];
  const res = await hubspotFetch("/crm/v3/objects/contacts/batch/read", {
    method: "POST",
    body: JSON.stringify({ properties: ["firstname", "lastname", "email", "jobtitle"], inputs: ids.map((id: string) => ({ id })) }),
  });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.results ?? []).map((c: { id: string; properties?: Record<string, string> }) => ({
    id: c.id,
    firstname: c.properties?.firstname ?? null,
    lastname: c.properties?.lastname ?? null,
    email: c.properties?.email ?? null,
    jobtitle: c.properties?.jobtitle ?? null,
  }));
}

// ============================================================================
// GATED WRITE helpers — every one asserts the target company is allowlisted.
// ============================================================================

async function assertDealBelongsToCompany(dealId: string, companyId: string): Promise<void> {
  const ids = await getCompanyDealIds(companyId);
  if (!ids.includes(String(dealId))) {
    throw new Error(`Deal ${dealId} is not associated with allowlisted company ${companyId} — refusing write.`);
  }
}

async function associateDefault(fromType: string, fromId: string, toType: string, toId: string): Promise<void> {
  await hubspotFetch(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, {
    method: "PUT",
  }).catch(() => {});
}

/** Log a meeting engagement on a company (+ optional deal/contacts). GATED. */
export async function logMeetingToHubSpot(input: {
  companyId: string;
  dealId?: string | null;
  contactIds?: string[];
  title: string;
  bodyHtml: string;
  startISO: string;
  endISO?: string | null;
}): Promise<string | null> {
  assertWritableCompany(input.companyId);
  if (input.dealId) await assertDealBelongsToCompany(input.dealId, input.companyId);

  const startMs = Date.parse(input.startISO);
  const res = await hubspotFetch("/crm/v3/objects/meetings", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: Number.isFinite(startMs) ? startMs : Date.now(),
        hs_meeting_title: input.title,
        hs_meeting_body: input.bodyHtml,
        hs_meeting_start_time: input.startISO,
        ...(input.endISO ? { hs_meeting_end_time: input.endISO } : {}),
      },
    }),
  });
  if (!res.ok) {
    const errorMessage = `logMeeting ${res.status}: ${(await res.text()).slice(0, 200)}`;
    await logSync({ system: "hubspot", direction: "outbound", entityType: "meeting", entityId: input.companyId, operation: "log_meeting", success: false, errorMessage }).catch(() => {});
    return null;
  }
  const created = await res.json();
  const meetingId = created.id as string;
  await associateDefault("meetings", meetingId, "companies", input.companyId);
  if (input.dealId) await associateDefault("meetings", meetingId, "deals", input.dealId);
  for (const cId of input.contactIds ?? []) await associateDefault("meetings", meetingId, "contacts", cId);
  await logSync({ system: "hubspot", direction: "outbound", entityType: "meeting", entityId: input.companyId, externalId: meetingId, operation: "log_meeting", success: true }).catch(() => {});
  return meetingId;
}

/** Move a deal's stage. GATED + verifies the deal belongs to the company. */
export async function updateDealStage(companyId: string, dealId: string, stageId: string): Promise<boolean> {
  assertWritableCompany(companyId);
  await assertDealBelongsToCompany(dealId, companyId);
  const res = await hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { dealstage: stageId } }),
  });
  await logSync({ system: "hubspot", direction: "outbound", entityType: "deal", entityId: dealId, operation: "update_stage", changeset: { dealstage: stageId }, success: res.ok, errorMessage: res.ok ? undefined : `${res.status}` }).catch(() => {});
  return res.ok;
}

/** Patch arbitrary (standard) deal properties. GATED. */
export async function updateDealProperties(
  companyId: string,
  dealId: string,
  properties: Record<string, string>
): Promise<boolean> {
  assertWritableCompany(companyId);
  await assertDealBelongsToCompany(dealId, companyId);
  const res = await hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  await logSync({ system: "hubspot", direction: "outbound", entityType: "deal", entityId: dealId, operation: "update_props", changeset: properties, success: res.ok, errorMessage: res.ok ? undefined : `${res.status}` }).catch(() => {});
  return res.ok;
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
 * Pull ALL company names from HubSpot (deals + engaged contacts) in bulk,
 * then fuzzy match against a list of conference companies locally.
 * Two API calls total instead of N per company.
 */
export async function getActiveHubSpotCompanies(companyNames?: string[]): Promise<Set<string>> {
  const hubspotCompanies = new Set<string>(); // all known company names from HubSpot

  // 1. Pull all deal names (paginated) — extract company names
  try {
    let after: string | undefined;
    do {
      const url = `/crm/v3/objects/deals?limit=100&properties=dealname${after ? `&after=${after}` : ""}`;
      const res = await hubspotFetch(url);
      if (!res.ok) break;
      const data = await res.json();
      for (const deal of data.results || []) {
        const name = deal.properties?.dealname || "";
        // "National Debt Relief - SIMS" → "National Debt Relief"
        const company = name.split(/\s+[-–—]\s+/)[0].trim();
        if (company) hubspotCompanies.add(company.toLowerCase());
      }
      after = data.paging?.next?.after;
    } while (after);
  } catch { /* continue */ }

  // 2. Pull companies from engaged contacts (opportunity/customer lifecycle OR recent activity)
  for (const filterGroup of [
    // Contacts at advanced lifecycle stages
    { filters: [{ propertyName: "lifecyclestage", operator: "IN", values: ["opportunity", "customer", "evangelist"] }] },
    // Contacts with recent notes/meetings (last 90 days)
    { filters: [{ propertyName: "notes_last_updated", operator: "GTE", value: String(Date.now() - 90 * 24 * 60 * 60 * 1000) }] },
    // Contacts with recent email activity
    { filters: [{ propertyName: "hs_email_last_reply_date", operator: "GTE", value: String(Date.now() - 90 * 24 * 60 * 60 * 1000) }] },
  ]) {
    try {
      const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [filterGroup],
          properties: ["company"],
          limit: 100,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        for (const contact of data.results || []) {
          const company = contact.properties?.company;
          if (company) hubspotCompanies.add(company.toLowerCase());
        }
      }
    } catch { /* continue */ }
  }

  console.log(`[hubspot] Loaded ${hubspotCompanies.size} active company names from HubSpot (deals + engaged contacts only)`);

  // 4. Fuzzy match conference companies against the HubSpot set
  const active = new Set<string>();
  if (!companyNames) return active;

  for (const name of companyNames) {
    const nameLower = name.toLowerCase();
    // Exact match
    if (hubspotCompanies.has(nameLower)) {
      active.add(nameLower);
      continue;
    }
    // Fuzzy: check if any HubSpot company contains or is contained by this name
    for (const hsName of hubspotCompanies) {
      if (hsName.includes(nameLower) || nameLower.includes(hsName)) {
        active.add(nameLower);
        break;
      }
      // Normalize: strip common suffixes and punctuation
      const norm = (s: string) => s.replace(/[.,\-']/g, "").replace(/\b(inc|llc|ltd|corp|co|com|group|the)\b/g, "").replace(/\s+/g, " ").trim();
      if (norm(hsName) === norm(nameLower)) {
        active.add(nameLower);
        break;
      }
    }
  }

  console.log(`[hubspot] Active companies matched: ${active.size} (${Array.from(active).slice(0, 10).join(", ")}...)`);
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
