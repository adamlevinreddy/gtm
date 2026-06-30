import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enrichmentRuns } from "@/lib/schema";

export const maxDuration = 60;

/**
 * Clay webhook handler stub.
 * Clay tables aren't finalized yet — this accepts and logs inbound payloads.
 * The actual field mappings will be configured once Clay tables are set up.
 */
export async function POST(req: NextRequest) {
  const payload = await req.json();

  // Log the raw payload for now
  await db.insert(enrichmentRuns).values({
    source: "clay",
    status: "pending",
    rawPayload: payload,
    completedAt: new Date(),
  });

  return NextResponse.json({ ok: true, message: "Clay webhook received and logged" });
}
