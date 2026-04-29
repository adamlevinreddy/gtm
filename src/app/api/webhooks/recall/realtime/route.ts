import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";

// Realtime transcript receiver. Recall fires this once per finalized
// utterance (`transcript.data` event) for any bot whose recording_config
// includes a realtime_endpoint pointing here. We append a compact line
// into a per-bot KV list so the agent can answer "what's been said in
// my Acme call so far" mid-meeting.
//
// Auth: query-param token (Recall's HMAC option also exists but the
// token model is simpler and equally secure for our threat model — the
// token is only known to us and Recall's egress).
//
// KV schema:
//   recall:rt:{bot_id}:lines  Redis LIST, head=oldest (rpush)
//                              entry: JSON {ts, rel, speaker, email, text}
//                              TTL: 6h refreshed on every push
//
// Return 200 fast — Recall retries up to 60x on non-2xx with 1s backoff,
// so a slow handler can flood us. KV writes are O(ms); we don't fan out.

export const maxDuration = 30;

const LIST_TTL_SECONDS = 6 * 60 * 60;
const MAX_LINES_PER_BOT = 5000;

type RealtimePayload = {
  event?: string;
  data?: {
    bot?: { id?: string };
    data?: {
      participant?: {
        id?: number;
        name?: string;
        email?: string | null;
      };
      words?: Array<{
        text?: string;
        start_timestamp?: { relative?: number };
      }>;
    };
  };
};

export async function POST(req: NextRequest) {
  const token = process.env.RECALL_REALTIME_WEBHOOK_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  if (req.nextUrl.searchParams.get("token") !== token) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: RealtimePayload;
  try {
    payload = (await req.json()) as RealtimePayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // We currently only act on finalized utterances. Partials would double
  // the volume and the agent doesn't need word-by-word streaming.
  if (payload.event !== "transcript.data") {
    return NextResponse.json({ ok: true, ignored: payload.event });
  }
  const botId = payload.data?.bot?.id;
  const inner = payload.data?.data;
  const words = inner?.words ?? [];
  if (!botId || words.length === 0) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const text = words
    .map((w) => w.text ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!text) return NextResponse.json({ ok: true, skipped: true });

  const line = {
    ts: new Date().toISOString(),
    rel: words[0]?.start_timestamp?.relative ?? null,
    speaker: inner?.participant?.name ?? null,
    email: inner?.participant?.email ?? null,
    text,
  };

  const key = `recall:rt:${botId}:lines`;
  try {
    await kv.rpush(key, JSON.stringify(line));
    await kv.expire(key, LIST_TTL_SECONDS);
    // Cap list size — for a 4-hour meeting at 5 utterances/min you'd
    // hit ~1200 entries, but a runaway agent shouldn't blow up KV.
    await kv.ltrim(key, -MAX_LINES_PER_BOT, -1);
  } catch (err) {
    console.error(`[realtime] kv write failed bot=${botId}: ${err instanceof Error ? err.message : err}`);
    // Still return 200 — retrying won't help for a KV outage and we
    // don't want Recall to flood us.
  }
  return NextResponse.json({ ok: true });
}
