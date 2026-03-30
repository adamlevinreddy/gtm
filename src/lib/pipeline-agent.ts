import type { RawUploadData } from "./parse-upload";
import {
  SCORING_WEIGHTS,
} from "./scoring";

// Re-export constants for the sandbox to embed
const REDDY_RELEVANT_PRIORITIES = [
  "training", "onboarding", "qa", "quality", "coaching", "agent performance",
  "agent development", "knowledge management", "knowledge base", "compliance",
  "speech analytics", "call scoring", "evaluation", "nesting", "simulation",
  "role play", "proficiency", "speed to proficiency", "new hire",
  "agent assist", "real-time", "real time", "supervisor", "team lead",
  "performance management", "calibration", "scorecard",
];

const NOT_REDDY_PRIORITIES = [
  "ivr", "interactive voice", "chatbot", "self-service", "self service",
  "robotic process", "rpa", "voicebot", "virtual agent",
  "workforce management", "wfm", "scheduling", "forecasting",
  "ccaas", "contact center as a service", "telephony", "pbx", "sip",
  "crm migration", "erp", "digital transformation",
];

const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction agent for Reddy, a company that sells AI-powered training, QA, and coaching solutions to contact centers.

You will receive raw row data from a conference/event attendee spreadsheet. The columns may have different names across different files. Your job is to intelligently map the raw data into our structured format.

For EACH row, extract:

1. **firstName** / **lastName**: Split from a "Name" or "Full Name" column, or from separate first/last columns
2. **email**: Any email column
3. **company**: Company or organization name
4. **title**: Job title, position, role
5. **agentCount**: Number of contact center agents. May be in columns like "# Agents", "Agent Count", "Number of Agents", "Size", "Seats", or buried in free text. Parse numbers from text like "about 500" → 500, "2,000+" → 2000, "250-500" → 375 (midpoint)
6. **agentLevelGuess**: If no exact agent count, estimate from company size, industry clues, or role seniority:
   - "High" = 1000+ agents (enterprise, large BPO, Fortune 500 CC operation)
   - "Medium" = 250-999 agents (mid-market CC)
   - "Low" = 100-249 agents (smaller CC)
   - null if truly unknown and can't be estimated
7. **brandBpoType**: Classify the company:
   - "Brand" = end-customer operating their own contact center
   - "BPO" = business process outsourcer / outsourced CC
   - "Competitor" = companies that sell competing CC software (QA, training, coaching, speech analytics, WFM, CCaaS platforms)
   - "Press" = media, analysts, journalists, industry publications
8. **projectPriorities**: What CX/CC projects or priorities they mentioned. May be in columns like "Priorities", "Interests", "Topics", "What are you looking for", "Goals", "Challenges". Preserve the original text.
9. **persona**: Classify into one of: cx_leadership, ld, qa, wfm, km, sales_marketing, it, excluded, unknown
   - cx_leadership: CX/CC leadership (VP+, Directors of CX/CC/Customer Service)
   - ld: L&D, Training, Onboarding, Enablement
   - qa: QA, Quality, Speech Analytics, Performance Management
   - wfm: Workforce Management, Scheduling, Forecasting
   - km: Knowledge Management
   - sales_marketing: Sales/Marketing at prospect companies
   - it: IT/Technology leaders
   - excluded: Vendors, SDRs, BDRs, junior non-buyer roles
   - unknown: can't determine
10. **background**: Current role/responsibilities summary. May come from a "Background" or "Bio" or "Notes" column, or you can synthesize from title + company + priorities.
11. **numberOfBpoVendors**: If data mentions BPO partners or outsourcing relationships, count them. Otherwise null.

IMPORTANT:
- Not all fields will be present in every spreadsheet. Return null for fields that can't be determined.
- Be creative about column name matching — "Org", "Organization", "Company Name", "Employer" all map to company.
- For agent count, if the spreadsheet has it in a non-obvious column (e.g. "Size" or "Headcount"), extract it.
- For brandBpoType, use your knowledge of the contact center industry to classify companies.

Respond with ONLY a valid JSON array of objects. No explanation text.`;

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

/**
 * Build all files needed for the pipeline sandbox.
 * Returns file paths + content buffers to write via sandbox.writeFiles().
 */
export function buildPipelineFiles(rawData: RawUploadData): {
  path: string;
  content: Buffer;
}[] {
  const BATCH_SIZE = 20;
  const batches: Record<string, string>[][] = [];
  for (let i = 0; i < rawData.rows.length; i += BATCH_SIZE) {
    batches.push(rawData.rows.slice(i, i + BATCH_SIZE));
  }

  const pipelineScript = `
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';

