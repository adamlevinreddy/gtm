import type { PricingMode } from "@/app/api/pricing/route";

export type PricingMeta = {
  mode: PricingMode;
  sandboxName: string;
  slackChannel: string;
  slackThreadTs: string;
  slackUser: string | null;
  threadKey: string;
  libraryRepoUrl: string;
  isFirstTurn: boolean;
  turnCount: number;
};

const MAX_AGENT_ITERATIONS = 40;
const HISTORY_KV_SUFFIX = ":history";

const SYSTEM_PROMPT = `You are the Reddy pricing-proposal assistant, running inside a Vercel Sandbox.

You are spoken to from a Slack thread. Each user message is a "turn" — you receive it from inbox/turn-N.json. Your job depends on the current mode:

== mode: "build" ==
Generate or iterate on a customer pricing proposal PDF.

Workflow for the FIRST turn of a build (turn 1):
  1. Call read_file on "library/INDEX.md" — pick the catalog entry whose customer profile (agent count, term, BYOT vs hosted, layout style) most closely matches the request.
  2. Call read_file on the chosen reference's proposal.tsx so you understand the structure.
  3. Pick a directory name: library/Brand Pricing/{kebab-company}-proposal/. If the user provided a logo URL, download it via fetch_url and save as {kebab-company}-logo.png.
  4. Copy the reference's package.json, fonts/, and reddy-logo.png into the new directory using copy_file.
  5. Write a new proposal.tsx adapting the reference to this customer (name, colors, pricing constants, copy). Keep the standard renderToFile entry point at the bottom: \`renderToFile(<Proposal />, "./Reddy_x_{Company}_Proposal.pdf")\`.
  6. Call compile_pdf with the proposal directory — it will run npm install (first time) then npx tsx and return the PDF path.
  7. Call upload_slack_pdf with the PDF path and a short caption describing what was built.
  8. End your turn by calling post_slack_message with a brief summary (one or two sentences) inviting the user to iterate ("Reply to change rates, swap colors, etc.").

Workflow for subsequent turns of a build:
  1. Read inbox/turn-N.json to see the request, and look at the thread history (provided in this prompt) to recall what was built.
  2. Read the existing proposal.tsx, edit it, recompile, re-upload. No need to re-read INDEX.md unless the user asks for a fundamentally different style.

== mode: "check" ==
Answer pricing-strategy questions WITHOUT writing files. Read library/PRICING_ASSUMPTIONS.md, library/INDEX.md, and any specifically relevant proposal source files. Cite specific numbers and reference proposals by name. End with post_slack_message — your reply IS the final answer.

== Critical rules ==
- ALL file paths are relative to /vercel/sandbox unless absolute. The library lives at library/ (cloned from github.com/ReddySolutions/pricing).
- NEVER fabricate competitor pricing or claims about historical Reddy proposals. If you don't have the data, say so.
- ALWAYS end your turn by calling EITHER upload_slack_pdf (build) OR post_slack_message (check). Both is fine for build (caption + closing message).
- Keep Slack messages brief. Use Slack mrkdwn (*bold*, _italic_, \`code\`, > quotes). No headings.
- Stay in the chosen directory for one build. Don't create multiple {company}-proposal directories per thread.
- Do NOT run git commands yourself. Any changes you write under library/Brand Pricing/ are automatically committed and pushed back to the main branch at the end of a successful build turn.

Use the tools provided. Don't make up function calls.`;

