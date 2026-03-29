import { kv } from "@vercel/kv";
import { WebClient } from "@slack/web-api";
import { getReview } from "./kv";

interface ReviewMeta {
  totalCompanies: number;
  excludedCount: number;
  taggedCount: number;
  unknownCount: number;
  totalJobs: number;
  slackChannel: string;
  slackThreadTs: string;
}

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Increment the job completion counter for a review.
 * When all jobs are done, send the combined Slack message and swap emoji.
 */
export async function markJobComplete(reviewId: string): Promise<void> {
  const counterKey = `review:${reviewId}:completed-jobs`;
  const completed = await kv.incr(counterKey);

  const meta = await kv.get<ReviewMeta>(`review:${reviewId}:meta`);
  if (!meta) return;

  if (completed < meta.totalJobs) return;

  // All jobs done — send combined message
  await kv.del(counterKey);
  await kv.del(`review:${reviewId}:meta`);

  const review = await getReview(reviewId);
  const excludeFromClaude = review?.items.filter((i) => i.action === "exclude").length || 0;
  const tagFromClaude = review?.items.filter((i) => i.action === "tag").length || 0;
  const prospectFromClaude = review?.items.filter((i) => i.action === "prospect").length || 0;
  const hsMatchCount = review?.hubspotMatches?.length || 0;
  const hsContactCount = review?.hubspotMatches?.reduce((s, m) => s + m.contacts.length, 0) || 0;

  const baseUrl = "https://gtm-jet.vercel.app";
  let text = `:white_check_mark: *Finished processing ${meta.totalCompanies} companies from ${review?.source || "upload"}*\n\n`;
  text += `*Known matches:*\n`;
  text += `> :no_entry: *${meta.excludedCount}* vendors excluded\n`;
  text += `> :label: *${meta.taggedCount}* tagged (BPO/Media)\n`;

  if (meta.unknownCount > 0) {
    text += `\n*Claude classified ${meta.unknownCount} unknowns:*\n`;
    text += `> :no_entry: *${excludeFromClaude}* suggested for exclusion\n`;
    text += `> :label: *${tagFromClaude}* suggested for tagging\n`;
    text += `> :bust_in_silhouette: *${prospectFromClaude}* identified as prospects\n`;
  }

  if (hsMatchCount > 0) {
    text += `\n*HubSpot CRM:*\n`;
    text += `> :mag: *${hsContactCount}* contacts found at *${hsMatchCount}* companies\n`;
  }

  text += `\n<${baseUrl}/review/${reviewId}|View full results>`;

  const slack = getSlackClient();
  await slack.chat.postMessage({
    channel: meta.slackChannel,
    thread_ts: meta.slackThreadTs,
    text,
  });

  // Swap emoji
  try {
    await slack.reactions.remove({ channel: meta.slackChannel, name: "hourglass_flowing_sand", timestamp: meta.slackThreadTs });
  } catch { /* may not exist */ }
  try {
    await slack.reactions.add({ channel: meta.slackChannel, name: "white_check_mark", timestamp: meta.slackThreadTs });
  } catch { /* may already exist */ }
}