// ============================================================================
// CONFIG
// ============================================================================
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const HUBSPOT_KEY = process.env.HUBSPOT_API_KEY;
const ENRICHLAYER_KEY = process.env.ENRICHLAYER_API_KEY;
const APOLLO_KEY = process.env.APOLLO_API_KEY;

function progress(step, msg) {
  process.stderr.write(JSON.stringify({ step, message: msg, ts: Date.now() }) + '\\n');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// PHASE 1: EXTRACTION (parallel Claude calls, batches of ${BATCH_SIZE})
// ============================================================================
progress('extraction', 'Starting extraction of ${rawData.rows.length} rows in ${batches.length} batches');

const EXTRACTION_PROMPT = ${JSON.stringify(EXTRACTION_SYSTEM_PROMPT)};
const HEADERS = ${JSON.stringify(rawData.headers)};
const BATCH_COUNT = ${batches.length};

async function extractBatch(batchIndex) {
  const batchData = JSON.parse(readFileSync('/vercel/sandbox/data/batch_' + batchIndex + '.json', 'utf-8'));
  const userPrompt = "Column headers: " + JSON.stringify(HEADERS) + "\\n\\nRows (" + batchData.length + "):\\n" + JSON.stringify(batchData);

  try {
    const response = await client.messages.create({
      model: "anthropic/claude-opus-4.6",
      max_tokens: 16000,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    const match = text.match(/\\[[\\s\\S]*\\]/);
    if (match) return JSON.parse(match[0]);
    return [];
  } catch (err) {
    process.stderr.write("Extraction batch " + batchIndex + " error: " + err.message + "\\n");
    return [];
  }
}

// Run all extraction batches in parallel
const extractionResults = await Promise.all(
  Array.from({ length: BATCH_COUNT }, (_, i) => extractBatch(i))
);
const extracted = extractionResults.flat();
progress('extraction', 'Extracted ' + extracted.length + ' contacts');

if (extracted.length === 0) {
  process.stdout.write(JSON.stringify({
    error: "No contacts extracted",
    ranked: [], filtered: [], existingActivity: [],
    stats: { totalRows: ${rawData.rows.length}, extracted: 0 }
  }));
  process.exit(0);
}

// ============================================================================
// PHASE 2: AGENT PIPELINE (Claude with tools for HubSpot/EnrichLayer/Apollo)
// ============================================================================
progress('agent', 'Starting agent pipeline for ' + extracted.length + ' contacts');

const TOOLS = [
  {
    name: "search_hubspot_contacts",
    description: "Search HubSpot CRM contacts by company name. Returns contacts with names, emails, titles, lifecycle stage, and activity dates. Use this to find if we already know someone at a company and check their engagement level.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Company name to search for" }
      },
      required: ["company_name"]
    }
  },
  {
    name: "search_hubspot_deals",
    description: "Search HubSpot deals by query string. Returns deal names and stages. Use this to check if we have active deals with a company.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (company name)" }
      },
      required: ["query"]
    }
  },
  {
    name: "enrichlayer_role_lookup",
    description: "Find a person's LinkedIn profile and real name from their company name + job title. Uses EnrichLayer/Proxycurl. Returns the best matching person with their full name, LinkedIn URL, headline, and work experience. Rate limited: 1 call per 2 seconds.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Company name" },
        role: { type: "string", description: "Job title / role to search for" }
      },
      required: ["company_name", "role"]
    }
  },
  {
    name: "enrichlayer_employee_search",
    description: "Search all employees at a company by keyword. Fallback when role_lookup returns wrong seniority. Needs a LinkedIn company URL. Rate limited: 1 call per 2 seconds.",
    input_schema: {
      type: "object",
      properties: {
        company_linkedin_url: { type: "string", description: "LinkedIn company URL (e.g. https://www.linkedin.com/company/best-buy/)" },
        keyword_boolean: { type: "string", description: "Boolean keyword query (e.g. 'vice+president+AND+customer+care')" }
      },
      required: ["company_linkedin_url", "keyword_boolean"]
    }
  },
  {
    name: "apollo_people_match",
    description: "Enrich a person via Apollo. Requires first_name + last_name + organization_name. Returns email, phone, LinkedIn, seniority, employment history. MUST have a name to work — do not call with just a company name.",
    input_schema: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        organization_name: { type: "string" },
        email: { type: "string", description: "Optional, improves match rate" }
      },
      required: ["first_name", "last_name", "organization_name"]
    }
  },
  {
    name: "create_hubspot_contact",
    description: "Create a new contact in HubSpot CRM. Include all known properties.",
    input_schema: {
      type: "object",
      properties: {
        properties: {
          type: "object",
          description: "HubSpot contact properties. Standard: firstname, lastname, email, jobtitle, company. Custom: agent_count__if_given_by_contact_ (number), agent_level_guess (High/Medium/Low), bpo_or_brand (Brand/BPO/Competitor/Press), project_priorities (text), hs_persona (text), current_role_and_responsibilities (text)"
        }
      },
      required: ["properties"]
    }
  },
  {
    name: "upsert_hubspot_company",
    description: "Create or update a company in HubSpot. Searches by name first to avoid duplicates.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name" },
        properties: {
          type: "object",
          description: "Company properties. Custom: total_number_of_agents (number), agent_level_guess (High/Medium/Low), brand_or_bpo (Brand/BPO/Competitor/Press), number_of_bpo_vendors (number)"
        }
      },
      required: ["name"]
    }
  },
  {
    name: "associate_contact_company",
    description: "Associate a HubSpot contact with a company",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        company_id: { type: "string" }
      },
      required: ["contact_id", "company_id"]
    }
  },
  {
    name: "submit_results",
    description: "Submit the final pipeline results. Call this when all processing is complete.",
    input_schema: {
      type: "object",
      properties: {
        ranked: { type: "array", description: "Scored and ranked contacts" },
        filtered: { type: "array", description: "Contacts filtered out (below threshold)" },
        existingActivity: { type: "array", description: "Contacts at companies with existing HubSpot activity" },
        stats: { type: "object", description: "Pipeline statistics" }
      },
      required: ["ranked", "filtered", "existingActivity", "stats"]
    }
  }
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================
let lastEnrichLayerCall = 0;

