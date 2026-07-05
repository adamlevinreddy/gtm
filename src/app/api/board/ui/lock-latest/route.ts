import { NextRequest, NextResponse } from "next/server";
import { commitToKb } from "@/lib/github-kb";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Lock-as-latest (Daybreak Phase 10): one click promotes a generated
// artifact to THE latest deliverable for an account — a per-account
// latest.json pointer in the KB, with who/when provenance. The Library
// badges whatever the pointer names; artifact loss can't return wearing
// new UI because the KB commit is the lock.

export async function POST(req: NextRequest) {
  const viewer = verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
  if (!viewer) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kbPath?: string; account?: string } | null;
  const kbPath = body?.kbPath ?? "";
  const account = (body?.account ?? "").trim();
  if (!kbPath.startsWith("corpora/deliverables/") || kbPath.includes("..") || kbPath.includes("//")) {
    return NextResponse.json({ ok: false, error: "only library deliverables can be locked" }, { status: 400 });
  }
  if (!account || account.length > 80) {
    return NextResponse.json({ ok: false, error: "need an account name" }, { status: 400 });
  }
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (!pat) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });

  const slug = account.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return NextResponse.json({ ok: false, error: "bad account name" }, { status: 400 });

  const pointer = {
    path: kbPath,
    name: kbPath.split("/").pop(),
    account,
    accountSlug: slug,
    lockedBy: viewer,
    lockedAt: new Date().toISOString(),
  };
  // The pointer lives in the FILE'S OWN directory (deliverable dirs are
  // title-slugs, not account-slugs) — that's the only dir readers scan.
  // Account identity travels INSIDE the JSON.
  const pointerDir = kbPath.split("/").slice(0, -1).join("/");
  try {
    await commitToKb({
      pat,
      message: `lock-latest: ${pointer.name} → ${slug} (by ${viewer})`,
      files: [
        {
          path: `${pointerDir}/latest.json`,
          utf8: JSON.stringify(pointer, null, 2) + "\n",
        },
      ],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `commit failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, slug });
}
