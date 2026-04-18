import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { buildConnectMessage, resolveSlackEmailForConnect } from "@/lib/composio-connect";

export const maxDuration = 120;

// Internal handler for "@Reddy-GTM set me up" — called fire-and-forget from
// /api/slack/events. Matches the existing Reddy-GTM pattern for heavy work
// that can't fit in Slack's 3s event ack window.
//
// Body: { slackUserId, slackChannel, slackEventTs, slackThreadTs }
export async function POST(req: NextRequest) {
  const { slackUserId, slackChannel, slackEventTs, slackThreadTs } =
    (await req.json()) as {
      slackUserId: string;
      slackChannel: string;
      slackEventTs: string;
      slackThreadTs?: string;
    };

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const threadTs = slackThreadTs || slackEventTs;

  try {
    const userEmail = await resolveSlackEmailForConnect(slackUserId, slack);
    if (!userEmail) {
      await slack.chat.postMessage({
        channel: slackChannel,
        thread_ts: threadTs,
        text: "Couldn't find your email on Slack. Make sure your profile has an email and try again.",
      });
      await slack.reactions.remove({ channel: slackChannel, name: "wave", timestamp: slackEventTs }).catch(() => {});
      await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackEventTs }).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    const body = await buildConnectMessage(userEmail);
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: threadTs,
      text: body,
    });
    await slack.reactions.remove({ channel: slackChannel, name: "wave", timestamp: slackEventTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackEventTs }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[set-me-up] failed: ${err instanceof Error ? (err.stack || err.message) : err}`);
    await slack.reactions.remove({ channel: slackChannel, name: "wave", timestamp: slackEventTs }).catch(() => {});
    await slack.reactions.add({ channel: slackChannel, name: "x", timestamp: slackEventTs }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: threadTs,
      text: `Setup hit an error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
