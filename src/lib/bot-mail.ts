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

import { randomUUID } from "node:crypto";
import { composio } from "@/lib/composio";
import { kv } from "@/lib/kv-client";
import { readKbFileBytes, commitToKb } from "@/lib/github-kb";
import { selfBaseUrl } from "@/lib/work-items";
import { postToChannel, salesChannel } from "@/lib/slack";

type MailAttachment = { name: string; mimetype: string; kbPath: string };

export const BOT_ADDR = (process.env.BOT_MAIL_ADDRESS || "bot@reddy.io").toLowerCase();
const ALLOWED_DOMAIN = "reddy.io";

// A reply we still owe the sender. Recorded the moment we kick the agent so the
// deliver-on-completion cron (/api/cron/bot-mail) can finish the job even if the
// agent outruns the inline wait or this function dies. Keyed by the agent run id
// → the answer lands at `mcp:result:{id}`.
type PendingMail = { to: string; cc?: string[]; subject: string; threadId: string | null; createdAt: number };
const pendingKey = (id: string) => `botmail:pending:${id}`;
// Pending ≥ result TTL (3h, set in the driver) so a live pending record always
// has its result available; both comfortably exceed MAX_DELIVER_WAIT_MS.
const PENDING_TTL_SECONDS = 3 * 60 * 60;
// Inline wait before we hand off to the cron (snappy replies for normal asks;
// heavy multi-tool runs like proposals deliver via the cron when they finish).
const INLINE_POLL_MS = 300_000;
// Cron gives up and sends a timeout note after this if no result ever lands.
const MAX_DELIVER_WAIT_MS = 40 * 60 * 1000;

// Exactly-once delivery claim. The inline path AND the cron can both observe a
// completed result for the same run (e.g. a cron tick fires while the inline
// poll is finishing, or the inline kv.del(pending) failed). Whoever wins this
// nx claim sends; the loser stands down — so the sender never double-emails.
// Released on a send FAILURE so a retry can re-claim.
const sentKey = (id: string) => `botmail:sent:${id}`;
async function claimDelivery(id: string): Promise<boolean> {
  const r = await kv.set(sentKey(id), new Date().toISOString(), { nx: true, ex: 24 * 60 * 60 }).catch(() => null);
  return r !== null;
}
async function releaseDelivery(id: string): Promise<void> {
  await kv.del(sentKey(id)).catch(() => {});
}
const NO_SUMMARY_NOTE =
  "I worked on this but didn't capture a written summary — any changes I made are on the board / in HubSpot. Reply if you'd like the details.";
const TIMEOUT_NOTE = "I couldn't finish that in time. Reply to retry, or ping @Reddy-GTM in Slack.";

export type InboundMail = {
  from: string; // bare lower-cased address
  subject: string;
  body: string;
  messageId: string;
  threadId: string | null;
};

/** Extract the bare address from a From header. The REAL addr-spec is the LAST
 * <...> group; the display name is attacker-controlled and may inject a quoted
 * "<a@reddy.io>" to fake the gate — so strip quoted display names first, then
 * take the last bracket. ('Name <a@b>'→a@b, 'a@b'→a@b, spoofed name-addr→real). */
export function parseFromAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const noQuotes = raw.replace(/"(?:[^"\\]|\\.)*"/g, " "); // drop quoted display names
  const m = [...noQuotes.matchAll(/<([^>]+)>/g)];
  const addr = (m.length ? m[m.length - 1][1] : noQuotes).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

/** Gate: only real @reddy.io senders, and never the bot itself (no self-loop). */
export function isAllowedSender(addr: string | null): addr is string {
  if (!addr) return false;
  if (addr === BOT_ADDR) return false; // ignore our own/sent mail
  return new RegExp(`^[^@\\s]+@${ALLOWED_DOMAIN.replace(".", "\\.")}$`, "i").test(addr);
}

// org-domain (relaxed) alignment to reddy.io: reddy.io or any subdomain of it.
const REDDY_ALIGNED_RE = /(^|\.)reddy\.io$/i;

