import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { kv } from "@/lib/kv-client";
import { workItems, workItemBotAttempts } from "@/lib/schema";
import { ptDate } from "@/lib/work-items";
import { runBotPass } from "@/lib/bot-worker/run";
import { BOT_FIRST_PASS_KINDS } from "@/lib/board-events";
import { isStalled, STALE_WAITING_DAYS } from "@/lib/board-aging";
import { createNotification } from "@/lib/board-world";

// ---------------------------------------------------------------------------
// Bot-worker BACKSTOP cron. The event-driven fire (board-events.maybeFire →
// /api/board/bot-run) is PRIMARY; this sweep is the self-heal that catches:
//   - dropped fire-and-forgets (the after()/keepalive never left the function),
//   - a teammate's first-ever COLD-START oneshot timeout (the failed attempt
//     freed the unique index + the run lock, so we retry now the sandbox is warm).
// runBotPass is KV-locked + idempotent per (itemId, taskRevision) and never
// throws, so re-driving here can never double-run a live pass.
//
// Also folds in the Reddy-Waiting SLA: items parked in `waiting` past
// STALE_WAITING_DAYS get a one-per-day "stalled" nudge to their owner.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET`. `?force=1` (same
// Bearer) is just a manual-test convenience; this route has no time-gate.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Max bot attempts (incl. failures) per botTaskRevision before we give up. */
const MAX_ATTEMPTS = 2;
/** How many items to drive per cron tick (the rest catch the next tick). */
const BATCH = 5;
/** Stagger between runBotPass kicks so we don't burst the sandbox/oneshot. */
const STAGGER_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const now = new Date();

  // -------------------------------------------------------------------------
  // (1) BOT-PASS BACKSTOP sweep.
  // Eligible rows: approved|in_progress, bot-assigned, owned, a bot-first-pass
  // kind, with NO succeeded/running attempt at the row's CURRENT botTaskRevision
  // and fewer than MAX_ATTEMPTS failed attempts at that revision. runBotPass
  // re-checks eligibility itself, so this query only needs to be a good filter.
  // -------------------------------------------------------------------------
  let sweptBotItems = 0;
  try {
    // # of NON-failed (running|succeeded) attempts at the row's current revision.
    const liveAttempts = sql<number>`(
      select count(*) from ${workItemBotAttempts}
      where ${workItemBotAttempts.workItemId} = ${workItems.id}
        and ${workItemBotAttempts.taskRevision} = ${workItems.botTaskRevision}
        and ${workItemBotAttempts.status} <> 'failed'
    )`;
    // # of FAILED attempts at the row's current revision (the retry budget).
    const failedAttempts = sql<number>`(
      select count(*) from ${workItemBotAttempts}
      where ${workItemBotAttempts.workItemId} = ${workItems.id}
        and ${workItemBotAttempts.taskRevision} = ${workItems.botTaskRevision}
        and ${workItemBotAttempts.status} = 'failed'
    )`;

    const eligible = await db
      .select({
        id: workItems.id,
        botTaskRevision: workItems.botTaskRevision,
      })
      .from(workItems)
      .where(
        and(
          inArray(workItems.status, ["approved", "in_progress"]),
          eq(workItems.botAssigned, true),
          isNotNull(workItems.ownerEmail),
          inArray(workItems.kind, BOT_FIRST_PASS_KINDS),
          sql`${liveAttempts} = 0`,
          sql`${failedAttempts} < ${MAX_ATTEMPTS}`
        )
      )
      .orderBy(workItems.stageEnteredAt)
      .limit(BATCH);

    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i];
      if (i > 0) await sleep(STAGGER_MS);
      // runBotPass never throws, but guard anyway so one bad row can't abort the
      // sweep (or the stalled pass below).
      await runBotPass(row.id, row.botTaskRevision).catch(() => {});
      sweptBotItems++;
    }
  } catch {
    /* sweep is best-effort; fall through to the stalled pass + a clean 200 */
  }

  // -------------------------------------------------------------------------
  // (2) STALLED (Reddy-Waiting SLA) sweep. Items in `waiting` past
  // STALE_WAITING_DAYS business days get ONE nudge per PT day to their owner.
  // KV nx guard keeps it idempotent across the multiple ticks each day.
  // -------------------------------------------------------------------------
  const today = ptDate(now);
  let stalledNotified = 0;
  try {
    const waiting = await db
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.status, "waiting"), isNotNull(workItems.ownerEmail))
      );

    for (const item of waiting) {
      if (!item.ownerEmail) continue;
      if (!isStalled(item, now)) continue;

      const guard = `stalled:${item.id}:${today}`;
      const claimed = await kv.set(guard, "1", {
        nx: true,
        ex: 60 * 60 * 36,
      });
      if (claimed === null) continue; // already nudged today

      await createNotification({
        recipientEmail: item.ownerEmail,
        kind: "stalled",
        workItemId: item.id,
        body: `No reply for ${STALE_WAITING_DAYS}+ business days — nudge?`,
      });
      stalledNotified++;
    }
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok: true,
    sweptBotItems,
    stalledNotified,
    forced: force,
  });
}
