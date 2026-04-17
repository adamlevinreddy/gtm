import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { answerCampaignQuestion } from "@/lib/supermetrics";

export const maxDuration = 120;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

export async function POST(req: NextRequest) {
  const { question, slackChannel, slackThreadTs } = await req.json();

  const slack = getSlackClient();

  try {
    const answer = await answerCampaignQuestion(question);

    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: answer,
    });

    // Swap reaction: bar_chart → checkmark
    try {
      await slack.reactions.remove({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs });
    } catch { /* may not exist */ }
    try {
      await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackThreadTs });
    } catch { /* may already exist */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";

    // Swap reaction: bar_chart → x
    try {
      await slack.reactions.remove({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs });
    } catch { /* may not exist */ }
    try {
      await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs });
    } catch { /* may already exist */ }

    if (msg.includes("SUPERMETRICS_API_KEY")) {
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: "Supermetrics API key is not configured. Add `SUPERMETRICS_API_KEY` to your environment variables.",
      });
    } else {
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: `Campaign query error: ${msg}`,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
