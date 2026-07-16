#!/usr/bin/env node
// Force-stop ALL running Reddy-GTM sandboxes.
//   set -a && source .env.local && set +a
//   node scripts/kill-all-sandboxes.mjs
import { Sandbox } from "@vercel/sandbox";

const { sandboxes = [] } = await Sandbox.list();
const running = sandboxes.filter(
  (s) => (s.name || "").startsWith("reddy-gtm-") && s.status !== "stopped",
);
console.log(`[kill-all] found ${running.length} reddy-gtm sandbox(es)`);
for (const s of running) {
  console.log(`  - ${s.name} (status=${s.status ?? "?"})`);
}
for (const s of running) {
  try {
    const sb = await Sandbox.get({ name: s.name });
    await sb.stop();
    console.log(`[kill-all] stopped ${s.name}`);
  } catch (err) {
    console.error(`[kill-all] failed to stop ${s.name}: ${err?.message || err}`);
  }
}
console.log("[kill-all] done");
