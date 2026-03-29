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
 * Use Claude Code agents running in parallel inside a Vercel Sandbox
 * to extract structured contact data from raw spreadsheet rows.
 *
 * Splits into batches of 20 and dispatches parallel agents for each batch.
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
    // Install Claude Code SDK locally for programmatic agent use
    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/claude-code"],
    });
    if (install.exitCode !== 0) {
      const stderr = await install.stderr();
      console.error(`[extract] SDK install failed: ${stderr}`);
      throw new Error(`Claude Code SDK install failed: ${stderr}`);
    }
    console.log("[extract] Claude Code SDK installed");

    // Write batch data files so the script can read them
    const batchFiles = batches.map((batch, i) => ({
      path: `/vercel/sandbox/batch_${i}.json`,
      content: Buffer.from(JSON.stringify(batch), "utf-8"),
    }));
    await sandbox.writeFiles(batchFiles);

    // Write the orchestrator script that spawns parallel agents
    const script = `
import { query } from '@anthropic-ai/claude-code';
import { readFileSync } from 'fs';

const SYSTEM_PROMPT = ${JSON.stringify(EXTRACTION_SYSTEM_PROMPT)};
const HEADERS = ${JSON.stringify(headers)};
const BATCH_COUNT = ${batches.length};

async function processAgent(batchIndex) {
  const batchData = JSON.parse(readFileSync(\`/vercel/sandbox/batch_\${batchIndex}.json\`, 'utf-8'));

  const prompt = [
    "Extract structured contact data from these spreadsheet rows.",
    "",
    "Column headers: " + JSON.stringify(HEADERS),
    "",
    "Rows (" + batchData.length + "):",
    JSON.stringify(batchData),
    "",
    "Return ONLY a JSON array of extracted contacts. No other text.",
  ].join("\\n");

  try {
    const messages = [];
    for await (const msg of query({
      prompt,
      abortController: new AbortController(),
      options: {
        maxTurns: 1,
        systemPrompt: SYSTEM_PROMPT,
      },
    })) {
      messages.push(msg);
    }

    // Extract text from assistant messages
    let text = "";
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
    }

    const jsonMatch = text.match(/\\[[\\s\\S]*\\]/);
    if (jsonMatch) {
      return { batchIndex, results: JSON.parse(jsonMatch[0]), error: null };
    }
    return { batchIndex, results: [], error: "No JSON array in response: " + text.slice(0, 200) };
  } catch (err) {
    return { batchIndex, results: [], error: String(err).slice(0, 300) };
  }
}

// Dispatch all agents in parallel
const agentPromises = [];
for (let i = 0; i < BATCH_COUNT; i++) {
  agentPromises.push(processAgent(i));
}

const results = await Promise.all(agentPromises);

// Report errors
for (const r of results) {
  if (r.error) {
    process.stderr.write("Batch " + r.batchIndex + " error: " + r.error + "\\n");
  }
}

// Combine all results
const combined = results.flatMap(r => r.results);
process.stdout.write(JSON.stringify(combined));
`;

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/orchestrator.mjs", content: Buffer.from(script, "utf-8") },
    ]);

    console.log(`[extract] Running orchestrator with ${batches.length} parallel agents`);

    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["orchestrator.mjs"],
      cwd: "/vercel/sandbox",
      env: {
        ANTHROPIC_API_KEY: process.env.AI_GATEWAY_API_KEY || "",
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      },
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (stderr) {
      console.error(`[extract] Orchestrator stderr: ${stderr.slice(0, 1000)}`);
    }
    if (run.exitCode !== 0) {
      console.error(`[extract] Orchestrator exit code: ${run.exitCode}`);
    }

    console.log(`[extract] Orchestrator done. stdout length: ${stdout?.length || 0}, exit: ${run.exitCode}`);

    if (!stdout || stdout.trim() === "[]" || stdout.trim() === "") {
      console.error(`[extract] Empty results. stdout: "${stdout?.slice(0, 300)}"`);
      return [];
    }

    try {
      const parsed: ExtractedContact[] = JSON.parse(stdout);
      // Attach raw rows back — flatten batch mapping
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
