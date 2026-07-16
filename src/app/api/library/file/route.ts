import { NextRequest, NextResponse } from "next/server";
import { readKbFileBytes, KB_REPO } from "@/lib/github-kb";
import { parseLfsPointer, lfsDownloadUrl } from "@/lib/github-lfs";
import { MIME } from "@/lib/library";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Authed streaming proxy for Library files (Daybreak Phase 11). The KB is a
// private GitHub repo — this is the only way a browser can read it. Cookie-
// gated; path locked to corpora/ with traversal rejected.

export async function GET(req: NextRequest) {
  if (!verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path.startsWith("corpora/") || path.includes("..") || path.includes("//")) {
    return NextResponse.json({ ok: false, error: "bad path" }, { status: 400 });
  }
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });

  let bytes = await readKbFileBytes(pat, path).catch(() => null);
  if (!bytes) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  // LFS-tracked binaries (decks, big PDFs) come back from the Contents API
  // as 132-byte POINTER text — resolve through the LFS batch API so the
  // Library never serves a corrupt download (live-verified failure mode).
  if (bytes.length < 400) {
    const pointer = parseLfsPointer(bytes.toString("utf8"));
    if (pointer) {
      const dl = await lfsDownloadUrl(pat, KB_REPO, pointer).catch(() => null);
      if (!dl) return NextResponse.json({ ok: false, error: "lfs object unavailable" }, { status: 502 });
      const real = await fetch(dl.url).catch(() => null);
      if (!real || !real.ok) return NextResponse.json({ ok: false, error: "lfs fetch failed" }, { status: 502 });
      bytes = Buffer.from(await real.arrayBuffer());
    }
  }

  const name = path.split("/").pop() ?? "file";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const download = req.nextUrl.searchParams.get("dl") === "1";
  // ASCII-sanitize the filename — undici throws on non-Latin-1 header values.
  const safeName = name.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
