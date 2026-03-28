import { NextRequest, NextResponse } from "next/server";
import { classifyWithAgent } from "@/lib/agent";
import { getReview, submitDecisions } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import type { ClassificationResult, ReviewItem, ReviewData } from "@/lib/types";

export const maxDuration = 300;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Background classification endpoint.
 * Called fire-and-forget by the Slack handler after known matching is done.
 * Classifies unknowns with Claude in a sandbox, updates the review in KV,
 * then posts results to Slack.
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

  try {
    // Classify with Claude in sandbox
    const agentResults = await classifyWithAgent(unknowns);

    // Update the review in KV with Claude's classifications
    const review = await getReview(reviewId);
    if (review) {
      const reviewItems: ReviewItem[] = agentResults.map((r) => {
        const companyData = unknowns.find((u: { name: string }) => u.name === r.name);
        return {
          name: r.name,
          titles: companyData?.titles || [],
          action: r.action,
          category: r.category,
          rationale: r.rationale,
        };
      });

      // Update the review with Claude's items
      review.items = reviewItems;
      await kv.set(`review:${reviewId}`, review, { ex: 7 * 24 * 60 * 60 });

      // Post update to Slack
      const baseUrl = "https://gtm-jet.vercel.app";
      await getSlackClient().chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: `:brain: Claude classified ${agentResults.length} of ${unknowns.length} unknown companies.\n\n<${baseUrl}/review/${reviewId}|Review & approve classifications>`,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Post error to Slack
    await getSlackClient().chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `:warning: Claude classification failed: ${errMsg.slice(0, 300)}`,
    });
  }

  return NextResponse.json({ ok: true });
}
