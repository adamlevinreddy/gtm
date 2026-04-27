import { NextRequest, NextResponse } from "next/server";
import { buildVideoLink } from "@/lib/video-link";

// Mint a self-authenticating, time-limited download URL for a meeting
// video. The agent calls this with the `x-reddy-secret` header (since
// the secret already lives in its sandbox env) and posts the returned
// `url` directly into Slack. Whoever clicks the link in Slack streams
// the mp4 from us with proper headers — no auth needed at click time
// because the URL itself carries an HMAC-signed token.
//
// Default TTL: 1 hour. Pass ?ttl=86400 for 24h, etc. Capped at 7 days.
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

  const customer = req.nextUrl.searchParams.get("customer");
  const ttlRaw = req.nextUrl.searchParams.get("ttl");
  const ttlSeconds = Math.min(
    Math.max(60, ttlRaw ? Number.parseInt(ttlRaw, 10) || 3600 : 3600),
    7 * 24 * 60 * 60,
  );

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const url = buildVideoLink({ baseUrl, botId, customer, secret, ttlSeconds });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return NextResponse.json({ ok: true, url, expiresAt, ttlSeconds });
}
