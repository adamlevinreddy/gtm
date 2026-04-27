import { NextRequest, NextResponse } from "next/server";
import { readKbFile, KB_REPO } from "@/lib/github-kb";
import { lfsDownloadUrl, parseLfsPointer } from "@/lib/github-lfs";

// Return a fresh, presigned download URL for a meeting's video.
//
// 1. Find the meeting folder under any customer's `meetings/{botId}/` (the
//    customer slug isn't known to the caller — only the bot ID — so we
//    locate the meta.json by bot ID).
// 2. Read the LFS pointer file `video.mp4`, parse the OID + size.
// 3. Hit GitHub's LFS Batch API to get a fresh signed URL (~5 min expiry).
// 4. Return it. The agent posts the URL to Slack; the user clicks it; the
//    browser downloads the mp4 directly from GitHub's CDN — no proxy.
//
// Auth: x-reddy-secret matching RECALL_VIDEO_FETCH_SECRET (so this stays
// internal — only the agent in the sandbox should be hitting it).
export async function GET(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  const expected = process.env.RECALL_VIDEO_FETCH_SECRET;
  const provided = req.headers.get("x-reddy-secret");
  if (expected && provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!botId) {
    return NextResponse.json({ ok: false, error: "missing botId" }, { status: 400 });
  }

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) {
    return NextResponse.json({ ok: false, error: "PAT not set" }, { status: 500 });
  }

  // Caller can pass the customer slug to skip the search — saves a few
  // GitHub round-trips. Otherwise we use code search to locate the
  // meta.json. (For volumes <1k meetings the search route is plenty fast.)
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

  try {
    const dl = await lfsDownloadUrl(pat, KB_REPO, obj);
    if (!dl) {
      return NextResponse.json({ ok: false, error: "LFS object not available" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, url: dl.url, expiresAt: dl.expiresAt, oid: obj.oid, size: obj.size });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

// Find the path of `video.mp4` in `corpora/success/customers/*/meetings/{botId}/video.mp4`.
// Tries the slug hint first, then falls back to GitHub code search.
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

  // GitHub code search: find any `video.mp4` under a meetings/{botId}/ folder.
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
