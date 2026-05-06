import { NextResponse } from "next/server";
import { auditDump } from "@/lib/gtm";

export const maxDuration = 30;

// GET /api/gtm/audit — one-shot diagnostic dump of the published GTM
// container. Answers the audit triage questions:
// - Do the named CTA event tags (book_a_demo_click, etc.) exist in live?
// - What does the Google Ads Conversion trigger regex actually match?
// - What scroll-depth thresholds are configured?
// Plus raw tag/trigger/variable inventory for the agent to reason over.
export async function GET() {
  try {
    const dump = await auditDump();
    return NextResponse.json(dump);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
