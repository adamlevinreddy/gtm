import { NextRequest, NextResponse } from "next/server";
import { classifyWithAgent } from "@/lib/agent";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import type { ReviewItem } from "@/lib/types";

export const maxDuration = 300;

const BATCH_SIZE = 40;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Background classification — processes ALL unknowns in sequential batches.
 * Each batch spins up a sandbox, calls Claude, updates KV, posts progress.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    reviewId,
    unknowns,
    slackChannel,
    slackThreadTs,
  }: {
    reviewId: string;
    unknowns: { name: string; titles: string[] }[];
    slackChannel: string;
    slackThreadTs: string;
    source: string;
  } = body;

  const totalUnknowns = unknowns.length;
  let totalProcessed = 0;

  // Process in sequential batches within this single function execution
  for (let i = 0; i < unknowns.length; i += BATCH_SIZE) {
    const batch = unknowns.slice(i, i + BATCH_SIZE);

    try {
      const agentResults = await classifyWithAgent(batch);

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
        await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });
      }

      totalProcessed += agentResults.length;

      // Post progress (not on last batch — we'll post a final message)
      if (i + BATCH_SIZE < unknowns.length) {
        await getSlackClient().chat.postMessage({
          channel: slackChannel,
          thread_ts: slackThreadTs,
          text: `:brain: Classified ${totalProcessed}/${totalUnknowns} unknown companies...`,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await getSlackClient().chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: `:warning: Batch ${Math.floor(i / BATCH_SIZE) + 1} failed (${batch.length} companies): ${errMsg.slice(0, 200)}. Continuing...`,
      });
    }
  }

  // Final summary
  const review = await getReview(reviewId);
  const excludeCount = review?.items.filter((i) => i.action === "exclude").length || 0;
  const tagCount = review?.items.filter((i) => i.action === "tag").length || 0;
  const prospectCount = review?.items.filter((i) => i.action === "prospect").length || 0;

  const baseUrl = "https://gtm-jet.vercel.app";
  await getSlackClient().chat.postMessage({
    channel: slackChannel,
    thread_ts: slackThreadTs,
    text: `:white_check_mark: Claude finished classifying ${totalProcessed} companies:\n` +
      `> :no_entry: *${excludeCount}* suggested for exclusion (vendors)\n` +
      `> :label: *${tagCount}* suggested for tagging (BPO/Media)\n` +
      `> :bust_in_silhouette: *${prospectCount}* identified as prospects\n\n` +
      `<${baseUrl}/review/${reviewId}|Review the ${excludeCount + tagCount} exclusion/tag suggestions>`,
  });

  return NextResponse.json({ ok: true });
}
