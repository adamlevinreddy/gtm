import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { WebClient } from "@slack/web-api";
import { answerCampaignQuestion } from "@/lib/supermetrics";

export const maxDuration = 300;

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

// Fire-and-forget: return a 200 immediately so the caller's curl/fetch
// doesn't time out waiting for the Supermetrics MCP + Claude tool-use loop
// (which can easily take 60-90s over 15 iterations). Actual work runs via
// next/server after() which keeps the function alive until maxDuration.
//
// The handler posts results DIRECTLY to the Slack thread when it finishes;
// the caller never needs to await the answer.
export async function POST(req: NextRequest) {
  const { question, slackChannel, slackThreadTs } = (await req.json()) as {
    question: string;
    slackChannel: string;
    slackThreadTs: string;
  };

  if (!question || !slackChannel || !slackThreadTs) {
    return NextResponse.json(
      { ok: false, error: "question, slackChannel, slackThreadTs required" },
      { status: 400 },
    );
  }

  after(async () => {
    const slack = getSlackClient();
    try {
      const answer = await answerCampaignQuestion(question);
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: answer,
      });
      await slack.reactions.remove({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs }).catch(() => {});
      await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackThreadTs }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[campaign] ${msg}`);
      await slack.reactions.remove({ channel: slackChannel, name: "bar_chart", timestamp: slackThreadTs }).catch(() => {});
      await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackThreadTs }).catch(() => {});
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: slackThreadTs,
        text: msg.includes("SUPERMETRICS_API_KEY")
          ? "Supermetrics API key is not configured. Add `SUPERMETRICS_API_KEY` to your environment variables."
          : `Campaign query error: ${msg}`,
      }).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true, queued: true });
}