export function buildPricingDriver(meta: PricingMeta): string {
  return `// Auto-generated pricing driver — do not edit by hand
// Generated for sandbox=${meta.sandboxName} turn=${meta.turnCount} mode=${meta.mode}

import { readFile, writeFile, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const META = ${JSON.stringify(meta, null, 2)};
const TURN_NUMBER = parseInt(process.argv[2] ?? "${meta.turnCount}", 10);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const SLACK_THREAD_TS = process.env.SLACK_THREAD_TS;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PAT = process.env.PRICING_LIBRARY_GITHUB_PAT;
const THREAD_KEY = process.env.PRICING_THREAD_KEY;
const HISTORY_KEY = THREAD_KEY + ${JSON.stringify(HISTORY_KV_SUFFIX)};

const SYSTEM_PROMPT = ${JSON.stringify(SYSTEM_PROMPT)};
const MAX_ITERATIONS = ${MAX_AGENT_ITERATIONS};

// ────────── Slack helpers ──────────

async function slackApi(method, body) {
  const res = await fetch(\`https://slack.com/api/\${method}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: \`Bearer \${SLACK_TOKEN}\`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postSlackMessage(text) {
  return slackApi("chat.postMessage", {
    channel: SLACK_CHANNEL,
    thread_ts: SLACK_THREAD_TS,
    text,
  });
}

async function setReaction(name) {
  return slackApi("reactions.add", {
    channel: SLACK_CHANNEL,
    name,
    timestamp: SLACK_THREAD_TS,
  }).catch(() => null);
}

async function removeReaction(name) {
  return slackApi("reactions.remove", {
    channel: SLACK_CHANNEL,
    name,
    timestamp: SLACK_THREAD_TS,
  }).catch(() => null);
}

async function uploadPdfToSlack(filePath, title) {
  const fileBuffer = await readFile(filePath);
  const fileName = path.basename(filePath);

  // Step 1: get upload URL
  const getUrlRes = await fetch(\`https://slack.com/api/files.getUploadURLExternal?\${new URLSearchParams({
    filename: fileName,
    length: String(fileBuffer.length),
  })}\`, {
    method: "POST",
    headers: { Authorization: \`Bearer \${SLACK_TOKEN}\` },
  });
  const getUrl = await getUrlRes.json();
  if (!getUrl.ok) throw new Error("getUploadURLExternal failed: " + JSON.stringify(getUrl));

  // Step 2: PUT bytes to upload URL
  const putRes = await fetch(getUrl.upload_url, {
    method: "POST",
    body: fileBuffer,
    headers: { "Content-Type": "application/pdf" },
  });
  if (!putRes.ok) throw new Error("upload PUT failed: " + putRes.status);

  // Step 3: complete upload, attach to channel + thread
  const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: \`Bearer \${SLACK_TOKEN}\`,
    },
    body: JSON.stringify({
      files: [{ id: getUrl.file_id, title: title || fileName }],
      channel_id: SLACK_CHANNEL,
      thread_ts: SLACK_THREAD_TS,
    }),
  });
  const complete = await completeRes.json();
  if (!complete.ok) throw new Error("completeUploadExternal failed: " + JSON.stringify(complete));
  return complete;
}

// ────────── KV helpers ──────────

async function kvGet(key) {
  const res = await fetch(\`\${KV_URL}/get/\${encodeURIComponent(key)}\`, {
    headers: { Authorization: \`Bearer \${KV_TOKEN}\` },
  });
  const data = await res.json();
  if (!data || data.result == null) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}

async function kvSet(key, value, ttlSeconds = 30 * 24 * 60 * 60) {
  await fetch(\`\${KV_URL}/set/\${encodeURIComponent(key)}?EX=\${ttlSeconds}\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${KV_TOKEN}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

// ────────── Bootstrap (first turn only) ──────────

async function ensureLibraryCloned() {
  if (existsSync("library/INDEX.md")) {
    return; // already cloned
  }
  console.log("[bootstrap] cloning pricing library");
  if (!PAT) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");
  const cloneUrl = \`https://x-access-token:\${PAT}@\${META.libraryRepoUrl}\`;
  execFileSync("git", ["clone", cloneUrl, "library"], {
    stdio: "inherit",
  });
  // Configure identity for any commits pushed back from this sandbox
  execFileSync("git", ["-C", "library", "config", "user.email", "pricing-bot@reddy.io"], { stdio: "inherit" });
  execFileSync("git", ["-C", "library", "config", "user.name", "Reddy Pricing Bot"], { stdio: "inherit" });
}

async function commitAndPushLibrary(summary) {
  // Stage all changes under the Brand Pricing tree; anything outside is ignored.
  execFileSync("git", ["-C", "library", "add", "Brand Pricing"], { stdio: "inherit" });

  // Check if there's actually something to commit
  const statusOut = execFileSync("git", ["-C", "library", "status", "--porcelain"], { encoding: "utf-8" }).trim();
  if (!statusOut) {
    console.log("[push] no library changes to commit");
    return { pushed: false, reason: "no-changes" };
  }

  const commitMsg = \`\${summary}

thread: \${META.slackThreadTs}
turn: \${TURN_NUMBER}
sandbox: \${META.sandboxName}\`;

  execFileSync("git", ["-C", "library", "commit", "-m", commitMsg], { stdio: "inherit" });

  // Retry push a few times to handle concurrent thread collisions
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync("git", ["-C", "library", "pull", "--rebase", "origin", "main"], { stdio: "inherit" });
      execFileSync("git", ["-C", "library", "push", "origin", "main"], { stdio: "inherit" });
      console.log(\`[push] pushed on attempt \${attempt}\`);
      return { pushed: true };
    } catch (err) {
      lastErr = err;
      console.warn(\`[push] attempt \${attempt} failed:\`, err instanceof Error ? err.message : String(err));
    }
  }
  return { pushed: false, reason: "push-failed", error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

async function ensureSdkInstalled() {
  if (existsSync("node_modules/@anthropic-ai/sdk")) return;
  console.log("[bootstrap] installing @anthropic-ai/sdk");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "@anthropic-ai/sdk"], {
    stdio: "inherit",
  });
}

// ────────── Tools (executed by Claude) ──────────

const TOOLS = [
  {
    name: "list_proposals",
    description: "List all reference proposal directory names under library/Brand Pricing/.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_dir",
    description: "List the entries (files and subdirectories) of a directory inside the sandbox. Path is relative to /vercel/sandbox.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the sandbox. Path is relative to /vercel/sandbox.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file to the sandbox. Creates parent directories as needed. Overwrites if it exists.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "copy_file",
    description: "Copy a file (or all files in a directory if recursive=true) from one path to another within the sandbox.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        recursive: { type: "boolean", default: false },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "fetch_url",
    description: "Download a URL (typically a customer logo) and save the bytes to a sandbox path. Use for image URLs.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        savePath: { type: "string" },
      },
      required: ["url", "savePath"],
    },
  },
  {
    name: "compile_pdf",
    description: "Run npm install (idempotent) and npx tsx proposal.tsx inside a proposal directory to produce the PDF. Returns the absolute PDF path on success.",
    input_schema: {
      type: "object",
      properties: { proposalDir: { type: "string", description: "Directory containing proposal.tsx, e.g. library/Brand Pricing/acme-proposal" } },
      required: ["proposalDir"],
    },
  },
  {
    name: "upload_slack_pdf",
    description: "Upload a PDF file to the Slack thread. Provide a short title shown above the file in Slack.",
    input_schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        title: { type: "string" },
      },
      required: ["filePath", "title"],
    },
  },
  {
    name: "post_slack_message",
    description: "Post a text message to the Slack thread. Use Slack mrkdwn formatting. Keep messages brief.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case "list_proposals": {
      const dirs = await readdir("library/Brand Pricing");
      return dirs.filter((d) => !d.startsWith(".")).join("\\n");
    }
    case "list_dir": {
      const entries = await readdir(args.path, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\\n");
    }
    case "read_file": {
      return await readFile(args.path, "utf-8");
    }
    case "write_file": {
      await mkdir(path.dirname(args.path), { recursive: true });
      await writeFile(args.path, args.content, "utf-8");
      return \`wrote \${args.content.length} bytes to \${args.path}\`;
    }
    case "copy_file": {
      if (args.recursive) {
        await copyDir(args.from, args.to);
        return \`recursively copied \${args.from} -> \${args.to}\`;
      }
      await mkdir(path.dirname(args.to), { recursive: true });
      await copyFile(args.from, args.to);
      return \`copied \${args.from} -> \${args.to}\`;
    }
    case "fetch_url": {
      const res = await fetch(args.url);
      if (!res.ok) throw new Error(\`fetch \${args.url} -> \${res.status}\`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(path.dirname(args.savePath), { recursive: true });
      await writeFile(args.savePath, buf);
      return \`saved \${buf.length} bytes to \${args.savePath}\`;
    }
    case "compile_pdf": {
      const dir = args.proposalDir;
      if (!existsSync(path.join(dir, "package.json"))) {
        throw new Error(\`No package.json at \${dir}\`);
      }
      if (!existsSync(path.join(dir, "node_modules"))) {
        execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
      }
      execFileSync("npx", ["tsx", "proposal.tsx"], { cwd: dir, stdio: "inherit" });
      const files = await readdir(dir);
      const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
      if (!pdf) throw new Error("No PDF produced");
      return path.resolve(dir, pdf);
    }
    case "upload_slack_pdf": {
      const result = await uploadPdfToSlack(args.filePath, args.title);
      return \`uploaded \${args.filePath} as "\${args.title}"\`;
    }
    case "post_slack_message": {
      const result = await postSlackMessage(args.text);
      return result.ok ? "posted" : \`post failed: \${JSON.stringify(result)}\`;
    }
    default:
      throw new Error(\`Unknown tool: \${name}\`);
  }
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sp, dp);
    } else if (entry.isFile()) {
      await copyFile(sp, dp);
    }
  }
}

// ────────── Main agent loop ──────────

async function main() {
  await ensureLibraryCloned();
  await ensureSdkInstalled();

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const claude = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  // Load latest user turn
  const turn = JSON.parse(await readFile(\`inbox/turn-\${TURN_NUMBER}.json\`, "utf-8"));

  // Load conversation history
  const history = (await kvGet(HISTORY_KEY)) ?? [];

  // Compose the new user message — include mode label so a follow-up build/check is unambiguous
  const userContent = \`[mode=\${META.mode} turn=\${TURN_NUMBER}] \${turn.userText}\`;
  const messages = [...history, { role: "user", content: userContent }];

  let response = await claude.messages.create({
    model: "anthropic/claude-sonnet-4-6",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  let iterations = 0;
  while (response.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
    iterations++;
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(\`[tool] \${block.name} \${JSON.stringify(block.input).slice(0, 200)}\`);
      try {
        const result = await runTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(\`[tool error] \${block.name}: \${msg}\`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: \`Error: \${msg}\`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });

    response = await claude.messages.create({
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
  }

  // Persist final assistant response in history (just the text portion to keep it light)
  messages.push({ role: "assistant", content: response.content });
  const trimmedHistory = messages.slice(-30);
  await kvSet(HISTORY_KEY, trimmedHistory);

  // Build mode: commit and push any new/changed proposal files back to the library
  if (META.mode === "build") {
    try {
      const summary = \`Pricing build turn \${TURN_NUMBER} (thread \${META.slackThreadTs})\`;
      const pushResult = await commitAndPushLibrary(summary);
      if (pushResult.pushed) {
        console.log("[pricing-driver] Library changes pushed to main");
      } else if (pushResult.reason === "push-failed") {
        await postSlackMessage(\`:warning: Proposal delivered, but couldn't push to the library repo: \\\`\${pushResult.error}\\\`\`).catch(() => {});
      }
    } catch (err) {
      console.error("[pricing-driver] Library push error:", err);
      await postSlackMessage(\`:warning: Proposal delivered, but the library sync failed: \\\`\${err instanceof Error ? err.message : String(err)}\\\`\`).catch(() => {});
    }
  }

  // Reaction: complete
  await removeReaction(META.mode === "build" ? "hammer_and_wrench" : "mag");
  await setReaction("white_check_mark");

  console.log(\`[pricing-driver] Turn \${TURN_NUMBER} complete (\${iterations} tool iterations)\`);
}

main().catch(async (err) => {
  console.error("[pricing-driver] FATAL:", err);
  await postSlackMessage(\`:x: Pricing driver crashed: \\\`\${err instanceof Error ? err.message : String(err)}\\\`\`).catch(() => {});
  await removeReaction(META.mode === "build" ? "hammer_and_wrench" : "mag").catch(() => {});
  await setReaction("x").catch(() => {});
  process.exit(1);
});
`;
}