/**
 * Decide whether Gmail's Authentication-Results verdict PROVES the message
 * genuinely came from reddy.io (vs. a forged `From: someone@reddy.io`).
 *
 * Primary: `dmarc=pass` — DMARC pass requires SPF or DKIM to pass AND be aligned
 * to the From domain, so it's the real proof of origin. Google evaluates this on
 * every inbound message regardless of the domain's *published* DMARC policy, so
 * we get reject-grade certainty even while reddy.io is at p=quarantine.
 * Defensive fallback: `dkim=pass` with `header.d` aligned to reddy.io.
 * A bare `dkim=pass` (unaligned) is NOT trusted — a spoofer can DKIM-sign from
 * their own domain while forging the From.
 */
export function authResultsTrusted(authRes: string | null | undefined): boolean {
  if (!authRes) return false;
  const a = authRes.toLowerCase();
  if (/\bdmarc=pass\b/.test(a)) return true;
  if (/\bdkim=pass\b/.test(a)) {
    const m = a.match(/header\.d=([a-z0-9.\-]+)/);
    if (m && REDDY_ALIGNED_RE.test(m[1])) return true;
  }
  return false;
}

// Recursively find a header value by name in an arbitrary Composio/Gmail
// response shape (e.g. {data:{payload:{headers:[{name,value}]}}}).
function findHeaderValue(obj: unknown, headerName: string): string | null {
  const target = headerName.toLowerCase();
  let found: string | null = null;
  const visit = (v: unknown): void => {
    if (found != null || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && o.name.toLowerCase() === target && typeof o.value === "string") {
      found = o.value;
      return;
    }
    for (const k of Object.keys(o)) visit(o[k]);
  };
  visit(obj);
  return found;
}

/**
 * Pull the stored message's Authentication-Results header — the trigger payload
 * usually omits it, so we read it straight from the bot mailbox. Best-effort:
 * null on any failure (the webhook decides whether a null verdict fails open).
 */
export async function fetchAuthResults(messageId: string): Promise<string | null> {
  if (!messageId) return null;
  try {
    const res = await composio().tools.execute("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      userId: BOT_ADDR,
      arguments: { message_id: messageId, format: "full" },
      // Composio requires a toolkit version on manual execute(); "latest" is
      // rejected as not-specific, so we skip the pin and run the current version
      // (fine for stable Gmail ops — see the same flag on the send calls below).
      dangerouslySkipVersionCheck: true,
    });
    return findHeaderValue(res, "Authentication-Results");
  } catch (err) {
    console.warn(`[bot-mail] fetchAuthResults failed for ${messageId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function buildEmailPrompt(m: InboundMail): string {
  return [
    `You are Reddy-GTM, answering an internal email. This run is acting AS ${m.from} —`,
    `your Composio tools (Gmail, Google Calendar, Drive, HubSpot), Granola, and the`,
    `board (board_* tools) are scoped to ${m.from}'s connections and permissions, and`,
    `any board/HubSpot write is attributed to them.`,
    ``,
    `DELIVERY: you are NOT in Slack — there is no Slack channel. Put your COMPLETE`,
    `final answer in a SINGLE post_slack_message call (it is captured and emailed back`,
    `to ${m.from} verbatim — do NOT split it between a tool call and a trailing message,`,
    `and do not assume it posts to Slack). Write it as a clear, self-contained email`,
    `reply (greeting optional, no internal reasoning). For a FILE deliverable (a PDF`,
    `you generate, etc.), call upload_slack_pdf(filePath, title) — on this email lane`,
    `it becomes a real email ATTACHMENT on the reply. Prefer attaching over linking.`,
    ``,
    `If the email asks you to UPDATE something — HubSpot, the board (create/update a`,
    `task), or their calendar — do it with your tools, following the usual guardrails:`,
    `customer-facing content is draft/suggest-only (never auto-send email on their`,
    `behalf); before board_create, board_list first and update a near-duplicate`,
    `instead of duplicating; confirm-first for risky/destructive changes. Then state`,
    `exactly what you did in your reply. If a request needs a tool you can't see`,
    `(not connected), say so in the reply and tell them to reply "connect <tool>" —`,
    `do NOT reference Slack commands; this person is on email.`,
    ``,
    `From: ${m.from}`,
    `Subject: ${m.subject}`,
    ``,
    m.body,
  ].join("\n");
}

