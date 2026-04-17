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

== React-PDF layout rules (avoid recurring rendering bugs) ==
These are rules from post-hoc debugging of past proposals. Violate them only with a compelling reason.

1. **Large dollar amounts always need \`lineHeight: 1.1\`** — any Text with \`fontSize\` ≥ 20 MUST also set \`lineHeight: 1.1\`. Without it, React-PDF collapses the line box around the glyph and the descender of "$" visually overlaps the text below it. This is the most common layout bug we've hit. The proven pattern used in \`robinhood-proposal\`, \`gifthealth-proposal\`, and \`casio-proposal\` — which you should mirror:
   \`\`\`tsx
   <Text style={{ fontSize: 26, fontWeight: 700, color: C.navyDark, lineHeight: 1.1 }}>\${RATE}</Text>
   <View style={{ height: 14 }} />
   <Text style={{ fontSize: 8.5, color: C.mid }}>per agent / month</Text>
   \`\`\`
   Even with the height-14 spacer, without \`lineHeight: 1.1\` on the price the two will overlap. Always include both.

2. **Text that can wrap must have a bounded parent** — any long-form Text (feature descriptions, footnotes, disclaimers, "BYOT = Bring Your Own Transcription: …" paragraphs) must be inside a container that bounds its horizontal size. Use one of:
   - \`<Text style={{ flex: 1, ... }}>\` when inside a flex row
   - \`<Text style={{ width: "100%", ... }}>\` when in a block
   - \`<View style={{ width: "100%" }}><Text>...</Text></View>\` as wrapper
   Without a bound, React-PDF lets the text spill past the page's right margin. If you see a footnote paragraph directly under a full-width row with no wrapping View, add one.

3. **Page width is 595pt (A4) minus 32pt padding each side = 531pt usable.** Any \`<Text>\` with no parent width constraint must respect this. When in doubt, wrap in \`<View style={{ width: "100%" }}>\`.

4. **For multi-column card rows** (e.g. pricing tier cards), always use \`flexDirection: "row"\` + \`gap\` + children with \`flex: 1\` and explicit \`padding\` inside each card. Don't let fixed widths on cards cause them to overflow.

5. **Copy the typography exactly from the reference proposal you picked** — with ONE exception: if your chosen reference doesn't follow rule 1 above (no \`lineHeight\` on a ≥20pt price Text), you MUST add it. The rules in this section take priority over the reference. Gold-standard references for rendering: \`robinhood-proposal\`, \`gifthealth-proposal\`, \`casio-proposal\`. If in doubt on any layout detail, model those three rather than Tapestry/NDR/HGV.

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

// ────────── Trace + debug helpers (FIREHOSE — see CLEANUP.md) ──────────

const TRACE = [];
function traceInfo(msg, extra) {
  TRACE.push({ ts: new Date().toISOString(), kind: "info", output: msg, ...(extra || {}) });
  console.log("[info]", msg);
}

function execAndLog(label, cmd, args, opts = {}) {
  TRACE.push({ ts: new Date().toISOString(), kind: "exec", name: label, input: { cmd, args, opts: { cwd: opts.cwd, env: opts.env ? Object.keys(opts.env) : undefined } } });
  try {
    const out = execFileSync(cmd, args, { ...opts, encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
    TRACE.push({ ts: new Date().toISOString(), kind: "exec_output", name: label, exitCode: 0, stdout: String(out), stderr: "" });
    process.stdout.write(String(out));
    return String(out);
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : "";
    const stderr = err?.stderr ? String(err.stderr) : "";
    TRACE.push({
      ts: new Date().toISOString(),
      kind: "exec_output",
      name: label,
      exitCode: err?.status ?? null,
      stdout,
      stderr,
      error: err instanceof Error ? (err.stack || err.message) : String(err),
    });
    process.stderr.write(stderr || String(err));
    throw err;
  }
}

function chunkString(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

async function dumpTraceToSlack(header) {
  await postSlackMessage(header).catch(() => {});
  for (const entry of TRACE) {
    const body = "\`\`\`\\n" + JSON.stringify(entry, null, 2) + "\\n\`\`\`";
    for (const chunk of chunkString(body, 3500)) {
      await postSlackMessage(chunk).catch(() => {});
      // tiny pause so Slack preserves ordering
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

// ────────── Bootstrap (first turn only) ──────────

async function ensureLibraryCloned() {
  if (existsSync("library/INDEX.md")) {
    TRACE.push({ ts: new Date().toISOString(), kind: "bootstrap", output: "library already cloned" });
    return;
  }
  if (!PAT) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");
  const cloneUrl = \`https://x-access-token:\${PAT}@\${META.libraryRepoUrl}\`;
  // Run clone directly — don't use execAndLog here because we never want the PAT-bearing URL in TRACE.
  TRACE.push({ ts: new Date().toISOString(), kind: "bootstrap", name: "git-clone", input: { cmd: "git", args: ["clone", "https://x-access-token:***@" + META.libraryRepoUrl, "library"] } });
  try {
    const out = execFileSync("git", ["clone", cloneUrl, "library"], { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
    TRACE.push({ ts: new Date().toISOString(), kind: "bootstrap", name: "git-clone", output: String(out || ""), exitCode: 0 });
    process.stdout.write(String(out || ""));
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : "";
    const stderr = err?.stderr ? String(err.stderr) : "";
    TRACE.push({ ts: new Date().toISOString(), kind: "bootstrap", name: "git-clone", exitCode: err?.status ?? null, stdout, stderr, error: err instanceof Error ? (err.stack || err.message) : String(err) });
    throw err;
  }
  execAndLog("git-config-email", "git", ["-C", "library", "config", "user.email", "pricing-bot@reddy.io"]);
  execAndLog("git-config-name", "git", ["-C", "library", "config", "user.name", "Reddy Pricing Bot"]);
}

async function commitAndPushLibrary(summary) {
  execAndLog("git-add", "git", ["-C", "library", "add", "Brand Pricing"]);
  const statusOut = execFileSync("git", ["-C", "library", "status", "--porcelain"], { encoding: "utf-8" }).trim();
  TRACE.push({ ts: new Date().toISOString(), kind: "exec_output", name: "git-status", stdout: statusOut, exitCode: 0 });
  if (!statusOut) {
    traceInfo("[push] no library changes to commit");
    return { pushed: false, reason: "no-changes" };
  }

  const commitMsg = \`\${summary}

thread: \${META.slackThreadTs}
turn: \${TURN_NUMBER}
sandbox: \${META.sandboxName}\`;

  execAndLog("git-commit", "git", ["-C", "library", "commit", "-m", commitMsg]);

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execAndLog(\`git-pull-rebase-attempt-\${attempt}\`, "git", ["-C", "library", "pull", "--rebase", "origin", "main"]);
      execAndLog(\`git-push-attempt-\${attempt}\`, "git", ["-C", "library", "push", "origin", "main"]);
      traceInfo(\`[push] pushed on attempt \${attempt}\`);
      return { pushed: true };
    } catch (err) {
      lastErr = err;
      traceInfo(\`[push] attempt \${attempt} failed: \${err instanceof Error ? err.message : String(err)}\`);
    }
  }
  return { pushed: false, reason: "push-failed", error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

async function ensureSdkInstalled() {
  if (existsSync("node_modules/@anthropic-ai/sdk")) {
    TRACE.push({ ts: new Date().toISOString(), kind: "bootstrap", output: "sdk already installed" });
    return;
  }
  execAndLog("npm-install-sdk", "npm", ["install", "--no-audit", "--no-fund", "@anthropic-ai/sdk"]);
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

const turnState = { pdfUploaded: false, slackResponded: false };

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
        execAndLog("npm-install-proposal", "npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
      }
      execAndLog("npx-tsx-render", "npx", ["tsx", "proposal.tsx"], { cwd: dir });
      const files = await readdir(dir);
      const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
      if (!pdf) throw new Error("No PDF produced");
      return path.resolve(dir, pdf);
    }
    case "upload_slack_pdf": {
      await uploadPdfToSlack(args.filePath, args.title);
      turnState.pdfUploaded = true;
      turnState.slackResponded = true;
      return \`uploaded \${args.filePath} as "\${args.title}"\`;
    }
    case "post_slack_message": {
      const result = await postSlackMessage(args.text);
      turnState.slackResponded = true;
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

  let response = await claude.messages.stream({
    model: "anthropic/claude-opus-4-7",
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  }).finalMessage();

  let iterations = 0;
  traceInfo(\`agent initial response stop_reason=\${response.stop_reason}\`, { iteration: 0 });
  const textBlocks0 = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\\n");
  if (textBlocks0) TRACE.push({ ts: new Date().toISOString(), kind: "info", iteration: 0, name: "assistant_text", output: textBlocks0 });

  while (response.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
    iterations++;
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      TRACE.push({ ts: new Date().toISOString(), kind: "tool_call", iteration: iterations, name: block.name, input: block.input });
      console.log(\`[tool] \${block.name} \${JSON.stringify(block.input).slice(0, 200)}\`);
      try {
        const result = await runTool(block.name, block.input);
        const contentStr = typeof result === "string" ? result : JSON.stringify(result);
        TRACE.push({ ts: new Date().toISOString(), kind: "tool_result", iteration: iterations, name: block.name, output: contentStr });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: contentStr,
        });
      } catch (err) {
        const msg = err instanceof Error ? (err.stack || err.message) : String(err);
        TRACE.push({ ts: new Date().toISOString(), kind: "tool_error", iteration: iterations, name: block.name, input: block.input, error: msg });
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

    response = await claude.messages.stream({
      model: "anthropic/claude-opus-4-7",
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }).finalMessage();
    const textBlocks = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\\n");
    traceInfo(\`agent response stop_reason=\${response.stop_reason} tool_uses=\${(response.content || []).filter((b) => b.type === "tool_use").length}\`, { iteration: iterations });
    if (textBlocks) TRACE.push({ ts: new Date().toISOString(), kind: "info", iteration: iterations, name: "assistant_text", output: textBlocks });
  }

  // Persist final assistant response in history (just the text portion to keep it light)
  messages.push({ role: "assistant", content: response.content });
  const trimmedHistory = messages.slice(-30);
  await kvSet(HISTORY_KEY, trimmedHistory);

  // Build mode: only commit + push if a PDF was actually uploaded this turn.
  // Otherwise the agent failed mid-build and we don't want partial state in the library.
  let buildOk = false;
  if (META.mode === "build") {
    if (turnState.pdfUploaded) {
      buildOk = true;
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
    } else {
      // Discard partial work so the next turn starts from a clean tree.
      try {
        execAndLog("git-checkout-reset", "git", ["-C", "library", "checkout", "--", "."]);
        execAndLog("git-clean-fd", "git", ["-C", "library", "clean", "-fd"]);
      } catch {}
    }
  }

  // Persist FULL trace to KV for post-hoc inspection
  const TRACE_KEY = THREAD_KEY + \`:trace:\${TURN_NUMBER}\`;
  await kvSet(TRACE_KEY, TRACE).catch((err) => {
    console.error("[trace] kvSet failed:", err);
  });

  // Always make sure Slack got a final message — agent might have stopped without posting one.
  if (!turnState.slackResponded) {
    const header = [
      \`:x: *\${META.mode === "build" ? "Build failed." : "Check failed."}*\`,
      \`iter=\${iterations}/\${MAX_ITERATIONS} · sandbox=\\\`\${META.sandboxName}\\\` · trace=\\\`\${TRACE_KEY}\\\`\`,
      \`Dashboard: https://vercel.com/reddyio/gtm/observability/sandboxes\`,
      \`Trace entries: \${TRACE.length} (dumping below)\`,
    ].join("\\n");
    await dumpTraceToSlack(header);
  }

  // Reaction: complete (vs. failure)
  await removeReaction(META.mode === "build" ? "hammer_and_wrench" : "mag");
  const ok = META.mode === "build" ? buildOk : turnState.slackResponded;
  await setReaction(ok ? "white_check_mark" : "x");

  console.log(\`[pricing-driver] Turn \${TURN_NUMBER} complete (\${iterations} tool iterations, ok=\${ok})\`);
}

main().catch(async (err) => {
  console.error("[pricing-driver] FATAL:", err);
  TRACE.push({
    ts: new Date().toISOString(),
    kind: "fatal",
    error: err instanceof Error ? (err.stack || err.message) : String(err),
  });
  const TRACE_KEY = THREAD_KEY + \`:trace:\${TURN_NUMBER}\`;
  await kvSet(TRACE_KEY, TRACE).catch(() => {});
  const header = [
    \`:rotating_light: *Pricing driver crashed*\`,
    \`sandbox=\\\`\${META.sandboxName}\\\` · trace=\\\`\${TRACE_KEY}\\\` · entries=\${TRACE.length}\`,
    \`Error: \\\`\${err instanceof Error ? err.message : String(err)}\\\`\`,
  ].join("\\n");
  await dumpTraceToSlack(header).catch(() => {});
  await removeReaction(META.mode === "build" ? "hammer_and_wrench" : "mag").catch(() => {});
  await setReaction("x").catch(() => {});
  process.exit(1);
});
`;
}
