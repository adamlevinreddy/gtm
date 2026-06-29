// ============================================================================
// bot@reddy.io — the Gmail surface of the shared agent primitive.
//
// An @reddy.io teammate emails bot@reddy.io → we run the SAME sandbox agent
// (/api/agent/oneshot) AS the sender (so it uses THEIR HubSpot/board/calendar/
// Granola tools and attributes any writes to them) → the agent does the work
// and/or takes actions → we email the result back to the sender, FROM the bot
// mailbox (pure transport), threaded on the original message.
//
// Identity rule: the agent runs as the SENDER; the bot mailbox is only the
// inbound channel + reply-from address. See the meetings-view chat for the same
// "resolve a human, run as them" pattern.
// ============================================================================

import { composio } from "@/lib/composio";
import { selfBaseUrl } from "@/lib/work-items";

export const BOT_ADDR = (process.env.BOT_MAIL_ADDRESS || "bot@reddy.io").toLowerCase();
const ALLOWED_DOMAIN = "reddy.io";

export type InboundMail = {
  from: string; // bare lower-cased address
  subject: string;
  body: string;
  messageId: string;
  threadId: string | null;
};

/** Extract the bare address from a From header ("Name <a@b>" or "a@b"). */
export function parseFromAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

/** Gate: only real @reddy.io senders, and never the bot itself (no self-loop). */
export function isAllowedSender(addr: string | null): addr is string {
  if (!addr) return false;
  if (addr === BOT_ADDR) return false; // ignore our own/sent mail
  return new RegExp(`^[^@\\s]+@${ALLOWED_DOMAIN.replace(".", "\\.")}$`, "i").test(addr);
}

function buildEmailPrompt(m: InboundMail): string {
  return [
    `You are Reddy-GTM, answering an internal email. This run is acting AS ${m.from} —`,
    `your Composio tools (Gmail, Google Calendar, Drive, HubSpot), Granola, and the`,
    `board (board_* tools) are scoped to ${m.from}'s connections and permissions, and`,
    `any board/HubSpot write is attributed to them.`,
    ``,
    `DELIVERY: you are NOT in Slack — there is no Slack channel here. Do the work and`,
    `put your COMPLETE final answer in your last message; it is emailed back to`,
    `${m.from} verbatim. Write it as a clear, self-contained email reply (greeting`,
    `optional, no internal reasoning). For a file deliverable, link to the artifact.`,
    ``,
    `If the email asks you to UPDATE something — HubSpot, the board (create/update a`,
    `task), or their calendar — do it with your tools, following the usual guardrails:`,
    `customer-facing content is draft/suggest-only (never auto-send email on their`,
    `behalf); before board_create, board_list first and update a near-duplicate`,
    `instead of duplicating; confirm-first for risky/destructive changes. Then state`,
    `exactly what you did in your reply.`,
    ``,
    `From: ${m.from}`,
    `Subject: ${m.subject}`,
    ``,
    m.body,
  ].join("\n");
}

async function runOneshot(question: string, userEmail: string): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      // Leave headroom under the route's 800s maxDuration for the reply send.
      body: JSON.stringify({ question, userEmail, pollTimeoutMs: 650_000 }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    return json?.ok && json.answer ? json.answer : null;
  } catch {
    return null;
  }
}

// Send a reply FROM bot@reddy.io. Uses the bot's own Composio Gmail connection
// (the same mailbox the inbound trigger watches) — NOT the sender's. Replies in
// the original thread when a threadId is known, else a fresh email.
export async function sendBotEmail(opts: {
  to: string;
  subject: string;
  bodyText: string;
  threadId?: string | null;
}): Promise<boolean> {
  try {
    if (opts.threadId) {
      await composio().tools.execute("GMAIL_REPLY_TO_THREAD", {
        userId: BOT_ADDR,
        arguments: {
          thread_id: opts.threadId,
          recipient_email: opts.to,
          message_body: opts.bodyText,
          is_html: false,
        },
      });
    } else {
      await composio().tools.execute("GMAIL_SEND_EMAIL", {
        userId: BOT_ADDR,
        arguments: {
          recipient_email: opts.to,
          subject: opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`,
          body: opts.bodyText,
          is_html: false,
        },
      });
    }
    return true;
  } catch (err) {
    console.error(`[bot-mail] send failed to ${opts.to}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Full inbound flow: run the agent as the sender, email the result back from the
// bot mailbox. Runs in the webhook's after() (or a worker). Never throws.
export async function processInboundMail(m: InboundMail): Promise<void> {
  const subject = m.subject || "(no subject)";
  let answer: string | null = null;
  try {
    answer = await runOneshot(buildEmailPrompt(m), m.from);
  } catch {
    /* fall through to failure reply */
  }
  const bodyText =
    answer ??
    "I couldn't complete that in time — reply to retry, or ping @Reddy-GTM in Slack.";
  await sendBotEmail({ to: m.from, subject, bodyText, threadId: m.threadId });
}
