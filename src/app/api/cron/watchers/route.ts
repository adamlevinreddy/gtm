import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";
import { dueWatches } from "@/lib/watchers";
import { runWatch } from "@/lib/watcher-run";

// Conditional-follow-up evaluator. Runs a few times each business day; pulls
// watches whose check date has arrived, evaluates each (checks the signal via
// the owner's Gmail/HubSpot and drafts + notifies if it trips), and marks them
// done. No time-gate — it just processes whatever is due; cadence only affects
// latency. Each watch is claimed (nx) before running so overlapping cron runs
// can't double-fire it. Sequential + capped (each does one agent pass); any
// backlog beyond BATCH carries to the next tick.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET`.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

// Each watch is one agent pass (pollTimeoutMs 300s in watcher-run) + possible
// cold start; keep BATCH × that comfortably under maxDuration (800s).
const BATCH = 2;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const due = await dueWatches(now, BATCH * 3).catch(() => []);
  const results: Array<{ id: string; ok: boolean; tripped?: boolean; skipped?: string }> = [];
  let processed = 0;

  for (const w of due) {
    if (processed >= BATCH) break;
    // Claim so overlapping ticks don't double-process the same watch.
    const claimed = await kv.set(`watchers:claim:${w.id}`, now.toString(), { nx: true, ex: 60 * 60 }).catch(() => "err");
    if (claimed === null) {
      results.push({ id: w.id, ok: true, skipped: "claimed" });
      continue;
    }
    processed += 1;
    try {
      const r = await runWatch(w);
      results.push({ id: w.id, ok: r.ok, tripped: r.tripped });
    } catch (err) {
      results.push({ id: w.id, ok: false, skipped: err instanceof Error ? err.message : String(err) });
    } finally {
      // Release the short claim — status changes already removed a fired/satisfied
      // watch from the due set, so releasing can't cause a re-fire this window.
      await kv.del(`watchers:claim:${w.id}`).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true, due: due.length, processed, results });
}
