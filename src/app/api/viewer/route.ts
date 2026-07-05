import { NextRequest, NextResponse } from "next/server";
import { isValidEmail, signViewer } from "@/lib/viewer";
import { ssoEnabled } from "@/lib/workos";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Sets the signed, httpOnly viewer-identity cookie (Daybreak Phase 6).
// Called by the welcome gate and the header picker — HONOR-SYSTEM ONLY.
// With WorkOS SSO enabled this endpoint is CLOSED: identity comes from the
// Google sign-in callback exclusively, or SSO would be a decoration.
export async function POST(req: NextRequest) {
  if (ssoEnabled()) {
    return NextResponse.json({ ok: false, error: "sign in with Google (SSO is enforced)" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: "invalid email" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, viewer: email });
  res.cookies.set(VIEWER_COOKIE, signViewer(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return res;
}
