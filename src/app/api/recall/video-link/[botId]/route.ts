import { NextRequest, NextResponse } from "next/server";
import { buildVideoLink } from "@/lib/video-link";
import { signedPlayerUrl } from "@/lib/mux";
import { readKbFile, KB_REPO } from "@/lib/github-kb";

// Mint a clickable, time-limited video link for a meeting. Whoever
// clicks the link in Slack streams the video — no auth needed at click
// time because the URL itself carries a signed token.
//
// Resolution order:
//   1. Look up the meeting's meta.json for a `mux.playback_id`. If
//      present, return a Mux signed player URL (HLS, adaptive bitrate,
//      proper player UI). This is the path for all post-migration
//      meetings.
//   2. Otherwise (legacy meetings before Mux ingest), fall back to the
//      LFS proxy URL — `/api/recall/video/{botId}?token=…`. Same TTL
//      semantics; the proxy streams from GitHub LFS.
//
// Default TTL: 7 days. Pass ?ttl=NNN to override. Capped at 7 days.
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
    Math.max(60, ttlRaw ? Number.parseInt(ttlRaw, 10) || 7 * 86400 : 7 * 86400),
    7 * 24 * 60 * 60,
  );

  // Try Mux first.
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (pat) {
    const muxPlaybackId = await readMuxPlaybackId(pat, botId, customer);
    if (muxPlaybackId && process.env.MUX_SIGNING_KEY_ID && process.env.MUX_SIGNING_KEY_PRIVATE) {
      try {
        const url = signedPlayerUrl(muxPlaybackId, ttlSeconds);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        return NextResponse.json({ ok: true, url, expiresAt, ttlSeconds, source: "mux" });
      } catch (err) {
        console.warn(`[video-link] mux sign failed bot=${botId}: ${err instanceof Error ? err.message : err}`);
        // fall through to LFS proxy
      }
    }
  }

  // Fallback: LFS proxy.
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const url = buildVideoLink({ baseUrl, botId, customer, secret, ttlSeconds });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return NextResponse.json({ ok: true, url, expiresAt, ttlSeconds, source: "lfs-proxy" });
}

// Locate meta.json for a bot and pull the mux.playback_id, if present.
//
// Resolution order:
//   1. Customer hint (if caller passed `?customer=`) — direct read.
//   2. _unsorted/ — most likely landing slug for unattributed meetings.
//   3. GitHub code search across the kb (subject to indexing latency,
//      so it may miss commits less than a few minutes old).
//   4. Tree walk via the Git Trees API — guaranteed to find the file
//      if it exists, but slower (single recursive list of the kb).
//
// The walk is the failsafe: it lets newly-committed meetings work
// immediately, before code search has indexed them.
async function readMuxPlaybackId(
  pat: string,
  botId: string,
  customer: string | null,
): Promise<string | null> {
  if (customer) {
    const direct = await readKbFile(pat, `corpora/success/customers/${customer}/meetings/${botId}/meta.json`);
    const id = parseMuxPlaybackId(direct);
    if (id) return id;
  }
  const unsorted = await readKbFile(pat, `corpora/success/customers/_unsorted/meetings/${botId}/meta.json`);
  const fromUnsorted = parseMuxPlaybackId(unsorted);
  if (fromUnsorted) return fromUnsorted;
  // Code search.
  const q = encodeURIComponent(
    `repo:${KB_REPO.owner}/${KB_REPO.name} path:meetings/${botId} filename:meta.json`,
  );
  const res = await fetch(`https://api.github.com/search/code?q=${q}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.ok) {
    const body = (await res.json()) as { items?: Array<{ path: string }> };
    const path = body.items?.[0]?.path;
    if (path) {
      const text = await readKbFile(pat, path);
      const id = parseMuxPlaybackId(text);
      if (id) return id;
    }
  }
  // Failsafe: walk the kb tree for any meta.json under meetings/{botId}/
  return readMuxPlaybackIdViaTreeWalk(pat, botId);
}

async function readMuxPlaybackIdViaTreeWalk(pat: string, botId: string): Promise<string | null> {
  const ghHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const refRes = await fetch(`https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/ref/heads/main`, { headers: ghHeaders });
  if (!refRes.ok) return null;
  const ref = (await refRes.json()) as { object: { sha: string } };
  const commitRes = await fetch(`https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/commits/${ref.object.sha}`, { headers: ghHeaders });
  if (!commitRes.ok) return null;
  const commit = (await commitRes.json()) as { tree: { sha: string } };
  const treeRes = await fetch(
    `https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: ghHeaders },
  );
  if (!treeRes.ok) return null;
  const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string }> };
  const match = (tree.tree ?? []).find(
    (e) => e.type === "blob" && e.path.includes(`/meetings/${botId}/meta.json`),
  );
  if (!match) return null;
  const text = await readKbFile(pat, match.path);
  return parseMuxPlaybackId(text);
}

function parseMuxPlaybackId(text: string | null): string | null {
  if (!text) return null;
  try {
    const meta = JSON.parse(text) as { mux?: { playback_id?: string } | null };
    return meta.mux?.playback_id ?? null;
  } catch {
    return null;
  }
}
