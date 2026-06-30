#!/usr/bin/env node
// Debug harness for the new /api/agent route (Reddy-GTM agent).
//
// Usage:
//   vercel env pull .env.local --environment=development
//   set -a && source .env.local && set +a
//   node scripts/debug-agent.mjs --text "build a pricing proposal for Acme, 500 agents, BYOT"
//
// Optional flags:
//   --text "..."          The user message. Required.
//   --threadTs <ts>       Reuse an existing thread. Default: generate a fresh one.
//   --baseUrl <url>       Default https://gtm-jet.vercel.app (override for preview).
//   --channel <cid>       Slack channel. Default C0APM9JLAFN (#sales-testing).
//   --follow              Stream live command logs while the sandbox runs.

import { Sandbox } from "@vercel/sandbox";
import { setTimeout as sleep } from "node:timers/promises";

function argv(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
function required(env) {
  if (!process.env[env]) {
    console.error(`[harness] missing ${env} — run \`vercel env pull .env.local --environment=development && set -a && source .env.local && set +a\``);
    process.exit(2);
  }
  return process.env[env];
}

const TEXT = argv("text");
if (!TEXT || typeof TEXT !== "string") {
  console.error("[harness] --text required");
  process.exit(2);
}
const BASE_URL = argv("baseUrl", "https://gtm-jet.vercel.app");
const CHANNEL = argv("channel", "C0APM9JLAFN");
const THREAD_TS = argv("threadTs", `debug-${Math.floor(Date.now() / 1000)}.${process.pid}`);
const FOLLOW = argv("follow") === true;

const KV_URL = required("REDDY_KV_REST_API_URL");
const KV_TOKEN = required("REDDY_KV_REST_API_TOKEN");

console.log(`[harness] base=${BASE_URL} thread=${THREAD_TS}`);
console.log(`[harness] userText:\n${TEXT.split("\n").map((l) => "  " + l).join("\n")}\n`);

const res = await fetch(`${BASE_URL}/api/agent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userText: TEXT,
    slackChannel: CHANNEL,
    slackThreadTs: THREAD_TS,
    slackUser: "harness",
  }),
});
const dispatched = await res.json();
if (!res.ok || !dispatched.ok) {
  console.error("[harness] /api/agent failed:", res.status, dispatched);
  process.exit(1);
}
const { sandboxName, sessionId, cmdId, turn } = dispatched;
console.log(`[harness] dispatched — sandbox=${sandboxName} session=${sessionId} turn=${turn} cmd=${cmdId}`);

if (FOLLOW) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  const cmd = await sandbox.getCommand(cmdId);
  console.log("[harness] ── live driver output ──");
  const logStream = (async () => {
    try {
      for await (const log of cmd.logs()) {
        (log.stream === "stderr" ? process.stderr : process.stdout).write(log.data);
      }
    } catch (err) {
      console.error(`\n[harness] log stream ended: ${err.message || err}`);
    }
  })();
  const finished = await cmd.wait();
  await Promise.race([logStream, sleep(500)]);
  console.log(`\n[harness] ── command exit=${finished.exitCode} ──`);
}

// Dump KV trace
const traceKey = `reddy-gtm:thread:${THREAD_TS}:trace:${turn}`;
const traceRes = await fetch(`${KV_URL}/get/${encodeURIComponent(traceKey)}`, {
  headers: { Authorization: `Bearer ${KV_TOKEN}` },
});
const traceBody = await traceRes.json();
let trace = null;
if (traceBody && traceBody.result != null) {
  try { trace = JSON.parse(traceBody.result); } catch { trace = traceBody.result; }
}

if (!trace) {
  console.log(`[harness] no trace at ${traceKey}`);
} else if (Array.isArray(trace)) {
  console.log(`[harness] ── KV trace (${trace.length} entries @ ${traceKey}) ──`);
  for (const [i, entry] of trace.entries()) {
    const head = `[${String(i).padStart(3, "0")}] ${entry.ts} ${entry.kind}${entry.name ? " " + entry.name : ""}`;
    console.log(head);
    for (const field of ["input", "output", "stdout", "stderr", "error", "raw", "textPreview"]) {
      if (entry[field] != null && entry[field] !== "") {
        const s = typeof entry[field] === "string" ? entry[field] : JSON.stringify(entry[field]);
        console.log(`  ${field}: ${truncate(s, 800)}`);
      }
    }
    if (entry.exitCode != null) console.log(`  exitCode: ${entry.exitCode}`);
  }
} else {
  console.log(`[harness] trace (non-array) @ ${traceKey}:`, trace);
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

console.log(`\n[harness] done. Sandbox: ${sandboxName}. Session: ${sessionId}. KV trace: ${traceKey}`);
