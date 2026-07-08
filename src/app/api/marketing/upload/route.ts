import { NextRequest, NextResponse } from "next/server";
import { resolveApiViewer } from "@/lib/viewer";
import { commitToKb } from "@/lib/github-kb";

// Persistent marketing-library upload. UNLIKE the chat paperclip
// (/api/board/ui/upload, which stashes bytes in KV for ONE turn), this commits
// the file straight into the KB repo under corpora/marketing/uploads/ — so it
// becomes permanent marketing material that every future Marketing sandbox
// clones and can read. This is the "drag in what's missing and it's saved
// forever" area on /marketing.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// Kept in step with the platform request-body ceiling (the chat upload uses the
// same). Typical marketing docs (one-sheets, briefs, images, short PDFs) fit;
// large decks/video should go through the Library's manual path for now.
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

// Keep names filesystem/git-safe and confined to the marketing corpus. Collapse
// whitespace to dashes, drop anything that isn't alnum/dot/dash/underscore.
function safeName(raw: string): string {
  const base = (raw || "upload").split(/[/\\]/).pop() || "upload";
  const cleaned = base
    .normalize("NFKD")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "upload";
}

export async function POST(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) return NextResponse.json({ ok: false, error: "library not configured" }, { status: 500 });

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
      { ok: false, error: `file too large — max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB here` },
      { status: 413 },
    );
  }

  const name = safeName(file.name);
  const path = `corpora/marketing/uploads/${name}`;
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    const { commitSha } = await commitToKb({
      pat,
      message: `marketing: add ${name} (via /marketing, ${viewer})`,
      files: [{ path, base64 }],
    });
    console.log(`[marketing/upload] ${path} by=${viewer} sha=${commitSha}`);
    return NextResponse.json({ ok: true, name, path, size: file.size, commitSha });
  } catch (err) {
    console.error(`[marketing/upload] commit failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ ok: false, error: "couldn't save to the library — try again" }, { status: 502 });
  }
}
