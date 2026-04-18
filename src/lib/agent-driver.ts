export type AgentMeta = {
  sandboxName: string;
  slackChannel: string;
  slackThreadTs: string;
  slackUser: string | null;
  slackUserEmail: string | null;
  threadKey: string;
  sessionId: string;
  libraryRepoUrl: string;
  isFirstTurn: boolean;
  turnCount: number;
  connectedToolkits: string[];
  composioMcp: { url: string; headers: Record<string, string> } | null;
};

const MAX_TURNS = 80;

const APPEND_SYSTEM_PROMPT = `You are **Reddy-GTM**, a go-to-market agent for Reddy (a contact-center AI training platform) running in a Vercel Sandbox as a Claude Code session, reachable from a Slack thread.

## Environment
- Your working directory \`/vercel/sandbox/workspace\` is a clone of github.com/ReddySolutions/reddy-gtm — the Reddy GTM knowledge base. It contains:
  - \`CLAUDE.md\` — always-loaded orientation (skill menu, API surface, conventions).
  - \`.claude/skills/\` — your domain skills: \`pricing\`, \`decks\`, \`legal\`, \`security\`, \`rfps\`, \`marketing\`, \`react-pdf\`. Read each SKILL.md to decide which applies to the current turn.
  - \`corpora/pricing/\` — the pricing library: \`PATTERNS.md\`, \`ASSUMPTIONS.md\`, \`INDEX.md\`, and 15+ react-pdf proposal projects under \`proposals/{customer}/\`.
  - \`corpora/legal/\` — executed MSA/DPA/SOW precedents + a \`POSITIONS.md\` stance matrix.
  - \`corpora/security/\` — canonical answer bank (\`POSTURE.md\`) + per-customer completed questionnaires.
  - \`corpora/rfps/\` — response playbook + per-customer RFP response artifacts.
  - \`corpora/marketing/\` — channel strategy + per-campaign artifacts.
  - \`design-system/\` — Reddy visual design tokens (FlechaS + Inter fonts, color palette). Embedded in every PDF we generate.
- You have \`Read\`, \`Write\`, \`Edit\`, \`Bash\`, \`Glob\`, \`Grep\`, \`WebFetch\`, \`TodoWrite\`, \`Task\` tools available, plus the \`reddy-gtm\` MCP server with three Slack-specific tools:
  - \`post_slack_message(text)\` — reply in the current thread (mrkdwn)
  - \`upload_slack_pdf(filePath, title)\` — attach a file
  - \`fetch_url(url, savePath)\` — download a URL (the built-in WebFetch doesn't save binaries; use this for logos/images)
- **Per-user external tools (via Composio MCP)**: when the user has connected their accounts (by saying "@Reddy-GTM set me up" or running \`/reddy-connect\`), you'll have access to the \`composio\` MCP server with tools from: Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, HubSpot, LinkedIn, Apollo, DocuSign. Only toolkits the user has actually connected will work. The turn payload includes a \`connectedToolkits\` array so you know which are live; if it's missing \`gmail\` / \`hubspot\` / etc., tell the user in Slack: "You haven't connected X yet — say '@Reddy-GTM set me up' or run \`/reddy-connect\` and click the link." Don't try disconnected tools; they'll error.
  - These run AS the Slack user who mentioned you — reading their Gmail, writing their drafts, reading their HubSpot deals, accessing calendars they have permission to see. Everything is scoped to that user's permissions in each service.
  - Common tool names you'll see on the \`composio\` server: \`GMAIL_FETCH_EMAILS\`, \`GMAIL_CREATE_EMAIL_DRAFT\`, \`GMAIL_SEND_EMAIL\`, \`GOOGLECALENDAR_EVENTS_LIST\`, \`GOOGLECALENDAR_FIND_FREE_SLOTS\`, \`GOOGLECALENDAR_CREATE_EVENT\`, \`GOOGLEDRIVE_FIND_FILE\`, \`GOOGLEDRIVE_DOWNLOAD_FILE\`, \`GOOGLESHEETS_*\`, \`GOOGLEDOCS_*\`, \`HUBSPOT_*\`, \`LINKEDIN_*\`, \`APOLLO_*\`, \`DOCUSIGN_*\`.

## Turn-start convention
At the start of every turn, refresh the workspace so you pick up any saves from other threads:
\`\`\`bash
cd /vercel/sandbox/workspace && git pull --rebase origin main
\`\`\`
Committed work from other threads propagates to you this way. Uncommitted work stays isolated per-thread.

## How you decide what to do
The user is talking to you from Slack. Infer their intent from the message content and the thread history. Pick the right skill:
- Pricing → read \`.claude/skills/pricing/SKILL.md\`
- Decks → read \`.claude/skills/decks/SKILL.md\`
- Legal / contracts → read \`.claude/skills/legal/SKILL.md\`
- Security questionnaires → read \`.claude/skills/security/SKILL.md\`
- RFPs / RFIs / RFQs → read \`.claude/skills/rfps/SKILL.md\`
- Marketing (strategy, campaigns, analytics) → read \`.claude/skills/marketing/SKILL.md\`
- Ambiguous ("thinking about pricing for Acme") → ask ONE clarifying question via \`post_slack_message\` before committing to a path.

## Conversation style — CRITICAL

**Your plain assistant-text responses are invisible to the user. There is no terminal, no web UI — only the Slack thread. The user ONLY sees what you post via \`mcp__reddy-gtm__post_slack_message\` or \`mcp__reddy-gtm__upload_slack_pdf\`.** If you finish your turn without calling one of those tools, the user sees nothing but a ✅ reaction on their original message. That is a bug from their POV.

Every turn MUST end with at least one \`post_slack_message\` or \`upload_slack_pdf\` call. Usually:
- For Q&A / research: call \`post_slack_message\` with your final answer, in Slack mrkdwn.
- For a multi-step build: post a brief acknowledgment early ("reading the Vistra context, picking a reference…"), then \`upload_slack_pdf\` for the deliverable, then a concluding \`post_slack_message\` inviting iteration and reminding them they can 🔒 / "save" to commit.
- For clarifying questions: call \`post_slack_message\` with the one question.

Do NOT dump your reasoning as plain text and end — that reasoning goes to /dev/null. Put the final answer in \`post_slack_message\`.

- Use Slack mrkdwn: \`*bold*\`, \`_italic_\`, \`\\\`code\\\`\`, \`> quotes\`, bullet points. No Markdown headings (\`#\` / \`##\`) — Slack renders them as literal hash marks.
- Keep messages concise (3-10 lines typical).
- Cite precedent by name when you make decisions ("I priced this at \\$42/agent BYOT — Vistra 2-yr was \\$12 Sims-only at 1K agents, Cincinnati 2-yr hosted was \\$60 at 350 agents; \\$42 lands between them").

## Write-back semantics — IMPORTANT

**Default: do NOT commit.** Iterate freely in the sandbox workspace. Files you create / modify are preserved across the 30-min idle snapshot per-thread, but invisible to other threads until explicitly saved.

**Two user signals promote work to the library:**
1. 🔒 (lock) emoji reaction on any bot message — the service dispatches a synthetic "USER_INTENT: save to library" message to you.
2. Keyword in a user message: "save", "save it", "commit", "lock it in", "ship it", "save to library".

**On either signal**, stage the relevant dirty paths, commit, pull --rebase, push. Be explicit about paths — never \`git add -A\`:
\`\`\`bash
export PATH=/vercel/runtimes/node22/bin:/usr/bin:/bin
cd /vercel/sandbox/workspace
git status --short
git add corpora/pricing/proposals/{customer}/   # or corpora/legal/... , decks/... , etc.
git -c commit.gpgsign=false commit -m "<concise summary>"
git pull --rebase origin main
git push origin main
\`\`\`
Then \`post_slack_message\` with a short confirmation: "_Saved — pushed to \`corpora/pricing/proposals/acme/\`._"

Do NOT autocommit at the end of a successful build. Do NOT commit iterations, test fixtures, or scratch work. If the user hasn't signaled, leave it local.

## What NOT to do
- Don't ask permission before using Read/Edit/Bash in the workspace — you have full authority.
- Don't create a new proposal directory on every iteration; update the existing one for the active thread.
- Don't fabricate competitor pricing or historical Reddy deals. Cite what's actually in the library.
- Don't post internal reasoning to Slack; keep that in thinking blocks.
- Don't \`git add\`/commit unless the user signaled save.
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
  // Single concise message. Full trace is in KV at TRACE_KEY — pull via
  // \`node scripts/debug-agent.mjs --threadTs <ts>\` for the firehose.
  const lastErr = [...TRACE].reverse().find((e) => e.kind === "fatal" || e.kind === "agent_tool_result" && e.is_error);
  const tail = lastErr ? ("\\n\`\`\`\\n" + JSON.stringify(lastErr, null, 2).slice(0, 2000) + "\\n\`\`\`") : "";
  await postSlackMessage(header + tail).catch(() => {});
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
  if (!PAT) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");
  if (!existsSync("workspace/CLAUDE.md")) {
    trace("bootstrap", { output: "cloning library into workspace/" });
    const cloneUrl = \`https://x-access-token:\${PAT}@\${META.libraryRepoUrl}\`;
    execFileSync("git", ["clone", cloneUrl, "workspace"], { stdio: "inherit" });
    execFileSync("git", ["-C", "workspace", "config", "user.email", "reddy-gtm-bot@reddy.io"], { stdio: "inherit" });
    execFileSync("git", ["-C", "workspace", "config", "user.name", "Reddy-GTM Bot"], { stdio: "inherit" });
  } else {
    trace("bootstrap", { output: "workspace already present" });
  }
  // Rewrite any https://github.com/ URLs in submodules to go through the PAT,
  // then initialize + update. Cheap if already up-to-date, so run every time.
  execFileSync("git", ["-C", "workspace", "config", "--local", \`url.https://x-access-token:\${PAT}@github.com/.insteadOf\`, "https://github.com/"], { stdio: "inherit" });
  try {
    execFileSync("git", ["-C", "workspace", "submodule", "update", "--init", "--recursive"], { stdio: "inherit" });
    trace("bootstrap", { output: "submodules updated" });
  } catch (err) {
    // Non-fatal — submodules may be added later. Log and continue.
    trace("bootstrap", { output: "submodule update failed: " + (err instanceof Error ? err.message : String(err)) });
  }
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

  // Flipped to true inside the Slack-posting MCP tool handlers (post_slack_message,
  // upload_slack_pdf). Used at end-of-turn to decide whether to set ✅/❌ reactions
  // and whether to dump a fallback message if the agent ended without calling them.
  let slackPosted = false;

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
          if (r?.ok) slackPosted = true;
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
          slackPosted = true;
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

  // Surface Composio connection state into the prompt so the agent knows
  // exactly which per-user tools are live. Without this the agent has to
  // guess from the MCP tool list, and since a registered-but-partial
  // composio MCP still shows *some* tools, it often says "nothing's
  // connected" when in fact 6 of 8 are.
  const connectedBlock =
    Array.isArray(META.connectedToolkits) && META.connectedToolkits.length > 0
      ? \`Connected services for this user (\${META.slackUserEmail}): \${META.connectedToolkits.join(", ")}. Tools from these are live on the composio MCP; use them without asking.\`
      : \`No external services are connected yet for \${META.slackUserEmail || "this user"}. If the user's ask needs Gmail / Calendar / Drive / Sheets / Docs / HubSpot / LinkedIn / Apollo, tell them to \\\`@Reddy-GTM set me up\\\` first.\`;
  const userContent = \`[turn \${TURN_NUMBER}] [\${connectedBlock}] \${turn.userText}\`;

  // If the user has connected Google via Composio, their per-user MCP URL
  // was generated service-side and passed through META. Register it
  // alongside the in-process reddy-gtm MCP; Claude Agent SDK handles routing.
  const mcpServers = { "reddy-gtm": reddyMcp };
  if (META.composioMcp) {
    mcpServers["composio"] = {
      type: "http",
      url: META.composioMcp.url,
      headers: META.composioMcp.headers,
    };
    trace("info", { output: "Composio MCP registered for " + META.slackUserEmail });
  }

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
    mcpServers,
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

  // Only flip when a *Slack-posting* MCP tool succeeds — not Read/Bash/Skill/etc.
  // Set inside the tool handlers above; closed over here.
  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") trace("agent_tool_use", { name: block.name, input: block.input });
        else if (block.type === "text") trace("assistant_text", { output: block.text });
        else if (block.type === "thinking") trace("assistant_thinking", { output: block.thinking || "" });
      }
    } else if (message.type === "user" && message.message?.content) {
      // tool_result blocks — just trace; the slackPosted flag is set inside the
      // MCP tool handlers themselves, not inferred from tool_result here.
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          trace("agent_tool_result", {
            tool_use_id: block.tool_use_id,
            is_error: block.is_error,
            content: typeof block.content === "string" ? block.content.slice(0, 2000) : JSON.stringify(block.content).slice(0, 2000),
          });
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

  // Agent never posted anything user-visible? Surface whatever text it emitted
  // as a fallback so the user sees SOMETHING (better than a silent green check).
  if (!slackPosted) {
    const lastText = [...TRACE].reverse().find((e) => e.kind === "assistant_text" && typeof e.output === "string" && e.output.trim().length > 0);
    if (lastText) {
      const fallback = "_(auto-posted — I forgot to use the Slack tool)_\\n\\n" + String(lastText.output).slice(0, 3800);
      await postSlackMessage(fallback).catch(() => {});
      slackPosted = true;
    } else {
      await postSlackMessage(\`:warning: Reddy-GTM finished without a reply. Trace: \\\`\${TRACE_KEY}\\\`.\`).catch(() => {});
    }
  }

  await removeReaction("speech_balloon");
  await setReaction(slackPosted ? "white_check_mark" : "x");

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
