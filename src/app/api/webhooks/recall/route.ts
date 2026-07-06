import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  attributeCustomer,
  fetchBot,
  fetchChatMessages,
  fetchParticipants,
  fetchTranscript,
  chatMessagesToText,
  transcriptToText,
  verifyWebhookSignature,
  type RecallBot,
  type RecallParticipant,
} from "@/lib/recall";
import { commitToKb, readKbFile, KB_REPO, type CommitFile } from "@/lib/github-kb";
import { uploadLfsBlob, lfsPointerText } from "@/lib/github-lfs";
import { assetCreateFromUrl, waitForAssetReady } from "@/lib/mux";
import {
  listCalendarEventsSince,
  shouldRecordEvent,
  scheduleBotForEvent,
  deleteBotForEvent,
  kvLookupEmailForCalendar,
  kvLinkCalendarToEmail,
  getRecallCalendar,
  kvClaimIcalOwner,
  kvRefreshIcalOwner,
  kvReleaseIcalOwner,
  kvKeyBotInvitees,
  kvKeyBotMeetingRef,
} from "@/lib/recall-calendar-v2";
import { getCompanyContacts } from "@/lib/hubspot";
import { canonicalCompanyName } from "@/lib/account-identity";
import { kv } from "@/lib/kv-client";
import { detectConeOfSilence, isConeOfSilence, markConeOfSilence } from "@/lib/cone-of-silence";
import { getBlockChecker } from "@/lib/meeting-optout";
import { upsertMeetingIndex, removeFromMeetingIndex } from "@/lib/meeting-index";

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

  let event: {
    event?: string;
    data?: {
      bot?: { id?: string };
      bot_id?: string;
      calendar_id?: string;
      last_updated_ts?: string;
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const eventName = event.event ?? "";

  // Calendar V2 events come without a bot id — branch up front.
  if (eventName === "calendar.update" || eventName === "calendar.sync_events") {
    const calendarId = event.data?.calendar_id;
    const lastUpdatedTs = event.data?.last_updated_ts ?? null;
    if (!calendarId) {
      console.warn(`[recall webhook] ${eventName} with no calendar_id; ignoring`);
      return NextResponse.json({ ok: true });
    }
    console.log(`[recall webhook] ${eventName} calendar=${calendarId}`);
    try {
      await handleCalendarEvent(eventName, calendarId, lastUpdatedTs);
    } catch (err) {
      console.error(
        `[recall webhook] calendar handler ${eventName} cal=${calendarId} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
      );
      return NextResponse.json({ ok: false, error: String(err) });
    }
    return NextResponse.json({ ok: true });
  }

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

// Internal re-ingest: re-run reconcile for a bot whose recording.done was
// missed (e.g. a webhook lost during a deploy) so its transcript/video get
// committed once Recall has them. Idempotent + self-healing — safe to re-run;
// a no-op if Recall's transcript isn't ready yet. x-reddy-internal only.
export async function GET(req: NextRequest) {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-reddy-internal") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const botId = req.nextUrl.searchParams.get("botId") ?? "";
  if (!botId) return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });

  // ?probe=1 → just read the bot's state from Recall (fast, no commit) so we
  // can see whether it recorded + whether the transcript/video are ready there.
  if (req.nextUrl.searchParams.get("probe") === "1") {
    try {
      const bot = await fetchBot(botId);
      const ms = bot.recordings?.[0]?.media_shortcuts;
      return NextResponse.json({
        ok: true,
        botId,
        recordings: bot.recordings?.length ?? 0,
        transcriptStatus: ms?.transcript?.status?.code ?? null,
        videoStatus: ms?.video_mixed?.status?.code ?? null,
      });
    } catch (err) {
      return NextResponse.json({ ok: false, botId, probeError: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  }

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) return NextResponse.json({ ok: false, error: "PRICING_LIBRARY_GITHUB_PAT not set" }, { status: 500 });
  try {
    await reconcile(botId, pat, "manual-reingest");
    return NextResponse.json({ ok: true, botId, note: "reconciled — re-check has_transcript" });
  } catch (err) {
    return NextResponse.json({ ok: false, botId, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// ────────── Calendar V2 handler ──────────

async function handleCalendarEvent(
  eventName: string,
  calendarId: string,
  lastUpdatedTs: string | null,
): Promise<void> {
  // Resolve the connecting user's email up front. KV is the fast path;
  // if it's missing (race: Recall fires webhooks the moment a calendar
  // is created, often before our OAuth callback finishes writing KV),
  // fall back to Recall's calendar object — `platform_email` carries
  // the same info — and back-fill KV so subsequent webhooks short-circuit.
  let ownerEmail = await kvLookupEmailForCalendar(calendarId);
  if (!ownerEmail) {
    const cal = await getRecallCalendar(calendarId).catch(() => null);
    if (cal?.platform_email) {
      ownerEmail = cal.platform_email;
      await kvLinkCalendarToEmail(calendarId, ownerEmail).catch(() => {});
      console.log(`[recall webhook] back-filled KV mapping ${calendarId} -> ${ownerEmail}`);
    }
  }

  if (eventName === "calendar.update") {
    // Calendar metadata changed (rename, disconnect, etc). KV mapping
    // is now resolved if it was missing — that's the substantive work.
    // No event scheduling on calendar.update by itself.
    return;
  }

  if (!ownerEmail) {
    console.warn(`[recall webhook] no owner email for calendar ${calendarId}; bots will not be scheduled`);
    return;
  }

  // calendar.sync_events: pull events updated since the cursor and
  // schedule/reschedule/delete bots accordingly.
  const cursor = lastUpdatedTs ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events = await listCalendarEventsSince({ calendarId, updatedAtGte: cursor });
  // Board-managed opt-outs ("bot must never join this meeting/series").
  // Loaded once per sync; checked per event below.
  const blockedBy = events.length > 0 ? await getBlockChecker() : () => null;
  let scheduled = 0;
  let deleted = 0;
  let skippedDup = 0;
  let skippedBlocked = 0;
  for (const e of events) {
    const dedupKey = `cal_${calendarId}_evt_${e.id}`;
    if (e.is_deleted || e.raw?.status === "cancelled") {
      try {
        await deleteBotForEvent(e.id);
        deleted += 1;
      } catch (err) {
        console.warn(`[recall webhook] delete bot for ${e.id} failed: ${err instanceof Error ? err.message : err}`);
      }
      await kv.del(`recall:cal:event:${calendarId}:${e.id}:bot`).catch(() => {});
      // Release any cross-calendar claim we held on this ical_uid so a
      // re-create can be re-claimed (possibly by a different teammate's
      // calendar firing first next time).
      if (e.ical_uid) await kvReleaseIcalOwner(e.ical_uid, calendarId);
      continue;
    }
    if (!shouldRecordEvent(e, ownerEmail)) continue;

    // Opt-out check BEFORE the dedup claim: blocked events must not claim
    // (or refresh) series ownership. Tear down any bot that was scheduled
    // before the block existed.
    const block = blockedBy(e);
    if (block) {
      skippedBlocked += 1;
      if ((e.bots?.length ?? 0) > 0) {
        try {
          await deleteBotForEvent(e.id);
        } catch (err) {
          console.warn(`[recall webhook] delete blocked bot for ${e.id} failed: ${err instanceof Error ? err.message : err}`);
        }
        await kv.del(`recall:cal:event:${calendarId}:${e.id}:bot`).catch(() => {});
      }
      continue;
    }

    // Cross-calendar dedup. Same meeting can land on multiple connected
    // calendars (any meeting where two teammates accept). First calendar
    // to fire its sync wins the bot; the others see the claim and skip.
    if (e.ical_uid) {
      const claim = await kvClaimIcalOwner(e.ical_uid, calendarId);
      if (claim.owner !== calendarId) {
        skippedDup += 1;
        // If we previously held a bot for this event on a non-owner
        // calendar (race or owner change), tear it down so we don't
        // leave a duplicate behind from before this code shipped.
        try {
          await deleteBotForEvent(e.id);
        } catch {
          // ignore — may not have a bot anyway
        }
        await kv.del(`recall:cal:event:${calendarId}:${e.id}:bot`).catch(() => {});
        continue;
      }
      // We own it — bump the TTL so the lock stays fresh.
      if (!claim.claimed) await kvRefreshIcalOwner(e.ical_uid, calendarId);
    }

    try {
      // Bot in the waiting room 2 min before start, so it's already there
      // when participants join early.
      const joinAt = e.start_time
        ? new Date(new Date(e.start_time).getTime() - 2 * 60 * 1000).toISOString()
        : undefined;
      const { botId } = await scheduleBotForEvent({
        eventId: e.id,
        deduplicationKey: dedupKey,
        joinAt,
      });
      if (botId) {
        await kv.set(`recall:cal:event:${calendarId}:${e.id}:bot`, botId).catch(() => {});
        // Reverse lookup for the post-meeting card-mute: this bot's meeting is
        // this ical_uid/start_time (proposeFromMeeting only has the botId).
        await kv
          .set(kvKeyBotMeetingRef(botId), { icalUid: e.ical_uid || e.id, startTime: e.start_time }, { ex: 30 * 24 * 60 * 60 })
          .catch(() => {});
        // Capture invite attendee emails now (the invite always carries them,
        // even when Teams later strips them from the meeting roster).
        const invitees: RecallParticipant[] = (e.raw?.attendees ?? [])
          .filter((a) => !!a.email)
          .map((a) => ({ name: undefined, email: a.email, is_host: a.organizer ?? false }));
        if (invitees.length) {
          await kv.set(kvKeyBotInvitees(botId), invitees, { ex: 30 * 24 * 60 * 60 }).catch(() => {});
        }
      }
      scheduled += 1;
    } catch (err) {
      console.warn(`[recall webhook] schedule bot for ${e.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(
    `[recall webhook] ${eventName} cal=${calendarId} owner=${ownerEmail} events=${events.length} scheduled=${scheduled} deleted=${deleted} skipped_dup=${skippedDup} skipped_blocked=${skippedBlocked}`,
  );
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
  has_chat?: boolean;
  schema_version?: number;
};

async function reconcile(botId: string, pat: string, eventName: string): Promise<void> {
  const bot = await fetchBot(botId);
  // Pull participants from the artifact (the inline list is empty on
  // current Recall bots); pull title from the recordings[0] location.
  const observed = await fetchParticipants(bot);
  // Merge calendar-invite attendees (real emails — Teams roster has none) so
  // attribution + meta.json get domains to work with.
  const invitees = (await kv.get<RecallParticipant[]>(kvKeyBotInvitees(botId)).catch(() => null)) ?? [];
  let liveParticipants = mergeParticipants(observed, invitees);
  const liveTitle = bot.recordings?.[0]?.media_shortcuts?.meeting_metadata?.data?.title ?? bot.bot_name ?? null;
  const { slug, attribution } = await customerSlugForBot(bot, liveParticipants, liveTitle);
  // Runtime safety net: if a company resolved but attendees still lack emails
  // (older bot with no stored invitees), recover emails from the company's
  // HubSpot contacts by name. Self-heals existing meetings on re-reconcile.
  if (attribution.hubspotCompanyId && liveParticipants.some((p) => p.name && !p.email)) {
    try {
      const crm = await getCompanyContacts(attribution.hubspotCompanyId);
      if (crm.length) liveParticipants = backfillEmailsFromContacts(liveParticipants, crm);
    } catch { /* best-effort */ }
  }
  const dir = `corpora/success/customers/${slug}/meetings/${botId}`;

  // Read existing meta (if any) so we can preserve fields populated by
  // earlier events.
  const existingMetaText = await readKbFile(pat, `${dir}/meta.json`);
  const existing: ExistingMeta = existingMetaText ? safeJson(existingMetaText) : {};

  // Cone of silence — already flagged (realtime detection mid-meeting, or a
  // prior reconcile pass)? Suppress now, BEFORE any video/Mux work: purge
  // whatever already landed and stop. The bot still recorded — we just never
  // persist or surface this meeting.
  if (await isConeOfSilence(botId)) {
    await suppressConeMeeting(pat, dir, existingMetaText, existing, botId, "marker");
    return;
  }

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
    // Cone of silence guarantee: scan the FULL transcript before committing it.
    // If the trigger was spoken, purge anything that landed (video may have been
    // committed on an earlier recording.done pass) and suppress — no commit, no
    // Slack. Discards this pass's pending commits (incl. any just-built video).
    if (detectConeOfSilence(transcriptText)) {
      await suppressConeMeeting(pat, dir, existingMetaText, existing, botId, "transcript");
      return;
    }
    filesToCommit.push({ path: `${dir}/transcript.txt`, utf8: transcriptText });
    hasTranscript = true;
    reasons.push(`transcript (${transcriptText.length} chars)`);
  }

  // In-meeting chat — commit chat.txt once and only if the meeting
  // actually had chat. Chat messages live in the participant_events
  // artifact (action="chat_message"), captured because the bot
  // subscribes to participant_events.chat_message. Gated on !has_chat so
  // we don't re-commit on later reconcile passes; fetchChatMessages
  // returns [] when the artifact isn't ready yet, so a later event
  // (recording.done / transcript.done) will pick it up.
  let hasChat = !!existing.has_chat;
  if (!existing.has_chat) {
    const chatMessages = await fetchChatMessages(bot);
    if (chatMessages.length > 0) {
      const chatText = chatMessagesToText(chatMessages);
      filesToCommit.push({ path: `${dir}/chat.txt`, utf8: chatText });
      hasChat = true;
      reasons.push(`chat (${chatMessages.length} msgs)`);
    }
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
    hasChat,
    liveParticipants,
    liveTitle,
  });
  if (metaText !== existingMetaText) {
    filesToCommit.push({ path: `${dir}/meta.json`, utf8: metaText });
  }

  // Daybreak Phase 3: keep the KV meeting index in lockstep with the KB.
  // Ordering matters — the index must only ever advertise artifacts that are
  // DURABLY in the KB, so it's written after commitToKb succeeds (a thrown
  // commit leaves the index at its previous truthful state; Recall retries +
  // the backstop cron's ground-truth heal converge it). Failures are
  // swallowed: an Upstash blip must never fail the reconcile.
  const writeIndex = () =>
    upsertMeetingIndex({
      bot_id: botId,
      customer_slug: slug,
      title: liveTitle ?? bot.bot_name ?? null,
      started_at: bot.recordings?.[0]?.started_at ?? bot.join_at ?? null,
      ended_at: bot.recordings?.[0]?.completed_at ?? null,
      platform: typeof bot.meeting_url === "object" ? bot.meeting_url?.platform ?? null : null,
      attendees: liveParticipants.map((p) => ({ name: p.name ?? null, email: p.email ?? null })),
      has_transcript: hasTranscript,
      has_video: !!videoOid,
      has_chat: hasChat,
      mux_playback_id: muxPlaybackId,
      attribution_confidence: attribution.confidence ?? null,
      // Persist HubSpot identity at ingest — accounts resolve with zero warm.
      hubspot_company_id: attribution.hubspotCompanyId ?? null,
      account_canonical: attribution.companyName ?? null,
    }).catch((err) => {
      console.warn(`[recall webhook] meeting-index upsert failed bot=${botId}: ${err instanceof Error ? err.message : err}`);
    });

  if (filesToCommit.length === 0) {
    // Nothing new to commit → the KB already reflects this state; safe to index.
    await writeIndex();
    console.log(`[recall webhook] reconcile ${eventName} bot=${botId} slug=${slug}: nothing to commit`);
    return;
  }

  await commitToKb({
    pat,
    message: `recall: ${reasons.length ? reasons.join(" + ") : "meta"} ${slug}/${botId}`,
    files: filesToCommit,
  });
  await writeIndex();
  console.log(
    `[recall webhook] committed bot=${botId} slug=${slug} reasons=[${reasons.join(",")}] confidence=${attribution.confidence}`,
  );

  // P2: once a transcript is present, fire the post-meeting triage → board
  // routing. after() so it survives this webhook returning; idempotent per
  // botId via the route's KV claim; best-effort (replay route + backstop cron
  // can re-run). Never lets the triage break the webhook.
  if (hasTranscript) {
    after(async () => {
      try {
        const base = process.env.PUBLIC_BASE_URL ?? "https://reddy-gtm.com";
        await fetch(`${base}/api/proactive/meeting`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-reddy-internal": process.env.MCP_INTERNAL_SECRET ?? "",
          },
          body: JSON.stringify({ botId }),
        });
      } catch {
        /* post-meeting triage is best-effort */
      }
    });
  }
}

// ────────── Helpers ──────────

// Cone of silence: flag the meeting and PURGE any artifacts already committed
// to the KB so it leaves the board/meetings view AND the agent's KB clone. We
// only delete paths we know exist (GitHub 422s on deleting a missing path):
// meta.json if it was ever written, and each artifact the existing meta marks
// present. Never touches the Recall bot — the recording itself is untouched.
async function suppressConeMeeting(
  pat: string,
  dir: string,
  existingMetaText: string | null,
  existing: ExistingMeta,
  botId: string,
  via: string,
): Promise<void> {
  await markConeOfSilence(botId);
  await removeFromMeetingIndex(botId); // never list a suppressed meeting
  const deletions: CommitFile[] = [];
  if (existingMetaText !== null) deletions.push({ path: `${dir}/meta.json`, delete: true });
  if (existing.has_transcript) deletions.push({ path: `${dir}/transcript.txt`, delete: true });
  if (existing.has_chat) deletions.push({ path: `${dir}/chat.txt`, delete: true });
  if (existing.video) deletions.push({ path: `${dir}/video.mp4`, delete: true });
  if (deletions.length) {
    try {
      await commitToKb({ pat, message: `recall: cone of silence — purge ${dir}`, files: deletions });
    } catch (err) {
      console.error(`[recall webhook] cone purge failed bot=${botId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[recall webhook] cone of silence bot=${botId} via=${via}: suppressed (purged ${deletions.length}, no slack)`);
}

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

async function customerSlugForBot(
  bot: RecallBot,
  liveParticipants: RecallParticipant[],
  liveTitle: string | null,
): Promise<{
  slug: string;
  attribution: Awaited<ReturnType<typeof attributeCustomer>>;
}> {
  // Prefer the participants artifact (current Recall API path); fall
  // back to the legacy inline list for any bots that still surface it.
  const participants = liveParticipants.length > 0
    ? liveParticipants
    : (bot.meeting_metadata?.participants ?? []);
  const attribution = await attributeCustomer(participants, { titleHint: liveTitle });
  // Canonicalize aliased company names at the source so every spelling files
  // under ONE slug (e.g. "800 Flowers" → "1-800-Flowers.com"). No-op for names
  // not in the alias map.
  const slugFor = (name: string) => kebabCase(canonicalCompanyName(name));
  if (attribution.confidence === "high" || attribution.confidence === "medium") {
    if (attribution.companyName) return { slug: slugFor(attribution.companyName), attribution };
  }
  // Title-based fallback (confidence "low") still attributes — better
  // than dumping every meeting into _unsorted/ when emails are missing.
  if (attribution.confidence === "low" && attribution.companyName) {
    return { slug: slugFor(attribution.companyName), attribution };
  }
  return { slug: "_unsorted", attribution };
}

// Union the observed in-meeting roster with calendar invitees, adding invitee
// emails the roster is missing (dedup by email). Teams rosters are email-less,
// so invitees supply the domains attribution needs.
function mergeParticipants(observed: RecallParticipant[], invitees: RecallParticipant[]): RecallParticipant[] {
  const have = new Set(observed.map((p) => p.email?.toLowerCase()).filter(Boolean) as string[]);
  const extra: RecallParticipant[] = [];
  for (const iv of invitees) {
    const e = iv.email?.toLowerCase();
    if (e && !have.has(e)) { have.add(e); extra.push(iv); } // dedup invitees vs roster AND each other
  }
  return [...observed, ...extra];
}

// Fill missing emails on NAMED attendees by matching a company's HubSpot
// contacts. Requires BOTH the contact's first name AND every last-name token to
// appear as whole tokens in the participant name (handles "Last, First" Teams
// format) — avoids assigning the wrong contact's email when surnames collide.
function backfillEmailsFromContacts(
  participants: RecallParticipant[],
  contacts: Array<{ firstname: string | null; lastname: string | null; email: string | null }>,
): RecallParticipant[] {
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter(Boolean));
  return participants.map((p) => {
    if (p.email || !p.name) return p;
    const pn = tok(p.name);
    const match = contacts.find((c) => {
      if (!c.email || !c.firstname || !c.lastname) return false;
      const fn = c.firstname.toLowerCase().replace(/[^a-z]+/g, "");
      const lastTokens = [...tok(c.lastname)];
      return fn.length > 1 && pn.has(fn) && lastTokens.length > 0 && lastTokens.every((t) => pn.has(t));
    });
    return match?.email ? { ...p, email: match.email } : p;
  });
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
  hasChat: boolean;
  liveParticipants: RecallParticipant[];
  liveTitle: string | null;
}): string {
  const { bot, slug, attribution, videoOid, videoSize, muxAssetId, muxPlaybackId, hasTranscript, hasChat, liveParticipants, liveTitle } = opts;
  const participants = liveParticipants.length > 0
    ? liveParticipants
    : (bot.meeting_metadata?.participants ?? []);
  const startedAt = bot.recordings?.[0]?.started_at ?? bot.join_at ?? null;
  const endedAt = bot.recordings?.[0]?.completed_at ?? null;
  const platform = typeof bot.meeting_url === "object" ? bot.meeting_url?.platform ?? null : null;
  const meetingUrl = typeof bot.meeting_url === "string" ? bot.meeting_url : null;

  return JSON.stringify(
    {
      recall_bot_id: bot.id,
      title: liveTitle ?? bot.meeting_metadata?.title ?? bot.bot_name ?? "Untitled meeting",
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
      has_chat: hasChat,
      schema_version: 2,
    },
    null,
    2,
  ) + "\n";
}
