import { NextRequest, NextResponse, after } from "next/server";
import { composio } from "@/lib/composio";
import { kv } from "@/lib/kv-client";
import { parseFromAddress, isAllowedSender, processInboundMail, type InboundMail } from "@/lib/bot-mail";

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
  if (!/gmail/i.test(slug)) return NextResponse.json({ ok: true, ignored: "non-gmail" });

  // 2) Extract Gmail fields (field names confirmed live; read aliases defensively).
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const s = (...keys: string[]): string => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const messageId = s("messageId", "message_id", "id");
  const threadId = s("threadId", "thread_id") || null;
  const fromRaw = s("sender", "from", "fromEmail");
  const subject = s("subject");
  const body = s("messageText", "preview", "snippet", "body");

  // 3) Sender gate — only real @reddy.io senders (protects the whole agent/tools surface).
  const from = parseFromAddress(fromRaw);
  if (!isAllowedSender(from)) return NextResponse.json({ ok: true, ignored: "sender" });

  // 4) Idempotency — claim the message id (Composio/Svix can redeliver).
  if (messageId) {
    const claimed = await kv.set(`bot-mail:seen:${messageId}`, "1", { nx: true, ex: 7 * 24 * 3600 }).catch(() => "err");
    if (claimed === null) return NextResponse.json({ ok: true, dedup: true });
  }

  // 5) Ack fast; run the agent + reply out of band.
  const mail: InboundMail = { from, subject, body, messageId, threadId };
  after(async () => {
    await processInboundMail(mail).catch((err) =>
      console.error(`[composio-webhook] mail run failed ${messageId}: ${err}`)
    );
  });

  return NextResponse.json({ ok: true });
}
