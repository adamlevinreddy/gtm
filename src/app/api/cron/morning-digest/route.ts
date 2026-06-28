import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";
import { postToChannel } from "@/lib/slack";
import { getDigestData, ptDate } from "@/lib/work-items";
import { buildDigestBlocks, buildDigestText } from "@/lib/digest";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Weekday 7am-PT morning digest.
//
// Vercel crons run in UTC only and do NOT observe DST, so 7am PT is 14:00 UTC
// (PDT, summer) or 15:00 UTC (PST, winter). We schedule BOTH in vercel.json
// (`0 14,15 * * 1-5`) and gate in-route on the live America/Los_Angeles hour,
// so exactly one firing per weekday posts. A KV set-once key makes the post
// idempotent even if both firings somehow pass the gate.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET` on cron requests.
// `?force=1` (with the same Bearer) bypasses the time-gate + dedupe for
// on-demand testing in the sales-testing channel.

const DIGEST_HOUR_PT = 7;

function ptHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }).format(now)
  );
}

function digestChannel(): string | undefined {
  return (
    process.env.DIGEST_SLACK_CHANNEL_ID ||
    process.env.SALES_TESTING_CHANNEL_ID ||
    process.env.SLACK_CHANNEL_ID
  );
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const now = new Date();

  if (!force && ptHour(now) !== DIGEST_HOUR_PT) {
    return NextResponse.json({ ok: true, skipped: "off-hour", ptHour: ptHour(now) });
  }

  // One post per PT calendar day, even with the 14:00 + 15:00 double firing.
  const dedupeKey = `proactive:digest:${ptDate(now)}`;
  if (!force) {
    const claimed = await kv.set(dedupeKey, new Date().toISOString(), {
      nx: true,
      ex: 60 * 60 * 36,
    });
    if (claimed === null) {
      return NextResponse.json({ ok: true, skipped: "already-sent", key: dedupeKey });
    }
  }

  const channel = digestChannel();
  if (!channel) {
    return NextResponse.json(
      { ok: false, error: "no digest channel configured (set SALES_TESTING_CHANNEL_ID)" },
      { status: 500 }
    );
  }

  try {
    const data = await getDigestData(now);
    const { ts } = await postToChannel(channel, {
      text: buildDigestText(data),
      blocks: buildDigestBlocks(data),
    });
    return NextResponse.json({
      ok: true,
      posted: { channel, ts },
      forced: force,
      added: data.addedYesterday.length,
      done: data.doneYesterday.length,
      summary: data.summary,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
