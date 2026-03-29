import { Sandbox } from "@vercel/sandbox";

export interface ExtractedContact {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  company: string;
  title: string | null;
  agentCount: number | null;
  agentLevelGuess: "High" | "Medium" | "Low" | null;
  brandBpoType: "Brand" | "BPO" | "Competitor" | "Press" | null;
  projectPriorities: string | null;
  persona: string | null;
  background: string | null;
  numberOfBpoVendors: number | null;
  rawRow: Record<string, string>;
}

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

/**
 * Use Claude in a Vercel Sandbox to extract structured contact data
 * from raw spreadsheet rows.
 */
export async function extractContactData(
  headers: string[],
  rows: Record<string, string>[]
): Promise<ExtractedContact[]> {
  if (rows.length === 0) return [];

  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: 300_000,
    runtime: "node22",
  });

  try {
    await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      sudo: true,
    });
    await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/sdk"],
    });

    // Batch rows if too many (keep under ~100k tokens)
    const BATCH_SIZE = 100;
    const batches: Record<string, string>[][] = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      batches.push(rows.slice(i, i + BATCH_SIZE));
    }

    const allResults: ExtractedContact[] = [];

    for (const batch of batches) {
      const userPrompt = `Here are the column headers from the spreadsheet:\n${JSON.stringify(headers)}\n\nHere are the rows to extract (${batch.length} rows):\n${JSON.stringify(batch)}`;

      const script = `
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const systemPrompt = ${JSON.stringify(EXTRACTION_SYSTEM_PROMPT)};
const userPrompt = ${JSON.stringify(userPrompt)};

try {
  const response = await client.messages.create({
    model: "anthropic/claude-opus-4.6",
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  let result = "";
  for (const block of response.content) {
    if (block.type === "text") result += block.text;
  }

  const jsonMatch = result.match(/\\[[\\s\\S]*\\]/);
  if (jsonMatch) {
    process.stdout.write(jsonMatch[0]);
  } else {
    process.stderr.write("NO_JSON: " + result.slice(0, 500) + "\\n");
    process.stdout.write("[]");
  }
} catch (err) {
  process.stderr.write("ERROR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
  process.stdout.write("[]");
}
`;

      await sandbox.writeFiles([
        { path: "/vercel/sandbox/extract.mjs", content: Buffer.from(script, "utf-8") },
      ]);

      const run = await sandbox.runCommand({
        cmd: "node",
        args: ["extract.mjs"],
        cwd: "/vercel/sandbox",
        env: {
          ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
          ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        },
      });

      const stdout = await run.stdout();
      if (stdout && stdout.trim() !== "[]") {
        const parsed: ExtractedContact[] = JSON.parse(stdout);
        // Attach raw rows back for reference
        for (let i = 0; i < parsed.length && i < batch.length; i++) {
          parsed[i].rawRow = batch[i];
        }
        allResults.push(...parsed);
      }
    }

    return allResults;
  } finally {
    await sandbox.stop();
  }
}
