#!/usr/bin/env node
// Local debug harness for pricing-build / pricing-check.
// Posts a synthetic request to /api/pricing, streams the driver's live logs
// from the sandbox, then dumps the full KV trace. No Slack involvement.
//
// Usage:
//   vercel env pull .env.local --environment=development  (one-time)
//   set -a && source .env.local && set +a
//   node scripts/debug-pricing.mjs --company Vistra \
//     --logo "https://stripe.com/img/v3/home/social.png" \
//     --model "250 agents, 2-year, BYOT, Tapestry-style layout"
//
// Required env:
//   REDDY_KV_REST_API_URL, REDDY_KV_REST_API_TOKEN  (from vercel env pull)
// Optional env:
//   DEBUG_BASE_URL        default https://gtm-jet.vercel.app
//   DEBUG_SLACK_CHANNEL   default C0APM9JLAFN (#sales-testing) — used only so the
//                         driver has a valid channel; we won't actually read Slack

import { Sandbox } from "@vercel/sandbox";
import { setTimeout as sleep } from "node:timers/promises";

function argv(name, fallback) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function required(env) {
  const v = process.env[env];
  if (!v) {
    console.error(`[harness] missing required env ${env} — run \`vercel env pull .env.local --environment=development && set -a && source .env.local && set +a\``);
    process.exit(2);
  }
  return v;
}

const MODE = argv("mode", "build");
const COMPANY = argv("company", "DebugCo");
const LOGO = argv("logo", "https://stripe.com/img/v3/home/social.png");
const MODEL = argv("model", "250 agents, 2-year, BYOT, Tapestry-style layout");
const USER_TEXT = argv("text", null);
const BASE_URL = process.env.DEBUG_BASE_URL || "https://gtm-jet.vercel.app";
const SLACK_CHANNEL = process.env.DEBUG_SLACK_CHANNEL || "C0APM9JLAFN";
const THREAD_TS = argv("threadTs", `debug-${Math.floor(Date.now() / 1000)}.${process.pid}`);

const KV_URL = required("REDDY_KV_REST_API_URL");
const KV_TOKEN = required("REDDY_KV_REST_API_TOKEN");

const userText = USER_TEXT
  ? USER_TEXT
  : MODE === "build"
    ? `Company: ${COMPANY}\nLogo: ${LOGO}\nModel: ${MODEL}`
    : `What rate would make sense for ${MODEL || "a 250-agent BYOT deployment"}?`;

console.log(`[harness] mode=${MODE} thread=${THREAD_TS}`);
console.log(`[harness] userText:\n${userText.split("\n").map((l) => "  " + l).join("\n")}\n`);

// 1. POST directly to /api/pricing
const postRes = await fetch(`${BASE_URL}/api/pricing`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: MODE,
    userText,
    slackChannel: SLACK_CHANNEL,
    slackThreadTs: THREAD_TS,
    slackUser: "harness",
  }),
});
const dispatched = await postRes.json();
if (!postRes.ok || !dispatched.ok) {
  console.error("[harness] /api/pricing failed:", postRes.status, dispatched);
  process.exit(1);
}
const { sandboxName, cmdId, turn } = dispatched;
console.log(`[harness] dispatched — sandbox=${sandboxName} cmd=${cmdId} turn=${turn}`);

// 2. Reattach to the sandbox and stream the command logs
const sandbox = await Sandbox.get({ name: sandboxName });
const cmd = await sandbox.getCommand(cmdId);

console.log("[harness] ── live driver output ──");
const logStream = (async () => {
  try {
    for await (const log of cmd.logs()) {
      const w = log.stream === "stderr" ? process.stderr : process.stdout;
      w.write(log.data);
    }
  } catch (err) {
    console.error(`\n[harness] log stream ended: ${err.message || err}`);
  }
})();

// 3. Wait for the command to finish, then stop streaming
const finished = await cmd.wait();
await Promise.race([logStream, sleep(500)]);
console.log(`\n[harness] ── command exit=${finished.exitCode} ──`);

// 4. Fetch the full KV trace we just persisted
const threadKey = `pricing:thread:${THREAD_TS}`;
const traceKey = `${threadKey}:trace:${turn}`;
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
    const head = `[${String(i).padStart(3, "0")}] ${entry.ts} ${entry.kind}${entry.iteration != null ? " iter=" + entry.iteration : ""}${entry.name ? " " + entry.name : ""}`;
    console.log(head);
    if (entry.input !== undefined) console.log("  input:", truncate(JSON.stringify(entry.input), 500));
    if (entry.output) console.log("  output:", truncate(entry.output, 500));
    if (entry.stdout) console.log("  stdout:", truncate(entry.stdout, 500));
    if (entry.stderr) console.log("  stderr:", truncate(entry.stderr, 500));
    if (entry.error) console.log("  error:", entry.error);
    if (entry.exitCode != null) console.log("  exitCode:", entry.exitCode);
  }
} else {
  console.log(`[harness] trace (non-array) @ ${traceKey}:`, trace);
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

console.log(`\n[harness] done. Sandbox: ${sandboxName}. KV trace: ${traceKey}`);
process.exit(finished.exitCode ?? 0);
