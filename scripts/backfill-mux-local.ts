#!/usr/bin/env tsx
// Local-mode Mux backfill: walks the kb on disk (LFS bytes already
// materialized), uploads each meeting video directly to Mux via the
// signed-PUT upload flow, and rewrites meta.json with mux IDs. Does NOT
// commit or push — leaves the kb dirty so you can review and push by hand.
//
// Why local mode: the in-prod backfill script needs a GitHub PAT scoped
// to the kb repo (ReddySolutions/reddy-gtm) which isn't easily exportable
// from Vercel. The local clone at ~/Downloads/reddy-gtm-kb already has
// the bytes, so we side-step GitHub entirely.
//
// Run from Reddy-GTM repo root:
//   npx tsx scripts/backfill-mux-local.ts \
//       --kb /Users/adamlevin/Downloads/reddy-gtm-kb            # dry run
//   npx tsx scripts/backfill-mux-local.ts \
//       --kb /Users/adamlevin/Downloads/reddy-gtm-kb --commit   # write meta.json
//
// Env required:
//   MUX_TOKEN_ID, MUX_TOKEN_SECRET   (Production-side, in .env.local)

import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const KB_FLAG_IDX = process.argv.indexOf("--kb");
const KB_ROOT = KB_FLAG_IDX >= 0 ? process.argv[KB_FLAG_IDX + 1] : null;
const COMMIT = process.argv.includes("--commit");

if (!KB_ROOT) {
  console.error("usage: backfill-mux-local.ts --kb <path-to-reddy-gtm-kb> [--commit]");
  process.exit(2);
}

const MEETINGS_GLOB = "corpora/success/customers/*/meetings/*/meta.json";
const MUX_API = "https://api.mux.com";

type MuxAsset = {
  id: string;
  status: "preparing" | "ready" | "errored";
  playback_ids?: Array<{ id: string; policy: "public" | "signed" }>;
  errors?: { messages?: string[] };
};

type Upload = {
  id: string;
  url: string;
  asset_id?: string;
  status: "waiting" | "asset_created" | "errored" | "cancelled";
};

function basicAuth(): string {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) throw new Error("MUX_TOKEN_ID / MUX_TOKEN_SECRET not set");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function muxJson<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuth(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`mux ${method} ${url} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function createSignedUpload(): Promise<Upload> {
  const body = await muxJson<{ data: Upload }>("POST", `${MUX_API}/video/v1/uploads`, {
    new_asset_settings: {
      playback_policies: ["signed"],
      encoding_tier: "baseline",
    },
    cors_origin: "*",
  });
  return body.data;
}

async function putBytes(uploadUrl: string, file: string): Promise<void> {
  // Stream the file with curl rather than loading into memory — typical
  // recordings are 50-500MB.
  execFileSync("curl", ["--silent", "--show-error", "--fail", "-X", "PUT", "-T", file, uploadUrl], {
    stdio: "inherit",
  });
}

async function pollUploadAssetId(uploadId: string, timeoutMs = 5 * 60 * 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = await muxJson<{ data: Upload }>("GET", `${MUX_API}/video/v1/uploads/${uploadId}`);
    if (u.data.status === "asset_created" && u.data.asset_id) return u.data.asset_id;
    if (u.data.status === "errored" || u.data.status === "cancelled") {
      throw new Error(`upload ${uploadId} terminal status=${u.data.status}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`upload ${uploadId} did not produce an asset within ${timeoutMs}ms`);
}

async function pollAssetReady(assetId: string, timeoutMs = 15 * 60 * 1000): Promise<MuxAsset> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = await muxJson<{ data: MuxAsset }>("GET", `${MUX_API}/video/v1/assets/${assetId}`);
    if (a.data.status === "ready") return a.data;
    if (a.data.status === "errored") throw new Error(`asset ${assetId} errored: ${JSON.stringify(a.data.errors)}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`asset ${assetId} not ready within ${timeoutMs}ms`);
}

function listMetaPaths(root: string): string[] {
  // Glob via shell to avoid pulling in another dep.
  const out = execFileSync("bash", ["-c", `cd "${root}" && ls ${MEETINGS_GLOB} 2>/dev/null || true`], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rel) => path.join(root, rel));
}

type Meta = {
  recall_bot_id?: string;
  video?: { oid: string; size: number } | null;
  mux?: { asset_id: string; playback_id: string } | null;
  schema_version?: number;
  [k: string]: unknown;
};

async function main() {
  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
    throw new Error("MUX_TOKEN_ID / MUX_TOKEN_SECRET not set; source .env.local first");
  }

  const metaPaths = listMetaPaths(KB_ROOT!);
  console.log(`[backfill] mode=${COMMIT ? "WRITE" : "DRY RUN"} kb=${KB_ROOT} found ${metaPaths.length} meta.json`);

  const queue: Array<{ metaPath: string; videoPath: string; meta: Meta; size: number }> = [];
  for (const metaPath of metaPaths) {
    let meta: Meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
    } catch {
      continue;
    }
    if (!meta.video?.oid) continue;
    if (meta.mux?.playback_id) continue;
    const videoPath = path.join(path.dirname(metaPath), "video.mp4");
    let size = 0;
    try {
      size = statSync(videoPath).size;
    } catch {
      console.warn(`[backfill] no video.mp4 next to ${metaPath}; run \`git lfs pull\` in the kb`);
      continue;
    }
    if (size < 1024) {
      // Probably an LFS pointer (small text file), not real bytes.
      const head = readFileSync(videoPath, "utf8").slice(0, 60);
      if (head.startsWith("version https://git-lfs")) {
        console.warn(`[backfill] ${videoPath} is an LFS pointer, bytes not pulled; skipping`);
        continue;
      }
    }
    queue.push({ metaPath, videoPath, meta, size });
  }

  console.log(`[backfill] ${queue.length} meetings need Mux ingest`);
  if (queue.length === 0) return;
  if (!COMMIT) {
    for (const q of queue) console.log(`  ${q.metaPath} (${(q.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[backfill] re-run with --commit to upload + write meta.json`);
    return;
  }

  let done = 0;
  for (const q of queue) {
    try {
      console.log(`[backfill] uploading ${q.metaPath} (${(q.size / 1024 / 1024).toFixed(1)} MB)`);
      const upload = await createSignedUpload();
      await putBytes(upload.url, q.videoPath);
      const assetId = await pollUploadAssetId(upload.id);
      const asset = await pollAssetReady(assetId);
      const playbackId =
        asset.playback_ids?.find((p) => p.policy === "signed")?.id ??
        asset.playback_ids?.[0]?.id;
      if (!playbackId) {
        console.warn(`[backfill] asset ${assetId} ready but no playback_id; skipping`);
        continue;
      }
      const updated: Meta = {
        ...q.meta,
        mux: { asset_id: asset.id, playback_id: playbackId },
        schema_version: 2,
      };
      writeFileSync(q.metaPath, JSON.stringify(updated, null, 2) + "\n");
      done += 1;
      console.log(`[backfill] ✓ ${q.metaPath} → mux ${playbackId}`);
    } catch (err) {
      console.error(`[backfill] ✗ ${q.metaPath}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[backfill] done: ${done}/${queue.length} migrated`);
  console.log(`[backfill] kb is now dirty — review with \`cd ${KB_ROOT} && git status\`, then commit + push`);
}

main().catch((err) => {
  console.error(`[backfill] fatal: ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