async function runOneshot(
  question: string,
  userEmail: string,
  requestId: string,
): Promise<{ ok: boolean; answer: string | null; attachments?: MailAttachment[] }> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return { ok: false, answer: null };
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      // lane:"email" unlocks file attachments in the driver. Pass our own
      // requestId so the answer lands at a key we already know — if the agent
      // outruns this inline poll, the deliver cron picks it up. Abort a bit past
      // the poll so we stay inside the webhook's maxDuration.
      body: JSON.stringify({ question, userEmail, requestId, lane: "email", pollTimeoutMs: INLINE_POLL_MS }),
      signal: AbortSignal.timeout(INLINE_POLL_MS + 40_000),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; answer?: string; attachments?: MailAttachment[] }
      | null;
    return {
      ok: !!json?.ok,
      answer: json?.ok && json.answer ? json.answer : null,
      attachments: json?.attachments,
    };
  } catch {
    return { ok: false, answer: null };
  }
}

// Send a reply FROM bot@reddy.io. Uses the bot's own Composio Gmail connection
// (the same mailbox the inbound trigger watches) — NOT the sender's. Replies in
// the original thread when a threadId is known, else a fresh email.
export async function sendBotEmail(opts: {
  to: string;
  cc?: string[];
  subject: string;
  bodyText: string;
  threadId?: string | null;
  attachments?: MailAttachment[];
}): Promise<boolean> {
  // Reply-all: keep the original @reddy.io participants in the loop. Only set cc
  // when non-empty so we never send an empty/invalid arg.
  const cc = (opts.cc ?? []).filter(Boolean);
  const ccArg = cc.length ? { cc } : {};

  // Stage attachments into Composio's S3 (the backend rejects raw bytes — it
  // needs a {name,mimetype,s3key} descriptor from files.upload). Bytes come from
  // the KB (binary-safe reader). A staging failure must NEVER drop the email —
  // we send the text + a note and leave the KB copy for a retry.
  let bodyText = opts.bodyText;
  let attachmentArg: Record<string, unknown> = {};
  const deliveredPaths: string[] = [];
  if (opts.attachments?.length) {
    const pat = process.env.PRICING_LIBRARY_GITHUB_PAT ?? "";
    const filesApi = (composio() as unknown as {
      files: { upload: (a: { file: File; toolSlug: string; toolkitSlug: string }) => Promise<{ name: string; mimetype: string; s3key: string }> };
    }).files;
    const staged: Array<{ name: string; mimetype: string; s3key: string }> = [];
    for (const a of opts.attachments) {
      try {
        const bytes = pat ? await readKbFileBytes(pat, a.kbPath) : null;
        if (!bytes) { console.warn(`[bot-mail] attachment bytes missing for ${a.kbPath}`); continue; }
        if (bytes.length > 24 * 1024 * 1024) { console.warn(`[bot-mail] attachment ${a.name} too large (${bytes.length}b) — skipping`); continue; }
        // Copy into a fresh ArrayBuffer-backed view (Buffer's ArrayBufferLike
        // isn't assignable to BlobPart under strict lib types).
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const file = new File([ab], a.name, { type: a.mimetype });
        const up = await filesApi.upload({ file, toolSlug: "GMAIL_SEND_EMAIL", toolkitSlug: "gmail" });
        staged.push(up);
        deliveredPaths.push(a.kbPath);
      } catch (err) {
        console.error(`[bot-mail] stage attachment failed (${a.name}): ${err instanceof Error ? err.message : err}`);
      }
    }
    if (staged.length) attachmentArg = { attachment: staged.length === 1 ? staged[0] : staged };
    const missed = opts.attachments.length - staged.length;
    if (missed > 0) bodyText += `\n\n(Note: ${missed} file${missed === 1 ? "" : "s"} couldn't be attached — reply and I'll resend.)`;
  }

  try {
    if (opts.threadId) {
      await composio().tools.execute("GMAIL_REPLY_TO_THREAD", {
        userId: BOT_ADDR,
        arguments: {
          thread_id: opts.threadId,
          recipient_email: opts.to,
          message_body: bodyText,
          is_html: false,
          ...ccArg,
          ...attachmentArg,
        },
        dangerouslySkipVersionCheck: true, // run current toolkit version (see fetchAuthResults)
      });
    } else {
      await composio().tools.execute("GMAIL_SEND_EMAIL", {
        userId: BOT_ADDR,
        arguments: {
          recipient_email: opts.to,
          subject: opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`,
          body: bodyText,
          is_html: false,
          ...ccArg,
          ...attachmentArg,
        },
        dangerouslySkipVersionCheck: true, // run current toolkit version (see fetchAuthResults)
      });
    }
    // Sent OK — drop the transient KB copies so mail-attachments/ doesn't bloat
    // the cold-start clone every sandbox does. Best-effort.
    if (deliveredPaths.length) {
      const pat = process.env.PRICING_LIBRARY_GITHUB_PAT ?? "";
      if (pat) {
        await commitToKb({ pat, message: "mail attachment delivered — purge", files: deliveredPaths.map((p) => ({ path: p, delete: true })) }).catch(() => {});
      }
    }
    return true;
  } catch (err) {
    console.error(`[bot-mail] send failed to ${opts.to}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Pull every email address out of a To/Cc header value
// ("Name <a@x>, b@y" → ["a@x","b@y"]). Lower-cased + deduped.
function parseAddressList(header: string): string[] {
  const out = new Set<string>();
  for (const m of header.matchAll(/<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g)) {
    const a = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) out.add(a);
  }
  return [...out];
}

// Resolve who else (besides the sender) should stay on the reply: the original
// To + Cc recipients, restricted to @reddy.io (the bot is internal-only, so any
// external CC is intentionally dropped) and minus the bot itself + the sender.
// Reads the stored message's headers; best-effort (empty on any failure).
async function replyAllCc(messageId: string, sender: string): Promise<string[]> {
  if (!messageId) return [];
  try {
    const res = await composio().tools.execute("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      userId: BOT_ADDR,
      arguments: { message_id: messageId, format: "full" },
      dangerouslySkipVersionCheck: true,
    });
    const recips = [
      ...parseAddressList(findHeaderValue(res, "To") ?? ""),
      ...parseAddressList(findHeaderValue(res, "Cc") ?? ""),
    ];
    return [...new Set(recips)].filter(
      (a) => /@reddy\.io$/i.test(a) && a !== BOT_ADDR && a !== sender,
    );
  } catch {
    return [];
  }
}

// Auto-reply / mailing-list / bounce detection from the inbound headers, to
// stop mail loops with other auto-responders (the per-sender rate limit in the
// webhook is the hard backstop; this avoids even one needless round-trip).
export function looksAutomated(headers: Record<string, unknown> | undefined, subject: string): boolean {
  const h = (k: string) => String(headers?.[k] ?? headers?.[k.toLowerCase()] ?? "").toLowerCase();
  if (/auto/.test(h("Auto-Submitted"))) return true;
  if (/(bulk|auto_reply|auto-reply|junk|list)/.test(h("Precedence"))) return true;
  if (h("X-Auto-Response-Suppress") || h("List-Id") || h("List-Unsubscribe")) return true;
  if (/^(auto(matic)?[- ]?reply|out of office|undeliverable|delivery status|mailer-daemon)/i.test(subject)) return true;
  return false;
}

async function alertSendFailure(to: string, subject: string): Promise<void> {
  const ch = salesChannel();
  if (ch) {
    await postToChannel(ch, {
      text: `⚠️ bot@reddy.io couldn't email a reply to ${to} (re: ${subject}). Check the bot's Gmail connection.`,
    }).catch(() => {});
  }
}

// Full inbound flow: run the agent as the sender, email the result back from the
// bot mailbox. Runs in the webhook's after(). Never throws.
//
// Deliver-on-completion: we record a PENDING reply (keyed by a run id we mint)
// BEFORE kicking the agent, then wait inline only for the snappy case. If the
// agent outruns the inline wait, we leave the pending record — the deliver cron
// finishes the job when `mcp:result:{id}` lands. This is why a heavy proposal no
// longer gets a premature "couldn't finish" reply.
export async function processInboundMail(m: InboundMail): Promise<void> {
  const subject = m.subject || "(no subject)";
  const requestId = randomUUID();
  // Reply-all: keep the original @reddy.io participants on the thread.
  const cc = await replyAllCc(m.messageId, m.from);
  if (cc.length) console.log(`[bot-mail] reply-all cc for ${m.from}: ${cc.join(", ")}`);
  await kv
    .set(pendingKey(requestId), { to: m.from, cc, subject, threadId: m.threadId, createdAt: Date.now() } as PendingMail, {
      ex: PENDING_TTL_SECONDS,
    })
    .catch(() => {});

  let result: { ok: boolean; answer: string | null; attachments?: MailAttachment[] } = { ok: false, answer: null };
  try {
    result = await runOneshot(buildEmailPrompt(m), m.from, requestId);
  } catch {
    /* inline run failed/aborted — the agent may still be running; cron delivers */
  }

  // Fast path: a written answer (or a no-summary "ran-but-no-text") came back in
  // time → reply now and clear the pending record. A failed SEND leaves pending
  // so the cron retries (and we alert).
  if (result.answer || result.ok) {
    // Exactly-once: stand down if the cron already delivered this run.
    if (!(await claimDelivery(requestId))) {
      await kv.del(pendingKey(requestId)).catch(() => {});
      return;
    }
    const bodyText = result.answer ?? NO_SUMMARY_NOTE;
    const sent = await sendBotEmail({ to: m.from, cc, subject, bodyText, threadId: m.threadId, attachments: result.attachments });
    if (sent) {
      await kv.del(pendingKey(requestId)).catch(() => {});
    } else {
      await releaseDelivery(requestId); // allow the cron to retry
      await alertSendFailure(m.from, subject);
    }
    return;
  }

  // Inline wait elapsed and no result yet — the agent is likely still working.
  // Do NOT send a premature failure; the deliver cron will email the answer when
  // it lands (or a timeout note if it never does).
  console.log(`[bot-mail] inline wait elapsed for ${m.from} (req=${requestId}); deferred to deliver cron`);
}

// Called by /api/cron/bot-mail. Finishes any reply whose agent run has completed
// (or times it out after MAX_DELIVER_WAIT_MS). Never throws.
export async function deliverPendingMail(): Promise<{ delivered: number; timedOut: number; waiting: number }> {
  let delivered = 0;
  let timedOut = 0;
  let waiting = 0;
  let keys: string[] = [];
  try {
    keys = await kv.keys("botmail:pending:*");
  } catch {
    keys = [];
  }
  for (const key of keys.slice(0, 25)) {
    const p = await kv.get<PendingMail>(key).catch(() => null);
    if (!p) {
      await kv.del(key).catch(() => {});
      continue;
    }
    const id = key.slice("botmail:pending:".length);
    const result = await kv
      .get<{ ok?: boolean; answer?: string; attachments?: MailAttachment[] }>(`mcp:result:${id}`)
      .catch(() => null);
    if (result) {
      // Exactly-once: if the inline path already delivered this run, just clean
      // up the (orphaned) pending record instead of sending again.
      if (!(await claimDelivery(id))) {
        await kv.del(key).catch(() => {});
        continue;
      }
      const bodyText = result.answer ? result.answer : result.ok ? NO_SUMMARY_NOTE : TIMEOUT_NOTE;
      const sent = await sendBotEmail({ to: p.to, cc: p.cc, subject: p.subject, bodyText, threadId: p.threadId, attachments: result.attachments });
      if (sent) {
        await kv.del(key).catch(() => {});
        delivered += 1;
      } else {
        await releaseDelivery(id); // allow a later tick to retry
        await alertSendFailure(p.to, p.subject);
        waiting += 1;
      }
    } else if (Date.now() - p.createdAt > MAX_DELIVER_WAIT_MS) {
      // Gave up waiting — send the timeout note once (claim guards against a
      // late inline send racing it).
      if (await claimDelivery(id)) {
        await sendBotEmail({ to: p.to, cc: p.cc, subject: p.subject, bodyText: TIMEOUT_NOTE, threadId: p.threadId });
      }
      await kv.del(key).catch(() => {});
      timedOut += 1;
    } else {
      waiting += 1;
    }
  }
  return { delivered, timedOut, waiting };
}
