import { NextRequest, NextResponse } from "next/server";
import {
  attributeCustomer,
  fetchBot,
  fetchTranscript,
  transcriptToText,
  verifyWebhookSignature,
  type RecallBot,
  type RecallParticipant,
} from "@/lib/recall";
import { commitToKb, readKbFile, KB_REPO } from "@/lib/github-kb";
import {
  uploadLfsBlob,
  lfsPointerText,
} from "@/lib/github-lfs";

export const maxDuration = 300;

// Recall.ai → reddy-gtm-kb webhook. Signed by Svix. Lands transcripts +
// videos directly into the KB so the success skill's fan-out reads the
// same file tree as everything else.
//
// Storage layout per meeting:
//   corpora/success/customers/{customer-kebab}/meetings/{recall_bot_id}/
//     ├── meta.json        (title, date, attendees, attribution, links)
//     ├── transcript.txt   (Speaker: line, full transcript)
//     └── video.mp4        (Git LFS pointer; real bytes in LFS storage)
//
// Unattributed meetings land under customer-kebab=`_unsorted`.
//
// Required env:
//   RECALL_WEBHOOK_SECRET       — whsec_... from Recall dashboard
//   RECALL_API_KEY              — used by lib/recall.ts to fetch bot details
//   PRICING_LIBRARY_GITHUB_PAT  — write access to ReddySolutions/reddy-gtm + LFS
//   HUBSPOT_API_KEY             — used by attributeCustomer()

