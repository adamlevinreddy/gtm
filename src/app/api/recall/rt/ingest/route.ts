import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";

// NOTE: also exposed at /api/recall/rt/ingest as a fallback path in
// case Recall's webhook delivery system has marked the original URL
// as failed (their 60-retry hard limit silently disables endpoints).
//
// Realtime transcript receiver. Recall fires this for every transcript
// event from the bot's deepgram pipeline. Two event types matter here:
//
//   transcript.data          — deepgram finalized this chunk; commit
//                              it to the per-bot lines list.
//   transcript.partial_data  — in-flight words; overwrite a per-(bot,
//                              participant) "live tail" so the reader
//                              can see speech as it's happening, but
//                              don't append to the lines list yet.
//
// Without partials, deepgram_streaming + nova-3 may not fire any
// transcript.data events for short utterances until the speaker pauses
// long enough — so live questions during the call would see an empty
// buffer for ~minutes.
//
// Auth: query-param token. KV writes are O(ms); always return 200 fast
// so Recall doesn't go into 60x retry mode on a transient KV blip.
//
// KV schema:
//   recall:rt:{bot_id}:lines        Redis LIST, head=oldest (rpush),
//                                   each entry: JSON {ts, rel, speaker,
//                                   email, text}. TTL 6h.
//   recall:rt:{bot_id}:tail:{pid}   STRING (latest partial per
//                                   participant). TTL 6h.

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

// Catch any unexpected method probes (Recall might HEAD/GET to validate)
// — log them and reply 200 instead of 405 in case the validator is strict.
export async function GET(req: NextRequest) {
  console.log(`[realtime] GET probe path=${req.nextUrl.pathname} qs=${req.nextUrl.search.slice(0, 80)}`);
  return NextResponse.json({ ok: true, hint: "POST events here" });
}
export async function HEAD(req: NextRequest) {
  console.log(`[realtime] HEAD probe path=${req.nextUrl.pathname}`);
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  // Aggressive entry-point log — we want to confirm Recall is even
  // hitting us. Logs every inbound request including auth misses.
  console.log(
    `[realtime] ENTRY method=POST path=${req.nextUrl.pathname} ` +
      `qs=${req.nextUrl.search.slice(0, 80)} ` +
      `ua=${(req.headers.get("user-agent") ?? "").slice(0, 60)} ` +
      `ct=${req.headers.get("content-type") ?? "?"}`,
  );
  const token = process.env.RECALL_REALTIME_WEBHOOK_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  if (req.nextUrl.searchParams.get("token") !== token) {
    console.warn(`[realtime] unauthorized request — token mismatch`);
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: RealtimePayload;
  try {
    payload = (await req.json()) as RealtimePayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const eventName = payload.event ?? "";
  const botId = payload.data?.bot?.id;
  const inner = payload.data?.data;
  const words = inner?.words ?? [];
  const isFinal = eventName === "transcript.data";
  const isPartial = eventName === "transcript.partial_data";
  if (!botId || (!isFinal && !isPartial)) {
    console.log(`[realtime] ignored event=${eventName} bot=${botId ?? "?"}`);
    return NextResponse.json({ ok: true, ignored: eventName });
  }
  if (words.length === 0) {
    return NextResponse.json({ ok: true, skipped: "empty words" });
  }

  const text = words
    .map((w) => w.text ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!text) return NextResponse.json({ ok: true, skipped: "empty text" });

  const speaker = inner?.participant?.name ?? null;
  const email = inner?.participant?.email ?? null;
  const participantId = inner?.participant?.id ?? 0;
  const line = {
    ts: new Date().toISOString(),
    rel: words[0]?.start_timestamp?.relative ?? null,
    speaker,
    email,
    text,
  };

  const linesKey = `recall:rt:${botId}:lines`;
  const tailKey = `recall:rt:${botId}:tail:${participantId}`;
  try {
    if (isFinal) {
      await kv.rpush(linesKey, JSON.stringify(line));
      await kv.expire(linesKey, LIST_TTL_SECONDS);
      await kv.ltrim(linesKey, -MAX_LINES_PER_BOT, -1);
      // The finalized utterance supersedes whatever partial we had.
      await kv.del(tailKey).catch(() => {});
    } else {
      // Partial: overwrite the live tail for this participant.
      await kv.set(tailKey, JSON.stringify(line), { ex: LIST_TTL_SECONDS });
    }
    console.log(`[realtime] ${eventName} bot=${botId} speaker=${speaker} chars=${text.length}`);
  } catch (err) {
    console.error(`[realtime] kv write failed bot=${botId}: ${err instanceof Error ? err.message : err}`);
  }
  return NextResponse.json({ ok: true });
}
