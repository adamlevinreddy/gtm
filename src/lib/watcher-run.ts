import { postToChannel, salesChannel, slackIdForEmail } from "@/lib/slack";
import { PLAYS, playRunPrompt, isPlayId, type PlayId } from "@/lib/plays";
import { selfBaseUrl } from "@/lib/work-items";
import { runAgentAnswer } from "@/lib/proactive-run";
import { getWatch, markFired, markSatisfied, noteAttempt, type Watch } from "@/lib/watchers";

// Evaluate a due conditional follow-up and, if it trips, FIRE ITS PLAY. Two
// phases: (1) a check that runs AS THE OWNER (their Gmail/HubSpot) and returns
// only a verdict; (2) if tripped, kick off the watch's chosen play in #sales as
// the owner — exactly like a play button — so a watch can fire ANY play (recap
// draft, pricing, RFP, catch-up, redline, …), each with its own normal output.
// Draft-only: the play posts to the thread and, for emails, saves a Gmail draft.
// Nothing is ever auto-sent, and no one's inbox but the owner's is read.

function fmtDatePT(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

export type WatchVerdict = { tripped: boolean; reason: string };

export function buildWatchEvalPrompt(w: Watch): string {
  const since = fmtDatePT(w.anchor);
  const who = w.domain || w.account || "the account";
  const check =
    w.signal === "no_reply"
      ? `Search ${w.owner}'s Gmail for ANY inbound message from anyone at ${who} since ${since} (e.g. \`from:${w.domain || ""} after:${new Date(w.anchor).toISOString().slice(0, 10)}\`). If even one exists → NOT tripped (they replied). If none → TRIPPED.`
      : w.signal === "no_activity"
        ? `Check HubSpot for ${w.account || "the account"} — any activity since ${since} (inbound/outbound email, meeting, note, deal-stage change)? Also check the KB for any new meeting with them since ${since}. If ANY activity → NOT tripped. If none → TRIPPED.`
        : `This is a time-based reminder — it is ALWAYS tripped (no condition to check).`;
  return [
    `A "conditional follow-up" you (${w.owner}) set up is due for a check. You are running AS ${w.owner} with their connected Gmail + HubSpot. Decide ONLY whether the condition has TRIPPED — do not draft anything yet.`,
    ``,
    `WATCH: account ${w.account || "(unspecified)"} · what I asked: "${w.note}" · set up ${w.botId ? `from meeting bot_id ${w.botId}` : "in chat"}`,
    ``,
    `CHECK: ${check}`,
    `If you do NOT have the tools to verify this (e.g. ${w.owner}'s Gmail/HubSpot isn't connected), do NOT guess — return tripped:false with reason "could not verify — connect Gmail/HubSpot via /reddy-connect".`,
    ``,
    `Return ONLY a fenced json block, nothing else:`,
    "```json",
    `{ "tripped": true, "reason": "one line — e.g. 'no reply from ${who} since ${since}' or 'they replied Jul 9'" }`,
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
    };
  } catch {
    return null;
  }
}

export type RunWatchResult = { ok: boolean; tripped?: boolean; reason?: string; retried?: boolean; skipped?: string; error?: string };

export async function runWatch(input: Watch): Promise<RunWatchResult> {
  // Re-read + assert still pending, so a pathological overlap (another run
  // already fired/closed this since it was fetched into the due batch) can't
  // double-fire it.
  const w = (await getWatch(input.id)) ?? input;
  if (w.status !== "pending") return { ok: true, skipped: `status=${w.status}` };
  try {
    // A time-only reminder has no condition to verify — skip the check pass.
    let verdict: WatchVerdict | null;
    if (w.signal === "time_only") {
      verdict = { tripped: true, reason: `scheduled reminder — ${w.note || "reach out"}` };
    } else {
      const answer = await runAgentAnswer(buildWatchEvalPrompt(w), {
        userEmail: w.owner, // check runs as the owner → their Gmail/HubSpot
        requestId: `watch:${w.id}`,
        pollTimeoutMs: 240_000, // a Gmail/HubSpot check is quick; the play fires async
      });
      verdict = parseWatchVerdict(answer);
    }
    if (!verdict) {
      await noteAttempt(w.id);
      return { ok: false, retried: true, error: "no parseable verdict" };
    }

    // Team sport: everything lands in #sales with the owner @-mentioned, so a
    // teammate can chime in ("they replied to me, you weren't copied"). Thread
    // into the meeting card's thread when armed in #sales, else top-level.
    const ownerSlackId = await slackIdForEmail(w.owner).catch(() => null);
    const owner = ownerSlackId ? `<@${ownerSlackId}>` : `@${w.owner.split("@")[0]}`;
    const channel = salesChannel();
    const threadTs = channel && w.slackChannel === channel ? w.slackThreadTs || undefined : undefined;

    if (!verdict.tripped) {
      await markSatisfied(w.id);
      if (channel) {
        await postToChannel(channel, {
          text: `🔕 ${owner} — closed the follow-up watch on *${w.account || "the account"}*: ${verdict.reason || "condition no longer applies"}.`,
          threadTs,
        }).catch(() => {});
      }
      return { ok: true, tripped: false, reason: verdict.reason };
    }

    // Tripped → fire the chosen play into #sales, AS THE OWNER (so it uses their
    // Gmail to draft/save). Any play works — the play posts its own output.
    const playId: PlayId = isPlayId(w.play) ? w.play : "recap_email";
    const label = PLAYS[playId].label;
    if (channel) {
      let fireThread = threadTs;
      const intro = await postToChannel(channel, {
        text: `⏰ ${owner} — *${w.account || "this account"}*: ${verdict.reason}. Kicking off *${label}*…`,
        threadTs: fireThread,
      }).catch(() => null);
      // With no meeting thread, thread the play under this intro message.
      if (!fireThread && intro?.ts) fireThread = intro.ts;
      const secret = process.env.BOARD_API_SECRET;
      if (secret) {
        const prompt = `${playRunPrompt(playId, { botId: w.botId || undefined, account: w.account || undefined })}\n\n[This is an automated conditional follow-up that just tripped: ${verdict.reason}. If this produces an email, ALSO save it as a Gmail draft in the mailbox (do NOT send) and share the draft link. Post the result in this thread.]`;
        // Slack lane, as the owner (slackUser → their email → their Composio).
        await fetch(`${selfBaseUrl()}/api/agent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-board-secret": secret },
          body: JSON.stringify({ userText: prompt, slackChannel: channel, slackThreadTs: fireThread, slackUser: ownerSlackId ?? undefined }),
        }).catch(() => {});
      }
    }
    await markFired(w.id);
    return { ok: true, tripped: true, reason: verdict.reason };
  } catch (err) {
    await noteAttempt(w.id);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
