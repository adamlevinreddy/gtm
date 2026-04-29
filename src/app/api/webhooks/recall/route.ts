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
import { commitToKb, readKbFile, KB_REPO, type CommitFile } from "@/lib/github-kb";
import { uploadLfsBlob, lfsPointerText } from "@/lib/github-lfs";
import { assetCreateFromUrl, waitForAssetReady } from "@/lib/mux";

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
// Reconciliation model: each event ("bot.done", "recording.done",
// "transcript.done") triggers a full reconcile() call. We re-fetch the
// bot from Recall, see which artifacts are now ready vs already in the
// KB, and commit whatever's new — plus a merged meta.json that
// preserves existing fields. This is idempotent (safe to re-run) and
// resilient to events arriving in any order or missing entirely (e.g.,
// transcript.done not firing for streaming providers).

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

    if (eventName === "transcript.failed" || eventName === "recording.failed") {
      console.warn(`[recall webhook] ${eventName} bot=${botId}`);
      return NextResponse.json({ ok: true });
    }
    // For bot.done / recording.done / transcript.done — same reconcile.
    await reconcile(botId, pat, eventName);
  } catch (err) {
    console.error(
      `[recall webhook] handler ${eventName} bot=${botId} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    // 200 so Svix doesn't keep retrying programmer errors.
    return NextResponse.json({ ok: false, error: String(err) });
  }

  return NextResponse.json({ ok: true });
}

// ────────── Reconcile ──────────

type ExistingMeta = {
  recall_bot_id?: string;
  title?: string;
  started_at?: string | null;
  ended_at?: string | null;
  platform?: string | null;
  meeting_url?: string | null;
  attendees?: Array<{ name: string | null; email: string | null; is_host: boolean | null }>;
  attribution?: {
    customer_slug?: string;
    confidence?: string;
    hubspot_company_id?: string | null;
    company_name?: string | null;
    matched_domains?: string[];
  };
  video?: { oid: string; size: number } | null;
  mux?: { asset_id: string; playback_id: string } | null;
  has_transcript?: boolean;
  schema_version?: number;
};

async function reconcile(botId: string, pat: string, eventName: string): Promise<void> {
  const bot = await fetchBot(botId);
  const { slug, attribution } = await customerSlugForBot(bot);
  const dir = `corpora/success/customers/${slug}/meetings/${botId}`;

  // Read existing meta (if any) so we can preserve fields populated by
  // earlier events.
  const existingMetaText = await readKbFile(pat, `${dir}/meta.json`);
  const existing: ExistingMeta = existingMetaText ? safeJson(existingMetaText) : {};

  const filesToCommit: CommitFile[] = [];
  const reasons: string[] = [];

  // Video — commit if Recall has it ready and we haven't already.
  // Two destinations: LFS (kept as durable backup) + Mux (the playback
  // surface we share into Slack as a signed URL). Mux pulls server-side
  // from the same Recall download URL we already used for LFS — no need
  // to re-upload bytes. Both writes are idempotent: if either has run
  // before (existing.video / existing.mux), we skip that side.
  let videoOid = existing.video?.oid ?? null;
  let videoSize = existing.video?.size ?? null;
  let muxAssetId = existing.mux?.asset_id ?? null;
  let muxPlaybackId = existing.mux?.playback_id ?? null;
  const videoStatus = bot.recordings?.[0]?.media_shortcuts?.video_mixed?.status?.code;
  const videoUrl = bot.recordings?.[0]?.media_shortcuts?.video_mixed?.data?.download_url;
  if (videoStatus === "done" && videoUrl) {
    if (!existing.video) {
      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`recall video download ${botId} -> ${dl.status}`);
      const bytes = Buffer.from(await dl.arrayBuffer());
      console.log(`[recall webhook] downloaded video bot=${botId} bytes=${bytes.length}`);
      const { oid, size } = await uploadLfsBlob(pat, KB_REPO, bytes);
      videoOid = oid;
      videoSize = size;
      filesToCommit.push({ path: `${dir}/video.mp4`, utf8: lfsPointerText(oid, size) });
      reasons.push("video");
    }
    if (!existing.mux && process.env.MUX_TOKEN_ID && process.env.MUX_TOKEN_SECRET) {
      try {
        const created = await assetCreateFromUrl({
          url: videoUrl,
          passthrough: `${slug}/${botId}`,
        });
        const ready = await waitForAssetReady(created.id);
        const playbackId = ready.playback_ids?.find((p) => p.policy === "signed")?.id
          ?? ready.playback_ids?.[0]?.id
          ?? null;
        if (playbackId) {
          muxAssetId = ready.id;
          muxPlaybackId = playbackId;
          reasons.push("mux");
          console.log(`[recall webhook] mux ingest bot=${botId} asset=${ready.id} playback=${playbackId}`);
        } else {
          console.warn(`[recall webhook] mux ingest bot=${botId} ready but no playback_id`);
        }
      } catch (muxErr) {
        // Don't fail the whole reconcile if Mux ingest is flaky — LFS is
        // still the source of truth. Backfill can retry.
        console.warn(
          `[recall webhook] mux ingest failed bot=${botId}: ${muxErr instanceof Error ? muxErr.message : muxErr}`,
        );
      }
    }
  }

  // Transcript — commit if Recall has it ready and we haven't already.
  let hasTranscript = !!existing.has_transcript;
  const transcriptStatus = bot.recordings?.[0]?.media_shortcuts?.transcript?.status?.code;
  const transcriptUrl = bot.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url;
  if (transcriptStatus === "done" && transcriptUrl && !existing.has_transcript) {
    const { segments } = await fetchTranscript(botId);
    const transcriptText = transcriptToText(segments);
    filesToCommit.push({ path: `${dir}/transcript.txt`, utf8: transcriptText });
    hasTranscript = true;
    reasons.push(`transcript (${transcriptText.length} chars)`);
  }

  // Always rewrite meta.json with the merged view (cheap; tree commits
  // dedupe identical content via blob SHA).
  const metaText = mergedMetaJson({
    bot,
    slug,
    attribution,
    videoOid,
    videoSize,
    muxAssetId,
    muxPlaybackId,
    hasTranscript,
  });
  if (metaText !== existingMetaText) {
    filesToCommit.push({ path: `${dir}/meta.json`, utf8: metaText });
  }

  if (filesToCommit.length === 0) {
    console.log(`[recall webhook] reconcile ${eventName} bot=${botId} slug=${slug}: nothing to commit`);
    return;
  }

  await commitToKb({
    pat,
    message: `recall: ${reasons.length ? reasons.join(" + ") : "meta"} ${slug}/${botId}`,
    files: filesToCommit,
  });
  console.log(
    `[recall webhook] committed bot=${botId} slug=${slug} reasons=[${reasons.join(",")}] confidence=${attribution.confidence}`,
  );
}

// ────────── Helpers ──────────

function safeJson(s: string): ExistingMeta {
  try {
    return JSON.parse(s) as ExistingMeta;
  } catch {
    return {};
  }
}

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

function mergedMetaJson(opts: {
  bot: RecallBot;
  slug: string;
  attribution: Awaited<ReturnType<typeof attributeCustomer>>;
  videoOid: string | null;
  videoSize: number | null;
  muxAssetId: string | null;
  muxPlaybackId: string | null;
  hasTranscript: boolean;
}): string {
  const { bot, slug, attribution, videoOid, videoSize, muxAssetId, muxPlaybackId, hasTranscript } = opts;
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
      mux: muxAssetId && muxPlaybackId ? { asset_id: muxAssetId, playback_id: muxPlaybackId } : null,
      has_transcript: hasTranscript,
      schema_version: 2,
    },
    null,
    2,
  ) + "\n";
}
