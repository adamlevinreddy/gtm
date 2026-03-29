import { NextRequest, NextResponse } from "next/server";
import { classifyWithAgent } from "@/lib/agent";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { markJobComplete } from "@/lib/completion";
import type { ReviewItem } from "@/lib/types";

export const maxDuration = 300;

/**
 * Background classification — processes a single batch of unknowns.
 * Multiple instances run in parallel, each handling one batch.
 * Uses shared completion counter to trigger final Slack message.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { reviewId, batch, batchIndex } = body as {
    reviewId: string;
    batch: { name: string; titles: string[] }[];
    batchIndex: number;
  };

  try {
    const { classifications: agentResults, hubspotMatches } = await classifyWithAgent(batch);

    // Update review in KV — append new items
    const review = await getReview(reviewId);
    if (review) {
      const newItems: ReviewItem[] = agentResults.map((r) => {
        const companyData = batch.find((u) => u.name === r.name);
        return {
          name: r.name,
          titles: companyData?.titles || [],
          action: r.action,
          category: r.category,
          rationale: r.rationale,
        };
      });

      review.items = [...review.items, ...newItems];

      if (hubspotMatches.length > 0) {
        review.hubspotMatches = [...(review.hubspotMatches || []), ...hubspotMatches];
      }

      await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await kv.set(`review:${reviewId}:error:${batchIndex}`, errMsg.slice(0, 500), { ex: 3600 });
  }

  // Signal job completion (triggers combined Slack message when all jobs done)
  await markJobComplete(reviewId);

  return NextResponse.json({ ok: true });
}
