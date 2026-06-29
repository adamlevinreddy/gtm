import { NextRequest, NextResponse, after } from "next/server";
import { composio } from "@/lib/composio";
import { kv } from "@/lib/kv-client";
import { parseFromAddress, isAllowedSender, looksAutomated, processInboundMail, type InboundMail } from "@/lib/bot-mail";

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

  // 3) Sender gate — only REAL @reddy.io senders (the From is spoofable; this lane
  // also relies on Workspace DMARC p=reject for reddy.io rejecting spoofed inbound
  // before it reaches the mailbox — see setup docs). Best-effort: if the payload
  // surfaces an auth verdict, require DKIM pass.
  const from = parseFromAddress(fromRaw);
  if (!isAllowedSender(from)) return NextResponse.json({ ok: true, ignored: "sender" });
  const authRes = s("authentication_results", "auth_results") || String(headers["Authentication-Results"] ?? "");
  if (authRes && !/dkim=pass/i.test(authRes)) {
    console.warn(`[composio-webhook] dropped ${from}: DKIM not pass (${authRes.slice(0, 120)})`);
    return NextResponse.json({ ok: true, ignored: "dkim" });
  }

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

  // 7) Ack fast; run the agent + reply out of band.
  const mail: InboundMail = { from, subject, body, messageId, threadId };
  after(async () => {
    await processInboundMail(mail).catch((err) =>
      console.error(`[composio-webhook] mail run failed ${messageId}: ${err}`)
    );
  });

  return NextResponse.json({ ok: true });
}