async function handleTool(name, input) {
  switch (name) {
    case "search_hubspot_contacts": {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input.company_name,
          properties: ["firstname", "lastname", "email", "jobtitle", "company", "lifecyclestage", "notes_last_updated", "hs_email_last_reply_date"],
          limit: 50,
        }),
      });
      if (!res.ok) return { error: "HubSpot API error: " + res.status };
      const data = await res.json();
      return {
        total: data.total || 0,
        contacts: (data.results || []).map(c => ({
          id: c.id,
          ...c.properties,
        })),
      };
    }

    case "search_hubspot_deals": {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
        method: "POST",
        headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          properties: ["dealname", "dealstage", "pipeline"],
          limit: 10,
        }),
      });
      if (!res.ok) return { error: "HubSpot API error: " + res.status };
      const data = await res.json();
      return {
        total: data.total || 0,
        deals: (data.results || []).map(d => d.properties),
      };
    }

    case "enrichlayer_role_lookup": {
      // Rate limiting
      const now = Date.now();
      const elapsed = now - lastEnrichLayerCall;
      if (elapsed < 2000) await delay(2000 - elapsed);
      lastEnrichLayerCall = Date.now();

      const params = new URLSearchParams({
        role: input.role,
        company_name: input.company_name,
        enrich_profile: "enrich",
      });
      const res = await fetch("https://enrichlayer.com/api/v2/find/company/role/?" + params, {
        headers: { Authorization: "Bearer " + ENRICHLAYER_KEY },
      });
      if (res.status === 429) {
        await delay(10000);
        lastEnrichLayerCall = Date.now();
        const retry = await fetch("https://enrichlayer.com/api/v2/find/company/role/?" + params, {
          headers: { Authorization: "Bearer " + ENRICHLAYER_KEY },
        });
        if (!retry.ok) return { error: "Rate limited, retry also failed" };
        return await retry.json();
      }
      if (!res.ok) return { error: "EnrichLayer error: " + res.status };
      return await res.json();
    }

    case "enrichlayer_employee_search": {
      const now = Date.now();
      const elapsed = now - lastEnrichLayerCall;
      if (elapsed < 2000) await delay(2000 - elapsed);
      lastEnrichLayerCall = Date.now();

      const params = new URLSearchParams({
        company_profile_url: input.company_linkedin_url,
        keyword_boolean: input.keyword_boolean,
        page_size: "5",
        enrich_profiles: "enrich",
      });
      const res = await fetch("https://enrichlayer.com/api/v2/company/employee/search/?" + params, {
        headers: { Authorization: "Bearer " + ENRICHLAYER_KEY },
      });
      if (res.status === 429) {
        await delay(10000);
        lastEnrichLayerCall = Date.now();
        const retry = await fetch("https://enrichlayer.com/api/v2/company/employee/search/?" + params, {
          headers: { Authorization: "Bearer " + ENRICHLAYER_KEY },
        });
        if (!retry.ok) return { error: "Rate limited, retry also failed" };
        return await retry.json();
      }
      if (!res.ok) return { error: "EnrichLayer error: " + res.status };
      return await res.json();
    }

    case "apollo_people_match": {
      const res = await fetch("https://api.apollo.io/api/v1/people/match", {
        method: "POST",
        headers: { "X-Api-Key": APOLLO_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: input.first_name,
          last_name: input.last_name,
          organization_name: input.organization_name,
          email: input.email || undefined,
          reveal_personal_emails: true,
        }),
      });
      if (!res.ok) return { error: "Apollo API error: " + res.status };
      return await res.json();
    }

    case "create_hubspot_contact": {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: input.properties }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || "HubSpot create error: " + res.status };
      return { id: data.id, success: true };
    }

    case "upsert_hubspot_company": {
      // Search first
      const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
        method: "POST",
        headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: input.name }] }],
          properties: ["name"],
          limit: 1,
        }),
      });
      const searchData = await searchRes.json();
      const existingId = searchData.results?.[0]?.id;

      const props = { name: input.name, ...(input.properties || {}) };

      if (existingId) {
        const updateRes = await fetch("https://api.hubapi.com/crm/v3/objects/companies/" + existingId, {
          method: "PATCH",
          headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ properties: props }),
        });
        return { id: existingId, updated: updateRes.ok };
      }

      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/companies", {
        method: "POST",
        headers: { Authorization: "Bearer " + HUBSPOT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });
      const createData = await createRes.json();
      return { id: createData.id, created: createRes.ok };
    }

    case "associate_contact_company": {
      await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/" + input.contact_id + "/associations/companies/" + input.company_id + "/contact_to_company",
        { method: "PUT", headers: { Authorization: "Bearer " + HUBSPOT_KEY } }
      );
      return { success: true };
    }

    case "submit_results": {
      process.stdout.write(JSON.stringify(input));
      process.exit(0);
    }

    default:
      return { error: "Unknown tool: " + name };
  }
}

