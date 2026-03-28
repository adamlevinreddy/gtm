/**
 * Slack notification helpers.
 * Sends classification results to a Slack channel via incoming webhook.
 */

export async function sendQuickClassification(params: {
  companyName: string;
  action: string;
  category: string | null;
  confidence: string;
  threadTs?: string;
}): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("SLACK_WEBHOOK_URL not set — skipping Slack notification");
    return;
  }

  const emoji =
    params.action === "exclude"
      ? ":no_entry_sign:"
      : params.action === "tag"
        ? ":label:"
        : ":dart:";

  const text = [
    `${emoji} *${params.companyName}*`,
    `Action: \`${params.action}\``,
    params.category ? `Category: \`${params.category}\`` : null,
    `Confidence: \`${params.confidence}\``,
  ]
    .filter(Boolean)
    .join(" | ");

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    }),
  });
}
