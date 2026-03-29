// src/app/api/review/[id]/commit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getReview, markCommitted } from "@/lib/kv";
import { commitCompanyListUpdates } from "@/lib/database";
import { persistAttendees } from "@/lib/contacts";
import { sendCommitConfirmation } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const review = await getReview(id);

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "submitted") {
    return NextResponse.json(
      { error: `Review must be submitted first. Current status: ${review.status}` },
      { status: 409 }
    );
  }
  if (!review.decisions) {
    return NextResponse.json({ error: "No decisions found" }, { status: 400 });
  }

  let exclusionsAdded = 0;
  let tagsAdded = 0;
  let prospectsAdded = 0;

  const inserts: {
    name: string;
    action: "exclude" | "tag" | "prospect";
    category: string | null;
    categoryLabel: string | null;
    source: string;
    note: string | null;
  }[] = [];

  for (const item of review.items) {
    const decision = review.decisions[item.name];
    if (!decision) continue;

    if (decision === "accept") {
      inserts.push({
        name: item.name,
        action: item.action,
        category: item.category,
        categoryLabel: null,
        source: review.source,
        note: item.rationale,
      });
      if (item.action === "exclude") exclusionsAdded++;
      else if (item.action === "tag") tagsAdded++;
      else if (item.action === "prospect") prospectsAdded++;
    } else if (decision === "reject") {
      // Rejected classifications become prospects for manual follow-up
      inserts.push({
        name: item.name,
        action: "prospect",
        category: null,
        categoryLabel: null,
        source: review.source,
        note: `Rejected Claude classification: ${item.action}/${item.category}`,
      });
      prospectsAdded++;
    }
  }

  try {
    await commitCompanyListUpdates(inserts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Database write failed: ${errMsg}` }, { status: 500 });
  }

  // Persist contacts from attendees (if any)
  let contactsCreated = 0;
  if (review.attendees && review.attendees.length > 0) {
    try {
      const result = await persistAttendees({
        reviewId: id,
        source: review.source,
        fileName: review.fileName,
        attendees: review.attendees,
      });
      contactsCreated = result.contactsCreated;
    } catch (err) {
      // Contact persistence is non-critical — log but don't fail the commit
      console.error("Failed to persist contacts:", err);
    }
  }

  const summary = { exclusionsAdded, tagsAdded, prospectsAdded };
  await markCommitted(id, summary);

  try {
    await sendCommitConfirmation({ source: review.source, ...summary, contactsCreated });
  } catch {
    // Slack notification is non-critical
  }

  return NextResponse.json({ ok: true, ...summary, contactsCreated });
}
