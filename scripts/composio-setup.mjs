#!/usr/bin/env node
// One-shot: create a Composio-managed auth config for every toolkit we expose
// to Reddy-GTM. Prints the resulting env-var block to paste into Vercel.
//
// Usage:
//   export COMPOSIO_API_KEY=ak_xxx
//   node scripts/composio-setup.mjs
import { Composio } from "@composio/core";

if (!process.env.COMPOSIO_API_KEY) {
  console.error("COMPOSIO_API_KEY not set");
  process.exit(2);
}

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

// [toolkit slug, env var name, display name]
const TOOLKITS = [
  ["gmail",          "COMPOSIO_AUTH_CONFIG_GMAIL",     "Gmail"],
  ["googlecalendar", "COMPOSIO_AUTH_CONFIG_GCAL",      "Google Calendar"],
  ["googledrive",    "COMPOSIO_AUTH_CONFIG_GDRIVE",    "Google Drive"],
  ["googlesheets",   "COMPOSIO_AUTH_CONFIG_GSHEETS",   "Google Sheets"],
  ["googledocs",     "COMPOSIO_AUTH_CONFIG_GDOCS",     "Google Docs"],
  ["hubspot",        "COMPOSIO_AUTH_CONFIG_HUBSPOT",   "HubSpot"],
  ["linkedin",       "COMPOSIO_AUTH_CONFIG_LINKEDIN",  "LinkedIn"],
  ["apollo",         "COMPOSIO_AUTH_CONFIG_APOLLO",    "Apollo"],
  ["docusign",       "COMPOSIO_AUTH_CONFIG_DOCUSIGN",  "DocuSign"],
];

const results = [];
for (const [slug, envVar, label] of TOOLKITS) {
  try {
    const existing = await composio.authConfigs.list({ toolkit: slug });
    const items = existing.items ?? [];
    if (items.length > 0) {
      const id = items[0].id;
      console.log(`✓ ${label.padEnd(20)} already exists: ${id}`);
      results.push([envVar, id]);
      continue;
    }
    const cfg = await composio.authConfigs.create(slug, {
      type: "use_composio_managed_auth",
      name: `Reddy-GTM ${label}`,
    });
    const id = cfg.id ?? cfg.authConfig?.id;
    console.log(`+ ${label.padEnd(20)} created:        ${id}`);
    results.push([envVar, id]);
  } catch (err) {
    console.log(`✗ ${label.padEnd(20)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\n----- ENV VARS -----");
console.log(`COMPOSIO_API_KEY=${process.env.COMPOSIO_API_KEY}`);
for (const [envVar, id] of results) {
  console.log(`${envVar}=${id}`);
}
