import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";
import { recentMeetingIndex } from "@/lib/recall-index";
import { proposeFromMeeting } from "@/lib/post-meeting";
import { proposeCrmFromMeeting } from "@/lib/post-meeting-crm";

// ---------------------------------------------------------------------------
// Post-meeting BACKSTOP cron. The recall webhook firing /api/proactive/meeting
// when a transcript lands is PRIMARY; this sweep is the self-heal that catches
// a meeting whose triage oneshot FAILED once (cold-sandbox/timeout) and was
// never retried — exactly the Orkin 2026-06-29 miss (claim released on failure,
// nothing re-fired → the Slack suggestion was silently dropped forever).
//
// For each recently-transcribed meeting we re-fire whichever post-meeting pass
// has NO completed claim:
//   - tasks: proactive:meeting:{botId}     (success/0-items keeps the claim)
//   - CRM:   postmeeting:crm:claim:{botId}  (kept even on the not-writable skip)
// Both helpers are KV-claim idempotent (nx) and release their claim only on a
// transient failure, so re-driving here can never double-post a live pass: a
// SET claim means "done" (skip); a NULL claim means "never ran or ran+failed".
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET`. `?force=1` (same
// Bearer) is a manual-test convenience; this route has no time-gate.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

/** Look back this many days for transcribed meetings missing a completed pass. */
const SINCE_DAYS = 2;
/** Cap meetings scanned (index is recency-sorted; misses are within a day). */
const SCAN_LIMIT = 60;
/** Max meetings to (re)drive per tick — the rest catch the next tick. */
const BATCH = 3;
/** Stagger between oneshots so we don't burst the sandbox. */
const STAGGER_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) return NextResponse.json({ ok: true, skipped: "no kb PAT" });

  const meetings = await recentMeetingIndex(pat, SINCE_DAYS, SCAN_LIMIT).catch(() => []);
  const candidates = meetings.filter((m) => m.has_transcript && m.bot_id);

  const driven: Array<Record<string, unknown>> = [];
  let touched = 0;

  for (const m of candidates) {
    if (touched >= BATCH) break;
    const botId = m.bot_id;

    // A SET claim = that pass completed (kept on success / 0-items / not-writable
    // skip); NULL = never ran or ran+failed+released. On a KV read error we treat
    // it as "done" (don't re-fire blindly).
    const taskClaim = await kv.get(`proactive:meeting:${botId}`).catch(() => "err");
    const crmClaim = await kv.get(`postmeeting:crm:claim:${botId}`).catch(() => "err");
    const needTask = taskClaim === null;
    const needCrm = crmClaim === null;
    if (!needTask && !needCrm) continue;

    touched++;
    const rec: Record<string, unknown> = { botId, title: m.title, needTask, needCrm };
    if (needTask) {
      rec.task = await proposeFromMeeting(botId).catch((e) => ({ ok: false, error: String(e) }));
    }
    if (needCrm) {
      await sleep(STAGGER_MS);
      rec.crm = await proposeCrmFromMeeting(botId).catch((e) => ({ ok: false, error: String(e) }));
    }
    driven.push(rec);
    await sleep(STAGGER_MS);
  }

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    driven: driven.length,
    results: driven,
  });
}
