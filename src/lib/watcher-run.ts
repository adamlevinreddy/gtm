import { postToChannel, salesChannel, slackIdForEmail } from "@/lib/slack";
import { playRunPrompt, isPlayId, type PlayId } from "@/lib/plays";
import { runAgentAnswer } from "@/lib/proactive-run";
import {
  getWatch,
  markFired,
  markSatisfied,
  noteAttempt,
  type Watch,
} from "@/lib/watchers";

// Evaluate + fire a conditional follow-up. Runs the agent AS the watch owner
// (so it has their Gmail/HubSpot), which (1) checks the signal and (2) if the
// condition trips, drafts the follow-up as a real Gmail draft — never sends.
// The cron posts the "draft ready" card; nothing goes outbound autonomously.

// Slack action_ids for the fire card (unique prefix; handled in interactivity).
export const WATCH_ACTION_PREFIX = "watch_";
export const WATCH_EDIT_ACTION = "watch_edit";
export const WATCH_SNOOZE_ACTION = "watch_snooze";
export const WATCH_DISMISS_ACTION = "watch_dismiss";

function fmtDatePT(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

export type WatchVerdict = {
  tripped: boolean;
  reason: string;
  draftCreated: boolean;
  draftLink: string | null;
  preview: string | null;
};

export function buildWatchEvalPrompt(w: Watch): string {
  const since = fmtDatePT(w.anchor);
  const who = w.domain || w.account || "the account";
  const play = (isPlayId(w.play) ? w.play : "recap_email") as PlayId;
  const check =
    w.signal === "no_reply"
      ? `Search ${w.owner}'s Gmail for ANY inbound message from anyone at ${who} since ${since} (e.g. \`from:${w.domain || ""} after:${new Date(w.anchor).toISOString().slice(0, 10)}\`). If even one exists → NOT tripped (they replied). If none → TRIPPED.`
      : w.signal === "no_activity"
        ? `Check HubSpot for ${w.account || "the account"} — any activity since ${since} (inbound/outbound email, meeting, note, deal-stage change)? Also check the KB for any new meeting with them since ${since}. If ANY activity → NOT tripped. If none → TRIPPED.`
        : `This is a time-based reminder — it is ALWAYS tripped (no condition to check).`;
  return [
    `A "conditional follow-up" you (${w.owner}) set up is due for a check. You are running AS ${w.owner} and have their connected Gmail + HubSpot tools. Decide whether it should TRIP, and if so, prepare the draft. Do NOT send anything.`,
    ``,
    `WATCH:`,
    `  - account: ${w.account || "(unspecified)"}`,
    `  - what I asked: "${w.note}"`,
    `  - set up from: ${w.botId ? `meeting bot_id ${w.botId}` : "a chat request"}`,
    ``,
    `STEP 1 — CHECK THE CONDITION:`,
    `  ${check}`,
    `  If you do NOT have the tools to verify this (e.g. ${w.owner}'s Gmail/HubSpot isn't in your connected tools), do NOT guess — return tripped:false with reason "could not verify — connect Gmail/HubSpot via /reddy-connect".`,
    ``,
    `STEP 2 — ONLY IF TRIPPED, DRAFT (never send):`,
    `  Draft the follow-up: ${playRunPrompt(play, { botId: w.botId || undefined, account: w.account || undefined })}`,
    `  Keep it a light, warm nudge that references our last conversation. Then save it as a Gmail DRAFT in ${w.owner}'s mailbox using your Gmail tools (create-draft — do NOT send). If your Gmail tools return a draft URL/id, capture it. If you have no Gmail tool connected, skip the draft and just return the full draft text in "preview".`,
    ``,
    `RETURN ONLY a fenced json block, nothing else:`,
    "```json",
    `{ "tripped": true, "reason": "one line — e.g. 'no reply from ${who} since ${since}' or 'they replied Jul 9'", "draftCreated": true, "draftLink": "https://mail.google.com/... or null", "preview": "2-3 line preview of the drafted email, or the full text if no draft was created" }`,
    "```",
  ].join("\n");
}

export function parseWatchVerdict(answer: string | null): WatchVerdict | null {
  if (!answer) return null;
  const block = answer.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (block ? block[1] : answer).match(/\{[\s\S]*\}/);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw[0]) as Record<string, unknown>;
    return {
      tripped: o.tripped === true || o.tripped === "true",
      reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : "",
      draftCreated: o.draftCreated === true,
      draftLink: typeof o.draftLink === "string" && /^https?:\/\//.test(o.draftLink) ? o.draftLink : null,
      preview: typeof o.preview === "string" ? o.preview.slice(0, 1200) : null,
    };
  } catch {
    return null;
  }
}

