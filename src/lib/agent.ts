import { Sandbox } from "@vercel/sandbox";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
} from "./prompts";

export interface HubSpotMatch {
  company: string;
  contacts: {
    name: string;
    email: string | null;
    title: string | null;
  }[];
}

export interface ClassificationOutput {
  classifications: ClassificationResult[];
  hubspotMatches: HubSpotMatch[];
}

/**
 * Classify unknown companies using Claude in a Vercel Sandbox.
 * Claude has a search_hubspot tool to look up contacts/companies in HubSpot CRM.
 */
export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationOutput> {
  if (companies.length === 0) return { classifications: [], hubspotMatches: [] };

  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: 300_000,
    runtime: "node22",
  });

  try {
    // Step 1: Install Claude Code CLI globally (per Vercel guide)
    const installCLI = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      sudo: true,
    });
    if (installCLI.exitCode !== 0) {
      throw new Error(`CLI install failed: ${await installCLI.stderr()}`);
    }

    // Step 2: Install Anthropic SDK locally (per Vercel guide)
    const installSDK = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/sdk"],
    });
    if (installSDK.exitCode !== 0) {
      throw new Error(`SDK install failed: ${await installSDK.stderr()}`);
    }

    // Step 3: Write classification script with HubSpot tool use
    const userPrompt = buildClassificationPrompt(companies);

    const script = `
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const HUBSPOT_TOKEN = process.env.HUBSPOT_API_KEY;

const tools = [
  {
    name: "search_hubspot",
    description: "Search HubSpot CRM for contacts matching a company name and optionally a job title. Returns matching contacts with their name, email, job title, and company. Use this to check if any of the company+title combinations from the conference list already exist in our CRM.",
    input_schema: {
      type: "object",
      properties: {
        company_name: {
          type: "string",
          description: "The company name to search for in HubSpot"
        },
        job_title: {
          type: "string",
          description: "Optional job title to narrow the search. If provided, only contacts matching both company AND title are returned."
        }
      },
      required: ["company_name"]
    }
  }
];

async function searchHubSpot(companyName, jobTitle) {
  try {
    const filters = [{
      propertyName: "company",
      operator: "CONTAINS_TOKEN",
      value: companyName
    }];
    if (jobTitle) {
      filters.push({
        propertyName: "jobtitle",
        operator: "CONTAINS_TOKEN",
        value: jobTitle
      });
    }
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + HUBSPOT_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: ["firstname", "lastname", "email", "jobtitle", "company", "lifecyclestage", "hs_lead_status"],
        limit: 10,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      // If CONTAINS_TOKEN fails (common with multi-word values), fall back to broader search
      if (res.status === 400) {
        const fallbackRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + HUBSPOT_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: companyName,
            properties: ["firstname", "lastname", "email", "jobtitle", "company", "lifecyclestage", "hs_lead_status"],
            limit: 10,
          }),
        });
        if (!fallbackRes.ok) return { error: "HubSpot API error: " + fallbackRes.status, results: [] };
        const fallbackData = await fallbackRes.json();
        const filtered = jobTitle
          ? (fallbackData.results || []).filter(c => {
              const t = (c.properties.jobtitle || "").toLowerCase();
              return t.includes(jobTitle.toLowerCase());
            })
          : fallbackData.results || [];
        return {
          total: filtered.length,
          results: filtered.map(c => ({
            name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "Unknown",
            email: c.properties.email || null,
            title: c.properties.jobtitle || null,
            company: c.properties.company || null,
            lifecycle: c.properties.lifecyclestage || null,
            leadStatus: c.properties.hs_lead_status || null,
          })),
        };
      }
      return { error: "HubSpot API error: " + res.status, results: [] };
    }
    const data = await res.json();
    return {
      total: data.total || 0,
      results: (data.results || []).map(c => ({
        name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "Unknown",
        email: c.properties.email || null,
        title: c.properties.jobtitle || null,
        company: c.properties.company || null,
        lifecycle: c.properties.lifecyclestage || null,
        leadStatus: c.properties.hs_lead_status || null,
      })),
    };
  } catch (err) {
    return { error: err.message, results: [] };
  }
}

const systemPrompt = ${JSON.stringify(CLASSIFICATION_SYSTEM_PROMPT)};
const userPrompt = ${JSON.stringify(userPrompt)};

const enhancedSystem = systemPrompt + \`

## HubSpot CRM Lookup
You have a search_hubspot tool that lets you look up contacts in our HubSpot CRM by company name.
For companies you classify as "prospect", use the tool to check if we already have contacts there.
After completing all classifications, report any HubSpot matches you found.

Your final output must be a JSON object with two keys:
- "classifications": the array of classification results (same format as before)
- "hubspot_matches": an array of objects like {"company": "...", "contacts": [{"name": "...", "email": "...", "title": "..."}]}

Only include companies in hubspot_matches if the search actually returned results.\`;

try {
  let messages = [{ role: "user", content: userPrompt }];

  // Agentic tool-use loop
  let response = await client.messages.create({
    model: "anthropic/claude-opus-4.6",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: enhancedSystem,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    // Collect all tool calls from this response
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        if (block.name === "search_hubspot") {
          const result = await searchHubSpot(block.input.company_name, block.input.job_title);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "anthropic/claude-opus-4.6",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: enhancedSystem,
      tools,
      messages,
    });
  }

  // Extract final text
  let result = "";
  for (const block of response.content) {
    if (block.type === "text") {
      result += block.text;
    }
  }

  // Try to parse as the new format {classifications, hubspot_matches}
  const jsonMatch = result.match(/\\{[\\s\\S]*\\}/);
  if (jsonMatch) {
    process.stdout.write(jsonMatch[0]);
  } else {
    // Fallback: try array format
    const arrayMatch = result.match(/\\[[\\s\\S]*\\]/);
    if (arrayMatch) {
      process.stdout.write(JSON.stringify({ classifications: JSON.parse(arrayMatch[0]), hubspot_matches: [] }));
    } else {
      process.stdout.write(JSON.stringify({ classifications: [], hubspot_matches: [] }));
      process.stderr.write("NO_JSON_IN_RESPONSE: " + result.slice(0, 500) + "\\n");
    }
  }
} catch (err) {
  process.stderr.write("API_ERROR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
  process.stdout.write(JSON.stringify({ classifications: [], hubspot_matches: [] }));
}
`;

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/classify.mjs", content: Buffer.from(script, "utf-8") },
    ]);

    // Step 4: Run the script with API credentials
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["classify.mjs"],
      cwd: "/vercel/sandbox",
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        HUBSPOT_API_KEY: process.env.HUBSPOT_API_KEY || "",
      },
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (!stdout || stdout.trim() === "{}") {
      throw new Error(`No results. stderr: ${stderr} | exit: ${run.exitCode}`);
    }

    const parsed: {
      classifications: Array<{
        name: string;
        action: string;
        category: string | null;
        rationale: string;
      }>;
      hubspot_matches: Array<{
        company: string;
        contacts: Array<{
          name: string;
          email: string | null;
          title: string | null;
        }>;
      }>;
    } = JSON.parse(stdout);

    const classifications = (parsed.classifications || []).map((item) => ({
      name: item.name,
      action: item.action as "exclude" | "tag" | "prospect",
      category: item.category,
      confidence: "claude" as const,
      rationale: item.rationale,
    }));

    const hubspotMatches = (parsed.hubspot_matches || []).map((m) => ({
      company: m.company,
      contacts: m.contacts || [],
    }));

    return { classifications, hubspotMatches };
  } finally {
    await sandbox.stop();
  }
}
