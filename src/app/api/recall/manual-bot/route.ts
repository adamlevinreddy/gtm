import { NextRequest, NextResponse } from "next/server";
import { buildDefaultBotConfig } from "@/lib/recall-calendar-v2";

// Spawn an ad-hoc Recall bot pointed at an arbitrary meeting URL.
// Used by the manual landing page (/recall-bot) for cases where the
// calendar-driven flow misses a meeting (last-minute invites, third-
// party calendars, etc.).
//
// Auth: x-reddy-secret header equal to RECALL_VIDEO_FETCH_SECRET.
// Same shared secret pattern we already use for the video link
// endpoints — anyone with that secret can spawn a bot, so guard it.

const REGION = process.env.RECALL_REGION ?? "us-west-2";
const RECALL_BASE = `https://${REGION}.recall.ai/api/v1`;

export async function POST(req: NextRequest) {
  const secret = process.env.RECALL_VIDEO_FETCH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  if (req.headers.get("x-reddy-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.RECALL_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "RECALL_API_KEY not set" }, { status: 500 });
  }

  const { meetingUrl, botName } = (await req.json()) as {
    meetingUrl?: string;
    botName?: string;
  };
  if (!meetingUrl || typeof meetingUrl !== "string") {
    return NextResponse.json({ ok: false, error: "meetingUrl required" }, { status: 400 });
  }
  // Light validation — Recall will return its own error for unsupported URLs.
  try {
    new URL(meetingUrl);
  } catch {
    return NextResponse.json({ ok: false, error: "meetingUrl is not a valid URL" }, { status: 400 });
  }

  const cfg = buildDefaultBotConfig();
  const body = {
    meeting_url: meetingUrl,
    bot_name: botName?.trim() || cfg.bot_name,
    recording_config: cfg.recording_config,
  };

  const res = await fetch(`${RECALL_BASE}/bot/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[manual-bot] recall create bot -> ${res.status} ${text}`);
    return NextResponse.json({ ok: false, error: `Recall returned ${res.status}: ${text}` }, { status: 502 });
  }
  const bot = (await res.json()) as { id: string; meeting_url?: unknown; bot_name?: string };
  return NextResponse.json({
    ok: true,
    botId: bot.id,
    botName: bot.bot_name,
    meetingUrl,
  });
}