// ============================================================================
// AGENT SYSTEM PROMPT
// ============================================================================
const SYSTEM_PROMPT = \`You are a GTM pipeline agent for Reddy, a company that sells AI-powered training, QA, and coaching solutions to contact centers.

You have been given a list of \${extracted.length} extracted contacts from a conference attendee list. Your job is to:

1. RESOLVE NAMES: For each contact without a firstName/lastName, find their real identity:
   a. First try search_hubspot_contacts with their company name. Look through the results for someone whose job title closely matches (e.g. "VP, Customer Care Operations" ≈ "Vice President of Customer Care"). If found, use their name and email.
   b. If not found in HubSpot, try enrichlayer_role_lookup with their company name + title.
   c. If role_lookup returns someone at the wrong seniority level (you searched for VP but got an Analyst), try enrichlayer_employee_search as a fallback.

2. CHECK ACTIVITY: For each contact's company, determine if we have existing engagement:
   a. Use search_hubspot_deals to check for deals. Any deal = existing activity.
   b. From the HubSpot contacts search results (step 1), check lifecycle stage (opportunity/customer/evangelist = active), notes_last_updated (within 90 days = active), hs_email_last_reply_date (within 90 days = active).
   c. A contact at "subscriber" lifecycle with no recent notes is NOT existing activity.

3. SCORE each contact 0-100:
   - Agent Size (max 30): 5000+=30, 2000+=27, 1000+=24, 500+=19.5, 250+=15, 100+=9, <100=0, unknown=9
   - Seniority (max 25): C-suite=25, SVP/EVP=23.75, VP=21.25, Director/Head=17.5, Sr Manager=13.75, Manager=10, IC=6.25
   - Persona Fit (max 25): cx_leadership=25, ld=23.75, qa=22.5, km=15, wfm=12.5, it=10, sales_marketing=7.5, excluded=0
   - Priority Relevance (max 15): 3+ Reddy keywords=15, 2=12, 1=9, none=4.5
     Reddy keywords: ${JSON.stringify(REDDY_RELEVANT_PRIORITIES)}
     NOT Reddy: ${JSON.stringify(NOT_REDDY_PRIORITIES)}
   - Brand Bonus (max 5): Brand=5, BPO=3, other=0

4. BUCKET contacts:
   - "filtered": agentCount < 100, or brandBpoType is Competitor/Press, or persona is excluded
   - "existing_activity": company has a deal OR contact has advanced lifecycle/recent activity
   - "ranked": everything else, sorted by score descending

5. ENRICH top 50 ranked contacts via apollo_people_match (only those with names). Update their data with email, phone, LinkedIn from Apollo.

6. PUSH ranked contacts to HubSpot:
   - For each, create_hubspot_contact with all properties
   - upsert_hubspot_company with company-level properties
   - associate_contact_company to link them

7. When done, call submit_results with the final data.

IMPORTANT RULES:
- Be smart about title matching. "VP, Customer Care Operations" matches "Vice President of Customer Care".
- EnrichLayer is rate limited. The tool handler adds delays, but avoid calling it unnecessarily.
- Apollo REQUIRES first_name + last_name. Never call it without a name.
- Process contacts efficiently — batch HubSpot searches by company (search once per company, match multiple contacts).
- For HubSpot contact creation, use these custom properties:
  - agent_count__if_given_by_contact_: number of agents
  - agent_level_guess: "High", "Medium", or "Low"
  - bpo_or_brand: "Brand", "BPO", "Competitor", or "Press"
  - project_priorities: free text
  - hs_persona: ${JSON.stringify(PERSONA_MAP)}
  - current_role_and_responsibilities: background text
- For HubSpot company properties:
  - total_number_of_agents: number
  - agent_level_guess: "High", "Medium", or "Low"
  - brand_or_bpo: "Brand", "BPO", "Competitor", or "Press"
  - number_of_bpo_vendors: number

Work through this systematically. Process all contacts, then submit results.\`;

// ============================================================================
// AGENTIC TOOL-USE LOOP
// ============================================================================
const userMessage = "Here are the " + extracted.length + " extracted contacts to process:\\n\\n" + JSON.stringify(extracted, null, 2);

let messages = [{ role: "user", content: userMessage }];
let response = await client.messages.create({
  model: "anthropic/claude-opus-4.6",
  max_tokens: 16000,
  system: SYSTEM_PROMPT,
  tools: TOOLS,
  messages,
});

let turns = 0;
const MAX_TURNS = 200;

while (response.stop_reason === "tool_use" && turns < MAX_TURNS) {
  turns++;
  const assistantContent = response.content;
  messages.push({ role: "assistant", content: assistantContent });

  const toolResults = [];
  for (const block of assistantContent) {
    if (block.type === "tool_use") {
      progress('agent', 'Tool: ' + block.name + (block.input?.company_name ? ' (' + block.input.company_name + ')' : ''));
      try {
        const result = await handleTool(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
      }
    }
  }

  messages.push({ role: "user", content: toolResults });

  response = await client.messages.create({
    model: "anthropic/claude-opus-4.6",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });
}

// If Claude stopped without calling submit_results, extract any text and create a fallback result
if (response.stop_reason !== "tool_use") {
  let finalText = "";
  for (const block of response.content) {
    if (block.type === "text") finalText += block.text;
  }

  // Try to find JSON in the final text
  const jsonMatch = finalText.match(/\\{[\\s\\S]*\\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      process.stdout.write(JSON.stringify(parsed));
    } catch {
      process.stdout.write(JSON.stringify({
        error: "Agent finished without submitting results",
        agentText: finalText.slice(0, 1000),
        ranked: [], filtered: [], existingActivity: [],
        stats: { totalRows: ${rawData.rows.length}, extracted: extracted.length, agentTurns: turns }
      }));
    }
  } else {
    process.stdout.write(JSON.stringify({
      error: "Agent finished without submitting structured results",
      agentText: finalText.slice(0, 1000),
      ranked: [], filtered: [], existingActivity: [],
      stats: { totalRows: ${rawData.rows.length}, extracted: extracted.length, agentTurns: turns }
    }));
  }
}

progress('done', 'Pipeline complete after ' + turns + ' agent turns');
`;

  // Build files array
  const files: { path: string; content: Buffer }[] = [
    {
      path: "/vercel/sandbox/pipeline.mjs",
      content: Buffer.from(pipelineScript, "utf-8"),
    },
    {
      path: "/vercel/sandbox/data/input.json",
      content: Buffer.from(JSON.stringify(rawData), "utf-8"),
    },
  ];

  // Write batch files for extraction
  for (let i = 0; i < batches.length; i++) {
    files.push({
      path: `/vercel/sandbox/data/batch_${i}.json`,
      content: Buffer.from(JSON.stringify(batches[i]), "utf-8"),
    });
  }

  return files;
}
