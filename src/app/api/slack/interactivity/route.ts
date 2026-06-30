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
import {
  CRM_APPLY_ACTION_ID,
  getStoredCrmProposal,
  executeCrmProposal,
  crmProposalKey,
} from "@/lib/post-meeting-crm";
import { boardLink } from "@/lib/work-items";
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
  const actionId = action?.action_id;
  // Only the post-meeting buttons are handled here; ack everything else.
  if (payload.type !== "block_actions" || (actionId !== CONFIRM_ACTION_ID && actionId !== CRM_APPLY_ACTION_ID)) {
    return NextResponse.json({});
  }

  const botId = action?.value ?? "";
  const channel = payload.channel?.id ?? null;
  const messageTs = payload.message?.ts ?? null;
  const threadTs = payload.message?.thread_ts ?? messageTs ?? undefined;
  const responseUrl = payload.response_url ?? null;
  const slackUserId = payload.user?.id ?? "";
  const originalBlocks = payload.message?.blocks ?? [];

  // Helper to swap a message's action button for an "applied/created" note.
  const markApplied = async (note: string) => {
    if (!responseUrl) return;
    const kept = originalBlocks
      .map((b) => (b.type === "actions" ? { type: "actions", elements: (b.elements ?? []).filter((e) => e.url) } : b))
      .filter((b) => !(b.type === "actions" && (!b.elements || b.elements.length === 0)));
    if (kept.length && kept[kept.length - 1].type === "context") kept.pop();
    kept.push({ type: "context", elements: [{ type: "mrkdwn", text: note }] } as SlackBlock);
    await postToResponseUrl(responseUrl, { replace_original: true, text: note.replace(/[*<>]/g, ""), blocks: kept });
  };

  // Do the work after acking (DB writes + Slack posts exceed the 3s deadline).
  after(async () => {
    // ---- CRM apply (HubSpot stage/field updates; gated to the allowlist) ----
    if (actionId === CRM_APPLY_ACTION_ID) {
      try {
        const proposal = await getStoredCrmProposal(botId);
        if (!proposal) {
          if (channel) await postToChannel(channel, { text: "⚠️ That CRM suggestion expired — re-run the meeting sync.", threadTs }).catch(() => {});
          return;
        }
        const who = `<@${slackUserId}>`;
        const result = await executeCrmProposal(proposal);
        const parts: string[] = [];
        if (result.stageMoved && proposal.suggestedStageLabel) parts.push(`stage → *${proposal.suggestedStageLabel}*`);
        if (result.fieldsUpdated) parts.push(`${result.fieldsUpdated} field${result.fieldsUpdated === 1 ? "" : "s"} updated`);
        const summary = parts.length ? parts.join(" · ") : "no changes applied";
        if (channel) {
          await postToChannel(channel, {
            text: `✅ HubSpot updated on *${proposal.companyName}* — ${summary}. (${who})${
              result.errors.length ? `\n⚠️ ${result.errors.slice(0, 3).join("; ")}` : ""
            }`,
            threadTs,
          }).catch(() => {});
        }
        await markApplied(`✅ *Applied to HubSpot* — ${summary}. (${who})`);
        await kv.del(crmProposalKey(botId)).catch(() => {});
        // The proposal is stashed under the THREAD-ROOT ts; delete that (not the
        // clicked message's ts, which may be a re-posted edit reply).
        if (threadTs) await kv.del(`postmeeting:crm:ts:${threadTs}`).catch(() => {});
      } catch (err) {
        if (channel) await postToChannel(channel, { text: `⚠️ Couldn't apply the CRM updates: ${err instanceof Error ? err.message : String(err)}`, threadTs }).catch(() => {});
      }
      return;
    }

    // ---- Task confirm (board creation) ----
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
          text: `✅ Created on the board — ${summary}. (${who})\n📋 <${boardLink({})}|View on the board>${
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
