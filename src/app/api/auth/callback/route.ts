import { NextRequest, NextResponse } from "next/server";
import { ssoEnabled, emailFromCode, ALLOWED_DOMAIN } from "@/lib/workos";
import { signViewer } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// WorkOS AuthKit callback: exchange the code, require a reddy.io identity,
// set the signed httpOnly viewer cookie, land on the app.
export async function GET(req: NextRequest) {
  if (!ssoEnabled()) return NextResponse.json({ ok: false, error: "sso not configured" }, { status: 404 });
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const base = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  if (!code) return NextResponse.redirect(`${base}/?auth=missing-code`);

  // Login-CSRF: the state's nonce prefix must match the cookie this browser
  // set at /api/auth/login — a forced sign-in from elsewhere fails here.
  const dot = state.indexOf(".");
  const nonce = dot > 0 ? state.slice(0, dot) : "";
  const statePath = dot > 0 ? state.slice(dot + 1) : "/";
  if (!nonce || req.cookies.get("sso_state")?.value !== nonce) {
    return NextResponse.redirect(`${base}/?auth=state-mismatch`);
  }

  const email = await emailFromCode(code);
  if (!email || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    // Wrong Google account (or exchange failed) — no cookie, back to the gate.
    return NextResponse.redirect(`${base}/?auth=denied`);
  }

  const dest = statePath.startsWith("/") ? statePath : "/";
  const res = NextResponse.redirect(`${base}${dest}`);
  res.cookies.set(VIEWER_COOKIE, signViewer(email, "sso"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days with SSO (vs 1yr picker cookie)
  });
  res.cookies.set("sso_state", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
