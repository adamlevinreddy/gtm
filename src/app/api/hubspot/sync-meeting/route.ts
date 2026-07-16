import { NextRequest, NextResponse } from "next/server";
import {
  logMeetingToHubSpot,
  updateDealStage,
  getDeal,
  getDealPipelines,
} from "@/lib/hubspot";
import { isCompanyWritable } from "@/lib/hubspot-guard";

// Internal, gated endpoint: log a meeting to HubSpot (system of record for sales
// activity) on a company + deal, and optionally advance the deal stage. EVERY
// write is hard-gated to the HUBSPOT_WRITE_ALLOWLIST (Luminare only this phase)
// inside the hubspot.ts helpers. Internal-auth only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  companyId?: string;
  dealId?: string;
  stageId?: string;
  contactIds?: string[];
  meeting?: { title?: string; startISO?: string; endISO?: string; bodyHtml?: string };
  dryRun?: boolean;
};

export async function POST(req: NextRequest) {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-reddy-internal") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const { companyId, dealId, stageId, contactIds, meeting, dryRun } = body;
  if (!companyId || !dealId) {
    return NextResponse.json({ ok: false, error: "companyId and dealId required" }, { status: 400 });
  }

  // Surface the guard verdict + the before-state without writing.
  const writable = isCompanyWritable(companyId);
  const before = await getDeal(dealId).catch(() => null);
  let stageLabelBefore: string | null = null;
  let stageLabelAfter: string | null = null;
  if (before?.pipeline) {
    const pipelines = await getDealPipelines().catch(() => null);
    const stages = pipelines?.get(before.pipeline) ?? [];
    stageLabelBefore = stages.find((s) => s.id === before.dealstage)?.label ?? before.dealstage;
    if (stageId) stageLabelAfter = stages.find((s) => s.id === stageId)?.label ?? stageId;
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true, writable,
      deal: before, stageLabelBefore, plannedStageId: stageId ?? null, plannedStageLabel: stageLabelAfter,
      willLogMeeting: !!meeting?.title,
    });
  }

  if (!writable) {
    return NextResponse.json(
      { ok: false, error: `company ${companyId} is not writable (check HUBSPOT_WRITES_ENABLED + HUBSPOT_WRITE_ALLOWLIST)` },
      { status: 403 }
    );
  }

  const result: Record<string, unknown> = { ok: true, companyId, dealId, stageLabelBefore };

  // 1) Log the meeting (additive, safe).
  if (meeting?.title && meeting.startISO && meeting.bodyHtml) {
    try {
      const meetingId = await logMeetingToHubSpot({
        companyId, dealId, contactIds,
        title: meeting.title, bodyHtml: meeting.bodyHtml,
        startISO: meeting.startISO, endISO: meeting.endISO ?? null,
      });
      result.meetingId = meetingId;
    } catch (err) {
      result.meetingError = err instanceof Error ? err.message : String(err);
    }
  }

  // 2) Advance the stage (only if requested).
  if (stageId) {
    try {
      const moved = await updateDealStage(companyId, dealId, stageId);
      result.stageUpdated = moved;
      result.stageId = stageId;
      result.stageLabelAfter = stageLabelAfter;
    } catch (err) {
      result.stageError = err instanceof Error ? err.message : String(err);
    }
  }

  const after = await getDeal(dealId).catch(() => null);
  result.dealstageAfter = after?.dealstage ?? null;
  return NextResponse.json(result);
}
