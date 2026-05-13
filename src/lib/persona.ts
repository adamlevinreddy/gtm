import { Sandbox } from "@vercel/sandbox";
import type { Persona } from "./types";

const PERSONA_SYSTEM_PROMPT = `You are a persona classifier for Reddy, a company that sells AI-powered training, QA, and coaching solutions to contact centers.

Given a list of job titles, classify each into one of these personas:

## BUYER PERSONAS (people who buy or influence purchase of CC tools):

- cx_leadership: CX / Contact Center Leadership — VPs, SVPs, Directors who run customer experience, contact center, customer service, customer operations, customer care, member services, support operations. Senior "Operations" titles in a CC context also go here.
- ld: L&D / Training — people who train contact center agents: training managers/directors, L&D, agent development, onboarding, enablement, talent development, instructional design
- qa: QA Ops — quality assurance in contact centers: quality managers/directors, QA, speech analytics, performance management, compliance (CC-related)
- wfm: WFM — workforce management: WFM managers/directors, workforce planning, forecasting, scheduling, capacity planning, real-time operations
- km: Knowledge Management — knowledge base managers, content strategy (internal), documentation, agent resources
- sales_marketing: Sales & Marketing — CMO, VP Marketing, VP Sales, marketing/sales directors at prospect companies (they influence CC decisions at some companies)
- it: IT / Technology — CTO, VP IT, technology directors/managers, systems architects at companies that operate contact centers

## EXCLUDED (not buyers, even at prospect companies):
- excluded: SDR, BDR, Account Executive, Account Manager, Sales Development, Business Development Rep, Solutions Engineer, Sales Engineer, Pre-Sales, Partnerships, Alliances, Channel Manager, Intern, Administrative Assistant, Contact Center Agent, Customer Service Representative, Call Center Associate, Software Engineer, Developer, Data Scientist (unless CX-related), Finance, Accounting, Legal

## UNKNOWN:
- unknown: title doesn't clearly fit any category

## Rules:
1. Senior titles (VP, SVP, C-suite) that oversee contact centers → cx_leadership
2. Multi-hat titles: pick the MOST relevant persona. "Director of Training & Quality" → ld
3. If a title could be excluded OR a buyer, lean toward including (false negatives are worse)

Respond with ONLY a valid JSON array. Each element: {"title": "exact title as provided", "persona": "persona_key"}`;

/**
 * Classify titles into personas using Claude in a Vercel Sandbox.
 */
export async function classifyPersonas(
  titles: string[]
): Promise<Record<string, Persona>> {
  const uniqueTitles = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  if (uniqueTitles.length === 0) return {};

  const sandbox = await Sandbox.create({
    resources: { vcpus: 2 },
    timeout: 120_000,
    runtime: "node22",
    persistent: false,
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

    const script = `
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const titles = ${JSON.stringify(uniqueTitles)};
const systemPrompt = ${JSON.stringify(PERSONA_SYSTEM_PROMPT)};

try {
  const response = await client.messages.create({
    model: "anthropic/claude-sonnet-4-6",
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: "Classify these titles:\\n" + JSON.stringify(titles) }],
  });

  let result = "";
  for (const block of response.content) {
    if (block.type === "text") result += block.text;
  }

  const jsonMatch = result.match(/\\[[\\s\\S]*\\]/);
  if (jsonMatch) {
    process.stdout.write(jsonMatch[0]);
  } else {
    process.stdout.write("[]");
  }
} catch (err) {
  process.stderr.write("PERSONA_ERROR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
  process.stdout.write("[]");
}
`;

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/persona.mjs", content: Buffer.from(script, "utf-8") },
    ]);

    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["persona.mjs"],
      cwd: "/vercel/sandbox",
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
      },
    });

    const stdout = await run.stdout();
    if (!stdout || stdout.trim() === "[]") return {};

    const results: Array<{ title: string; persona: string }> = JSON.parse(stdout);

    const map: Record<string, Persona> = {};
    for (const r of results) {
      map[r.title.toLowerCase().trim()] = r.persona as Persona;
    }
    return map;
  } finally {
    await sandbox.stop();
  }
}