function buildFireCard(w: Watch, v: WatchVerdict, ownerSlackId: string | null): { text: string; blocks: object[] } {
  const owner = ownerSlackId ? `<@${ownerSlackId}>` : `@${w.owner.split("@")[0]}`;
  const acct = w.account || "this account";
  const elements: object[] = [];
  if (v.draftLink) {
    elements.push({ type: "button", text: { type: "plain_text", text: "✉️ Open draft", emoji: true }, url: v.draftLink });
  }
  elements.push(
    { type: "button", action_id: WATCH_EDIT_ACTION, style: "primary" as const, text: { type: "plain_text", text: "✏️ Edit with me", emoji: true }, value: w.id },
    { type: "button", action_id: WATCH_SNOOZE_ACTION, text: { type: "plain_text", text: "🕒 Snooze 3d", emoji: true }, value: w.id },
    { type: "button", action_id: WATCH_DISMISS_ACTION, text: { type: "plain_text", text: "Dismiss", emoji: true }, value: w.id },
  );
  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: `⏰ *Follow-up ready — ${acct}* ${owner}\n_${v.reason}_` } },
  ];
  if (v.preview) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: v.draftCreated ? `Drafted in your Gmail:\n>${v.preview.replace(/\n/g, "\n>")}` : `Draft:\n>${v.preview.replace(/\n/g, "\n>")}` } });
  }
  blocks.push({ type: "actions", elements });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: v.draftLink ? "Open it to edit + send, or refine it with me. Nothing is sent until you do." : "Edit it with me or copy it out — nothing is sent until you do." }],
  });
  return { text: `⏰ Follow-up ready for ${acct} — ${v.reason}`, blocks };
}

export type RunWatchResult = { ok: boolean; tripped?: boolean; reason?: string; retried?: boolean; skipped?: string; error?: string };

export async function runWatch(input: Watch): Promise<RunWatchResult> {
  // Re-read + assert still pending, so a pathological overlap (another run
  // already fired/closed this since it was fetched into the due batch) can't
  // double-fire it.
  const w = (await getWatch(input.id)) ?? input;
  if (w.status !== "pending") return { ok: true, skipped: `status=${w.status}` };
  try {
    const answer = await runAgentAnswer(buildWatchEvalPrompt(w), {
      userEmail: w.owner, // run as the owner → their Gmail/HubSpot
      requestId: `watch:${w.id}`,
      pollTimeoutMs: 300_000,
    });
    const verdict = parseWatchVerdict(answer);
    if (!verdict) {
      await noteAttempt(w.id);
      return { ok: false, retried: true, error: "no parseable verdict" };
    }

    // Where to notify: the meeting card's thread for a watch armed from a
    // meeting; otherwise DM the owner (chat-armed watches carry no Slack context
    // — don't broadcast someone's private draft/close notes to #sales).
    const ownerSlackId = await slackIdForEmail(w.owner).catch(() => null);
    const channel = w.slackChannel || ownerSlackId || salesChannel();
    const threadTs = w.slackThreadTs || undefined;

    if (!verdict.tripped) {
      await markSatisfied(w.id);
      if (channel) {
        await postToChannel(channel, {
          text: `🔕 Closed the follow-up watch on *${w.account || "the account"}* — ${verdict.reason || "condition no longer applies"}.`,
          threadTs,
        }).catch(() => {});
      }
      return { ok: true, tripped: false, reason: verdict.reason };
    }

    if (channel) {
      const card = buildFireCard(w, verdict, ownerSlackId);
      await postToChannel(channel, { ...card, threadTs }).catch(() => {});
    }
    await markFired(w.id);
    return { ok: true, tripped: true, reason: verdict.reason };
  } catch (err) {
    await noteAttempt(w.id);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
