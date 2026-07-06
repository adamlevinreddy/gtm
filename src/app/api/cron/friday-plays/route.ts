import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";
import { ptDate } from "@/lib/work-items";
import { runFridayPlays } from "@/lib/friday-plays";

// Friday-morning proactive digests — 8am PT Friday. Three Slack posts: accounts
// going quiet, product signal for engineering, and manual workflows worth
// turning into Plays. See src/lib/friday-plays.ts.
//
// Vercel crons are UTC + DST-blind: 8am PT Friday is 15:00 UTC (PDT) or 16:00
// UTC (PST), both still Friday. We fire both hours (vercel.json `0 15,16 * * 5`)
// and gate in-route on the live PT hour + that it's Friday; a set-once KV key
// makes it idempotent across the double firing.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET`. `?force=1` (same
// Bearer) bypasses the time-gate + dedupe for on-demand testing.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

const RUN_HOUR_PT = 8;

function ptHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(now));
}
function ptWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(now);
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const now = new Date();
  if (!force && (ptHour(now) !== RUN_HOUR_PT || ptWeekday(now) !== "Fri")) {
    return NextResponse.json({ ok: true, skipped: "off-hour", ptHour: ptHour(now), ptWeekday: ptWeekday(now) });
  }

  const day = ptDate(now);
  if (!force) {
    const claimed = await kv.set(`proactive:friday-plays:${day}`, new Date().toISOString(), { nx: true, ex: 60 * 60 * 36 });
    if (claimed === null) return NextResponse.json({ ok: true, skipped: "already-sent", day });
  }

  const result = await runFridayPlays({ runId: `friday-${day}` });
  return NextResponse.json({ ...result, forced: force, day });
}
