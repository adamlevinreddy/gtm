// src/app/api/review/[id]/commit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getReview, markCommitted } from "@/lib/kv";
import { fetchCompanyLists, commitCompanyListUpdates } from "@/lib/github";
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

  const lists = await fetchCompanyLists();
  const today = new Date().toISOString().split("T")[0];

  let exclusionsAdded = 0;
  let tagsAdded = 0;
  let prospectsAdded = 0;

  for (const item of review.items) {
    const decision = review.decisions[item.name];
    if (!decision) continue;

    if (decision === "accept") {
      if (item.action === "exclude" && item.category) {
        lists.exclusions.companies.push({
          name: item.name, aliases: [], category: item.category,
          added: today, source: review.source,
        });
        exclusionsAdded++;
      } else if (item.action === "tag" && item.category) {
        lists.tags.companies.push({
          name: item.name, aliases: [], category: item.category,
          added: today, source: review.source,
        });
        tagsAdded++;
      } else if (item.action === "prospect") {
        lists.prospects.companies.push({
          name: item.name, aliases: [], added: today,
          source: review.source, note: item.rationale || "",
        });
        prospectsAdded++;
      }
    } else if (decision === "reject") {
      lists.prospects.companies.push({
        name: item.name, aliases: [], added: today,
        source: review.source,
        note: `Rejected Claude classification: ${item.action}/${item.category}`,
      });
      prospectsAdded++;
    }
  }

  const message = `Update company lists from ${review.source} — ${exclusionsAdded} exclusions, ${tagsAdded} tags, ${prospectsAdded} prospects`;

  await commitCompanyListUpdates({
    exclusions: lists.exclusions, exclusionsSha: lists.shas.exclusions,
    tags: lists.tags, tagsSha: lists.shas.tags,
    prospects: lists.prospects, prospectsSha: lists.shas.prospects,
    message,
  });

  const summary = { exclusionsAdded, tagsAdded, prospectsAdded };
  await markCommitted(id, summary);

  await sendCommitConfirmation({ source: review.source, ...summary });

  return NextResponse.json({ ok: true, ...summary });
}
