import { Sandbox } from "@vercel/sandbox";
import { kv } from "@vercel/kv";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
} from "./prompts";

const SNAPSHOT_KV_KEY = "sandbox:agent-snapshot-v9";

/**
 * Get or create a sandbox snapshot with the Agent SDK pre-installed.
 * First call installs deps and creates a snapshot (~30-60s).
 * Subsequent calls reuse the snapshot (instant).
 */
async function getOrCreateSnapshot(): Promise<string> {
  // Delete stale snapshots from previous versions
  await kv.del("sandbox:agent-snapshot-id");
  await kv.del("sandbox:agent-snapshot-v2");
  await kv.del("sandbox:agent-snapshot-v3");
  await kv.del("sandbox:agent-snapshot-v4");
  await kv.del("sandbox:agent-snapshot-v5");
  await kv.del("sandbox:agent-snapshot-v6");
  await kv.del("sandbox:agent-snapshot-v7");
  await kv.del("sandbox:agent-snapshot-v8");

  const cached = await kv.get<string>(SNAPSHOT_KV_KEY);
  if (cached) return cached;

  // No snapshot — create one, install deps, snapshot it
  const sandbox = await Sandbox.create({
    runtime: "node24",
    resources: { vcpus: 2 },
    timeout: 300_000,
    env: {
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
      ANTHROPIC_API_KEY: "",
    },
  });

  try {
    // Install Agent SDK locally
    const installSdk = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-save", "@anthropic-ai/claude-agent-sdk"],
      cwd: "/vercel/sandbox",
      sudo: true,
    });
    if (installSdk.exitCode !== 0) {
      const stderr = await installSdk.stderr();
      throw new Error(`SDK install failed (exit ${installSdk.exitCode}): ${stderr}`);
    }

    // Install Claude Code CLI globally so it's on PATH
    const installCli = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      cwd: "/vercel/sandbox",
      sudo: true,
    });
    if (installCli.exitCode !== 0) {
      const stderr = await installCli.stderr();
      throw new Error(`CLI install failed (exit ${installCli.exitCode}): ${stderr}`);
    }

    // Find the claude-code cli.js file
    const findCli = await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", "find / -path '*/claude-code/cli.js' -type f 2>/dev/null | head -1"],
      cwd: "/vercel/sandbox",
    });
    const cliJsPath = (await findCli.stdout()).trim();
    if (!cliJsPath) {
      throw new Error("cli.js not found anywhere after install");
    }
    // pathToClaudeCodeExecutable should be the DIRECTORY containing cli.js
    const claudePath = cliJsPath.replace(/\/cli\.js$/, "");

    // Store the path for the classification script
    await sandbox.writeFiles([
      { path: "/vercel/sandbox/.claude-path", content: Buffer.from(claudePath, "utf-8") },
    ]);

    // Snapshot captures installed deps — reusable without reinstall
    const snapshot = await sandbox.snapshot();
    // sandbox is stopped after snapshot

    // Cache snapshot ID for 7 days
    await kv.set(SNAPSHOT_KV_KEY, snapshot.snapshotId, { ex: 7 * 24 * 60 * 60 });

    return snapshot.snapshotId;
  } catch (err) {
    await sandbox.stop();
    throw err;
  }
}

/**
 * Classify unknown companies using Claude Agent SDK in a Vercel Sandbox.
 * The agent runs with Opus via AI Gateway.
 */
export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationResult[]> {
  if (companies.length === 0) return [];

  const snapshotId = await getOrCreateSnapshot();

  // Create sandbox from snapshot (deps pre-installed)
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    resources: { vcpus: 2 },
    timeout: 300_000,
    env: {
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
      ANTHROPIC_API_KEY: "",
    },
  });

  try {
    const userPrompt = buildClassificationPrompt(companies);

    // Read the claude CLI path from the snapshot
    const claudePathBuf = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/.claude-path" });
    const claudeCliPath = claudePathBuf ? claudePathBuf.toString("utf-8").trim() : "/usr/local/bin/claude";

    // Write the classification script
    const script = `
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const claudePath = ${JSON.stringify(claudeCliPath)};
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
      pathToClaudeCodeExecutable: claudePath,
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_API_KEY: "",
      },
    },
  })) {
    if (message.type === "result" && "result" in message) {
      result = message.result;
    }
  }
} catch (err) {
  process.stderr.write("Agent error: " + (err instanceof Error ? err.message : String(err)) + "\\n");
}

// Output result as JSON to stdout
const jsonMatch = result.match(/\\[[\\s\\S]*\\]/);
if (jsonMatch) {
  process.stdout.write(jsonMatch[0]);
} else {
  process.stdout.write("[]");
  process.stderr.write("No JSON array found in agent output: " + result.slice(0, 500) + "\\n");
}
`;

    await sandbox.writeFiles([
      {
        path: "/vercel/sandbox/classify.mjs",
        content: Buffer.from(script, "utf-8"),
      },
    ]);

    // Run the classification script
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["classify.mjs"],
      cwd: "/vercel/sandbox",
    });

    const stdout = await run.stdout();
    const stderr = await run.stderr();

    if (run.exitCode !== 0) {
      throw new Error(`Classification script failed (exit ${run.exitCode}): ${stderr}`);
    }

    // If stdout is empty or just "[]", check stderr for diagnostics
    if (!stdout || stdout.trim() === "[]") {
      throw new Error(`Agent returned no results. stderr: ${stderr || "(empty)"}, stdout: ${stdout || "(empty)"}`);
    }

    // Parse the JSON array from stdout
    const parsed: Array<{
      name: string;
      action: string;
      category: string | null;
      rationale: string;
    }> = JSON.parse(stdout || "[]");

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
