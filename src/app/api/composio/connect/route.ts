import { NextRequest, NextResponse } from "next/server";
import { resolveApiViewer } from "@/lib/viewer";
import { initiateConnection, TOOLKITS, type ToolkitSlug } from "@/lib/composio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One-click web connect (Arc V). Initiates the Composio OAuth flow for the
// signed-in viewer + a single toolkit, then 302s the browser straight to the
// consent screen; Composio returns to /settings?connected=<slug> when done.
//
// Cookie-gated: the viewer (their SSO email) IS the Composio user_id, so a
// connection can only ever be started for yourself — no ?email= to spoof.
export async function GET(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });

  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  const slug = req.nextUrl.searchParams.get("slug") as ToolkitSlug | null;
  if (!slug || !TOOLKITS.some((t) => t.slug === slug)) {
    return NextResponse.redirect(`${base}/settings?connect=badslug`);
  }

  try {
    const { redirectUrl } = await initiateConnection(viewer, slug, `${base}/settings?connected=${slug}`);
    if (!redirectUrl) throw new Error("no redirect url returned");
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error(`[composio/connect] ${slug} for ${viewer}: ${err instanceof Error ? err.message : err}`);
    return NextResponse.redirect(`${base}/settings?connect=error&slug=${slug}`);
  }
}
