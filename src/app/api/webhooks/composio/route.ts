import { NextRequest, NextResponse, after } from "next/server";
import { composio } from "@/lib/composio";
import { kv } from "@/lib/kv-client";
import { parseFromAddress, isAllowedSender, looksAutomated, authResultsTrusted, fetchAuthResults, processInboundMail, type InboundMail } from "@/lib/bot-mail";

// Composio trigger webhook — Gmail "new message" events for bot@reddy.io land
// here. Composio signs them (Svix); triggers.parse() verifies + parses. We gate
// to @reddy.io senders, dedupe on the Gmail message id, ack fast, and run the
// agent + email the reply in after() (within this route's maxDuration).
//
// Setup (one-time, see /api/mail/setup): connect bot@reddy.io's Gmail to
// Composio, register this URL via triggers.setWebhookSubscription, create the
// GMAIL_NEW_GMAIL_MESSAGE trigger for bot@reddy.io, set COMPOSIO_WEBHOOK_SECRET.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

type ParsedEvent = { triggerSlug?: string; payload?: Record<string, unknown> };

export async function POST(req: NextRequest) {
  // 1) Verify + parse the Composio webhook (throws on bad signature).
  let event: ParsedEvent;
  try {
    const result = (await composio().triggers.parse(req, {
      verifySecret: process.env.COMPOSIO_WEBHOOK_SECRET,
    })) as { payload?: ParsedEvent } & ParsedEvent;
    // SDK returns VerifyWebhookResult whose .payload is the IncomingTriggerPayload
    // ({ triggerSlug, payload }); fall back defensively to the top object.
    event = (result.payload as ParsedEvent) ?? result;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const slug = String(event.triggerSlug ?? "");
  if (!/gmail/i.test(slug)) {
    console.warn(`[composio-webhook] ignored slug='${slug}' keys=${Object.keys(event).join(",")}`);
    return NextResponse.json({ ok: true, ignored: "non-gmail" });
  }

  // 2) Extract Gmail fields (snake_case aliases FIRST — Composio's Gmail trigger
  // emits message_text / from / thread_id; read aliases defensively regardless).
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const headers = ((p.headers as Record<string, unknown>) ?? p) as Record<string, unknown>;
  const s = (...keys: string[]): string => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const messageId = s("message_id", "messageId", "id");
  const threadId = s("thread_id", "threadId") || null;
  const fromRaw = s("sender", "from", "from_email", "fromEmail");
  const subject = s("subject");
  const body = s("message_text", "messageText", "preview", "snippet", "body");

  // 3) Sender gate — only addresses that CLAIM to be @reddy.io get past here
  // (the From is spoofable; the authenticity gate in step 6.5 proves it's real).
  const from = parseFromAddress(fromRaw);
  if (!isAllowedSender(from)) return NextResponse.json({ ok: true, ignored: "sender" });

  // 4) Loop suppression — never auto-reply to auto-replies / lists / bounces.
  if (looksAutomated(headers, subject)) return NextResponse.json({ ok: true, ignored: "automated" });

  // 5) Per-sender rate limit — hard backstop against mail loops / abuse (12/hr).
  const rlKey = `bot-mail:rate:${from}`;
  const n = (await kv.incr(rlKey).catch(() => 0)) as number;
  if (n === 1) await kv.expire(rlKey, 3600).catch(() => {});
  if (n > 12) {
    console.warn(`[composio-webhook] rate-limited ${from} (${n}/hr)`);
    return NextResponse.json({ ok: true, ignored: "rate-limit" });
  }

  // 6) Idempotency — require a message id, then claim it (Composio/Svix redeliver).
  if (!messageId) {
    console.warn(`[composio-webhook] no message id; dropping to avoid unbounded dupes`);
    return NextResponse.json({ ok: true, ignored: "no-message-id" });
  }
  const claimed = await kv.set(`bot-mail:seen:${messageId}`, "1", { nx: true, ex: 7 * 24 * 3600 }).catch(() => "err");
  if (claimed === null) return NextResponse.json({ ok: true, dedup: true });

  // 6.5) Authenticity — prove the @reddy.io From is REAL, not forged. Google
  // stamps an SPF/DKIM/DMARC verdict on every inbound message regardless of our
  // PUBLISHED DMARC policy, so we require dmarc=pass (or DKIM aligned to
  // reddy.io). The trigger payload usually omits it → fall back to reading the
  // stored message's Authentication-Results header. Done here (post-dedup) so we
  // only fetch for genuinely-new mail.
  //   present-but-failing verdict → DROP (a real spoof signal).
  //   missing verdict → governed by BOT_MAIL_AUTH_FAIL_OPEN: default fail-OPEN
  //     (Google Workspace inbound-spoofing protection is the upstream backstop);
  //     set it to "false" for hard fail-closed once a live email confirms we're
  //     reading the verdict correctly.
  let authRes = s("authentication_results", "auth_results")
    || String(headers["Authentication-Results"] ?? headers["authentication-results"] ?? "");
  let authVia = authRes ? "payload" : "none";
  if (!authRes) {
    const fetched = await fetchAuthResults(messageId);
    if (fetched) { authRes = fetched; authVia = "fetch"; }
  }
  const trusted = authResultsTrusted(authRes);
  console.log(`[composio-webhook] auth from=${from} msg=${messageId} via=${authVia} trusted=${trusted} verdict="${authRes.slice(0, 220)}"`);
  if (authRes && !trusted) {
    console.warn(`[composio-webhook] DROPPED ${from}: auth verdict not trusted (possible spoof)`);
    return NextResponse.json({ ok: true, ignored: "auth-fail" });
  }
  if (!authRes) {
    const failOpen = process.env.BOT_MAIL_AUTH_FAIL_OPEN !== "false";
    console.warn(`[composio-webhook] no auth verdict for ${from} (msg=${messageId}); ${failOpen ? "ALLOWING (fail-open; Workspace backstop)" : "DROPPING (strict)"}`);
    if (!failOpen) return NextResponse.json({ ok: true, ignored: "auth-unknown" });
  }

  // 7) Ack fast; run the agent + reply out of band.
  const mail: InboundMail = { from, subject, body, messageId, threadId };
  after(async () => {
    await processInboundMail(mail).catch((err) =>
      console.error(`[composio-webhook] mail run failed ${messageId}: ${err}`)
    );
  });

  return NextResponse.json({ ok: true });
}