export async function POST(req: NextRequest) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[recall webhook] RECALL_WEBHOOK_SECRET not set");
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  const rawBody = await req.text();
  const headers = {
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
    const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
    if (!pat) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");

    if (eventName === "transcript.done") {
      await handleTranscriptDone(botId, pat);
    } else if (eventName === "recording.done") {
      await handleRecordingDone(botId, pat);
    } else if (eventName === "bot.done") {
      // Make sure meta.json exists with whatever metadata we have.
      // Transcript + video may not be ready yet.
      await handleMetadataOnly(botId, pat);
    } else if (eventName === "transcript.failed" || eventName === "recording.failed") {
      console.warn(`[recall webhook] ${eventName} bot=${botId}`);
    }
  } catch (err) {
    console.error(
      `[recall webhook] handler ${eventName} bot=${botId} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    // 200 to stop Svix retries on programmer errors; transient errors will
    // be re-driven by subsequent events for the same bot anyway.
    return NextResponse.json({ ok: false, error: String(err) });
  }

  return NextResponse.json({ ok: true });
}

// ────────── Helpers ──────────

function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "meeting";
}

async function customerSlugForBot(bot: RecallBot): Promise<{
  slug: string;
  attribution: Awaited<ReturnType<typeof attributeCustomer>>;
}> {
  const participants = bot.meeting_metadata?.participants ?? [];
  const attribution = await attributeCustomer(participants);
  if (attribution.confidence === "high" || attribution.confidence === "medium") {
    if (attribution.companyName) return { slug: kebabCase(attribution.companyName), attribution };
  }
  return { slug: "_unsorted", attribution };
}

function meetingDir(slug: string, botId: string): string {
  return `corpora/success/customers/${slug}/meetings/${botId}`;
}

function metaJson(opts: {
  bot: RecallBot;
  slug: string;
  attribution: Awaited<ReturnType<typeof attributeCustomer>>;
  videoOid?: string | null;
  videoSize?: number | null;
  hasTranscript?: boolean;
}): string {
  const { bot, slug, attribution, videoOid, videoSize, hasTranscript } = opts;
  const participants: RecallParticipant[] = bot.meeting_metadata?.participants ?? [];
  const startedAt = bot.recordings?.[0]?.started_at ?? bot.join_at ?? null;
  const endedAt = bot.recordings?.[0]?.completed_at ?? null;
  const platform = typeof bot.meeting_url === "object" ? bot.meeting_url?.platform ?? null : null;
  const meetingUrl = typeof bot.meeting_url === "string" ? bot.meeting_url : null;

  return JSON.stringify(
    {
      recall_bot_id: bot.id,
      title: bot.meeting_metadata?.title ?? bot.bot_name ?? "Untitled meeting",
      started_at: startedAt,
      ended_at: endedAt,
      platform,
      meeting_url: meetingUrl,
      attendees: participants.map((p) => ({
        name: p.name ?? null,
        email: p.email ?? null,
        is_host: p.is_host ?? null,
      })),
      attribution: {
        customer_slug: slug,
        confidence: attribution.confidence,
        hubspot_company_id: attribution.hubspotCompanyId,
        company_name: attribution.companyName,
        matched_domains: attribution.matchedDomains,
      },
      video: videoOid && videoSize != null ? { oid: videoOid, size: videoSize } : null,
      has_transcript: !!hasTranscript,
      schema_version: 1,
    },
    null,
    2,
  ) + "\n";
}

async function handleMetadataOnly(botId: string, pat: string) {
  const bot = await fetchBot(botId);
  const { slug, attribution } = await customerSlugForBot(bot);

  // If we already wrote meta for this bot, leave it alone (transcript/video
  // handlers will overwrite with fuller data).
  const existing = await readKbFile(pat, `${meetingDir(slug, botId)}/meta.json`);
  if (existing) {
    console.log(`[recall webhook] bot.done for ${botId}: meta already present`);
    return;
  }

  await commitToKb({
    pat,
    message: `recall: meta for ${slug}/${botId}`,
    files: [
      {
        path: `${meetingDir(slug, botId)}/meta.json`,
        utf8: metaJson({ bot, slug, attribution }),
      },
    ],
  });
}

async function handleTranscriptDone(botId: string, pat: string) {
  const bot = await fetchBot(botId);
  const { slug, attribution } = await customerSlugForBot(bot);

  const { segments } = await fetchTranscript(botId);
  const transcriptText = transcriptToText(segments);

  await commitToKb({
    pat,
    message: `recall: transcript ${slug}/${botId}`,
    files: [
      {
        path: `${meetingDir(slug, botId)}/transcript.txt`,
        utf8: transcriptText,
      },
      {
        path: `${meetingDir(slug, botId)}/meta.json`,
        utf8: metaJson({ bot, slug, attribution, hasTranscript: true }),
      },
    ],
  });
  console.log(
    `[recall webhook] persisted transcript bot=${botId} slug=${slug} chars=${transcriptText.length} confidence=${attribution.confidence}`,
  );
}

async function handleRecordingDone(botId: string, pat: string) {
  const bot = await fetchBot(botId);
  const { slug, attribution } = await customerSlugForBot(bot);

  const videoUrl = bot.recordings?.[0]?.media_shortcuts?.video_mixed?.data?.download_url;
  if (!videoUrl) {
    console.warn(`[recall webhook] recording.done bot=${botId} but no video_mixed download_url`);
    return;
  }

  // Pull the video bytes from Recall (signed S3 URL, fast).
  const dl = await fetch(videoUrl);
  if (!dl.ok) {
    throw new Error(`recall video download ${botId} -> ${dl.status}`);
  }
  const bytes = Buffer.from(await dl.arrayBuffer());
  console.log(`[recall webhook] downloaded recall video bot=${botId} bytes=${bytes.length}`);

  // Upload to GitHub LFS first; the pointer file we commit references it.
  const { oid, size } = await uploadLfsBlob(pat, KB_REPO, bytes);

  await commitToKb({
    pat,
    message: `recall: video ${slug}/${botId}`,
    files: [
      {
        path: `${meetingDir(slug, botId)}/video.mp4`,
        utf8: lfsPointerText(oid, size),
      },
      {
        path: `${meetingDir(slug, botId)}/meta.json`,
        utf8: metaJson({ bot, slug, attribution, videoOid: oid, videoSize: size }),
      },
    ],
  });
  console.log(`[recall webhook] persisted video bot=${botId} oid=${oid.slice(0, 12)} size=${size}`);
}
