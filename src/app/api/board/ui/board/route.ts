import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/work-items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Browser-facing board re-fetch. Used by BoardClient to reconcile after a 409
// conflict (someone else moved the card). Read-only; honors the same ?owner /
// ?customer filters the server page applies. No secret needed — this only
// reads the projection.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const owner = sp.get("owner") || undefined;
  const customer = sp.get("customer") || undefined;
  try {
    const board = await getBoard({ ownerEmail: owner, customerSlug: customer });
    return NextResponse.json({ ok: true, board });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
