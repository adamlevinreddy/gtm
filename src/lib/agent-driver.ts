export type AgentMeta = {
  sandboxName: string;
  slackChannel: string;
  slackThreadTs: string;
  slackUser: string | null;
  threadKey: string;
  sessionId: string;
  libraryRepoUrl: string;
  isFirstTurn: boolean;
  turnCount: number;
};

const MAX_TURNS = 80;

const APPEND_SYSTEM_PROMPT = `You are **Reddy-GTM**, a go-to-market agent for Reddy (a contact-center AI training platform) running in a Vercel Sandbox as a Claude Code session, reachable from a Slack thread.

## Environment
- Your working directory \`/vercel/sandbox/workspace\` is a clone of github.com/ReddySolutions/pricing — the Reddy GTM library. It contains:
  - \`.claude/skills/\` — your domain skills. At minimum: \`pricing\`, \`decks\`, \`legal\`, \`react-pdf\`. Read each SKILL.md to decide which applies to the current turn.
  - \`design-system/\` — the Reddy visual design tokens (FlechaS + Inter fonts, color palette, component conventions). Embedded in every PDF we generate.
  - \`PRICING_PATTERNS.md\`, \`PRICING_ASSUMPTIONS.md\`, \`INDEX.md\` — pricing precedent library.
  - \`Brand Pricing/{customer}-proposal/\` — 15+ react-pdf proposal projects.
  - \`BPO Pricing/\` — HTML proposals for BPO partnerships.
- You have \`Read\`, \`Write\`, \`Edit\`, \`Bash\`, \`Glob\`, \`Grep\`, \`WebFetch\`, \`TodoWrite\`, \`Task\` tools available, plus the \`reddy-gtm\` MCP server with three Slack-specific tools:
  - \`post_slack_message(text)\` — reply in the current thread (mrkdwn)
  - \`upload_slack_pdf(filePath, title)\` — attach a file
  - \`fetch_url(url, savePath)\` — download a URL (the built-in WebFetch doesn't save binaries; use this for logos/images)

## How you decide what to do
The user is talking to you from Slack. Infer their intent from the message content and the thread history. Pick the right skill:
- Pricing questions ("what should I quote Acme at 500 agents BYOT?") → read \`.claude/skills/pricing/SKILL.md\`, answer citing precedent.
- Pricing proposals ("build me a deck for Vistra, 250 agents, 2-yr BYOT, Tapestry layout") → same skill, build + compile PDF + upload.
- Deck requests ("make me a QBR deck for Grubhub") → read \`.claude/skills/decks/SKILL.md\`.
- Legal requests ("review these redlines vs precedent") → read \`.claude/skills/legal/SKILL.md\`.
- Ambiguous ("thinking about pricing for Acme") → ask ONE clarifying question via \`post_slack_message\` before committing to a path.

## Conversation style
- Keep replies concise; use Slack mrkdwn (*bold*, _italic_, \`code\`, > quotes, bullet points). No Markdown headings (\`#\`) — Slack doesn't render them as headings.
- When you start a multi-step build, post a brief acknowledgment via \`post_slack_message\` ("Reading the Vistra context, picking a reference…") so the user knows you're working. Don't narrate every tool call.
- When done, post a single concluding \`post_slack_message\` summarizing what you did + what you'd like the user to tell you next.
- For proposal/deck builds: the PDF is delivered via \`upload_slack_pdf\`; the concluding message invites iteration ("reply to swap colors, adjust rates, etc.").
- Cite precedent by name when you make pricing decisions ("I priced this at $42/agent BYOT — Vistra 2-yr was $38 at the same scale, Cincinnati 2-yr hosted was $60; $42 lands between them").

## After a successful build
If you wrote new files under \`Brand Pricing/\` and produced a PDF via \`upload_slack_pdf\`, commit and push them back to the library so future turns (and other users) benefit — use Bash: \`git -C /vercel/sandbox/workspace add Brand\\ Pricing && git commit -m "..." && git pull --rebase && git push\`. Skip the push if nothing material changed, or if the build failed mid-stream.

## What NOT to do
- Don't ask permission before using Read/Edit/Bash in the workspace — you have full authority.
- Don't create a new proposal directory on every iteration; update the existing one for the active thread.
- Don't fabricate competitor pricing or historical Reddy deals. Cite what's actually in the library.
- Don't post internal reasoning to Slack; keep that in thinking blocks.
`;

