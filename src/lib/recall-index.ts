// Read the recent meeting index directly from the kb via GitHub's API.
// Used by /api/agent/oneshot to pre-inject "here's what's in the kb"
// into the user's MCP message — so the agent can't accidentally route
// to Granola without acknowledging the kb has data.

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
};

export type IndexedMeeting = {
  customer_slug: string;
  bot_id: string;
  started_at: string | null;
  attendees: Array<{ name: string | null; email: string | null }>;
  has_transcript: boolean;
  has_video: boolean;
  platform: string | null;
};

// List recent meeting folders. Returns up to N most-recent meetings
// (across all customer slugs including _unsorted), with metadata. We
// query the GitHub Trees API once for the whole `corpora/success/
// customers/` subtree, filter for meta.json paths, then fetch each in
// parallel.
export async function recentMeetingIndex(pat: string, sinceDays = 7, limit = 20): Promise<IndexedMeeting[]> {
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

      return {
        customer_slug,
        bot_id,
        started_at: parsed.started_at ?? null,
        attendees: (parsed.attendees ?? []).map((a) => ({ name: a.name ?? null, email: a.email ?? null })),
        has_transcript: !!parsed.has_transcript,
        has_video: !!parsed.video,
        platform: parsed.platform ?? null,
      } as IndexedMeeting;
    }),
  );

  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const filtered = fetched
    .filter((m): m is IndexedMeeting => !!m && !!m.started_at)
    .filter((m) => {
      const t = Date.parse(m.started_at as string);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.started_at as string) - Date.parse(a.started_at as string))
    .slice(0, limit);
  return filtered;
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
    return `- ${m.started_at} ${m.platform ?? ""} ${m.customer_slug}/${m.bot_id} [${flags.join("+") || "metadata only"}] attendees: ${attLabel}`;
  });
  return lines.join("\n");
}

function ghHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
