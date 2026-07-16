import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { signViewer } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";
import { ALLOWED_DOMAIN } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Post-sign-in bridge (Clerk → the app). Clerk has authenticated the user;
// here we read that identity, enforce the @reddy.io domain server-side (defense
// in depth on top of Clerk's allowlist), mint our signed viewer cookie, and
// bounce to the page the user was headed for. Runs once per cookie lifetime;
// every request afterward is a plain signed-cookie read (no Clerk call).
//
// This route lives OUTSIDE /api on purpose: the middleware matcher runs on it
// (so clerkMiddleware provides the session for currentUser()) and marks it
// public (so it's reachable before the cookie exists).
export async function GET(req: NextRequest) {
  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  const nextParam = req.nextUrl.searchParams.get("next");
  // Same-site paths only — reject protocol-relative (//host) open redirects.
  const dest = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  const u = await currentUser().catch(() => null);
  const email = u?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;

  if (!email) {
    // Not signed in — home is protected, so this bounces to the Clerk sign-in.
    return NextResponse.redirect(`${base}/`);
  }
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    // Wrong-domain Clerk session → terminal public page (NOT home, which would
    // bounce back here and loop). They must sign out.
    return NextResponse.redirect(`${base}/auth/denied`);
  }

  const res = NextResponse.redirect(`${base}${dest}`);
  res.cookies.set(VIEWER_COOKIE, signViewer(email, "sso"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // 7d — short so a removed teammate loses API access within a week even
    // though the cookie is self-contained (Clerk revocation doesn't reach it).
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
