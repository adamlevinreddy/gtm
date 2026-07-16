#!/usr/bin/env tsx
// One-shot backfill of the KV meeting index (Daybreak Phase 3) from the KB.
// Walks every meta.json via the GitHub API (the old slow path) and upserts
// each meeting into mtg:index:z / mtg:index:h. Idempotent — re-running just
// refreshes rows; the webhook keeps the index current afterward.
//
// Run from repo root:
//   npx tsx scripts/backfill-meeting-index.ts
//
// Env required (e.g. via: set -a; source .env.backfill; set +a):
//   PRICING_LIBRARY_GITHUB_PAT, REDDY_KV_REST_API_URL, REDDY_KV_REST_API_TOKEN

import { walkAllKbMeetings } from "../src/lib/recall-index";
import { upsertMeetingIndex, meetingIndexSize } from "../src/lib/meeting-index";

async function main() {
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");

  console.log("walking KB metas (may take ~30-60s cold)…");
  const rows = await walkAllKbMeetings(pat);
  console.log(`parsed ${rows.length} meetings from the KB`);

  let ok = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.bot_id || !r.started_at) {
      skipped++;
      continue;
    }
    await upsertMeetingIndex({
      bot_id: r.bot_id,
      customer_slug: r.customer_slug,
      title: r.title,
      started_at: r.started_at,
      ended_at: r.ended_at,
      platform: r.platform,
      attendees: r.attendees,
      has_transcript: r.has_transcript,
      has_video: r.has_video,
      has_chat: r.has_chat,
      mux_playback_id: r.mux_playback_id,
      attribution_confidence: r.attribution_confidence,
      hubspot_company_id: r.hubspot_company_id,
      account_canonical: r.account_canonical,
    });
    ok++;
    if (ok % 100 === 0) console.log(`  upserted ${ok}…`);
  }
  const size = await meetingIndexSize();
  console.log(`done: upserted=${ok} skipped(no bot/start)=${skipped} index size=${size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
