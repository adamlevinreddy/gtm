#!/usr/bin/env node
// Force-stop a running Reddy-GTM sandbox.
// Usage:
//   set -a && source .env.local && set +a
//   node scripts/kill-sandbox.mjs <sandbox-name>
import { Sandbox } from "@vercel/sandbox";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/kill-sandbox.mjs <sandbox-name>");
  process.exit(2);
}

console.log(`[kill] connecting to ${name}`);
const sandbox = await Sandbox.get({ name });
console.log(`[kill] got sandbox, stopping…`);
await sandbox.stop();
console.log(`[kill] stopped ${name}`);
