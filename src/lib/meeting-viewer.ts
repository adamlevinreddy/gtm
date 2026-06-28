// Resolve a Recall botId → everything the in-board meeting viewer needs:
// the customer slug, meta (title/attendees/time), the persisted transcript,
// and a browser-playable video URL (Mux signed player iframe, else an inline
// LFS-proxy <video> src). All reads are server-side (KB via GitHub PAT, Mux
// signing) — the browser never holds a secret. Mirrors the resolution ladder
// in /api/recall/video-link (customer hint → _unsorted → code search → tree
// walk) so freshly-committed meetings resolve before code search indexes them.

import { readKbFile, KB_REPO } from "@/lib/github-kb";
import { signedPlayerUrl } from "@/lib/mux";
import { buildVideoLink } from "@/lib/video-link";
import { selfBaseUrl } from "@/lib/work-items";

export type MeetingMeta = {
  recall_bot_id?: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
  platform?: string;
  meeting_url?: string;
  attendees?: Array<{ name?: string; email?: string; is_host?: boolean }>;
  attribution?: { customer_slug?: string; company_name?: string };
  mux?: { playback_id?: string } | null;
  video?: { oid?: string; size?: number } | null;
  has_transcript?: boolean;
};

export type LoadedMeeting = {
  botId: string;
  slug: string | null;
  found: boolean;
  title: string;
  startedAt: string | null;
  platform: string | null;
  companyName: string | null;
  attendees: Array<{ name?: string; email?: string }>;
  transcript: string | null;
  video: { kind: "mux" | "lfs" | "none"; url: string | null };
};

const ghHeaders = (pat: string) => ({
  Authorization: `Bearer ${pat}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// Find the repo path to a meeting's meta.json. Returns null if not found.
async function findMetaPath(
  pat: string,
  botId: string,
  customerHint?: string | null
): Promise<string | null> {
  const tryPath = async (slug: string) => {
    const p = `corpora/success/customers/${slug}/meetings/${botId}/meta.json`;
    return (await readKbFile(pat, p).catch(() => null)) ? p : null;
  };
  if (customerHint) {
    const p = await tryPath(customerHint);
    if (p) return p;
  }
  const u = await tryPath("_unsorted");
  if (u) return u;

  // Code search (lags a few minutes behind fresh commits).
  try {
    const q = encodeURIComponent(
      `repo:${KB_REPO.owner}/${KB_REPO.name} path:meetings/${botId} filename:meta.json`
    );
    const res = await fetch(`https://api.github.com/search/code?q=${q}`, { headers: ghHeaders(pat) });
    if (res.ok) {
      const body = (await res.json()) as { items?: Array<{ path: string }> };
      if (body.items?.[0]?.path) return body.items[0].path;
    }
  } catch {
    /* fall through to tree walk */
  }

  // Failsafe: recursive tree walk (finds it even seconds after commit).
  try {
    const refRes = await fetch(
      `https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/ref/heads/main`,
      { headers: ghHeaders(pat) }
    );
    if (!refRes.ok) return null;
    const ref = (await refRes.json()) as { object: { sha: string } };
    const commitRes = await fetch(
      `https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/commits/${ref.object.sha}`,
      { headers: ghHeaders(pat) }
    );
    if (!commitRes.ok) return null;
    const commit = (await commitRes.json()) as { tree: { sha: string } };
    const treeRes = await fetch(
      `https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/git/trees/${commit.tree.sha}?recursive=1`,
      { headers: ghHeaders(pat) }
    );
    if (!treeRes.ok) return null;
    const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string }> };
    const match = (tree.tree ?? []).find(
      (e) => e.type === "blob" && e.path.includes(`/meetings/${botId}/meta.json`)
    );
    return match?.path ?? null;
  } catch {
    return null;
  }
}

// corpora/success/customers/{slug}/meetings/{botId}/meta.json → slug
function slugFromMetaPath(path: string): string | null {
  const seg = path.split("/");
  return seg[3] ?? null;
}

export async function loadMeeting(
  botId: string,
  opts?: { customerHint?: string | null; videoTtlSeconds?: number }
): Promise<LoadedMeeting> {
  const empty: LoadedMeeting = {
    botId, slug: null, found: false, title: "Meeting", startedAt: null,
    platform: null, companyName: null, attendees: [], transcript: null,
    video: { kind: "none", url: null },
  };
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat || !botId) return empty;

  const metaPath = await findMetaPath(pat, botId, opts?.customerHint);
  if (!metaPath) return empty;
  const slug = slugFromMetaPath(metaPath);

  const metaText = await readKbFile(pat, metaPath).catch(() => null);
  let meta: MeetingMeta = {};
  try {
    if (metaText) meta = JSON.parse(metaText) as MeetingMeta;
  } catch {
    /* keep empty meta */
  }

  const transcriptPath = metaPath.replace(/meta\.json$/, "transcript.txt");
  const transcript = await readKbFile(pat, transcriptPath).catch(() => null);

  const ttl = opts?.videoTtlSeconds ?? 6 * 3600;
  let video: LoadedMeeting["video"] = { kind: "none", url: null };
  if (meta.mux?.playback_id && process.env.MUX_SIGNING_KEY_ID && process.env.MUX_SIGNING_KEY_PRIVATE) {
    try {
      video = { kind: "mux", url: signedPlayerUrl(meta.mux.playback_id, ttl) };
    } catch {
      /* fall back to LFS */
    }
  }
  if (video.kind === "none" && meta.video?.oid) {
    const secret = process.env.RECALL_VIDEO_FETCH_SECRET;
    if (secret) {
      const baseUrl = process.env.PUBLIC_BASE_URL ?? selfBaseUrl();
      const link = buildVideoLink({ baseUrl, botId, customer: slug, secret, ttlSeconds: ttl });
      video = { kind: "lfs", url: `${link}&inline=1` };
    }
  }

  return {
    botId,
    slug,
    found: true,
    title: meta.title || "Meeting",
    startedAt: meta.started_at ?? null,
    platform: meta.platform ?? null,
    companyName: meta.attribution?.company_name ?? null,
    attendees: (meta.attendees ?? []).map((a) => ({ name: a.name, email: a.email })),
    transcript: transcript ?? null,
    video,
  };
}
