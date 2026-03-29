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
 * Use Claude in a Vercel Sandbox to extract structured contact data.
 * One sandbox, parallel Claude API calls for each batch of 20 rows.
 * Follows the proven pattern: @anthropic-ai/claude-code CLI + @anthropic-ai/sdk
 * per https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk
 */
export async function extractContactData(
  headers: string[],
  rows: Record<string, string>[]
): Promise<ExtractedContact[]> {
  if (rows.length === 0) return [];

  const BATCH_SIZE = 20;
  const batches: Record<string, string>[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  console.log(`[extract] Starting: ${rows.length} rows, ${batches.length} batches of ${BATCH_SIZE}`);

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
      console.error(`[extract] CLI install failed: ${await installCLI.stderr()}`);
    }

    // Step 2: Install Anthropic SDK locally (per Vercel guide)
    const installSDK = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/sdk"],
    });
    if (installSDK.exitCode !== 0) {
      console.error(`[extract] SDK install failed: ${await installSDK.stderr()}`);
    }

    // Step 3: Write batch data files
    const batchFiles = batches.map((batch, i) => ({
      path: `/vercel/sandbox/batch_${i}.json`,
      content: Buffer.from(JSON.stringify(batch), "utf-8"),
    }));
    await sandbox.writeFiles(batchFiles);

    // Step 4: Write orchestrator that runs parallel agents via Anthropic SDK
    const script = `
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const SYSTEM_PROMPT = ${JSON.stringify(EXTRACTION_SYSTEM_PROMPT)};
const HEADERS = ${JSON.stringify(headers)};
const BATCH_COUNT = ${batches.length};

async function processAgent(batchIndex) {
  const batchData = JSON.parse(readFileSync(\`/vercel/sandbox/batch_\${batchIndex}.json\`, 'utf-8'));

  const userPrompt = "Column headers: " + JSON.stringify(HEADERS) + "\\n\\nRows (" + batchData.length + "):\\n" + JSON.stringify(batchData);

  try {
    const response = await client.messages.create({
      model: "anthropic/claude-opus-4.6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const jsonMatch = text.match(/\\[[\\s\\S]*\\]/);
    if (jsonMatch) {
      return { batchIndex, results: JSON.parse(jsonMatch[0]), error: null };
    }
    return { batchIndex, results: [], error: "No JSON in response: " + text.slice(0, 200) };
  } catch (err) {
    return { batchIndex, results: [], error: "Agent " + batchIndex + ": " + String(err).slice(0, 300) };
  }
}

// Dispatch ALL agents in parallel
const agentPromises = [];
for (let i = 0; i < BATCH_COUNT; i++) {
  agentPromises.push(processAgent(i));
}

process.stderr.write("Dispatched " + BATCH_COUNT + " parallel agents\\n");
const results = await Promise.all(agentPromises);

// Report per-batch status
let totalExtracted = 0;
for (const r of results) {
  if (r.error) {
    process.stderr.write("Batch " + r.batchIndex + " ERROR: " + r.error + "\\n");
  } else {
    process.stderr.write("Batch " + r.batchIndex + " OK: " + r.results.length + " contacts\\n");
    totalExtracted += r.results.length;
  }
}
process.stderr.write("Total extracted: " + totalExtracted + "\\n");

// Combine and output
const combined = results.flatMap(r => r.results);
process.stdout.write(JSON.stringify(combined));
`;

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/orchestrator.mjs", content: Buffer.from(script, "utf-8") },
    ]);

    console.log(`[extract] Running orchestrator with ${batches.length} parallel agents`);

    // Step 5: Run with the same env pattern that works for classification
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["orchestrator.mjs"],
      cwd: "/vercel/sandbox",
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
      },
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (stderr) {
      console.error(`[extract] Orchestrator stderr:\n${stderr.slice(0, 2000)}`);
    }
    if (run.exitCode !== 0) {
      console.error(`[extract] Orchestrator exit code: ${run.exitCode}`);
    }

    console.log(`[extract] Done. stdout length: ${stdout?.length || 0}, exit: ${run.exitCode}`);

    if (!stdout || stdout.trim() === "[]" || stdout.trim() === "") {
      console.error(`[extract] Empty results. stdout: "${stdout?.slice(0, 300)}"`);
      return [];
    }

    try {
      const parsed: ExtractedContact[] = JSON.parse(stdout);
      // Attach raw rows back
      const allRows = batches.flat();
      for (let i = 0; i < parsed.length && i < allRows.length; i++) {
        parsed[i].rawRow = allRows[i];
      }
      console.log(`[extract] Success: ${parsed.length} contacts extracted`);
      return parsed;
    } catch (parseErr) {
      console.error(`[extract] JSON parse error: ${parseErr}. stdout: ${stdout.slice(0, 500)}`);
      return [];
    }
  } finally {
    await sandbox.stop();
  }
}
