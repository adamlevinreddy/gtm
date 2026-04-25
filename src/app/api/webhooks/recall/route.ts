import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { meetings } from "@/lib/schema";
import { eq } from "drizzle-orm";
import {
  attributeCustomer,
  fetchBot,
  fetchTranscript,
  transcriptToText,
  verifyWebhookSignature,
  type RecallParticipant,
} from "@/lib/recall";

export const maxDuration = 300; // attribution + Recall fetches can take a moment

// Recall.ai delivers webhooks via Svix. We verify the HMAC signature using
// the per-endpoint secret from the Recall dashboard, then fan out to event
// handlers. On `transcript.done` we pull the transcript, attempt customer
// attribution via HubSpot, and upsert into the meetings table — keyed by
// recall_bot_id so re-deliveries are idempotent.
//
// Env required:
//   RECALL_WEBHOOK_SECRET — paste the `whsec_...` value from Recall's
//     webhook configuration page.
//   RECALL_API_KEY        — used by lib/recall.ts to fetch bot details.
//   HUBSPOT_API_KEY       — used by attributeCustomer().

type SvixHeaders = "svix-id" | "svix-timestamp" | "svix-signature" | "webhook-id" | "webhook-timestamp" | "webhook-signature";

export async function POST(req: NextRequest) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[recall webhook] RECALL_WEBHOOK_SECRET not set");
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  const rawBody = await req.text();
  const headers: Record<SvixHeaders, string | null> = {
    "svix-id": req.headers.get("svix-id"),
    "svix-timestamp": req.headers.get("svix-timestamp"),
    "svix-signature": req.headers.get("svix-signature"),
    "webhook-id": req.headers.get("webhook-id"),
    "webhook-timestamp": req.headers.get("webhook-timestamp"),
    "webhook-signature": req.headers.get("webhook-signature"),
  };

  if (!verifyWebhookSignature(rawBody, headers, secret)) {
    console.warn("[recall webhook] invalid signature; rejecting");
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  let event: { event?: string; data?: { bot?: { id?: string }; bot_id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const eventName = event.event ?? "";
  const botId = event.data?.bot?.id ?? event.data?.bot_id;
  if (!botId) {
    console.warn(`[recall webhook] ${eventName} with no bot id; ignoring`);
    return NextResponse.json({ ok: true });
  }

  console.log(`[recall webhook] ${eventName} bot=${botId}`);

  try {
    if (eventName === "transcript.done") {
      await handleTranscriptDone(botId);
    } else if (eventName === "bot.done" || eventName === "recording.done") {
      await handleBotMetadataUpsert(botId);
    } else if (eventName === "transcript.failed" || eventName === "recording.failed") {
      console.warn(`[recall webhook] ${eventName} bot=${botId}`);
    }
  } catch (err) {
    console.error(
      `[recall webhook] handler ${eventName} bot=${botId} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    // Return 200 so Svix doesn't keep retrying for handler bugs we already
    // logged. For genuinely transient errors we'll catch them on the next
    // event for the same bot.
    return NextResponse.json({ ok: false, error: String(err) });
  }

  return NextResponse.json({ ok: true });
}

async function handleBotMetadataUpsert(botId: string) {
  const bot = await fetchBot(botId);
  const participants = bot.meeting_metadata?.participants ?? [];
  const title = bot.meeting_metadata?.title ?? bot.bot_name ?? "Untitled meeting";
  const platform = typeof bot.meeting_url === "object" ? bot.meeting_url?.platform : null;
  const meetingUrl = typeof bot.meeting_url === "string" ? bot.meeting_url : null;
  const startedAt = bot.recordings?.[0]?.started_at ?? bot.join_at ?? new Date().toISOString();

  const attribution = await attributeCustomer(participants);

  await upsertMeeting({
    botId,
    title,
    meetingDate: new Date(startedAt),
    attendees: participants,
    platform: platform ?? null,
    meetingUrl,
    transcript: null,
    attributionConfidence: attribution.confidence,
    accountId: attribution.accountId,
  });
}

async function handleTranscriptDone(botId: string) {
  const bot = await fetchBot(botId);
  const participants = bot.meeting_metadata?.participants ?? [];
  const title = bot.meeting_metadata?.title ?? bot.bot_name ?? "Untitled meeting";
  const platform = typeof bot.meeting_url === "object" ? bot.meeting_url?.platform : null;
  const meetingUrl = typeof bot.meeting_url === "string" ? bot.meeting_url : null;
  const startedAt = bot.recordings?.[0]?.started_at ?? bot.join_at ?? new Date().toISOString();

  const { segments } = await fetchTranscript(botId);
  const transcriptText = transcriptToText(segments);

  const attribution = await attributeCustomer(participants);

  await upsertMeeting({
    botId,
    title,
    meetingDate: new Date(startedAt),
    attendees: participants,
    platform: platform ?? null,
    meetingUrl,
    transcript: transcriptText,
    attributionConfidence: attribution.confidence,
    accountId: attribution.accountId,
  });

  console.log(
    `[recall webhook] persisted bot=${botId} chars=${transcriptText.length} confidence=${attribution.confidence} matchedDomains=${attribution.matchedDomains.join(",") || "none"}`,
  );
}

async function upsertMeeting(args: {
  botId: string;
  title: string;
  meetingDate: Date;
  attendees: RecallParticipant[];
  platform: string | null;
  meetingUrl: string | null;
  transcript: string | null;
  attributionConfidence: string;
  accountId: string | null;
}) {
  const existing = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.recallBotId, args.botId))
    .limit(1);

  const base = {
    title: args.title,
    meetingDate: args.meetingDate,
    attendees: args.attendees,
    recallBotId: args.botId,
    recallPlatform: args.platform,
    recallMeetingUrl: args.meetingUrl,
    recallAttributionConfidence: args.attributionConfidence,
    accountId: args.accountId,
    source: "recall",
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    // Don't blow away an existing transcript with null on a metadata-only event.
    const update = args.transcript ? { ...base, transcript: args.transcript } : base;
    await db.update(meetings).set(update).where(eq(meetings.id, existing[0].id));
  } else {
    await db.insert(meetings).values({
      ...base,
      transcript: args.transcript,
    });
  }
}
