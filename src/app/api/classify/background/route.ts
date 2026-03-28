import { NextRequest, NextResponse } from "next/server";
import { classifyWithAgent } from "@/lib/agent";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import type { ClassificationResult, ReviewItem } from "@/lib/types";

export const maxDuration = 300;

const BATCH_SIZE = 40; // Companies per Claude call

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Background classification — processes unknowns in batches.
 * Each batch gets its own sandbox + Claude call.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    reviewId,
    unknowns,
    slackChannel,
    slackThreadTs,
    source,
  }: {
    reviewId: string;
    unknowns: { name: string; titles: string[] }[];
    slackChannel: string;
    slackThreadTs: string;
    source: string;
  } = body;

  // If more unknowns than we can handle in one function execution,
  // process first batch and chain to self for the rest
  const batch = unknowns.slice(0, BATCH_SIZE);
  const remaining = unknowns.slice(BATCH_SIZE);

  try {
    const agentResults = await classifyWithAgent(batch);

    // Update review in KV — append to existing items
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
      await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });

      // Post progress to Slack
      const totalProcessed = review.items.length;
      const totalUnknowns = totalProcessed + remaining.length;

      if (remaining.length > 0) {
        await getSlackClient().chat.postMessage({
          channel: slackChannel,
          thread_ts: slackThreadTs,
          text: `:brain: Classified ${totalProcessed}/${totalUnknowns} unknown companies... (${remaining.length} remaining)`,
        });

        // Chain: fire next batch
        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/classify/background`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewId,
            unknowns: remaining,
            slackChannel,
            slackThreadTs,
            source,
          }),
        }).catch(() => { /* fire and forget */ });
      } else {
        // All done
        const baseUrl = "https://gtm-jet.vercel.app";
        await getSlackClient().chat.postMessage({
          channel: slackChannel,
          thread_ts: slackThreadTs,
          text: `:white_check_mark: Claude finished classifying all ${totalProcessed} unknown companies.\n\n<${baseUrl}/review/${reviewId}|Review & approve classifications>`,
        });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await getSlackClient().chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `:warning: Classification batch failed (${batch.length} companies): ${errMsg.slice(0, 300)}\n${remaining.length > 0 ? `Skipping remaining ${remaining.length} companies.` : ""}`,
    });
  }

  return NextResponse.json({ ok: true });
}
