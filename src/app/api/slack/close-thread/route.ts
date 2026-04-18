import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { Sandbox } from "@vercel/sandbox";
import { kv } from "@/lib/kv-client";
import { agentThreadKey } from "@/app/api/agent/route";

export const maxDuration = 60;

function sandboxNameFor(threadTs: string) {
  return `reddy-gtm-${threadTs.replace(/\./g, "_")}`;
}

// Force-close a Reddy-GTM thread:
// - Stop the Vercel sandbox (compute goes cold → no further cost, snapshot
//   expires in 30 days)
// - Delete KV thread state so the next mention treats it as a first turn
//   (fresh Claude Code session ID → zero conversation memory carried over)
// - Post a confirmation to the thread
//
// Triggered by either a :end: reaction on any bot message OR "end thread"
// in an app_mention. Safe to call multiple times (all ops idempotent).
export async function POST(req: NextRequest) {
  const { slackChannel, slackThreadTs, slackEventTs } = (await req.json()) as {
    slackChannel: string;
    slackThreadTs: string;
    slackEventTs?: string;
  };

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const threadKey = agentThreadKey(slackThreadTs);
  const sandboxName = sandboxNameFor(slackThreadTs);

  const errors: string[] = [];

  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: true }).catch(() => null);
    if (sandbox) {
      await sandbox.stop().catch((err) => errors.push(`sandbox.stop: ${err instanceof Error ? err.message : String(err)}`));
    }
  } catch (err) {
    errors.push(`sandbox.get: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await kv.del(threadKey);
  } catch (err) {
    errors.push(`kv.del: ${err instanceof Error ? err.message : String(err)}`);
  }

  const msg = errors.length === 0
    ? ":end: *Thread closed.* Session history wiped, sandbox stopped. Tool access revoked — any new mention in this thread will start a fresh session scoped to the mentioning user."
    : `:end: Thread close partially failed:\n\`\`\`\n${errors.join("\n")}\n\`\`\``;

  await slack.chat.postMessage({
    channel: slackChannel,
    thread_ts: slackThreadTs,
    text: msg,
  }).catch((err) => console.error(`[close-thread] chat.postMessage failed: ${err}`));

  if (slackEventTs) {
    await slack.reactions.add({ channel: slackChannel, name: "white_check_mark", timestamp: slackEventTs })
      .catch(() => {});
  }

  return NextResponse.json({ ok: errors.length === 0, errors });
}
