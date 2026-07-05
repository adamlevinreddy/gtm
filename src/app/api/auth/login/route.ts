import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ssoEnabled, authorizationUrl } from "@/lib/workos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Kicks off WorkOS AuthKit sign-in. 404s when SSO isn't configured (the
// picker gate covers that mode). A nonce cookie binds the callback to THIS
// browser (login-CSRF protection).
export async function GET(req: NextRequest) {
  if (!ssoEnabled()) return NextResponse.json({ ok: false, error: "sso not configured" }, { status: 404 });
  const next = req.nextUrl.searchParams.get("next") ?? "/";
  const nonce = randomUUID();
  const res = NextResponse.redirect(authorizationUrl(`${nonce}.${next.startsWith("/") ? next : "/"}`));
  res.cookies.set("sso_state", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
