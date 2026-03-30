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
9. **persona**: Classify into one of: ld, qa, wfm, km, sales_marketing, it, excluded, unknown
   - ld: L&D, Training, Onboarding, Enablement, Agent Development
   - qa: QA, Quality, Speech Analytics, Performance Management, Compliance
   - wfm: Workforce Management, Scheduling, Forecasting, Capacity Planning
   - km: Knowledge Management, Content Strategy, Documentation
   - sales_marketing: Sales/Marketing at prospect companies
   - it: IT/Technology leaders, CTO, Systems
   - excluded: Vendors, SDRs, BDRs, junior non-buyer roles, competitors
   - unknown: can't clearly determine the specific function (includes senior CX/CC leaders whose specific function area is unclear)
   NOTE: Do NOT use "cx_leadership". Senior leaders (VP of CX, Director of Contact Center) should be classified by what they specifically oversee — if a VP oversees training, they are "ld"; if they oversee quality, they are "qa". If unclear, use "unknown".
10. **background**: Current role/responsibilities summary. May come from a "Background" or "Bio" or "Notes" column, or you can synthesize from title + company + priorities.
11. **numberOfBpoVendors**: If data mentions BPO partners or outsourcing relationships, count them. Otherwise null.

IMPORTANT:
- Not all fields will be present in every spreadsheet. Return null for fields that can't be determined.
- Be creative about column name matching — "Org", "Organization", "Company Name", "Employer" all map to company.
- For agent count, if the spreadsheet has it in a non-obvious column (e.g. "Size" or "Headcount"), extract it.
- For brandBpoType, use your knowledge of the contact center industry to classify companies.

