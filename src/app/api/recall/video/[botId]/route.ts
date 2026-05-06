import { NextRequest, NextResponse } from "next/server";
import { readKbFile, KB_REPO } from "@/lib/github-kb";
import { lfsDownloadUrl, parseLfsPointer } from "@/lib/github-lfs";
import { verifyVideoToken } from "@/lib/video-link";

// Stream a meeting video to the caller with proper mp4 headers, so a
// click in Slack downloads as `meeting-{prefix}.mp4` rather than a
// generic blob.
//
// Auth — TWO accepted modes:
//   1. `x-reddy-secret` header equal to RECALL_VIDEO_FETCH_SECRET
//      (used by the agent in the sandbox calling this directly).
//   2. `?token=<signed>` query param (HMAC of botId + expiry, signed
//      with the same secret). This is what makes clickable Slack URLs
//      work — browsers can't send custom headers on a plain link.
//
// The endpoint then locates the meeting's LFS pointer in the kb, asks
// GitHub LFS for a fresh signed download URL, fetches the bytes, and
// proxies them back with `Content-Type: video/mp4` +
// `Content-Disposition: attachment; filename="..."`. GitHub's LFS
// storage serves files as `binary/octet-stream` with no filename, which
// is why we proxy instead of redirect.
export async function GET(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  const secret = process.env.RECALL_VIDEO_FETCH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  const headerOk = req.headers.get("x-reddy-secret") === secret;
  const token = req.nextUrl.searchParams.get("token");
  const tokenOk = token ? verifyVideoToken(token, botId, secret) : false;
  if (!headerOk && !tokenOk) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) {
    return NextResponse.json({ ok: false, error: "PAT not set" }, { status: 500 });
  }

  // Caller can pass the customer slug to skip the search.
  const slugHint = req.nextUrl.searchParams.get("customer");
  const path = await locateVideoPointer(pat, botId, slugHint);
  if (!path) {
    return NextResponse.json({ ok: false, error: "no video pointer found for bot" }, { status: 404 });
  }

  const pointerText = await readKbFile(pat, path);
  if (!pointerText) {
    return NextResponse.json({ ok: false, error: "pointer file unreadable" }, { status: 404 });
  }

  const obj = parseLfsPointer(pointerText);
  if (!obj) {
    return NextResponse.json({ ok: false, error: "video.mp4 is not an LFS pointer" }, { status: 422 });
  }

  let dl: { url: string; expiresAt: string | null } | null;
  try {
    dl = await lfsDownloadUrl(pat, KB_REPO, obj);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  if (!dl) {
    return NextResponse.json({ ok: false, error: "LFS object not available" }, { status: 404 });
  }

  // Stream from GitHub's LFS CDN through Vercel with proper headers.
  const upstream = await fetch(dl.url);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { ok: false, error: `LFS upstream ${upstream.status}` },
      { status: 502 },
    );
  }

  // Filename: derive from path so customer + bot prefix appear (so a
  // user with multiple downloads can tell them apart).
  const segments = path.split("/");
  const customerSlug = segments[3] ?? "meeting";
  const filename = `${customerSlug}-${botId.slice(0, 8)}.mp4`;

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(obj.size),
      // Don't have intermediaries cache per-token URLs.
      "Cache-Control": "private, max-age=0, no-store",
    },
  });
}

async function locateVideoPointer(
  pat: string,
  botId: string,
  slugHint: string | null,
): Promise<string | null> {
  if (slugHint) {
    const candidate = `corpora/success/customers/${slugHint}/meetings/${botId}/video.mp4`;
    const ok = await readKbFile(pat, candidate);
    if (ok) return candidate;
  }
  const q = encodeURIComponent(`repo:${KB_REPO.owner}/${KB_REPO.name} path:meetings/${botId} filename:video.mp4`);
  const res = await fetch(`https://api.github.com/search/code?q=${q}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { items?: Array<{ path: string }> };
  return body.items?.[0]?.path ?? null;
}
