import { Sandbox } from "@vercel/sandbox";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
} from "./prompts";

/**
 * Classify unknown companies using Claude in a Vercel Sandbox.
 * Follows the Vercel guide: installs @anthropic-ai/claude-code globally
 * and @anthropic-ai/sdk locally, then runs a script that calls Claude.
 */
export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationResult[]> {
  if (companies.length === 0) return [];

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

    // Step 3: Write classification script using @anthropic-ai/sdk
    const userPrompt = buildClassificationPrompt(companies);

    const script = `
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const systemPrompt = ${JSON.stringify(CLASSIFICATION_SYSTEM_PROMPT)};
const userPrompt = ${JSON.stringify(userPrompt)};

try {
  const response = await client.messages.create({
    model: "anthropic/claude-opus-4.6",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  let result = "";
  for (const block of response.content) {
    if (block.type === "text") {
      result += block.text;
    }
  }

  const jsonMatch = result.match(/\\[[\\s\\S]*\\]/);
  if (jsonMatch) {
    process.stdout.write(jsonMatch[0]);
  } else {
    process.stdout.write("[]");
    process.stderr.write("NO_JSON_IN_RESPONSE: " + result.slice(0, 500) + "\\n");
  }
} catch (err) {
  process.stderr.write("API_ERROR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
  process.stdout.write("[]");
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
      },
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (!stdout || stdout.trim() === "[]") {
      throw new Error(`No results. stderr: ${stderr} | exit: ${run.exitCode}`);
    }

    const parsed: Array<{
      name: string;
      action: string;
      category: string | null;
      rationale: string;
    }> = JSON.parse(stdout);

    return parsed.map((item) => ({
      name: item.name,
      action: item.action as "exclude" | "tag" | "prospect",
      category: item.category,
      confidence: "claude" as const,
      rationale: item.rationale,
    }));
  } finally {
    await sandbox.stop();
  }
}
