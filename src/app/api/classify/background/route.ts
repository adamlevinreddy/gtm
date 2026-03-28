import { NextRequest, NextResponse } from "next/server";
import { classifyWithAgent } from "@/lib/agent";
import { getReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import type { ReviewItem } from "@/lib/types";

export const maxDuration = 300;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

async function removeReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.remove({ channel, name: emoji, timestamp });
  } catch { /* may not exist */ }
}

async function addReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.add({ channel, name: emoji, timestamp });
  } catch { /* may already exist */ }
}

/**
 * Background classification — processes a single batch of unknowns.
 * Multiple instances run in parallel, each handling one batch.
 * Uses a KV counter to track completion and post final summary.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    reviewId,
    batch,
    batchIndex,
    totalBatches,
    totalUnknowns,
    slackChannel,
    slackThreadTs,
  }: {
    reviewId: string;
    batch: { name: string; titles: string[] }[];
    batchIndex: number;
    totalBatches: number;
    totalUnknowns: number;
    slackChannel: string;
    slackThreadTs: string;
  } = body;

  const counterKey = `review:${reviewId}:completed-batches`;

  try {
    const { classifications: agentResults, hubspotMatches } = await classifyWithAgent(batch);

    // Update review in KV — append new items (atomic via get+set)
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

      // Store HubSpot matches if any were found
      if (hubspotMatches.length > 0) {
        review.hubspotMatches = [...(review.hubspotMatches || []), ...hubspotMatches];
      }

      await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });
    }

    // Increment completed batch counter
    const completed = await kv.incr(counterKey);

    // If this is the last batch to finish, post final summary + swap emoji
    if (completed >= totalBatches) {
      await kv.del(counterKey);

      const finalReview = await getReview(reviewId);
      const excludeCount = finalReview?.items.filter((i) => i.action === "exclude").length || 0;
      const tagCount = finalReview?.items.filter((i) => i.action === "tag").length || 0;
      const prospectCount = finalReview?.items.filter((i) => i.action === "prospect").length || 0;
      const totalClassified = (finalReview?.items.length || 0);
      const hsMatchCount = finalReview?.hubspotMatches?.length || 0;

      const baseUrl = "https://gtm-jet.vercel.app";
      let summaryText = `:white_check_mark: Claude finished classifying ${totalClassified} companies:\n` +
        `> :no_entry: *${excludeCount}* suggested for exclusion (vendors)\n` +
        `> :label: *${tagCount}* suggested for tagging (BPO/Media)\n` +
        `> :bust_in_silhouette: *${prospectCount}* identified as prospects\n`;

      if (hsMatchCount > 0) {
        summaryText += `> :mag: *${hsMatchCount}* companies found in HubSpot CRM\n`;
      }

      summaryText += `\n<${baseUrl}/review/${reviewId}|Review the ${excludeCount + tagCount} exclusion/tag suggestions>`;

      await getSlackClient().chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: summaryText,
      });

      // Swap emoji: hourglass → checkmark
      await removeReaction(slackChannel, slackThreadTs, "hourglass_flowing_sand");
      await addReaction(slackChannel, slackThreadTs, "white_check_mark");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await getSlackClient().chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `:warning: Batch ${batchIndex + 1}/${totalBatches} failed (${batch.length} companies): ${errMsg.slice(0, 200)}`,
    });

    // Still increment counter so we don't block completion
    const completed = await kv.incr(counterKey);
    if (completed >= totalBatches) {
      await kv.del(counterKey);
      await removeReaction(slackChannel, slackThreadTs, "hourglass_flowing_sand");
      await addReaction(slackChannel, slackThreadTs, "white_check_mark");
    }
  }

  return NextResponse.json({ ok: true });
}
