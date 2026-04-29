// Read the recent meeting index directly from the kb via GitHub's API.
// Used by /api/agent/oneshot to pre-inject "here's what's in the kb"
// into the user's MCP message — so the agent can't accidentally route
// to Granola without acknowledging the kb has data.

import { buildVideoLink } from "./video-link";
import { signedPlayerUrl } from "./mux";
import { listActiveBots, type RecallBot } from "./recall";

const GH_API = "https://api.github.com";
const REPO = { owner: "ReddySolutions", name: "reddy-gtm" };

type MetaJson = {
  recall_bot_id?: string;
  title?: string;
  started_at?: string | null;
  ended_at?: string | null;
  platform?: string | null;
  attendees?: Array<{ name: string | null; email: string | null; is_host: boolean | null }>;
  attribution?: { customer_slug?: string; confidence?: string };
  has_transcript?: boolean;
  video?: { oid: string; size: number } | null;
  mux?: { asset_id: string; playback_id: string } | null;
};

export type IndexedMeeting = {
  customer_slug: string;
  bot_id: string;
  started_at: string | null;
  attendees: Array<{ name: string | null; email: string | null }>;
  has_transcript: boolean;
  has_video: boolean;
  has_mux: boolean;
  platform: string | null;
  // Pre-minted clickable playback URL when the meeting has a video.
  // Prefers a Mux signed player URL (no auth required, embeds Mux's
  // web player) when meta.mux.playback_id is present; falls back to
  // the LFS proxy URL with HMAC-signed token for legacy meetings.
  // Saves the agent a round-trip.
  video_url?: string | null;
};

