import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { buildConnectMessage, resolveSlackEmailForConnect } from "@/lib/composio-connect";

export const maxDuration = 30;

// Slash command `/reddy-connect` — starts per-user OAuth flow for every
// Composio toolkit the operator has set up auth configs for.
// Slack posts application/x-www-form-urlencoded bodies.
//
// Response contract:
// - Ack within 3s (returned synchronously)
// - Then post real results back via response_url (DM-style, async)

async function postToResponseUrl(responseUrl: string, payload: Record<string, unknown>) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => console.error(`[connect] response_url POST failed: ${err}`));
}

export async function POST(req: NextRequest) {
  const body = await req.formData();
  const userId = body.get("user_id")?.toString();
  const responseUrl = body.get("response_url")?.toString();

  if (!userId || !responseUrl) {
    return NextResponse.json({ response_type: "ephemeral", text: "Missing Slack payload fields." });
  }

  (async () => {
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    const userEmail = await resolveSlackEmailForConnect(userId, slack);
    if (!userEmail) {
      await postToResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: "Couldn't find your email on Slack. Make sure your profile has an email and try again.",
      });
      return;
    }
    const text = await buildConnectMessage(userEmail);
    await postToResponseUrl(responseUrl, { response_type: "ephemeral", text });
  })().catch((err) => console.error(`[connect] async handler error: ${err}`));

  return NextResponse.json({
    response_type: "ephemeral",
    text: "Checking your connections…",
  });
}
