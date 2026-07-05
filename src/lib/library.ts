// The Library (Daybreak Phase 11): a browsable view of the team KB —
// deliverables, pricing, legal, RFPs — everything under corpora/ EXCEPT the
// meetings tree (which has its own surface). Tree cached in KV by commit
// SHA, so steady-state is one KV read.

import { kv } from "@/lib/kv-client";

const GH_API = "https://api.github.com";
const REPO = { owner: "ReddySolutions", name: "reddy-gtm" };

export type LibraryFile = {
  path: string; // repo-relative, starts with corpora/
  name: string; // basename
  category: string; // first dir under corpora/ ("deliverables", "pricing", …)
  subpath: string; // between category and basename ("nike", "msa/2026", "")
  sizeBytes: number | null;
  ext: string;
};

function ghHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const HIDDEN = new Set([".gitattributes", ".gitkeep", "README.md", "latest.json"]);

// DOCUMENT allowlist. The KB carries template machinery (149 font binaries,
// .tsx deck sources, build assets) that would drown the actual documents —
// the Library shows things a teammate would open or send, nothing else.
const DOC_EXTS = new Set([
  "pdf", "md", "txt", "csv", "json",
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "key",
  "png", "jpg", "jpeg", "webp",
]);

export async function listLibraryFiles(pat: string): Promise<LibraryFile[]> {
  const refRes = await fetch(`${GH_API}/repos/${REPO.owner}/${REPO.name}/git/ref/heads/main`, {
    headers: ghHeaders(pat),
  });
  if (!refRes.ok) return [];
  const ref = (await refRes.json()) as { object: { sha: string } };

  const cacheKey = `kbtree:v1:${ref.object.sha}`;
  const cached = await kv.get<LibraryFile[]>(cacheKey).catch(() => null);
  if (cached) return cached;

  const commitRes = await fetch(
    `${GH_API}/repos/${REPO.owner}/${REPO.name}/git/commits/${ref.object.sha}`,
    { headers: ghHeaders(pat) },
  );
  if (!commitRes.ok) return [];
  const commit = (await commitRes.json()) as { tree: { sha: string } };
  const treeRes = await fetch(
    `${GH_API}/repos/${REPO.owner}/${REPO.name}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: ghHeaders(pat) },
  );
  if (!treeRes.ok) return [];
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };

  const files: LibraryFile[] = [];
  for (const e of tree.tree ?? []) {
    if (e.type !== "blob" || !e.path.startsWith("corpora/")) continue;
    // The meetings tree has its own surface (/meetings) — keep it out.
    if (e.path.startsWith("corpora/success/customers/")) continue;
    const segs = e.path.split("/");
    if (segs.length < 3) continue; // corpora/<category>/<file…>
    const name = segs[segs.length - 1];
    if (HIDDEN.has(name)) continue;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    if (!DOC_EXTS.has(ext)) continue;
    files.push({
      path: e.path,
      name,
      category: segs[1],
      subpath: segs.slice(2, -1).join("/"),
      sizeBytes: e.size ?? null,
      ext: (name.split(".").pop() ?? "").toLowerCase(),
    });
  }
  files.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  await kv.set(cacheKey, files, { ex: 3600 }).catch(() => {});
  return files;
}

// Which deliverable is THE latest — pointers live in each deliverable's
// OWN dir (corpora/deliverables/{title-slug}/latest.json), so candidate
// dirs are exactly the dirs with visible files. Reads are KV-cached 10 min
// per dir; a fresh lock shows within one cache window.
export async function latestPointers(
  pat: string,
  files: LibraryFile[],
): Promise<Map<string, { account: string; lockedBy: string }>> {
  const dirs = [
    ...new Set(files.filter((f) => f.category === "deliverables").map((f) => f.path.split("/").slice(0, -1).join("/"))),
  ];
  const out = new Map<string, { account: string; lockedBy: string }>();
  await Promise.all(
    dirs.slice(0, 60).map(async (dir) => {
      const ck = `latestptr:v1:${dir}`;
      type Ptr = { path?: string; account?: string; lockedBy?: string } | { miss: true };
      let ptr = await kv.get<Ptr>(ck).catch(() => null);
      if (!ptr) {
        try {
          const res = await fetch(
            `${GH_API}/repos/${REPO.owner}/${REPO.name}/contents/${dir}/latest.json`,
            { headers: { ...ghHeaders(pat), Accept: "application/vnd.github.raw" } },
          );
          ptr = res.ok ? (JSON.parse(await res.text()) as Ptr) : { miss: true };
        } catch {
          ptr = { miss: true };
        }
        await kv.set(ck, ptr, { ex: 600 }).catch(() => {});
      }
      if (ptr && !("miss" in ptr) && ptr.path) {
        out.set(ptr.path, { account: ptr.account ?? "", lockedBy: ptr.lockedBy ?? "" });
      }
    }),
  );
  return out;
}

export const MIME: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
