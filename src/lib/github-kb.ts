// Helpers for committing files to the reddy-gtm-kb repo via GitHub's Git
// Data API. Goes around the simpler Contents API because we want
// multi-file atomic commits (transcript.txt + meta.json + LFS pointer all
// in one tree). Uses optimistic concurrency: if main moves between our
// "get ref" and "update ref" calls, we retry from scratch.

const GH_API = "https://api.github.com";
const REPO = { owner: "ReddySolutions", name: "reddy-gtm" };
const BRANCH = "main";

function ghHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function gh<T>(
  pat: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${GH_API}/repos/${REPO.owner}/${REPO.name}${path}`, {
    method,
    headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`GH ${method} ${path} -> ${res.status} ${txt.slice(0, 300)}`);
  return { status: res.status, body: txt ? (JSON.parse(txt) as T) : ({} as T) };
}

export type CommitFile = {
  path: string; // repo-relative
  // Provide one of these:
  utf8?: string;
  base64?: string;
  // For LFS: pass the pointer text as utf8 — the actual bytes go via
  // uploadLfsBlob() in lib/github-lfs.ts before this commit lands.
};

// Atomic commit: writes N files in one commit on `main`. Retries up to
// 3 times if main advances under us between read and update.
export async function commitToKb(args: {
  pat: string;
  message: string;
  files: CommitFile[];
}): Promise<{ commitSha: string }> {
  const { pat, message, files } = args;

  let attempt = 0;
  while (attempt < 3) {
    attempt += 1;
    try {
      // 1. Current head of main
      const ref = await gh<{ object: { sha: string } }>(pat, "GET", `/git/ref/heads/${BRANCH}`);
      const parentCommitSha = ref.body.object.sha;

      // 2. Parent commit's tree
      const parentCommit = await gh<{ tree: { sha: string } }>(
        pat,
        "GET",
        `/git/commits/${parentCommitSha}`,
      );
      const parentTreeSha = parentCommit.body.tree.sha;

      // 3. Create a blob per file (using base64 to support binary-ish content
      // safely — the LFS pointer is plain text but going through base64 keeps
      // a single code path).
      const blobShas = await Promise.all(
        files.map(async (f) => {
          const content = f.base64 ?? Buffer.from(f.utf8 ?? "", "utf8").toString("base64");
          const res = await gh<{ sha: string }>(pat, "POST", `/git/blobs`, {
            content,
            encoding: "base64",
          });
          return { path: f.path, sha: res.body.sha };
        }),
      );

      // 4. New tree, parented on the existing tree (so we only touch the
      // listed paths; everything else stays).
      const tree = await gh<{ sha: string }>(pat, "POST", `/git/trees`, {
        base_tree: parentTreeSha,
        tree: blobShas.map((b) => ({
          path: b.path,
          mode: "100644",
          type: "blob",
          sha: b.sha,
        })),
      });

      // 5. New commit
      const commit = await gh<{ sha: string }>(pat, "POST", `/git/commits`, {
        message,
        tree: tree.body.sha,
        parents: [parentCommitSha],
      });

      // 6. Fast-forward main (will 422 if main moved — retry below).
      await gh(pat, "PATCH", `/git/refs/heads/${BRANCH}`, {
        sha: commit.body.sha,
        force: false,
      });

      return { commitSha: commit.body.sha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Concurrency loss → retry. Anything else → bubble up.
      if (msg.includes("422") && msg.toLowerCase().includes("update is not a fast forward")) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("commitToKb: exceeded retries due to concurrent main updates");
}

// Read a file from main on the KB. Returns the raw content string. Used to
// pull meta.json + the LFS pointer when serving a video URL.
export async function readKbFile(pat: string, repoPath: string): Promise<string | null> {
  const res = await fetch(
    `${GH_API}/repos/${REPO.owner}/${REPO.name}/contents/${encodeURI(repoPath)}?ref=${BRANCH}`,
    { headers: ghHeaders(pat) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`readKbFile ${repoPath} -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) return null;
  return Buffer.from(body.content, (body.encoding ?? "base64") as BufferEncoding).toString("utf8");
}

export const KB_REPO = REPO;
