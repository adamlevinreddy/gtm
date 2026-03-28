import { Sandbox } from "@vercel/sandbox";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
} from "./prompts";

/**
 * Classify unknown companies using Claude Agent SDK in a Vercel Sandbox.
 * No snapshot caching — builds fresh each time until we confirm it works.
 */
export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationResult[]> {
  if (companies.length === 0) return [];

  const sandbox = await Sandbox.create({
    runtime: "node22",
    resources: { vcpus: 4 },
    timeout: 300_000,
    env: {
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
      ANTHROPIC_API_KEY: "",
    },
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

    // Step 2: Install Agent SDK AND Claude Code locally (SDK needs to find CLI next to itself)
    const installSDK = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-code"],
    });
    if (installSDK.exitCode !== 0) {
      throw new Error(`SDK install failed: ${await installSDK.stderr()}`);
    }

    // Step 3: Verify claude is available and find its path
    const verify = await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", "which claude && claude --version 2>&1 || echo 'claude not found'"],
    });
    const verifyOutput = await verify.stdout();

    // Step 4: Write the classification script
    const userPrompt = buildClassificationPrompt(companies);

    const script = `
import { query } from "@anthropic-ai/claude-agent-sdk";

const systemPrompt = ${JSON.stringify(CLASSIFICATION_SYSTEM_PROMPT)};
const userPrompt = ${JSON.stringify(userPrompt)};

let result = "";

try {
  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: "claude-opus-4-6",
      systemPrompt,
      allowedTools: [],
      maxTurns: 3,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "",
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "",
        ANTHROPIC_API_KEY: "",
      },
    },
  })) {
    if (message.type === "result" && "result" in message) {
      result = message.result;
    }
  }
} catch (err) {
  process.stderr.write("AGENT_ERROR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
}

const jsonMatch = result.match(/\\[[\\s\\S]*\\]/);
if (jsonMatch) {
  process.stdout.write(jsonMatch[0]);
} else {
  process.stdout.write("[]");
  process.stderr.write("NO_JSON: " + result.slice(0, 1000) + "\\n");
}
`;

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/classify.mjs", content: Buffer.from(script, "utf-8") },
    ]);

    // Step 5: Run the script
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["classify.mjs"],
      cwd: "/vercel/sandbox",
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (!stdout || stdout.trim() === "[]") {
      throw new Error(`Agent returned no results. verify: ${verifyOutput} | stderr: ${stderr} | exit: ${run.exitCode}`);
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