// List recent meeting folders. Returns up to N most-recent meetings
// (across all customer slugs including _unsorted), with metadata. We
// query the GitHub Trees API once for the whole `corpora/success/
// customers/` subtree, filter for meta.json paths, then fetch each in
// parallel.
//
// If `videoLinkOpts` is supplied, also pre-mints a clickable video
// URL for each meeting that has a video — saves the agent from
// having to curl /api/recall/video-link.
export async function recentMeetingIndex(
  pat: string,
  sinceDays = 7,
  limit = 20,
  videoLinkOpts?: { baseUrl: string; secret: string; ttlSeconds?: number },
): Promise<IndexedMeeting[]> {
  // Get the latest commit's tree SHA on main
  const refRes = await fetch(`${GH_API}/repos/${REPO.owner}/${REPO.name}/git/ref/heads/main`, {
    headers: ghHeaders(pat),
  });
  if (!refRes.ok) return [];
  const ref = (await refRes.json()) as { object: { sha: string } };
  const commitRes = await fetch(`${GH_API}/repos/${REPO.owner}/${REPO.name}/git/commits/${ref.object.sha}`, {
    headers: ghHeaders(pat),
  });
  if (!commitRes.ok) return [];
  const commit = (await commitRes.json()) as { tree: { sha: string } };

  // Recursive tree fetch for the subtree we care about. The full repo
  // tree may be large; GitHub will set `truncated: true` if so. The
  // /trees endpoint with recursive=1 returns paths.
  const treeRes = await fetch(
    `${GH_API}/repos/${REPO.owner}/${REPO.name}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: ghHeaders(pat) },
  );
  if (!treeRes.ok) return [];
  const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; sha: string }> };
  const metaPaths = (tree.tree ?? [])
    .filter((e) => e.type === "blob" && e.path.startsWith("corpora/success/customers/") && e.path.endsWith("/meta.json"))
    .map((e) => ({ path: e.path, sha: e.sha }));

  if (metaPaths.length === 0) return [];

  // Fetch up to `limit * 2` blobs in parallel (we'll filter by date
  // afterwards; over-fetching a bit so the date cutoff doesn't leave
  // us with too few entries).
  const candidates = metaPaths.slice(-Math.max(limit * 2, 30));

  type IndexedRow = IndexedMeeting & { _muxPlaybackId: string | null };

  const fetched = await Promise.all(
    candidates.map(async (entry) => {
      const blob = await fetch(`${GH_API}/repos/${REPO.owner}/${REPO.name}/git/blobs/${entry.sha}`, {
        headers: ghHeaders(pat),
      });
      if (!blob.ok) return null;
      const body = (await blob.json()) as { content?: string; encoding?: string };
      if (!body.content) return null;
      const text = Buffer.from(body.content, (body.encoding ?? "base64") as BufferEncoding).toString("utf8");
      let parsed: MetaJson;
      try {
        parsed = JSON.parse(text) as MetaJson;
      } catch {
        return null;
      }

      // path: corpora/success/customers/{slug}/meetings/{bot_id}/meta.json
      const segs = entry.path.split("/");
      const customer_slug = segs[3] ?? "_unsorted";
      const bot_id = parsed.recall_bot_id ?? segs[5] ?? "";

      const row: IndexedRow = {
        customer_slug,
        bot_id,
        started_at: parsed.started_at ?? null,
        attendees: (parsed.attendees ?? []).map((a) => ({ name: a.name ?? null, email: a.email ?? null })),
        has_transcript: !!parsed.has_transcript,
        has_video: !!parsed.video,
        has_mux: !!parsed.mux?.playback_id,
        platform: parsed.platform ?? null,
        // Stash the Mux playback id on the row so we can mint a signed
        // URL below without re-reading meta.json.
        _muxPlaybackId: parsed.mux?.playback_id ?? null,
      };
      return row;
    }),
  );

  // Cutoff anchored to PT midnight, sinceDays back. Users are all on
  // Pacific time — a UTC-anchored cutoff at 11pm PT silently rolls into
  // the next day and excludes meetings from the start of the user's day.
  const cutoff = ptMidnightDaysAgo(sinceDays);
  const filtered = fetched
    .filter((m): m is IndexedRow => !!m && !!m.started_at)
    .filter((m) => {
      const t = Date.parse(m.started_at as string);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.started_at as string) - Date.parse(a.started_at as string))
    .slice(0, limit);

  if (videoLinkOpts) {
    const ttl = videoLinkOpts.ttlSeconds ?? 7 * 86400;
    const muxConfigured = !!process.env.MUX_SIGNING_KEY_ID && !!process.env.MUX_SIGNING_KEY_PRIVATE;
    for (const m of filtered) {
      if (!m.bot_id) continue;
      if (m._muxPlaybackId && muxConfigured) {
        try {
          m.video_url = signedPlayerUrl(m._muxPlaybackId, ttl);
        } catch {
          // Fall through to LFS proxy if signing fails for any reason.
        }
      }
      if (!m.video_url && m.has_video) {
        m.video_url = buildVideoLink({
          baseUrl: videoLinkOpts.baseUrl,
          botId: m.bot_id,
          customer: m.customer_slug,
          secret: videoLinkOpts.secret,
          ttlSeconds: ttl,
        });
      }
    }
  }

  // Drop the internal _muxPlaybackId stash before returning.
  return filtered.map((m) => {
    const { _muxPlaybackId: _drop, ...rest } = m;
    void _drop;
    return rest;
  });
}

export function formatMeetingIndex(meetings: IndexedMeeting[]): string {
  if (meetings.length === 0) {
    return "(no recent kb meetings — kb glob will return zero; falling back to Granola/Recall API is appropriate)";
  }
  const lines = meetings.map((m) => {
    const attLabel = m.attendees
      .map((a) => a.name ?? a.email ?? "?")
      .filter((s) => s !== "?")
      .join(", ") || "(no attendees in meta)";
    const flags: string[] = [];
    if (m.has_transcript) flags.push("transcript");
    if (m.has_video) flags.push("video");
    const startedPt = m.started_at ? formatPt(m.started_at) : "(no start)";
    let line = `- ${startedPt} ${m.platform ?? ""} ${m.customer_slug}/${m.bot_id} [${flags.join("+") || "metadata only"}] attendees: ${attLabel}`;
    if (m.video_url) {
      line += `\n  video_url: ${m.video_url}`;
    }
    return line;
  });
  return lines.join("\n");
}

// Format a UTC ISO timestamp as Pacific local for display. Example:
// "2026-04-27T17:00:23Z" → "2026-04-27 10:00 PT". The PT label intentionally
// drops the PST/PDT distinction — agent and user only need the wall-clock
// time, not the offset.
function formatPt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} ${time} PT`;
}

// Returns epoch ms for "midnight PT, N days ago". Used so a "last 7 days"
// query at 11pm PT still includes meetings from 7 calendar days back rather
// than rolling forward into UTC tomorrow.
function ptMidnightDaysAgo(daysAgo: number): number {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD" in PT
  // Midnight PT = midnight America/Los_Angeles. We can't construct that
  // directly from a Date, but we can ask Intl what "midnight PT today"
  // looks like in UTC by computing the offset for the current instant.
  const ptNow = new Date(`${ymd}T00:00:00Z`); // pretend midnight in UTC for the PT date
  // Compute UTC offset for America/Los_Angeles right now (handles DST).
  const offsetMin = ptOffsetMinutes(now);
  const ptMidnightUtcMs = ptNow.getTime() + offsetMin * 60 * 1000;
  return ptMidnightUtcMs - daysAgo * 24 * 60 * 60 * 1000;
}

function ptOffsetMinutes(d: Date): number {
  // The offset for "America/Los_Angeles" relative to UTC, in minutes.
  // PDT = +420 (UTC is 7h ahead), PST = +480 (UTC is 8h ahead).
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  });
  const parts = dtf.formatToParts(d);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  // "GMT-7" / "GMT-8" → 420 / 480 (minutes Eastern of PT, i.e. UTC offset)
  const m = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 480;
  const sign = m[1] === "-" ? 1 : -1;
  const hours = Number.parseInt(m[2], 10);
  const mins = Number.parseInt(m[3] ?? "0", 10);
  return sign * (hours * 60 + mins);
}

function ghHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Pre-formatted "what's live right now" block for the agent prompt.
// Lets "what's been said in <meeting>" queries skip the bot-discovery
// step — bot_id is right in the prompt, agent just curls the realtime
// endpoint with that ID.
export async function activeMeetingsBlock(): Promise<string> {
  const bots = await listActiveBots({ limit: 10 }).catch(() => [] as RecallBot[]);
  if (bots.length === 0) return "";
  const lines = bots.map((b) => {
    const title =
      b.recordings?.[0]?.media_shortcuts?.meeting_metadata?.data?.title ??
      b.meeting_metadata?.title ??
      b.bot_name ??
      "Untitled";
    const startedRaw = b.recordings?.[0]?.started_at ?? b.join_at ?? null;
    const started = startedRaw ? formatPt(startedRaw) : "(no start)";
    return `- "${title}" · started ${started} · bot_id=${b.id}`;
  });
  return [
    "[active recall meetings — speakers may still be talking]",
    "For \"what's being said now / what did Bob just say\" questions, hit:",
    "  GET $REDDY_GTM_BASE_URL/api/recall/realtime/<bot_id>?format=text",
    "  -H \"x-reddy-secret: $RECALL_VIDEO_FETCH_SECRET\"",
    "Bot ids (use these directly — no need to look up):",
    ...lines,
  ].join("\n");
}
