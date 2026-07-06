import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveApiViewer } from "@/lib/viewer";
import { kv } from "@/lib/kv-client";
import { selfBaseUrl } from "@/lib/work-items";

// Browser-facing file upload for the web chat dock — Slack parity. A user
// attaches a document (RFP, contract to redline, requirements, spreadsheet);
// we stash the bytes and hand back a descriptor of the SAME shape the Slack
// lane produces ({ id, name, mimetype, size, url }). The chat send threads that
// descriptor through meeting-chat → oneshot → the sandbox driver, whose
// existing download loop fetches `url` into inbox/files/ and points the agent
// at it.
//
// Storage: the uploaded bytes live in KV (base64) under a random id with a 1h
// TTL — long enough to send the message, short enough to stay transient. No new
// infra (KV caps a value at 10 MiB, so we cap the raw file well under that).
// The GET below streams the bytes back and is called only by the sandbox
// driver (x-board-secret), never the browser.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// 6 MB raw → ~8 MB base64, safely under KV's 10 MiB per-value ceiling. Covers
// virtually every RFP / contract / requirements doc / spreadsheet.
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const UPLOAD_TTL_SEC = 60 * 60;

const metaKey = (id: string) => `upload:${id}:meta`;
const dataKey = (id: string) => `upload:${id}:data`;

type UploadMeta = { name: string; mimetype: string; size: number };

export async function POST(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "no file" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: "empty file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: `file too large — max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB` },
      { status: 413 },
    );
  }

  const id = randomUUID();
  const name = (file.name || "upload").slice(0, 200);
  const mimetype = file.type || "application/octet-stream";
  const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    // Two keys so the big payload isn't wrapped in a JSON object (keeps it
    // under the value ceiling; base64 stored as the raw string value).
    await kv.set(metaKey(id), { name, mimetype, size: file.size } satisfies UploadMeta, { ex: UPLOAD_TTL_SEC });
    await kv.set(dataKey(id), b64, { ex: UPLOAD_TTL_SEC });
  } catch (err) {
    console.error(`[upload] KV write failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ ok: false, error: "could not stash the file — try a smaller one" }, { status: 500 });
  }

  console.log(`[upload] ${name} (${mimetype}, ${Math.round(file.size / 1024)}KB) by=${viewer} id=${id}`);
  return NextResponse.json({
    ok: true,
    id,
    name,
    mimetype,
    size: file.size,
    // The sandbox driver fetches this (with x-board-secret) into inbox/files/.
    url: `${selfBaseUrl()}/api/board/ui/upload?id=${id}`,
  });
}

// Server-to-server only: the sandbox driver fetches the stashed bytes here.
export async function GET(req: NextRequest) {
  const secret = process.env.BOARD_API_SECRET;
  if (!secret || req.headers.get("x-board-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{16,40}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  const [meta, b64] = await Promise.all([
    kv.get<UploadMeta>(metaKey(id)).catch(() => null),
    kv.get<string>(dataKey(id)).catch(() => null),
  ]);
  if (!meta || !b64) {
    return NextResponse.json({ ok: false, error: "not found or expired" }, { status: 404 });
  }
  const bytes = Buffer.from(b64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "content-type": meta.mimetype || "application/octet-stream",
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    },
  });
}