Respond with ONLY a valid JSON array of objects. No explanation text.`;

const PERSONA_MAP: Record<string, string> = {
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
 * The sandbox handles EVERYTHING: extraction, agent pipeline, KV storage, Slack report.
 * The serverless function just creates the sandbox and walks away.
 */
export function buildPipelineFiles(rawData: RawUploadData, meta: {
  pipelineId: string;
  fileName: string;
  slackChannel: string;
  slackThreadTs: string;
  baseUrl: string;
}): {
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

// Wrap entire script in try/catch so uncaught errors report to Slack
try {

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
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const PIPELINE_ID = ${JSON.stringify(meta.pipelineId)};
const FILE_NAME = ${JSON.stringify(meta.fileName)};
const SLACK_CHANNEL = ${JSON.stringify(meta.slackChannel)};
const SLACK_THREAD_TS = ${JSON.stringify(meta.slackThreadTs)};
const BASE_URL = ${JSON.stringify(meta.baseUrl)};
const PIPELINE_START = Date.now();

// ============================================================================
// LOGGING — all output goes to stderr so we can see it in Vercel Sandbox Activity
// ============================================================================
function log(tag, msg, data) {
  const entry = { tag, msg, ts: new Date().toISOString(), ...(data ? { data } : {}) };
  process.stderr.write(JSON.stringify(entry) + '\\n');
}

function progress(step, msg) {
  log('PROGRESS', step + ': ' + msg);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Log all env vars (redacted) to verify they're set
log('CONFIG', 'Environment check', {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? 'set (' + process.env.ANTHROPIC_AUTH_TOKEN.length + ' chars)' : 'MISSING',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || 'MISSING',
  HUBSPOT_API_KEY: HUBSPOT_KEY ? 'set' : 'MISSING',
  ENRICHLAYER_API_KEY: ENRICHLAYER_KEY ? 'set' : 'MISSING',
  APOLLO_API_KEY: APOLLO_KEY ? 'set' : 'MISSING',
  SLACK_BOT_TOKEN: SLACK_TOKEN ? 'set' : 'MISSING',
  KV_REST_API_URL: KV_REST_API_URL ? 'set' : 'MISSING',
  KV_REST_API_TOKEN: KV_REST_API_TOKEN ? 'set' : 'MISSING',
  PIPELINE_ID: PIPELINE_ID,
  SLACK_CHANNEL: SLACK_CHANNEL,
});

// Slack helpers (direct API calls, no SDK needed)
async function slackReaction(action, emoji) {
  try {
    const res = await fetch('https://slack.com/api/reactions.' + action, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: SLACK_CHANNEL, timestamp: SLACK_THREAD_TS, name: emoji }),
    });
    const data = await res.json();
    if (!data.ok) log('SLACK_WARN', 'reactions.' + action + ' ' + emoji + ': ' + data.error);
  } catch (err) {
    log('SLACK_ERROR', 'reactions.' + action + ' failed: ' + err.message);
  }
}
async function slackMessage(blocks, text) {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD_TS, blocks, text }),
    });
    const data = await res.json();
    if (!data.ok) log('SLACK_ERROR', 'postMessage failed: ' + data.error);
    else log('SLACK', 'Message posted to thread');
  } catch (err) {
    log('SLACK_ERROR', 'postMessage threw: ' + err.message);
  }
}
async function kvSet(key, value, exSeconds) {
  if (!KV_REST_API_URL) { log('KV_WARN', 'KV_REST_API_URL not set, skipping'); return; }
  try {
    const res = await fetch(KV_REST_API_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KV_REST_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(["SET", key, JSON.stringify(value), "EX", exSeconds]),
    });
    const data = await res.json();
    log('KV', 'SET ' + key + ': ' + (data.result || JSON.stringify(data).slice(0, 100)));
  } catch (err) {
    log('KV_ERROR', 'SET ' + key + ' failed: ' + err.message);
  }
}

// ============================================================================
// PHASE 1: EXTRACTION (parallel Claude calls, batches of ${BATCH_SIZE})
// ============================================================================
progress('extraction', 'Starting extraction of ${rawData.rows.length} rows in ${batches.length} batches');

const EXTRACTION_PROMPT = ${JSON.stringify(EXTRACTION_SYSTEM_PROMPT)};
const HEADERS = ${JSON.stringify(rawData.headers)};
const BATCH_COUNT = ${batches.length};

async function extractBatch(batchIndex) {
  const batchData = JSON.parse(readFileSync('/vercel/sandbox/data/batch_' + batchIndex + '.json', 'utf-8'));
  log('EXTRACT', 'Starting batch ' + batchIndex + ' (' + batchData.length + ' rows)');
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
    log('EXTRACT', 'Batch ' + batchIndex + ' response: ' + text.length + ' chars, usage: ' + JSON.stringify(response.usage));
    const match = text.match(/\\[[\\s\\S]*\\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      log('EXTRACT', 'Batch ' + batchIndex + ' extracted ' + parsed.length + ' contacts');
      return parsed;
    }
    log('EXTRACT', 'Batch ' + batchIndex + ' NO JSON found in response: ' + text.slice(0, 200));
    return [];
  } catch (err) {
    log('EXTRACT_ERROR', 'Batch ' + batchIndex + ' failed: ' + err.message);
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
  const toolStart = Date.now();
  log('TOOL_CALL', name, { input: JSON.stringify(input).slice(0, 300) });
  let result;
  try {
    result = await _handleToolInner(name, input);
    log('TOOL_RESULT', name + ' completed in ' + (Date.now() - toolStart) + 'ms', {
      resultPreview: JSON.stringify(result).slice(0, 300)
    });
    return result;
  } catch (err) {
    log('TOOL_ERROR', name + ' failed: ' + err.message);
    throw err;
  }
}

async function _handleToolInner(name, input) {
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
      await reportResults(input);
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

You have been given a list of \${extracted.length} extracted contacts from a conference attendee list. Process them through the steps below.

## STEP 1: RESOLVE NAMES

For each contact without a firstName/lastName, find their real identity using this exact sequence:

**1a. Search HubSpot first (free, catches people we already know):**
- Call search_hubspot_contacts with their company name
- Look through ALL results for someone whose title closely matches
- Title matching should be smart: "VP, Customer Care Operations" = "Vice President of Customer Care"
- If you find a match, take their firstname, lastname, and email
- ALSO note their lifecycle stage, notes_last_updated, and hs_email_last_reply_date for activity scoring

**1b. If no HubSpot match, try EnrichLayer role_lookup:**
- Call enrichlayer_role_lookup with company name + title
- Check the returned person carefully:
  - Does their current experience title match the seniority you searched for?
  - If you searched for a VP but got an "Associate Director" or "Analyst", that is WRONG — do NOT accept it
  - If the seniority matches, accept the name and LinkedIn URL

**1c. If role_lookup returned wrong seniority, try employee_search fallback:**
- You need a LinkedIn company URL. Try: https://www.linkedin.com/company/{company-slug}/
  (company slug = lowercase, hyphens for spaces, e.g. "best-buy", "1800flowers-com")
- Call enrichlayer_employee_search with the company URL and keywords from the title
- Build the keyword_boolean by joining key title words with +AND+ (e.g. "vice+president+AND+customer+care")
- From the results, pick the person whose seniority best matches what you searched for

## STEP 2: CHECK ACTIVITY + SCORE EXISTING CONTACTS

For each contact's company, check for existing HubSpot engagement:

**2a. Search for deals:**
- Call search_hubspot_deals with the company name
- Note any deals found, their stage, and dealname

**2b. Assess the contact's individual activity from the HubSpot search in Step 1:**
- lifecycle stage: opportunity/customer/evangelist = significant engagement
- notes_last_updated: within 90 days = recent activity
- hs_email_last_reply_date: within 90 days = recent email engagement
- A contact at "subscriber" lifecycle with no recent notes is NOT active

**2c. Score existing activity contacts (0-100 activity score):**
Contacts flagged as existing activity should also get an ACTIVITY SCORE separate from the contact score:
- Deal in late stage (contractsent, closedwon): 40 points
- Deal in mid stage (appointmentscheduled, qualifiedtobuy): 25 points
- Deal in early stage: 15 points
- Lifecycle = customer: 20 points
- Lifecycle = opportunity: 15 points
- Recent email reply (90 days): 10 points
- Recent notes (90 days): 10 points
- Just has a record with email, no activity: 5 points

## STEP 3: SCORE NEW CONTACTS (0-100)

For contacts NOT flagged as existing activity:
- Agent Size (max 30): 5000+=30, 2000+=27, 1000+=24, 500+=19.5, 250+=15, 100+=9, <100=0, unknown=9
- Seniority (max 25): C-suite=25, SVP/EVP=23.75, VP=21.25, Director/Head=17.5, Sr Manager=13.75, Manager=10, IC=6.25
- Persona Fit (max 25): ld=25, qa=23.75, wfm=15, km=15, it=10, sales_marketing=7.5, excluded=0, unknown=5
  NOTE: Do NOT use "cx_leadership" as a persona. Instead, classify senior CX/CC leaders into the specific function they oversee (ld, qa, wfm, km, it). If their function is unclear, use "unknown".
- Priority Relevance (max 15): 3+ Reddy keywords=15, 2=12, 1=9, none=4.5
  Reddy keywords: ${JSON.stringify(REDDY_RELEVANT_PRIORITIES)}
  NOT Reddy: ${JSON.stringify(NOT_REDDY_PRIORITIES)}
- Brand Bonus (max 5): Brand=5, BPO=3, other=0

## STEP 4: BUCKET CONTACTS

- "filtered": agentCount < 100, or brandBpoType is Competitor/Press, or persona is excluded
- "existing_activity": company has a deal OR contact has advanced lifecycle/recent activity. Include their activityScore and activityDetails (what deals exist, what stage, what engagement).
- "ranked": everything else, sorted by score descending

## STEP 5: ENRICH VIA APOLLO

For the top 50 ranked contacts that have names (firstName + lastName):
- Call apollo_people_match with their name + company
- Update the contact data with email, phone, LinkedIn from Apollo's response
- Skip contacts without names — Apollo can't match them

## STEP 6: PUSH TO HUBSPOT

For ranked contacts (not filtered, not existing_activity):
- Call create_hubspot_contact with all properties
- Call upsert_hubspot_company with company-level properties
- Call associate_contact_company to link them

Custom contact properties:
- agent_count__if_given_by_contact_: number of agents
- agent_level_guess: "High", "Medium", or "Low"
- bpo_or_brand: "Brand", "BPO", "Competitor", or "Press"
- project_priorities: free text
- hs_persona: ${JSON.stringify(PERSONA_MAP)}
- current_role_and_responsibilities: background text

Custom company properties:
- total_number_of_agents: number
- agent_level_guess: "High", "Medium", or "Low"
- brand_or_bpo: "Brand", "BPO", "Competitor", or "Press"
- number_of_bpo_vendors: number

## STEP 7: SUBMIT RESULTS

Call submit_results with:
- ranked: array of scored contacts (sorted by score desc)
- filtered: array of filtered contacts with filterReason
- existingActivity: array of contacts with activityScore and activityDetails
- stats: { extracted, namesResolved, ranked, filtered, existingActivity, apolloEnriched, hubspotCreated }

## IMPORTANT RULES

- Process contacts efficiently: search HubSpot once per unique company, match multiple contacts from results
- EnrichLayer is rate limited. The tool handler adds delays automatically, but don't call it unnecessarily
- Apollo REQUIRES first_name + last_name. NEVER call it without a name
- When EnrichLayer role_lookup returns someone, ALWAYS check if their current title/seniority matches what you searched for. An Associate Director is not a VP.
- For the employee_search fallback, the company LinkedIn URL format is typically: https://www.linkedin.com/company/{slug}/ where slug is lowercase with hyphens
- Title matching should be intelligent: "VP, Customer Care Operations" = "Vice President of Customer Care" = "VP Customer Care"
- Work through ALL contacts systematically before submitting results. Do not stop early.

Work through this systematically. Process all contacts, then submit results.\`;

// ============================================================================
// AGENTIC TOOL-USE LOOP
// ============================================================================
const userMessage = "Here are the " + extracted.length + " extracted contacts to process:\\n\\n" + JSON.stringify(extracted, null, 2);

log('AGENT', 'Starting agent loop', { contactCount: extracted.length, userMessageLength: userMessage.length });

let messages = [{ role: "user", content: userMessage }];

log('AGENT', 'Sending initial message to Claude...');
let response;
try {
  response = await client.messages.create({
    model: "anthropic/claude-opus-4.6",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });
  log('AGENT', 'Initial response received', {
    stop_reason: response.stop_reason,
    content_blocks: response.content.length,
    usage: response.usage,
    textPreview: response.content.filter(b => b.type === 'text').map(b => b.text.slice(0, 200)).join(''),
    toolCalls: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
  });
} catch (err) {
  log('AGENT_ERROR', 'Initial Claude call failed: ' + err.message, { stack: err.stack?.slice(0, 500) });
  // Report error to Slack and exit
  await slackReaction('remove', 'brain');
  await slackReaction('add', 'x');
  await slackMessage([], 'Pipeline error: Claude agent failed to start - ' + err.message);
  process.exit(1);
}

let turns = 0;
const MAX_TURNS = 200;

while (response.stop_reason === "tool_use" && turns < MAX_TURNS) {
  turns++;
  const assistantContent = response.content;
  messages.push({ role: "assistant", content: assistantContent });

  // Log any text blocks (Claude's reasoning)
  for (const block of assistantContent) {
    if (block.type === "text" && block.text.trim()) {
      log('AGENT_TEXT', 'Turn ' + turns + ': ' + block.text.slice(0, 500));
    }
  }

  const toolCalls = assistantContent.filter(b => b.type === "tool_use");
  log('AGENT', 'Turn ' + turns + ': ' + toolCalls.length + ' tool calls: ' + toolCalls.map(b => b.name).join(', '));

  const toolResults = [];
  for (const block of assistantContent) {
    if (block.type === "tool_use") {
      try {
        const result = await handleTool(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        log('AGENT_TOOL_ERROR', 'Tool ' + block.name + ' threw: ' + err.message);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
      }
    }
  }

  messages.push({ role: "user", content: toolResults });

  // Track message context size
  const msgSize = JSON.stringify(messages).length;
  log('AGENT', 'Sending turn ' + (turns + 1) + ' to Claude (message context: ' + Math.round(msgSize / 1024) + 'KB)');

  try {
    response = await client.messages.create({
      model: "anthropic/claude-opus-4.6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    log('AGENT', 'Turn ' + (turns + 1) + ' response', {
      stop_reason: response.stop_reason,
      usage: response.usage,
      toolCalls: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
    });
  } catch (err) {
    log('AGENT_ERROR', 'Claude call failed on turn ' + (turns + 1) + ': ' + err.message);
    // Report and exit
    await slackReaction('remove', 'brain');
    await slackReaction('add', 'x');
    await slackMessage([], 'Pipeline error on turn ' + (turns + 1) + ': ' + err.message);
    process.exit(1);
  }
}

log('AGENT', 'Loop ended. stop_reason: ' + response.stop_reason + ', turns: ' + turns);

// If Claude stopped without calling submit_results, extract any text and create a fallback result
if (response.stop_reason !== "tool_use") {
  let finalText = "";
  for (const block of response.content) {
    if (block.type === "text") finalText += block.text;
  }

  // Try to find JSON in the final text
  const jsonMatch = finalText.match(/\\{[\\s\\S]*\\}/);
  let fallbackResults;
  if (jsonMatch) {
    try {
      fallbackResults = JSON.parse(jsonMatch[0]);
    } catch {
      fallbackResults = {
        error: "Agent finished without submitting results",
        ranked: [], filtered: [], existingActivity: [],
        stats: { totalRows: ${rawData.rows.length}, extracted: extracted.length, agentTurns: turns }
      };
    }
  } else {
    fallbackResults = {
      error: "Agent finished without submitting structured results",
      ranked: [], filtered: [], existingActivity: [],
      stats: { totalRows: ${rawData.rows.length}, extracted: extracted.length, agentTurns: turns }
    };
  }
  await reportResults(fallbackResults);
  process.stdout.write(JSON.stringify(fallbackResults));
}

// ============================================================================
// REPORT RESULTS (Slack + KV) — called by submit_results tool or fallback
// ============================================================================
async function reportResults(results) {
  const ranked = results.ranked || [];
  const filtered = results.filtered || [];
  const existingActivity = results.existingActivity || [];
  const stats = results.stats || {};
  const durationSec = Math.round((Date.now() - PIPELINE_START) / 1000);

  // Store in KV
  await kvSet('pipeline:' + PIPELINE_ID, {
    id: PIPELINE_ID,
    fileName: FILE_NAME,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - PIPELINE_START,
    stats,
    ranked: ranked.map(c => ({ ...c, rawRow: undefined })),
    filtered: filtered.map(c => ({ ...c, rawRow: undefined })),
    existingActivity: existingActivity.map(c => ({ ...c, rawRow: undefined })),
  }, 30 * 24 * 60 * 60);

  // Swap emoji
  await slackReaction('remove', 'brain');
  await slackReaction('add', 'white_check_mark');

  // Build Slack blocks
  const personaLabels = ${JSON.stringify(PERSONA_MAP)};
  const byPersona = {};
  for (const c of ranked) {
    const p = c.persona || 'unknown';
    if (!byPersona[p]) byPersona[p] = [];
    byPersona[p].push(c);
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Pipeline complete: ' + FILE_NAME } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Extracted:*\\n' + (stats.extracted || 0) },
      { type: 'mrkdwn', text: '*Ranked:*\\n' + ranked.length },
      { type: 'mrkdwn', text: '*Filtered:*\\n' + filtered.length },
      { type: 'mrkdwn', text: '*Existing Activity:*\\n' + existingActivity.length },
      { type: 'mrkdwn', text: '*Apollo Enriched:*\\n' + (stats.apolloEnriched || 0) },
      { type: 'mrkdwn', text: '*HubSpot Created:*\\n' + (stats.hubspotCreated || 0) },
    ]},
    { type: 'divider' },
  ];

  const personaOrder = ['cx_leadership', 'ld', 'qa', 'wfm', 'km', 'it', 'sales_marketing', 'unknown'];
  for (const persona of personaOrder) {
    const contacts = byPersona[persona];
    if (!contacts || contacts.length === 0) continue;
    const top = contacts.slice(0, 5).map(c => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
      const agents = c.agentCount ? c.agentCount + ' agents' : (c.agentLevelGuess || '—');
      return '• *' + name + '* (' + (c.score || 0) + ') — ' + (c.title || '—') + ' @ ' + c.company + ' | ' + agents;
    });
    if (contacts.length > 5) top.push('_...and ' + (contacts.length - 5) + ' more_');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*' + (personaLabels[persona] || persona) + '* (' + contacts.length + ')\\n' + top.join('\\n') } });
  }

  blocks.push(
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Pipeline completed in ' + durationSec + 's' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Full Results' }, url: BASE_URL + '/pipeline/' + PIPELINE_ID, style: 'primary' }] }
  );

  await slackMessage(blocks, 'Pipeline complete: ' + ranked.length + ' ranked');
  progress('reported', 'Slack + KV report sent');
}

progress('done', 'Pipeline complete after ' + turns + ' agent turns');

} catch (fatalErr) {
  // Top-level catch — report any uncaught error to Slack
  const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
  const stack = fatalErr instanceof Error ? fatalErr.stack : '';
  process.stderr.write(JSON.stringify({ tag: 'FATAL', msg, stack: (stack || '').slice(0, 500) }) + '\\n');

  try {
    await slackReaction('remove', 'brain');
    await slackReaction('add', 'x');
    await slackMessage([], 'Pipeline fatal error: ' + msg);
  } catch { /* can\\'t do anything more */ }

  process.exit(1);
} finally {
  // Self-cleanup: stop the sandbox from inside by exiting the process.
  // The detached command finishing signals the sandbox to stop.
  log('CLEANUP', 'Script finished, process exiting');
}
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
