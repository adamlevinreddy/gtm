import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { kv } from "./kv-client";

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

/** The channel proactive bot updates post to. Prefers SALES_CHANNEL_ID (the
 * real #sales channel) and falls back to the testing channel during rollout. */
export function salesChannel(): string | undefined {
  return process.env.SALES_CHANNEL_ID || process.env.SALES_TESTING_CHANNEL_ID;
}

/**
 * Verify a Slack request signature (Events API / interactivity). Slack signs
 * `v0:${timestamp}:${rawBody}` with the app's signing secret and sends the hex
 * digest as `x-slack-signature: v0=<hex>` plus `x-slack-request-timestamp`.
 * Mutating endpoints (the post-meeting confirm button) MUST verify this. Fails
 * closed: a missing secret/header returns false. Best-effort — never throws.
 */
export function verifySlackSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret = process.env.SLACK_SIGNING_SECRET
): boolean {
  try {
    if (!secret || !signature || !timestamp) return false;
    // Replay guard: reject anything more than 5 minutes old.
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
    const expected =
      "v0=" + crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Resolve a Slack user id → email (the reverse of slackIdForEmail), KV-cached.
 * Used to attribute a button click to a teammate. Returns null if unknown.
 * Best-effort — never throws.
 */
export async function emailForSlackId(userId: string): Promise<string | null> {
  if (!userId) return null;
  const key = `slack:emailForId:${userId}`;
  try {
    const cached = await kv.get<string>(key);
    if (cached) return cached;
  } catch {
    /* ignore cache miss */
  }
  try {
    const res = await getSlackClient().users.info({ user: userId });
    const email = res.user?.profile?.email ?? null;
    if (email) await kv.set(key, email, { ex: 7 * 24 * 3600 }).catch(() => {});
    return email;
  } catch {
    return null;
  }
}

/**
 * POST to a Slack response_url (from a slash command / interactivity payload).
 * Used to replace the original message in place (e.g. swap the confirm button
 * for a "✅ Created" state). Best-effort — never throws.
 */
export async function postToResponseUrl(
  responseUrl: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* ignore */
  }
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
    // These are structured Block Kit messages with their own buttons/links;
    // don't let Slack auto-unfurl board URLs into an ugly preview card.
    unfurl_links: false,
    unfurl_media: false,
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