export function buildAgentDriver(meta: AgentMeta): string {
  return `// Auto-generated Reddy-GTM driver — do not edit by hand
// Sandbox: ${meta.sandboxName} · Turn: ${meta.turnCount} · Session: ${meta.sessionId}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const META = ${JSON.stringify(meta, null, 2)};
const TURN_NUMBER = parseInt(process.argv[2] ?? "${meta.turnCount}", 10);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const SLACK_THREAD_TS = process.env.SLACK_THREAD_TS;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PAT = process.env.PRICING_LIBRARY_GITHUB_PAT;
const THREAD_KEY = process.env.AGENT_THREAD_KEY;
const SESSION_ID = process.env.AGENT_SESSION_ID;
const TRACE_KEY = THREAD_KEY + ":trace:" + TURN_NUMBER;

// ────────── Slack helpers ──────────
async function slackApi(method, body) {
  const res = await fetch(\`https://slack.com/api/\${method}\`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: "Bearer " + SLACK_TOKEN },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function postSlackMessage(text) {
  return slackApi("chat.postMessage", { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD_TS, text });
}
async function setReaction(name) {
  return slackApi("reactions.add", { channel: SLACK_CHANNEL, name, timestamp: SLACK_THREAD_TS }).catch(() => null);
}
async function removeReaction(name) {
  return slackApi("reactions.remove", { channel: SLACK_CHANNEL, name, timestamp: SLACK_THREAD_TS }).catch(() => null);
}
async function uploadPdfToSlack(filePath, title) {
  const buf = await readFile(filePath);
  const name = path.basename(filePath);
  const urlRes = await fetch(\`https://slack.com/api/files.getUploadURLExternal?\${new URLSearchParams({ filename: name, length: String(buf.length) })}\`, {
    method: "POST", headers: { Authorization: "Bearer " + SLACK_TOKEN },
  });
  const u = await urlRes.json();
  if (!u.ok) throw new Error("getUploadURLExternal failed: " + JSON.stringify(u));
  const putRes = await fetch(u.upload_url, { method: "POST", body: buf, headers: { "Content-Type": "application/pdf" } });
  if (!putRes.ok) throw new Error("upload PUT failed: " + putRes.status);
  const complete = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: "Bearer " + SLACK_TOKEN },
    body: JSON.stringify({ files: [{ id: u.file_id, title: title || name }], channel_id: SLACK_CHANNEL, thread_ts: SLACK_THREAD_TS }),
  });
  const c = await complete.json();
  if (!c.ok) throw new Error("completeUploadExternal failed: " + JSON.stringify(c));
  return c;
}

// ────────── KV helpers ──────────
async function kvGet(key) {
  const res = await fetch(\`\${KV_URL}/get/\${encodeURIComponent(key)}\`, { headers: { Authorization: "Bearer " + KV_TOKEN } });
  const d = await res.json();
  if (!d || d.result == null) return null;
  try { return JSON.parse(d.result); } catch { return d.result; }
}
async function kvSet(key, value, ttlSeconds = 30 * 24 * 60 * 60) {
  await fetch(\`\${KV_URL}/set/\${encodeURIComponent(key)}?EX=\${ttlSeconds}\`, {
    method: "POST", headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

// ────────── TRACE (firehose) ──────────
const TRACE = [];
function trace(kind, payload) { TRACE.push({ ts: new Date().toISOString(), kind, ...payload }); }
function chunkString(s, n) { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }
async function dumpTraceToSlack(header) {
  await postSlackMessage(header).catch(() => {});
  for (const entry of TRACE) {
    const body = "\\\`\\\`\\\`\\n" + JSON.stringify(entry, null, 2).slice(0, 30000) + "\\n\\\`\\\`\\\`";
    for (const c of chunkString(body, 3500)) {
      await postSlackMessage(c).catch(() => {});
      await new Promise(r => setTimeout(r, 120));
    }
  }
}

// ────────── Bootstrap ──────────
function execLog(label, cmd, args, opts) {
  trace("exec", { label, cmd, args });
  try {
    const out = execFileSync(cmd, args, { ...opts, encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
    trace("exec_output", { label, exitCode: 0, stdout: String(out || "") });
    process.stdout.write(String(out || ""));
    return String(out || "");
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : "";
    const stdout = err?.stdout ? String(err.stdout) : "";
    trace("exec_output", { label, exitCode: err?.status ?? null, stdout, stderr, error: err?.message });
    process.stderr.write(stderr || String(err));
    throw err;
  }
}

async function ensureLibraryCloned() {
  if (existsSync("workspace/INDEX.md")) { trace("bootstrap", { output: "workspace already present" }); return; }
  if (!PAT) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");
  trace("bootstrap", { output: "cloning library into workspace/" });
  const cloneUrl = \`https://x-access-token:\${PAT}@\${META.libraryRepoUrl}\`;
  execFileSync("git", ["clone", cloneUrl, "workspace"], { stdio: "inherit" });
  execFileSync("git", ["-C", "workspace", "config", "user.email", "reddy-gtm-bot@reddy.io"], { stdio: "inherit" });
  execFileSync("git", ["-C", "workspace", "config", "user.name", "Reddy-GTM Bot"], { stdio: "inherit" });
}

async function ensureSdkInstalled() {
  if (existsSync("node_modules/@anthropic-ai/claude-agent-sdk")) { trace("bootstrap", { output: "sdk present" }); return; }
  execLog("npm-init", "npm", ["init", "-y"]);
  execLog("npm-install-sdk", "npm", ["install", "--no-audit", "--no-fund", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-code", "zod"]);
}

// ────────── Agent SDK invocation ──────────
async function main() {
  await ensureLibraryCloned();
  await ensureSdkInstalled();

  const { query, createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");

  const turn = JSON.parse(await readFile(\`inbox/turn-\${TURN_NUMBER}.json\`, "utf-8"));
  trace("info", { output: "turn payload: " + JSON.stringify(turn) });

  // Domain MCP server — Slack + fetch_url. PDF compile uses plain Bash.
  const reddyMcp = createSdkMcpServer({
    name: "reddy-gtm",
    version: "0.1.0",
    tools: [
      tool(
        "post_slack_message",
        "Post a mrkdwn message to the current Slack thread. Use for all user-visible replies.",
        { text: z.string().describe("The message text (Slack mrkdwn).") },
        async ({ text }) => {
          const r = await postSlackMessage(text);
          trace("tool_call", { name: "post_slack_message", textPreview: text.slice(0, 200), ok: r?.ok });
          return { content: [{ type: "text", text: r?.ok ? "posted" : "post failed: " + JSON.stringify(r) }] };
        },
      ),
      tool(
        "upload_slack_pdf",
        "Upload a PDF file from the sandbox filesystem to the current Slack thread. The file will appear inline.",
        {
          filePath: z.string().describe("Absolute or workspace-relative path to the PDF."),
          title: z.string().describe("Short title shown above the file in Slack."),
        },
        async ({ filePath, title }) => {
          const abs = path.isAbsolute(filePath) ? filePath : path.join("/vercel/sandbox", filePath);
          await uploadPdfToSlack(abs, title);
          trace("tool_call", { name: "upload_slack_pdf", filePath: abs, title });
          return { content: [{ type: "text", text: "uploaded " + path.basename(abs) + " as '" + title + "'" }] };
        },
      ),
      tool(
        "fetch_url",
        "Download an HTTP(S) URL and save the bytes to a sandbox path. Use for customer logos and any remote binary asset.",
        {
          url: z.string().url(),
          savePath: z.string().describe("Path inside the sandbox to save the file to."),
        },
        async ({ url, savePath }) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(\`fetch \${url} -> \${res.status}\`);
          const abs = path.isAbsolute(savePath) ? savePath : path.join("/vercel/sandbox", savePath);
          mkdirSync(path.dirname(abs), { recursive: true });
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(abs, buf);
          trace("tool_call", { name: "fetch_url", url, savePath: abs, bytes: buf.length });
          return { content: [{ type: "text", text: \`saved \${buf.length} bytes to \${abs}\` }] };
        },
      ),
    ],
  });

  const userContent = \`[turn \${TURN_NUMBER}] \${turn.userText}\`;

  const queryOptions = {
    model: "claude-opus-4-7",
    systemPrompt: { type: "preset", preset: "claude_code", append: ${JSON.stringify(APPEND_SYSTEM_PROMPT)} },
    cwd: "/vercel/sandbox/workspace",
    additionalDirectories: ["/vercel/sandbox"],
    settingSources: ["project"],
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "TodoWrite", "Task",
      "mcp__reddy-gtm__post_slack_message",
      "mcp__reddy-gtm__upload_slack_pdf",
      "mcp__reddy-gtm__fetch_url",
    ],
    mcpServers: { "reddy-gtm": reddyMcp },
    thinking: { type: "adaptive" },
    effort: "xhigh",
    maxTurns: ${MAX_TURNS},
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_AGENT_SDK_CLIENT_APP: "reddy-gtm/0.1",
    },
  };

  // On the first turn start a fresh session with our chosen UUID; subsequent
  // turns resume that session so the agent carries context across Slack turns.
  if (META.isFirstTurn) {
    queryOptions.sessionId = SESSION_ID;
  } else {
    queryOptions.resume = SESSION_ID;
  }

  trace("info", { output: "starting query", isFirstTurn: META.isFirstTurn, sessionId: SESSION_ID });

  const q = query({ prompt: userContent, options: queryOptions });

  let postedAnything = false;
  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") trace("agent_tool_use", { name: block.name, input: block.input });
        else if (block.type === "text") trace("assistant_text", { output: block.text });
        else if (block.type === "thinking") trace("assistant_thinking", { output: block.thinking || "" });
      }
    } else if (message.type === "user" && message.message?.content) {
      // tool_result blocks
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          trace("agent_tool_result", {
            tool_use_id: block.tool_use_id,
            is_error: block.is_error,
            content: typeof block.content === "string" ? block.content.slice(0, 2000) : JSON.stringify(block.content).slice(0, 2000),
          });
          if (!block.is_error) postedAnything = true;
        }
      }
    } else if (message.type === "result") {
      trace("result", {
        subtype: message.subtype,
        is_error: message.is_error,
        num_turns: message.num_turns,
        total_cost_usd: message.total_cost_usd,
        duration_ms: message.duration_ms,
      });
    } else {
      trace("stream_" + message.type, { raw: JSON.stringify(message).slice(0, 1000) });
    }
  }

  await kvSet(TRACE_KEY, TRACE).catch(() => {});

  // Reactions: we always react with something after the run.
  await removeReaction("speech_balloon");
  await setReaction(postedAnything ? "white_check_mark" : "x");

  if (!postedAnything) {
    // Agent never posted via MCP — dump the firehose so we can debug.
    await dumpTraceToSlack(\`:warning: Reddy-GTM finished without replying. Trace key: \\\`\${TRACE_KEY}\\\`. Dumping below.\`).catch(() => {});
  }

  console.log(\`[agent-driver] Turn \${TURN_NUMBER} complete\`);
}

main().catch(async (err) => {
  console.error("[agent-driver] FATAL:", err);
  trace("fatal", { error: err instanceof Error ? (err.stack || err.message) : String(err) });
  await kvSet(TRACE_KEY, TRACE).catch(() => {});
  const header = \`:rotating_light: *Reddy-GTM driver crashed* · sandbox=\\\`\${META.sandboxName}\\\` · trace=\\\`\${TRACE_KEY}\\\`\\nError: \\\`\${err instanceof Error ? err.message : String(err)}\\\`\`;
  await dumpTraceToSlack(header).catch(() => {});
  await removeReaction("speech_balloon").catch(() => {});
  await setReaction("x").catch(() => {});
  process.exit(1);
});
`;
}
