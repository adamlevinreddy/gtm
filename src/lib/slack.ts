import { WebClient } from "@slack/web-api";
import { kv } from "./kv-client";

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/**
 * Resolve a teammate email → Slack user id (for @mentions), KV-cached. Returns
 * null if not found (caller falls back to the name). Best-effort — never throws.
 */
export async function slackIdForEmail(email: string): Promise<string | null> {
  if (!email || !email.includes("@")) return null;
  const key = `slack:idForEmail:${email.toLowerCase()}`;
  try {
    const cached = await kv.get<string>(key);
    if (cached) return cached;
  } catch {
    /* ignore cache miss */
  }
  try {
    const res = await getSlackClient().users.lookupByEmail({ email });
    const id = res.user?.id ?? null;
    if (id) await kv.set(key, id, { ex: 7 * 24 * 3600 }).catch(() => {});
    return id;
  } catch {
    return null;
  }
}

/**
 * Post a message to an arbitrary channel. Generalizes the hardcoded
 * SLACK_CHANNEL_ID posting above so proactive features (morning digest,
 * post-meeting suggestions) can target the sales-testing channel.
 */
export async function postToChannel(
  channel: string,
  msg: { text: string; blocks?: object[]; threadTs?: string }
): Promise<{ ts?: string }> {
  const client = getSlackClient();
  const res = await client.chat.postMessage({
    channel,
    text: msg.text, // fallback / notification text -- always set
    ...(msg.blocks ? { blocks: msg.blocks as never } : {}),
    ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
  });
  return { ts: res.ts };
}

export async function sendReviewNotification(params: {
  reviewId: string;
  source: string;
  totalCompanies: number;
  knownMatches: number;
  needsReview: number;
  excludedCompanies: number;
  taggedCompanies: number;
  prospectCompanies: number;
}) {
  const client = getSlackClient();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Classification complete: ${params.source}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total companies:*\n${params.totalCompanies}` },
          { type: "mrkdwn", text: `*Known matches:*\n${params.knownMatches}` },
          { type: "mrkdwn", text: `*Excluded (vendors):*\n${params.excludedCompanies}` },
          { type: "mrkdwn", text: `*Tagged (BPO/Media):*\n${params.taggedCompanies}` },
          { type: "mrkdwn", text: `*Prospects:*\n${params.prospectCompanies}` },
          { type: "mrkdwn", text: `*Needs review:*\n${params.needsReview}` },
        ],
      },
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Review Now" },
          url: `${baseUrl}/review/${params.reviewId}`,
          style: "primary",
        }],
      },
    ],
  });
}

export async function sendCommitConfirmation(params: {
  source: string;
  exclusionsAdded: number;
  tagsAdded: number;
  prospectsAdded: number;
  contactsCreated?: number;
}) {
  const client = getSlackClient();

  const lines = [
    `*${params.exclusionsAdded}* new exclusions added`,
    `*${params.tagsAdded}* new tags added`,
    `*${params.prospectsAdded}* confirmed as prospects`,
  ];
  if (params.contactsCreated) {
    lines.push(`*${params.contactsCreated}* contacts persisted to database`);
  }
  lines.push("\nCompany lists updated. These will be caught automatically on future lists.");

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Review committed: ${params.source}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

export async function sendQuickClassification(params: {
  companyName: string;
  action: string;
  category: string | null;
  confidence: string;
  threadTs?: string;
}) {
  const client = getSlackClient();

  const emoji =
    params.action === "exclude" ? ":no_entry:" :
    params.action === "tag" ? ":label:" :
    ":white_check_mark:";

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    thread_ts: params.threadTs,
    text: `${emoji} *${params.companyName}*: ${params.action}${params.category ? ` (${params.category})` : ""} — confidence: ${params.confidence}`,
  });
}
