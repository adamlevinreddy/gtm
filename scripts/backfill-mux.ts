#!/usr/bin/env tsx
// One-shot backfill: scan all kb meeting meta.json, find those with an
// LFS video pointer but no Mux ingest, fetch a fresh LFS download URL,
// hand it to Mux as an input source, poll until ready, write the Mux
// IDs back to meta.json, and commit in batches.
//
// Run from the Reddy-GTM repo root after sourcing .env.local:
//   set -a; source .env.local; set +a
//   npx tsx scripts/backfill-mux.ts            # dry run, prints plan
//   npx tsx scripts/backfill-mux.ts --commit   # write changes
//
// Env required (pull via `vercel env pull .env.local`):
//   PRICING_LIBRARY_GITHUB_PAT
//   MUX_TOKEN_ID
//   MUX_TOKEN_SECRET
//
// Idempotent — meetings that already have meta.mux.playback_id are skipped.

import { commitToKb, KB_REPO, type CommitFile } from "../src/lib/github-kb";
import { lfsDownloadUrl, parseLfsPointer } from "../src/lib/github-lfs";
import { assetCreateFromUrl, waitForAssetReady } from "../src/lib/mux";

const COMMIT = process.argv.includes("--commit");
const BATCH_SIZE = 5; // commit every N successful ingests

const GH_API = "https://api.github.com";

type MetaJson = {
  recall_bot_id?: string;
  video?: { oid: string; size: number } | null;
  mux?: { asset_id: string; playback_id: string } | null;
  schema_version?: number;
  [key: string]: unknown;
};

async function main() {
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) throw new Error("PRICING_LIBRARY_GITHUB_PAT not set");
  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
    throw new Error("MUX_TOKEN_ID / MUX_TOKEN_SECRET not set");
  }

  console.log(`[backfill] mode=${COMMIT ? "WRITE" : "DRY RUN"}`);
  const candidates = await listMeetingMetaPaths(pat);
  console.log(`[backfill] found ${candidates.length} meeting meta.json files`);

  const queue: Array<{ path: string; sha: string; meta: MetaJson; pointerPath: string }> = [];
  for (const c of candidates) {
    const text = await readBlob(pat, c.sha);
    if (!text) continue;
    let meta: MetaJson;
    try {
      meta = JSON.parse(text) as MetaJson;
    } catch {
      continue;
    }
    if (!meta.video?.oid) continue;          // no video to migrate
    if (meta.mux?.playback_id) continue;     // already migrated
    const pointerPath = c.path.replace(/meta\.json$/, "video.mp4");
    queue.push({ path: c.path, sha: c.sha, meta, pointerPath });
  }

  console.log(`[backfill] ${queue.length} meetings need Mux ingest`);
  if (queue.length === 0) return;
  if (!COMMIT) {
    for (const q of queue.slice(0, 20)) console.log(`  ${q.path}`);
    if (queue.length > 20) console.log(`  …and ${queue.length - 20} more`);
    console.log(`[backfill] re-run with --commit to write`);
    return;
  }

  let pending: CommitFile[] = [];
  let done = 0;
  for (const q of queue) {
    try {
      const obj = q.meta.video!;
      const dl = await lfsDownloadUrl(pat, KB_REPO, obj);
      if (!dl) {
        console.warn(`[backfill] no LFS download URL for ${q.path}; skipping`);
        continue;
      }
      console.log(`[backfill] muxing ${q.path} (${(obj.size / 1024 / 1024).toFixed(1)} MB)`);
      const created = await assetCreateFromUrl({
        url: dl.url,
        passthrough: q.path.replace(/^corpora\/success\/customers\//, "").replace(/\/meetings\/.*$/, "") + "/" + (q.meta.recall_bot_id ?? ""),
      });
      const ready = await waitForAssetReady(created.id, { timeoutMs: 15 * 60 * 1000 });
      const playbackId =
        ready.playback_ids?.find((p) => p.policy === "signed")?.id ??
        ready.playback_ids?.[0]?.id;
      if (!playbackId) {
        console.warn(`[backfill] mux ready but no playback_id for ${q.path}; skipping`);
        continue;
      }
      const updated: MetaJson = {
        ...q.meta,
        mux: { asset_id: ready.id, playback_id: playbackId },
        schema_version: 2,
      };
      pending.push({ path: q.path, utf8: JSON.stringify(updated, null, 2) + "\n" });
      done += 1;
      console.log(`[backfill] ✓ ${q.path} → mux ${playbackId}`);

      if (pending.length >= BATCH_SIZE) {
        await commitToKb({
          pat,
          message: `mux: backfill ${pending.length} meeting(s)`,
          files: pending,
        });
        console.log(`[backfill] committed batch (${pending.length})`);
        pending = [];
      }
    } catch (err) {
      console.error(`[backfill] ✗ ${q.path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (pending.length > 0) {
    await commitToKb({
      pat,
      message: `mux: backfill ${pending.length} meeting(s)`,
      files: pending,
    });
    console.log(`[backfill] committed final batch (${pending.length})`);
  }
  console.log(`[backfill] done: ${done}/${queue.length} migrated`);
}

async function listMeetingMetaPaths(pat: string): Promise<Array<{ path: string; sha: string }>> {
  const refRes = await fetch(`${GH_API}/repos/${KB_REPO.owner}/${KB_REPO.name}/git/ref/heads/main`, {
    headers: ghHeaders(pat),
  });
  if (!refRes.ok) throw new Error(`gh ref -> ${refRes.status}`);
  const ref = (await refRes.json()) as { object: { sha: string } };
  const commitRes = await fetch(`${GH_API}/repos/${KB_REPO.owner}/${KB_REPO.name}/git/commits/${ref.object.sha}`, {
    headers: ghHeaders(pat),
  });
  if (!commitRes.ok) throw new Error(`gh commit -> ${commitRes.status}`);
  const commit = (await commitRes.json()) as { tree: { sha: string } };
  const treeRes = await fetch(
    `${GH_API}/repos/${KB_REPO.owner}/${KB_REPO.name}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: ghHeaders(pat) },
  );
  if (!treeRes.ok) throw new Error(`gh tree -> ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; sha: string }>; truncated?: boolean };
  if (tree.truncated) console.warn(`[backfill] WARNING: tree was truncated; some meetings may not be visible`);
  return (tree.tree ?? [])
    .filter((e) => e.type === "blob" && e.path.startsWith("corpora/success/customers/") && e.path.endsWith("/meta.json"))
    .map((e) => ({ path: e.path, sha: e.sha }));
}

async function readBlob(pat: string, sha: string): Promise<string | null> {
  const res = await fetch(`${GH_API}/repos/${KB_REPO.owner}/${KB_REPO.name}/git/blobs/${sha}`, {
    headers: ghHeaders(pat),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) return null;
  return Buffer.from(body.content, (body.encoding ?? "base64") as BufferEncoding).toString("utf8");
}

function ghHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// silence unused parseLfsPointer import if Vercel's tree-shake whines
void parseLfsPointer;

main().catch((err) => {
  console.error(`[backfill] fatal: ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
