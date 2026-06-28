import { NextRequest, NextResponse, after } from "next/server";
import {
  verifySlackSignature,
  emailForSlackId,
  postToChannel,
  postToResponseUrl,
} from "@/lib/slack";
import {
  CONFIRM_ACTION_ID,
  getStoredProposal,
  executeProposal,
  proposalKeyForBot,
} from "@/lib/post-meeting";
import { kv } from "@/lib/kv-client";

// Slack Interactivity Request URL. Slack POSTs button clicks here as
// application/x-www-form-urlencoded with a single `payload` field (URL-encoded
// JSON). We verify the signature on the RAW body (mutating endpoint), ack
// within Slack's 3s window, and run the create in after() so it survives on
// Vercel. Configure this path as the app's Interactivity Request URL.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

type BlockAction = { action_id?: string; value?: string };
type SlackElement = { url?: string; [k: string]: unknown };
type SlackBlock = { type?: string; elements?: SlackElement[] };
type BlockActionsPayload = {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; blocks?: SlackBlock[] };
  response_url?: string;
  actions?: BlockAction[];
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (
    !verifySlackSignature(
      rawBody,
      req.headers.get("x-slack-signature"),
      req.headers.get("x-slack-request-timestamp")
    )
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: BlockActionsPayload;
  try {
    const encoded = new URLSearchParams(rawBody).get("payload");
    if (!encoded) return NextResponse.json({ error: "no payload" }, { status: 400 });
    payload = JSON.parse(encoded) as BlockActionsPayload;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const action = payload.actions?.[0];
  // Only the post-meeting confirm button is handled here; ack everything else.
  if (payload.type !== "block_actions" || action?.action_id !== CONFIRM_ACTION_ID) {
    return NextResponse.json({});
  }

  const botId = action.value ?? "";
  const channel = payload.channel?.id ?? null;
  const messageTs = payload.message?.ts ?? null;
  const threadTs = payload.message?.thread_ts ?? messageTs ?? undefined;
  const responseUrl = payload.response_url ?? null;
  const slackUserId = payload.user?.id ?? "";
  const originalBlocks = payload.message?.blocks ?? [];

  // Do the work after acking (DB writes + Slack posts exceed the 3s deadline).
  after(async () => {
    try {
      const proposal = await getStoredProposal(botId);
      if (!proposal) {
        if (channel) {
          await postToChannel(channel, {
            text: "⚠️ That proposal has expired — re-run the meeting triage to get a fresh set of suggestions.",
            threadTs,
          }).catch(() => {});
        }
        return;
      }

      const actorEmail =
        (await emailForSlackId(slackUserId)) ||
        process.env.POST_MEETING_AGENT_EMAIL ||
        "adam@reddy.io";

      const res = await executeProposal(proposal, actorEmail);

      const parts: string[] = [];
      if (res.created) parts.push(`${res.created} new task${res.created === 1 ? "" : "s"}`);
      if (res.subtasks) parts.push(`${res.subtasks} subtask${res.subtasks === 1 ? "" : "s"}`);
      if (res.updated) parts.push(`${res.updated} activity update${res.updated === 1 ? "" : "s"}`);
      if (res.skipped) parts.push(`${res.skipped} skipped (already created)`);
      const summary = parts.length ? parts.join(" · ") : "nothing to create";
      const who = `<@${slackUserId}>`;

      // Reply in-thread with the outcome.
      if (channel) {
        await postToChannel(channel, {
          text: `✅ Created on the board — ${summary}. (${who})${
            res.errors.length ? `\n⚠️ ${res.errors.length} error(s): ${res.errors.slice(0, 3).join("; ")}` : ""
          }`,
          threadTs,
        }).catch(() => {});
      }

      // Replace the original message in place: drop the Confirm button (keep the
      // shareable board links) and swap the instruction line for a created note.
      if (responseUrl) {
        const kept = originalBlocks
          .map((b) =>
            b.type === "actions"
              ? { type: "actions", elements: (b.elements ?? []).filter((e) => e.url) }
              : b
          )
          .filter((b) => !(b.type === "actions" && (!b.elements || b.elements.length === 0)));
        if (kept.length && kept[kept.length - 1].type === "context") kept.pop();
        kept.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `✅ *Created* — ${summary}. (${who})` }],
        } as SlackBlock);
        await postToResponseUrl(responseUrl, {
          replace_original: true,
          text: `Post-meeting tasks created — ${summary}.`,
          blocks: kept,
        });
      }

      // Idempotency: drop the proposal so a re-click / late text reply is a no-op.
      await kv.del(proposalKeyForBot(botId)).catch(() => {});
      if (messageTs) await kv.del(`postmeeting:proposal:${messageTs}`).catch(() => {});
    } catch (err) {
      if (channel) {
        await postToChannel(channel, {
          text: `⚠️ Couldn't create the tasks: ${err instanceof Error ? err.message : String(err)}`,
          threadTs,
        }).catch(() => {});
      }
    }
  });

  return NextResponse.json({});
}
