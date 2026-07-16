import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";

// Read the buffered realtime transcript for an in-progress (or just-
// ended) bot. The agent calls this with `x-reddy-secret` mid-meeting
// to answer "what did Bob just say in my Acme call".
//
// Query params:
//   limit  optional, default 200, max 5000
//   since  optional ISO timestamp; only return lines newer than this
//   format optional: "json" (default) or "text" (Speaker: line\n form)

const LIST_KEY = (botId: string) => `recall:rt:${botId}:lines`;

type Line = {
  ts: string;
  rel: number | null;
  speaker: string | null;
  email: string | null;
  text: string;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  const secret = process.env.RECALL_VIDEO_FETCH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  if (req.headers.get("x-reddy-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }

  const limit = Math.min(
    Math.max(1, Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "200", 10) || 200),
    5000,
  );
  const sinceParam = req.nextUrl.searchParams.get("since");
  const format = req.nextUrl.searchParams.get("format") ?? "json";

  const raw = await kv.lrange<string>(LIST_KEY(botId), -limit, -1).catch(() => [] as string[]);
  let lines: Line[] = raw
    .map((s) => {
      try {
        return JSON.parse(s) as Line;
      } catch {
        return null;
      }
    })
    .filter((l): l is Line => !!l);

  if (sinceParam) {
    const sinceMs = Date.parse(sinceParam);
    if (Number.isFinite(sinceMs)) {
      lines = lines.filter((l) => Date.parse(l.ts) > sinceMs);
    }
  }

  // Also pull any "live tails" — the latest partial utterance per
  // participant — so callers can see speech that hasn't yet been
  // finalized by deepgram. Tail keys: recall:rt:{bot}:tail:{pid}.
  const tailKeys = await kv.keys(`recall:rt:${botId}:tail:*`).catch(() => [] as string[]);
  const tails: Line[] = [];
  if (tailKeys.length > 0) {
    const tailVals = await Promise.all(
      tailKeys.map((k) => kv.get<string>(k).catch(() => null)),
    );
    for (const v of tailVals) {
      if (!v) continue;
      try {
        tails.push(JSON.parse(v) as Line);
      } catch {
        // skip
      }
    }
  }

  if (format === "text") {
    const body = [
      ...lines.map((l) => `${l.speaker ?? "Unknown"}: ${l.text}`),
      ...tails.map((l) => `${l.speaker ?? "Unknown"} (live): ${l.text}`),
    ].join("\n");
    return new NextResponse(body, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.json({ ok: true, botId, count: lines.length, lines, tails });
}
